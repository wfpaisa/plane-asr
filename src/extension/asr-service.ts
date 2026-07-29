/* asr-service.ts
 *
 * Orquesta el flujo grabar -> transcribir -> mostrar salida y expone una
 * pequeña máquina de estados a la interfaz. El `Indicator` solo observa
 * estados y llama a `toggle()` / `cancel()`; toda la gestión de
 * subprocesos vive aquí.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SETTINGS_KEYS, normalizeCliMode} from '../config/settings.js';
import {cacheDir, pruneRecordings, recordsDir} from '../config/paths.js';
import {resolveAutoCli} from './cli-resolver.js';
import {getBackend} from './asr-backends.js';
import {notify} from './notify.js';
import {Recorder} from './recorder.js';
import {Transcriber, type TranscriberOptions} from './transcriber.js';
import {
    findModel,
    pickFile,
    resolveModelDir,
    modelFilePath,
} from '../models/catalog.js';
import {
    SAMPLE_RATE,
    cleanupChunks,
    getWavDataOffset,
    wavAvailableSamples,
    writeWavChunk,
} from './audio-chunker.js';
import {AudioConverter, NoConverterError} from './audio-converter.js';
import {copyToClipboard, pasteAtCursor} from '../util/paste.js';
import {
    dedupChunkJoin,
    finalizeTranscript,
    stripPlaceholders,
} from '../util/text-merge.js';

/**
 * Tamaño de trozo (ms) con el que el modo en tiempo real conduce el
 * streaming del CLI (`--stream-chunk-ms`). Valores pequeños producen
 * parciales más frecuentes (pegado más granular) a mayor coste por parcial;
 * 500 ms da actualizaciones a nivel de palabra sin recargar el modelo.
 */
const REALTIME_STREAM_CHUNK_MS = 500;

/** Estados generales del ciclo de vida, expuestos a la interfaz. */
export enum AsrState {
    Idle,
    Recording,
    Transcribing,
}

/** Contexto opcional que acompaña a un cambio de estado. */
export interface AsrChangeContext {
    /** Mensaje de error, al volver a Idle tras un fallo. */
    error?: string;
    /** Texto de transcripción producido en este ciclo, cuando está disponible. */
    text?: string;
    /** Etiqueta de progreso al transcribir varios trozos, ej. "2/5". */
    progress?: string;
}

type ChangeCb = (state: AsrState, ctx?: AsrChangeContext) => void;

/**
 * Estado mutable de una ejecución de transcripción en vivo. Se mantiene por
 * grabación, de modo que un worker cancelado conserva su propia vista
 * incluso después de que empiece una nueva grabación (el worker solo toca
 * el objeto que se le entregó, nunca la sesión actual del servicio).
 */
interface StreamSession {
    /** Se activa una vez que el grabador se detuvo, para que el worker drene la cola. */
    ended: boolean;
    /** Se activa al cancelar; el worker sale sin emitir más texto. */
    cancelled: boolean;
    /** Fragmentos transcritos en orden, unidos para formar el total final. */
    texts: string[];
    /** Offset en bytes de los datos PCM dentro del WAV, una vez que el encabezado es legible. */
    dataOffset: number | null;
}

/**
 * Dueño único del {@link Recorder} y del {@link Transcriber}. Conduce el
 * ciclo IDLE -> RECORDING -> TRANSCRIBING -> IDLE y despacha el texto
 * resultante al portapapeles o al widget con el foco.
 */
export class AsrService {
    private _settings: Gio.Settings;
    private _onChange: ChangeCb;
    private _state: AsrState = AsrState.Idle;
    private _recorder = new Recorder();
    private _converter = new AudioConverter();
    private _transcriber: Transcriber;
    private _extensionDir: string | null;
    private _currentAudioPath: string | null = null;
    /** Sesión de transcripción en vivo activa mientras hay streaming; null en otro caso. */
    private _stream: StreamSession | null = null;
    /** Se resuelve cuando el worker en vivo ha drenado por completo la grabación. */
    private _streamDone: Promise<void> | null = null;

    constructor(
        settings: Gio.Settings,
        onChange: ChangeCb,
        transcriberOpts: TranscriberOptions
    ) {
        this._settings = settings;
        this._onChange = onChange;
        this._extensionDir = transcriberOpts.extensionDir;
        this._transcriber = new Transcriber(settings, transcriberOpts);
    }

    /** Estado actual del ciclo de vida. */
    get state(): AsrState {
        return this._state;
    }

    /**
     * Avanza la máquina de estados:
     * - Idle         -> empieza a grabar
     * - Recording    -> detiene y transcribe
     * - Transcribing -> se ignora (usar {@link cancel})
     */
    async toggle(): Promise<void> {
        switch (this._state) {
            case AsrState.Idle:
                await this._startRecording();
                break;
            case AsrState.Recording:
                await this._stopAndTranscribe();
                break;
            case AsrState.Transcribing:
                // No-op intencional; el usuario puede cancelar explícitamente.
                break;
        }
    }

    /**
     * "Mantener para hablar": comienza a grabar. Solo actúa si está inactivo,
     * de modo que las repeticiones de auto-repeat del teclado o un atajo de
     * alternar concurrente no reinicien la grabación.
     */
    async beginHold(): Promise<void> {
        if (this._state === AsrState.Idle) {
            await this._startRecording();
        }
    }

    /**
     * "Mantener para hablar": detiene y transcribe. Solo actúa si está
     * grabando, así soltar las teclas después de que la grabación ya terminó
     * (p. ej. tras cancelar) no hace nada.
     */
    async endHold(): Promise<void> {
        if (this._state === AsrState.Recording) {
            await this._stopAndTranscribe();
        }
    }

    /** Aborta lo que esté en curso y vuelve a Idle. */
    cancel(): void {
        if (this._stream) this._stream.cancelled = true;
        if (this._recorder.isRecording()) {
            this._recorder.stop().catch(e => logError(e));
        }
        this._converter.forceExit();
        this._transcriber.forceExit();
        this._currentAudioPath = null;
        this._setState(AsrState.Idle);
    }

    /** Libera todo al desactivarse la extensión. */
    destroy(): void {
        this.cancel();
    }

    // -- transiciones de estado ----------------------------------------------

    /**
     * Notifica el resultado final de una transcripción.
     *
     * Cuando no hubo texto (silencio o ruido de fondo) avisa que no se
     * detectó voz, en lugar de afirmar falsamente que se pegó o copió algo.
     * Las rutas de entrega ya omiten el portapapeles/pegado cuando el texto
     * está vacío; esto solo mantiene el aviso coherente con lo ocurrido.
     */
    private _notifyResult(full: string, isPaste: boolean): void {
        if (!full) {
            notify(this._extensionDir, _('Plane ASR: no speech detected'));
            return;
        }
        notify(
            this._extensionDir,
            isPaste
                ? _('Plane ASR: transcription pasted')
                : _('Plane ASR: transcription copied')
        );
    }

    /**
     * Chequeo previo de que hay un binario de transcripción usable antes de
     * comprometerse a grabar.
     *
     * Qué hace: respeta `cli-mode`: 'gpu' valida la `cli-path` provista por
     * el usuario; 'cpu' prefiere el binario incluido y recurre al PATH. Los
     * valores heredados 'auto'/'manual' se migran. Devuelve un string de
     * error localizado, o null cuando el binario está bien.
     */
    private _validateCliBinary(): string | null {
        const raw = this._settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu';
        const mode = normalizeCliMode(raw);
        if (mode === 'gpu') {
            const cliPath =
                this._settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
            if (
                !cliPath ||
                !Gio.File.new_for_path(cliPath).query_exists(null)
            ) {
                return _('ASR binary not found. Set it in preferences.');
            }
            return null;
        }
        // cpu: primero el binario incluido, luego el PATH.
        const backendId =
            this._settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ??
            'transcribe-cli';
        const pathName = getBackend(backendId).defaultCliName;
        const resolved = resolveAutoCli(pathName);
        if (resolved.source !== 'none') return null;
        return _(
            'No transcription binary available. Download the engine from ' +
                'the "Setup" tab in preferences, switch to GPU mode and set ' +
                'the binary path, or install transcribe-cli on your PATH.'
        );
    }

    /**
     * Chequeo previo de que hay un modelo configurado antes de
     * comprometerse a grabar: o el modelo de catálogo activo está
     * descargado en disco, o el usuario dejó una ruta propia en
     * `model-params`. Misma resolución que usa {@link Transcriber} al
     * armar el flag `-m` del CLI, pero sin llegar a lanzarlo. Devuelve un
     * string de error localizado, o null cuando hay un modelo utilizable.
     */
    private _validateModel(): string | null {
        const modelId =
            this._settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
        if (modelId) {
            const entry = findModel(modelId);
            if (entry) {
                const quant =
                    this._settings.get_string(SETTINGS_KEYS.QUANT_PREFERENCE) ??
                    '';
                const file = pickFile(entry, quant);
                if (file) {
                    const modelDir = resolveModelDir(
                        this._settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
                    );
                    const path = modelFilePath(modelDir, file);
                    if (Gio.File.new_for_path(path).query_exists(null)) {
                        return null;
                    }
                }
            }
        }
        // Sin modelo de catálogo activo utilizable: una ruta propia en
        // model-params también cuenta como "hay modelo configurado".
        const userParams =
            this._settings.get_string(SETTINGS_KEYS.MODEL_PARAMS) ?? '';
        if (userParams.trim()) return null;
        return _(
            'No model selected. Open Preferences to choose a transcription model.'
        );
    }

    /**
     * Inicia una nueva grabación tras validar que hay un binario del CLI y
     * un modelo disponibles, y arranca el worker de transcripción en vivo
     * si el troceo (chunking) está habilitado.
     */
    private async _startRecording(): Promise<void> {
        const missing = this._validateCliBinary();
        if (missing) {
            this._setState(AsrState.Idle, {error: missing});
            return;
        }

        const missingModel = this._validateModel();
        if (missingModel) {
            this._setState(AsrState.Idle, {error: missingModel});
            return;
        }

        const audioPath = this._newAudioPath();
        this._currentAudioPath = audioPath;
        this._migrateLooseWavs();

        try {
            this._recorder.start(audioPath);
            this._setState(AsrState.Recording);
        } catch (e) {
            this._currentAudioPath = null;
            this._setState(AsrState.Idle, {error: this._errMsg(e)});
            return;
        }

        // Lanza el troceo en vivo: mientras el grabador sigue añadiendo al
        // WAV, un worker en segundo plano recorta trozos de N segundos ya
        // listos de la cola y transmite cada uno hacia afuera (pegado o
        // copiado) para que las primeras palabras lleguen mientras el usuario
        // sigue hablando. El modo en tiempo real NO entra aquí: procesa la
        // grabación completa al detener (ver _stopAndTranscribe).
        if (this._liveChunkingEnabled()) {
            const session: StreamSession = {
                ended: false,
                cancelled: false,
                texts: [],
                dataOffset: null,
            };
            this._stream = session;
            this._streamDone = this._runStream(audioPath, session);
        }
    }

    /**
     * Detiene la grabación en curso y produce la transcripción final,
     * usando la ruta de streaming en vivo si está activa, o transcribiendo
     * el archivo completo de una sola vez.
     */
    private async _stopAndTranscribe(): Promise<void> {
        const audioPath = this._currentAudioPath;
        this._currentAudioPath = null;
        try {
            await this._recorder.stop();
        } catch (e) {
            if (this._stream) this._stream.cancelled = true;
            this._setState(AsrState.Idle, {error: this._errMsg(e)});
            return;
        }

        if (!audioPath) {
            this._setState(AsrState.Idle);
            return;
        }

        const isPaste =
            (this._settings.get_string('output-mode') ?? 'clipboard') ===
            'paste';

        const session = this._stream;
        if (session) {
            // Ruta en vivo: señala el fin de la grabación, deja que el
            // worker transcriba el trozo parcial final, y luego publica el
            // total unido.
            this._setState(AsrState.Transcribing);
            session.ended = true;
            try {
                await this._streamDone;
            } catch (e) {
                this._stream = null;
                this._streamDone = null;
                this._setState(AsrState.Idle, {error: this._errMsg(e)});
                return;
            }
            this._stream = null;
            this._streamDone = null;
            if (session.cancelled) {
                this._setState(AsrState.Idle);
                return;
            }
            // La transcripción completa siempre se copia para que "Copiar
            // texto" y el portapapeles tengan todos los trozos unidos,
            // incluso en modo pegado.
            const full = finalizeTranscript(session.texts.join(' '));
            this._settings.set_string(SETTINGS_KEYS.LAST_TEXT, full);
            if (full) copyToClipboard(full);
            this._pruneRecordings();
            this._notifyResult(full, isPaste);
            this._setState(AsrState.Idle, {text: full});
            return;
        }

        // Modo en tiempo real + pegado: procesa la grabación completa en una
        // sola pasada usando el streaming del CLI y va pegando el texto en el
        // cursor a medida que la librería lo emite. Con salida al portapapeles
        // no hay pegado progresivo: cae a la pasada offline de abajo, que al
        // terminar copia el texto completo de una vez.
        if (
            this._settings.get_boolean(SETTINGS_KEYS.REALTIME_MODE) &&
            isPaste &&
            this._activeModelSupportsStreaming()
        ) {
            await this._transcribeStreamingProgressive(audioPath);
            return;
        }

        // Ruta sin streaming: transcribe la grabación completa en una sola pasada.
        await this._transcribeWhole(audioPath, isPaste);
    }

    /**
     * Transcribe un WAV completo de una vez (troceo desactivado). Las
     * grabaciones pasan por el paso de poda después; un archivo elegido por
     * el usuario pasa `prune: false` para que las grabaciones no
     * relacionadas bajo records/ nunca se borren por su causa.
     */
    private async _transcribeWhole(
        audioPath: string,
        isPaste: boolean
    ): Promise<void> {
        await this._runTranscription(audioPath, isPaste, true);
    }

    /**
     * Ruta del modo en tiempo real con pegado: procesa la grabación completa
     * al detener, en una sola pasada, usando el streaming del CLI, y va
     * pegando el texto en el cursor a medida que la librería lo produce.
     *
     * A diferencia del troceo en vivo, aquí el modelo se carga una sola vez
     * y el CLI emite parciales incrementales (append puro) que se pegan
     * secuencialmente. El total final se deja también en el portapapeles,
     * como en el resto de rutas.
     */
    private async _transcribeStreamingProgressive(
        audioPath: string
    ): Promise<void> {
        this._setState(AsrState.Transcribing);
        // Se lleva la cuenta de si ya se pegó algo para que el primer
        // fragmento arranque en minúscula (continúa donde esté el cursor, no
        // es una frase nueva), igual que la ruta de troceo en vivo.
        let firstDelta = true;
        try {
            const result = await this._transcriber.transcribeStreaming(
                audioPath,
                REALTIME_STREAM_CHUNK_MS,
                async delta => {
                    const piece =
                        firstDelta && delta
                            ? delta[0].toLowerCase() + delta.slice(1)
                            : delta;
                    firstDelta = false;
                    if (piece) await pasteAtCursor(piece);
                }
            );
            if (result.cancelled) {
                this._setState(AsrState.Idle);
                return;
            }
            const full = result.text.trim();
            this._settings.set_string(SETTINGS_KEYS.LAST_TEXT, full);
            // El total completo siempre queda en el portapapeles para que
            // "Copiar texto" tenga la transcripción entera, incluso en pegado.
            if (full) copyToClipboard(full);
            this._pruneRecordings();
            this._notifyResult(full, true);
            this._setState(AsrState.Idle, {text: full});
        } catch (e) {
            this._setState(AsrState.Idle, {error: this._errMsg(e)});
        }
    }

    /**
     * Núcleo de transcripción compartido tanto por la ruta de grabación
     * como por la de archivo elegido: ejecuta el CLI sobre un WAV completo,
     * publica el resultado y opcionalmente poda la carpeta de grabaciones.
     */
    private async _runTranscription(
        audioPath: string,
        isPaste: boolean,
        prune: boolean
    ): Promise<void> {
        this._setState(AsrState.Transcribing);
        try {
            const result = await this._transcriber.transcribe(audioPath);
            if (result.cancelled) {
                this._setState(AsrState.Idle);
                return;
            }
            const full = result.text.trim();
            this._settings.set_string(SETTINGS_KEYS.LAST_TEXT, full);
            if (full) {
                if (isPaste) await pasteAtCursor(full);
                else copyToClipboard(full);
            }
            this._notifyResult(full, isPaste);
            if (prune) this._pruneRecordings();
            this._setState(AsrState.Idle, {text: full});
        } catch (e) {
            this._setState(AsrState.Idle, {error: this._errMsg(e)});
        }
    }

    /**
     * Transcribe un archivo de audio existente que el usuario eligió
     * mediante la opción "Procesar archivo de audio" del indicador.
     *
     * Qué hace: si el archivo ya es un WAV s16le de 16 kHz mono, se
     * alimenta directamente al CLI; si no, se convierte primero (ffmpeg,
     * recurriendo a gst-launch-1.0). Cuando no hay conversor disponible, se
     * le indica al usuario el formato requerido en vez de fallar de forma genérica.
     *
     * Los archivos convertidos se escriben en records/ como `imported_*` y
     * NO se podan (la expresión regular de poda solo coincide con
     * `recording_*.wav`).
     */
    async transcribeFile(srcPath: string): Promise<void> {
        // No existe ninguna otra protección de concurrencia — el switch de
        // `toggle()` es lo único que evita que las transcripciones se
        // solapen. Este punto de entrada se llama directamente desde el
        // indicador, así que debe protegerse a sí mismo.
        if (this._state !== AsrState.Idle) {
            notify(this._extensionDir, _('Plane ASR is busy'));
            return;
        }

        const missing = this._validateCliBinary();
        if (missing) {
            this._setState(AsrState.Idle, {error: missing});
            return;
        }

        // Reclama el estado ocupado de entrada para que un toggle()
        // concurrente (atajo global o clic primario) no pueda iniciar una
        // grabación mientras convertimos o transcribimos. La conversión
        // puede tardar un rato en archivos grandes, y cancel() aborta el
        // conversor vía forceExit().
        this._setState(AsrState.Transcribing);

        // ¿Ya está en el formato objetivo? getWavDataOffset valida
        // RIFF/WAVE, PCM, mono, 16 kHz, 16 bits — exactamente lo que
        // produce el grabador.
        let finalPath = srcPath;
        if (getWavDataOffset(srcPath) === null) {
            const destPath = this._newImportedPath(srcPath);
            notify(this._extensionDir, _('Converting audio…'));
            try {
                await this._converter.convert(srcPath, destPath);
            } catch (e) {
                if (e instanceof NoConverterError) {
                    this._setState(AsrState.Idle, {
                        error: _(
                            'No audio converter found. Install ffmpeg, ' +
                                'or use a 16 kHz mono 16-bit WAV.'
                        ),
                    });
                } else {
                    this._setState(AsrState.Idle, {error: this._errMsg(e)});
                }
                return;
            }
            finalPath = destPath;
        }

        const isPaste =
            (this._settings.get_string('output-mode') ?? 'clipboard') ===
            'paste';
        await this._runTranscription(finalPath, isPaste, false);
    }

    /**
     * Worker de transcripción en vivo.
     *
     * Qué hace: repite en bucle hasta que la sesión se cancela o la
     * grabación ha terminado y cada muestra ha sido transcrita. En cada
     * iteración: espera un trozo completo de N segundos (o, una vez
     * terminada la grabación, el resto más corto), lo escribe en un WAV
     * temporal, lo transcribe y transmite el texto hacia afuera.
     *
     * Las ventanas consecutivas se solapan en `overlapSeconds` para que una
     * palabra a caballo entre dos trozos se retranscriba, y el duplicado se
     * elimina con coincidencia de texto aproximada (el ASR no da marcas de
     * tiempo para hacerlo de forma determinista). Con solapamiento 0 las
     * ventanas son contiguas y la deduplicación se salta, igual que en la
     * ruta antigua.
     *
     * Solo este worker toca el transcriptor mientras hay streaming, así que
     * las ejecuciones nunca se solapan entre sí. Cualquier error de
     * transcripción/E-S rechaza la promesa devuelta, que `_stopAndTranscribe`
     * muestra en la interfaz.
     */
    private async _runStream(
        audioPath: string,
        session: StreamSession
    ): Promise<void> {
        const isPaste =
            (this._settings.get_string('output-mode') ?? 'clipboard') ===
            'paste';
        const chunkSamples = Math.max(
            1,
            Math.floor(
                this._settings.get_int(SETTINGS_KEYS.CHUNK_SECONDS) *
                    SAMPLE_RATE
            )
        );
        const overlapSeconds = Math.max(
            0,
            this._settings.get_int(SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS)
        );
        // Conserva al menos 1 s de audio nuevo por trozo para que la
        // ventana siga avanzando incluso con un solapamiento grande sobre
        // un trozo corto.
        const overlapSamples = Math.min(
            overlapSeconds * SAMPLE_RATE,
            chunkSamples - SAMPLE_RATE
        );
        const step = chunkSamples - Math.max(0, overlapSamples);
        // Cuántas palabras del inicio estamos dispuestos a descartar en cada
        // empalme. Escala con el solapamiento para que una retranscripción
        // más larga pueda hacer coincidir frases más largas; 0 desactiva la
        // deduplicación por completo (ruta de ventanas contiguas).
        const maxOverlapWords =
            overlapSamples > 0
                ? Math.max(3, Math.ceil(overlapSeconds * 5 + 2))
                : 0;

        // Los trozos en vivo se escriben junto a la grabación, bajo records/.
        const cacheDir = recordsDir();
        const base = GLib.path_get_basename(audioPath).replace(/\.wav$/i, '');
        let part = 0;
        // Inicio de la ventana actual en muestras; avanza en `step` cada pasada.
        let cursor = 0;
        // Mayor offset de muestra ya entregado al transcriptor. `cursor`
        // puede quedar por detrás (por el solapamiento), así que la
        // terminación se rastrea sobre el tramo cubierto.
        let covered = 0;
        // Transcripción completa (sin recortar) del trozo anterior, usada
        // como referencia de cola para la deduplicación del siguiente empalme.
        let lastFull = '';

        while (!session.cancelled) {
            // El grabador escribe primero el encabezado WAV; se espera a que aparezca.
            if (session.dataOffset === null) {
                session.dataOffset = getWavDataOffset(audioPath);
                if (session.dataOffset === null) {
                    if (session.ended) break; // nunca produjo un encabezado válido
                    await this._sleep(200);
                    continue;
                }
            }

            const available = wavAvailableSamples(
                audioPath,
                session.dataOffset
            );

            let take: number;
            const need = cursor + chunkSamples;
            if (available >= need) {
                take = chunkSamples; // una ventana completa de N segundos está lista
            } else if (session.ended) {
                // La grabación se detuvo: transcribe la cola que todavía no
                // se cubrió (puede ser más corta que una ventana completa, o vacía).
                const tail = available - covered;
                if (tail <= 0) break; // completamente drenado
                take = Math.min(chunkSamples, tail);
            } else {
                await this._sleep(300); // sigue esperando más audio
                continue;
            }

            const outPath = GLib.build_filenamev([
                cacheDir,
                `${base}_live${++part}.wav`,
            ]);
            let piece = '';
            try {
                writeWavChunk(
                    audioPath,
                    session.dataOffset,
                    cursor,
                    take,
                    outPath
                );
                const result = await this._transcriber.transcribe(outPath);
                if (result.cancelled) {
                    session.cancelled = true;
                    break;
                }
                // Descarta marcadores de silencio ("(empty)", "[BLANK_AUDIO]",
                // ...) que el CLI emite para trozos sin habla — típico en la
                // cola final de la grabación — para que no se cuelen en la salida.
                piece = stripPlaceholders(result.text);
            } finally {
                cleanupChunks([outPath]);
            }

            // Avanza más allá de lo que se acaba de leer. `covered` se mueve
            // al final de la ventana; `cursor` avanza en `step`, releyendo
            // la cola de solapamiento.
            covered = cursor + take;
            cursor += step;

            if (!piece) {
                lastFull = ''; // no hay texto contra el cual anclar el siguiente empalme
                continue;
            }

            // Quita el duplicado de solapamiento del inicio de este
            // fragmento (se salta en el primer trozo y siempre que el
            // solapamiento esté apagado). El fragmento completo, sin
            // recortar, es lo que se lleva adelante como cola de referencia.
            const emitted =
                lastFull && maxOverlapWords > 0
                    ? dedupChunkJoin(lastFull, piece, maxOverlapWords)
                    : piece;
            lastFull = piece;
            if (!emitted) continue; // todo el fragmento era solapamiento

            if (isPaste) {
                // Un espacio inicial en cada fragmento salvo el primero
                // evita que las palabras se junten, reflejando la unión con
                // ' ' que se usa para el total. El primer fragmento arranca en
                // minúscula: es texto que continúa donde esté el cursor, no
                // una frase nueva.
                await pasteAtCursor(
                    session.texts.length === 0
                        ? emitted[0].toLowerCase() + emitted.slice(1)
                        : ` ${emitted}`
                );
            } else {
                // Portapapeles progresivo: el total en curso siempre está
                // listo para pegar incluso antes de que la grabación se detenga.
                copyToClipboard(
                    finalizeTranscript([...session.texts, emitted].join(' '))
                );
            }
            session.texts.push(emitted);

            // Mantiene `last-text` sincronizado con el total en curso para
            // que "Copiar texto" siempre refleje la transcripción completa
            // desde el inicio, no solo el trozo más reciente — incluso a
            // mitad de la grabación.
            this._settings.set_string(
                SETTINGS_KEYS.LAST_TEXT,
                finalizeTranscript(session.texts.join(' '))
            );
        }
    }

    /**
     * Si la grabación debe trocearse en vivo mientras se graba (interruptor
     * "Live chunked transcription").
     *
     * El modo en tiempo real queda excluido a propósito: procesa la
     * grabación completa al detenerse mediante el streaming del CLI
     * ({@link _transcribeStreamingProgressive}), no troceando en vivo, así
     * que aquí no debe arrancar el worker de troceo. Requiere además una
     * duración de trozo positiva.
     */
    private _liveChunkingEnabled(): boolean {
        if (this._settings.get_boolean(SETTINGS_KEYS.REALTIME_MODE)) {
            return false;
        }
        return (
            this._settings.get_boolean(SETTINGS_KEYS.CHUNK_ENABLED) &&
            this._settings.get_int(SETTINGS_KEYS.CHUNK_SECONDS) > 0
        );
    }

    /**
     * Si el modelo activo anuncia streaming, para decidir si el modo en
     * tiempo real puede conducir la API `--stream-chunk-ms` del CLI.
     *
     * Un modelo de catálogo lleva la bandera `streaming` explícita; los
     * modelos personalizados (sin id de catálogo) se asumen compatibles y se
     * deja que el CLI decida — si no lo son, fallará con un mensaje claro. Un
     * modelo de catálogo no-streaming devuelve false para que el pegado en
     * tiempo real caiga a la pasada offline en vez de que el CLI rechace la
     * bandera.
     */
    private _activeModelSupportsStreaming(): boolean {
        const modelId =
            this._settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
        if (!modelId) return true;
        const entry = findModel(modelId);
        return entry ? entry.streaming : true;
    }

    /** Promesa que resuelve tras `ms` mediante un timeout del bucle principal de GLib. */
    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // -- funciones auxiliares -------------------------------------------------

    /** Actualiza el estado interno y notifica a la interfaz. */
    private _setState(state: AsrState, ctx?: AsrChangeContext): void {
        this._state = state;
        this._onChange(state, ctx);
    }

    /** Genera la ruta de una nueva grabación bajo records/, con timestamp en microsegundos. */
    private _newAudioPath(): string {
        const dir = recordsDir();
        GLib.mkdir_with_parents(dir, 0o755);
        const stamp = GLib.get_real_time(); // microsegundos desde epoch
        return GLib.build_filenamev([dir, `recording_${stamp}.wav`]);
    }

    /**
     * Ruta de destino para un archivo convertido elegido por el usuario:
     * `records/imported_<nombre-saneado>_<microsegundos>.wav`. El prefijo
     * `imported_` lo mantiene fuera de la expresión regular de poda
     * (`^recording_\d+\.wav$`) para que un archivo que el usuario eligió
     * explícitamente nunca se borre automáticamente. La extensión original
     * se quita del nombre base para que `.mp3`/`.m4a`/... no se filtren en
     * el nombre final.
     */
    private _newImportedPath(srcPath: string): string {
        const dir = recordsDir();
        GLib.mkdir_with_parents(dir, 0o755);
        const base = GLib.path_get_basename(srcPath).replace(/\.[^.]+$/, '');
        // Sanea todo lo que no sea palabra/guion/guion bajo para que el
        // nombre de archivo se mantenga portable y libre de espacios que el
        // argv del conversor dividiría mal.
        const safe = base.replace(/[^\w-]+/g, '_') || 'audio';
        const stamp = GLib.get_real_time();
        return GLib.build_filenamev([dir, `imported_${safe}_${stamp}.wav`]);
    }

    /**
     * Migración única e idempotente: versiones anteriores guardaban las
     * grabaciones WAV directamente en la raíz de la caché
     * (`<cache>/planeasr/*.wav`). Mueve cualquiera de esos archivos sueltos
     * a `<cache>/planeasr/records/` para que la nueva disposición tome
     * efecto sin perder las grabaciones existentes. Seguro de llamar
     * repetidamente — es un no-op una vez que todo ya está bajo records/.
     */
    private _migrateLooseWavs(): void {
        const root = cacheDir();
        const dest = recordsDir();
        const rootFile = Gio.File.new_for_path(root);
        let iter: Gio.FileEnumerator | null;
        try {
            iter = rootFile.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch {
            return; // la raíz de caché aún no existe — nada que migrar
        }
        try {
            GLib.mkdir_with_parents(dest, 0o755);
            let info = iter.next_file(null);
            while (info !== null) {
                const name = info.get_name();
                if (
                    info.get_file_type() === Gio.FileType.REGULAR &&
                    /\.wav$/i.test(name)
                ) {
                    const src = Gio.File.new_for_path(
                        GLib.build_filenamev([root, name])
                    );
                    const dst = Gio.File.new_for_path(
                        GLib.build_filenamev([dest, name])
                    );
                    try {
                        src.move(dst, Gio.FileCopyFlags.NONE, null, null);
                    } catch {
                        // Colisión de nombre o error transitorio: deja el
                        // archivo en su lugar en vez de abortar la grabación.
                    }
                }
                info = iter.next_file(null);
            }
        } finally {
            iter.close(null);
        }
    }

    /**
     * Recorta la carpeta de grabaciones hasta los `keep-records` WAV más
     * recientes, según lo configurado en preferencias. Se llama después de
     * cada transcripción exitosa para que la caché no crezca sin límite.
     */
    private _pruneRecordings(): void {
        const keep = this._settings.get_int(SETTINGS_KEYS.KEEP_RECORDS);
        pruneRecordings(keep);
    }

    /** Extrae un mensaje legible de cualquier error capturado. */
    private _errMsg(e: unknown): string {
        return e instanceof GLib.Error ? e.message : String(e);
    }
}
