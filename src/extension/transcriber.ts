/* transcriber.ts
 *
 * Ejecuta el CLI de ASR configurado como un `Gio.Subprocess`, captura su
 * stdout y devuelve el texto de transcripción sin espacios sobrantes. El
 * proceso activo se expone para que el orquestador pueda matarlo al cancelar.
 *
 * También resuelve el modelo activo (descarga del catálogo o model-params
 * libre) y las features semánticas del backend (acelerador, idioma, hilos,
 * prompt) a partir de GSettings, mapeándolas a banderas del CLI mediante el
 * backend activo.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    SETTINGS_KEYS,
    normalizeCliMode,
    type Accelerator,
} from '../config/settings.js';
import {
    findModel,
    modelFilePath,
    pickFile,
    resolveModelDir,
} from '../models/catalog.js';
import {
    getBackend,
    type BackendFeatures,
    type BuildArgvOptions,
} from './asr-backends.js';
import {resolveAutoCli} from './cli-resolver.js';
import {ensureModelFlag, extractExtraFlags} from '../util/model-params.js';

/** Resuelto por `Transcriber.transcribe` cuando el proceso termina. */
export interface TranscribeResult {
    /** Texto de transcripción sin espacios sobrantes (puede estar vacío). */
    text: string;
    /** Si la salida fue resultado de una llamada externa a `force_exit()`. */
    cancelled: boolean;
}

/**
 * Extrae la transcripción de una ejecución del CLI.
 *
 * Algunos backends (por ejemplo transcribe-cli) imprimen un reporte legible
 * para humanos donde la transcripción está en una línea `text: <...>`
 * rodeada de diagnósticos como `audio:`, `samples:`, `detected-language:`.
 * Cuando ese marcador está presente, es la fuente autorizada; si no, se
 * devuelve el stdout crudo tal cual, lo que coincide con CLIs que solo
 * emiten la transcripción.
 */
function extractTranscription(stdout: string, stderr: string): string {
    const marker = /^text:[ \t]*(.*)$/m;
    for (const stream of [stdout, stderr]) {
        const m = stream.match(marker);
        if (m) return m[1].trim();
    }
    return stdout.trim();
}

/** Opciones inyectadas a un Transcriber al construirlo. */
export interface TranscriberOptions {
    /** Ruta absoluta a la raíz de la extensión instalada (para búsquedas en el catálogo). */
    extensionDir: string | null;
}

/**
 * Envoltorio alrededor del binario de transcripción configurado por el usuario.
 *
 * Una misma instancia puede ejecutar una transcripción a la vez; llamar a
 * `transcribe` de nuevo mientras ya hay una en curso rechaza la promesa.
 * Usa `forceExit()` para cancelar.
 */
export class Transcriber {
    private _settings: Gio.Settings;
    private _opts: TranscriberOptions;
    private _proc: Gio.Subprocess | null = null;
    /** Lo pone `forceExit()` para que el callback asíncrono pueda distinguir la cancelación. */
    private _wasForced = false;

    constructor(settings: Gio.Settings, opts: TranscriberOptions) {
        this._settings = settings;
        this._opts = opts;
    }

    /**
     * Ejecuta el CLI de ASR sobre `audioPath` y resuelve con su stdout.
     *
     * Qué hace: construye el argv, lanza el subproceso, y en su callback de
     * finalización extrae la transcripción (o rechaza con el detalle de
     * stderr si falló). El `Gio.Subprocess` activo se registra para que
     * quien llama pueda cancelarlo vía `forceExit()`; la cancelación
     * resuelve la promesa con `cancelled: true`.
     */
    async transcribe(audioPath: string): Promise<TranscribeResult> {
        if (this._proc) {
            throw new Error('Transcription already running');
        }

        const opts = await this._buildArgvOptions(audioPath);
        const argv = getBackend(
            this._settings.get_string('asr-backend') ?? 'transcribe-cli'
        ).buildArgv(opts);

        if (!argv[0]) {
            throw new Error('No CLI binary configured');
        }

        return new Promise<TranscribeResult>((resolve, reject) => {
            const proc = new Gio.Subprocess({
                argv,
                flags:
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            this._proc = proc;

            proc.communicate_utf8_async(null, null, (_self, res) => {
                this._proc = null;
                if (this._wasForced) {
                    // Se pidió `force_exit()` antes de que se disparara el callback.
                    resolve({text: '', cancelled: true});
                    return;
                }
                try {
                    const [, stdout, stderr] =
                        proc.communicate_utf8_finish(res);
                    const ok = proc.get_successful();
                    // Volcado de diagnóstico opcional: argv, código de salida
                    // y ambos flujos capturados. Depende de la preferencia
                    // "Debug logging"; se lee con:
                    //   journalctl --user -b /usr/bin/gnome-shell | grep planeasr
                    if (
                        this._settings.get_boolean(SETTINGS_KEYS.DEBUG_LOGGING)
                    ) {
                        console.warn(
                            `[planeasr] argv=${JSON.stringify(argv)} ` +
                                `success=${ok} ` +
                                `exit=${proc.get_exit_status()} ` +
                                `stdout=${JSON.stringify(stdout ?? '')} ` +
                                `stderr=${JSON.stringify(stderr ?? '')}`
                        );
                    }
                    if (!ok) {
                        // Código de salida != 0 (o señal). Los CLI escriben
                        // sus diagnósticos en stderr, así que se incluyen tal
                        // cual — esto es lo que se muestra vía `Main.notify`
                        // en caso de fallo.
                        const detail = (stderr ?? '').trim();
                        throw new Error(
                            detail ||
                                `Child process exited with code ${proc.get_exit_status()}`
                        );
                    }
                    resolve({
                        text: extractTranscription(stdout ?? '', stderr ?? ''),
                        cancelled: false,
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** Mata el subproceso de transcripción en curso, si lo hay. */
    forceExit(): void {
        this._wasForced = true;
        this._proc?.force_exit();
    }

    /**
     * Transcribe `audioPath` en una sola pasada usando la API de streaming
     * del CLI (`--stream-chunk-ms`), entregando el texto de forma progresiva
     * a medida que la librería lo va emitiendo.
     *
     * Qué hace: lanza el CLI con salida forzada a line-buffering (`stdbuf
     * -oL`, cuando está disponible) para que sus líneas `partial="..."`
     * lleguen una a una en vez de bufferizarse hasta el final. Un lector
     * consume stdout continuamente y guarda el último acumulado; un
     * "surtidor" paralelo llama a `onCommit` con solo el fragmento nuevo
     * (los parciales del CLI son append puro), fusionando los intermedios
     * para que un pegado lento no se atrase con cada parcial. Resuelve con
     * el texto final (línea `text:`) una vez que el proceso termina.
     *
     * El `Gio.Subprocess` activo se registra para que `forceExit()` pueda
     * cancelarlo; la cancelación resuelve con `cancelled: true`.
     */
    async transcribeStreaming(
        audioPath: string,
        streamChunkMs: number,
        onCommit: (delta: string) => Promise<void>
    ): Promise<TranscribeResult> {
        if (this._proc) {
            throw new Error('Transcription already running');
        }

        const opts = await this._buildArgvOptions(audioPath, streamChunkMs);
        const backendArgv = getBackend(
            this._settings.get_string('asr-backend') ?? 'transcribe-cli'
        ).buildArgv(opts);

        if (!backendArgv[0]) {
            throw new Error('No CLI binary configured');
        }

        // `stdbuf -oL` fuerza line-buffering en el stdout del CLI para que sus
        // parciales lleguen a medida que se producen; sin él, stdio bufferiza
        // por bloques hacia un pipe y todo el texto llegaría de golpe al
        // final (el pegado dejaría de ser progresivo). Si no está en el PATH,
        // se sigue sin él y el pegado simplemente ocurre al terminar.
        const argv = GLib.find_program_in_path('stdbuf')
            ? ['stdbuf', '-oL', ...backendArgv]
            : backendArgv;

        this._wasForced = false;
        const proc = new Gio.Subprocess({
            argv,
            flags:
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        this._proc = proc;

        const stdout = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe()!,
        });

        // stderr se drena en paralelo desde ya: transcribe-cli vuelca sus
        // logs `[info]` (carga del modelo, dispositivos) por stderr y, si no
        // se consume durante la ejecución, el buffer del pipe (~64 KB) puede
        // llenarse y bloquear al hijo mientras nosotros seguimos leyendo
        // stdout — un deadlock. El texto acumulado solo se usa como detalle
        // de error si el proceso falla.
        const stderrPromise = this._drainUtf8(proc.get_stderr_pipe());

        // Estado compartido entre el lector y el surtidor.
        let latest = ''; // último texto acumulado visto en un parcial
        let finalText = ''; // línea `text:` autoritativa ('' = aún no vista)
        let readerDone = false;

        const partialRe = /partial="(.*)"/;
        const textRe = /^text:[ \t]*(.*)$/;

        // Lector: drena stdout tan rápido como llega, actualizando `latest`.
        const reader = (async () => {
            for (;;) {
                let line: string | null;
                try {
                    line = await this._readLine(stdout);
                } catch {
                    break;
                }
                if (line === null) break; // EOF
                const pm = line.match(partialRe);
                if (pm) {
                    latest = pm[1];
                    continue;
                }
                const tm = line.match(textRe);
                if (tm) finalText = tm[1].trim();
            }
            readerDone = true;
        })();

        // Surtidor: emite el delta acumulado (fusionando intermedios). Como
        // los parciales del CLI son append puro, `latest` siempre extiende lo
        // ya emitido; el guard de prefijo evita retroceder ante un
        // improbable reajuste.
        let committed = '';
        while (
            !this._wasForced &&
            (!readerDone || latest.length > committed.length)
        ) {
            if (latest.length > committed.length && latest.startsWith(committed)) {
                const delta = latest.slice(committed.length);
                committed = latest;
                await onCommit(delta);
            } else if (!readerDone) {
                await this._sleep(50);
            } else {
                break;
            }
        }
        await reader;

        // Sufijo final: la línea `text:` puede añadir puntuación/mayúsculas
        // que el último parcial aún no tenía (p. ej. el punto final). Se pega
        // lo que falte para converger con el texto autoritativo.
        if (
            !this._wasForced &&
            finalText &&
            finalText.startsWith(committed) &&
            finalText.length > committed.length
        ) {
            await onCommit(finalText.slice(committed.length));
            committed = finalText;
        }

        // Espera la terminación del proceso y valida el estado de salida.
        await this._waitAsync(proc);
        this._proc = null;

        if (this._wasForced) {
            return {text: '', cancelled: true};
        }
        if (!proc.get_successful()) {
            const detail = (await stderrPromise).trim();
            if (this._settings.get_boolean(SETTINGS_KEYS.DEBUG_LOGGING)) {
                console.warn(
                    `[planeasr] streaming argv=${JSON.stringify(argv)} ` +
                        `exit=${proc.get_exit_status()} stderr=${JSON.stringify(detail)}`
                );
            }
            throw new Error(
                detail ||
                    `Child process exited with code ${proc.get_exit_status()}`
            );
        }
        return {text: (finalText || latest).trim(), cancelled: false};
    }

    /** Promesa de una línea de stdout (null en EOF). */
    private _readLine(stream: Gio.DataInputStream): Promise<string | null> {
        return new Promise((resolve, reject) => {
            stream.read_line_async(
                GLib.PRIORITY_DEFAULT,
                null,
                (s, res) => {
                    try {
                        const [line] = s!.read_line_finish_utf8(res);
                        resolve(line);
                    } catch (e) {
                        reject(e as object);
                    }
                }
            );
        });
    }

    /** Espera (sin validar el estado) a que el subproceso termine. */
    private _waitAsync(proc: Gio.Subprocess): Promise<void> {
        return new Promise(resolve => {
            proc.wait_async(null, (_self, res) => {
                try {
                    proc.wait_finish(res);
                } catch {
                    // La cancelación por force_exit() cae aquí; no es un fallo.
                }
                resolve();
            });
        });
    }

    /** Lee por completo un flujo de entrada como texto UTF-8. */
    private _drainUtf8(stream: Gio.InputStream | null): Promise<string> {
        if (!stream) return Promise.resolve('');
        return new Promise(resolve => {
            const mem = Gio.MemoryOutputStream.new_resizable();
            mem.splice_async(
                stream,
                Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
                    Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                GLib.PRIORITY_DEFAULT,
                null,
                (m, res) => {
                    try {
                        m!.splice_finish(res);
                        const bytes = mem.steal_as_bytes();
                        resolve(new TextDecoder().decode(bytes.toArray()));
                    } catch {
                        resolve('');
                    }
                }
            );
        });
    }

    /** Promesa que resuelve tras `ms` mediante un timeout del bucle de GLib. */
    private _sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // -- ensamblado del argv ------------------------------------------------

    /**
     * Ensambla las BuildArgvOptions para el backend activo: resuelve la
     * ruta del modelo (descarga del catálogo o parámetros libres), construye
     * el conjunto de features semánticas y resuelve el acelerador/dispositivo.
     */
    private async _buildArgvOptions(
        audioPath: string,
        streamChunkMs?: number
    ): Promise<BuildArgvOptions> {
        const modelParams = await this._resolveModelParams();
        const features = await this._resolveFeatures();
        const extraFlags =
            this._settings.get_string(SETTINGS_KEYS.EXTRA_CLI_FLAGS) ?? '';

        return {
            cliPath: this._resolveCliPath(),
            modelParams,
            extraFlags,
            audioPath,
            streamChunkMs,
            features,
        };
    }

    /**
     * Resuelve la ruta del binario del CLI según `cli-mode`.
     *
     * Qué hace: en modo 'gpu' usa tal cual la `cli-path` provista por el
     * usuario (por ejemplo, una compilación Vulkan/CUDA). En modo 'cpu' se
     * prefiere el binario solo-CPU incluido con la extensión, recurriendo a
     * un `transcribe-cli` encontrado en el PATH. Los valores heredados
     * 'auto'/'manual' se migran mediante {@link normalizeCliMode}.
     */
    private _resolveCliPath(): string {
        const raw = this._settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu';
        const mode = normalizeCliMode(raw);
        if (mode === 'gpu') {
            return this._settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
        }
        const backendId =
            this._settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ??
            'transcribe-cli';
        const pathName = getBackend(backendId).defaultCliName;
        return resolveAutoCli(this._opts.extensionDir, pathName).path;
    }

    /**
     * Resuelve los parámetros de modelo efectivos.
     *
     * Qué hace: cuando hay un modelo del catálogo activo y su archivo está
     * en disco, inyecta `-m <ruta>` e ignora el `model-params` libre (que
     * pertenece al modo "ruta de modelo personalizada" y de otro modo
     * filtraría una ruta obsoleta como argumento posicional suelto). Solo se
     * conservan los tokens de bandera extra que el usuario añadió después de
     * un modelo de catálogo.
     *
     * Sin un modelo de catálogo, recurre al `model-params` libre: si no trae
     * ya un token `-m`/`--model`, el valor se trata como una ruta de modelo
     * pelada y se le inyecta `-m` automáticamente.
     */
    private async _resolveModelParams(): Promise<string> {
        const userParams = this._settings.get_string('model-params') ?? '';
        const modelId = this._settings.get_string('active-model-id') ?? '';
        if (!modelId || !this._opts.extensionDir) {
            return ensureModelFlag(userParams);
        }

        const entry = findModel(this._opts.extensionDir, modelId);
        if (!entry) return ensureModelFlag(userParams);

        const quant = this._settings.get_string('quant-preference') ?? '';
        const file = pickFile(entry, quant);
        if (!file) return ensureModelFlag(userParams);

        const modelDir = resolveModelDir(
            this._settings.get_string('model-dir') ?? ''
        );
        const path = modelFilePath(modelDir, file);
        if (!Gio.File.new_for_path(path).query_exists(null)) {
            return ensureModelFlag(userParams);
        }

        // Inyecta la ruta del modelo del catálogo. El `model-params` libre
        // pertenece al modo "ruta de modelo personalizada" y NO se añade
        // aquí: hacerlo filtraría una ruta pelada obsoleta (por ejemplo, un
        // modelo Qwen seleccionado previamente) como un segundo argumento
        // posicional y haría que el CLI rechace la ejecución con "multiple
        // positional arguments". Solo se respetan los tokens de bandera
        // extra explícitos (los que empiezan con '-') tras una selección de catálogo.
        const extraFlags = extractExtraFlags(userParams);
        return extraFlags ? `-m ${path} ${extraFlags}` : `-m ${path}`;
    }

    /**
     * Construye el conjunto de features semánticas a partir de la
     * configuración.
     */
    private async _resolveFeatures(): Promise<BackendFeatures> {
        const accelerator = (this._settings.get_string(
            SETTINGS_KEYS.ACCELERATOR
        ) ?? 'auto') as Accelerator;
        // En modo tiempo real se ignora el idioma elegido y se deja en
        // 'auto' (sin bandera --language). Motivo: los modelos de streaming
        // (p. ej. nemotron) anuncian sus idiomas en formato BCP-47
        // ('es-ES', 'es-US') mientras que el desplegable envía el código
        // corto ISO ('es'); el CLI rechaza ese código con "unsupported
        // language" y aborta la ejecución. La autodetección funciona de
        // forma fiable en estos modelos, así que el modo en vivo la usa
        // siempre para no fallar.
        const realtime = this._settings.get_boolean(
            SETTINGS_KEYS.REALTIME_MODE
        );
        const language = realtime
            ? 'auto'
            : this._settings.get_string(SETTINGS_KEYS.SELECTED_LANGUAGE);
        const threads = this._settings.get_int(SETTINGS_KEYS.CPU_THREADS);

        const gpuDevice = this._resolveGpuDevice();
        return {
            accelerator,
            gpuDevice,
            language: language || 'auto',
            translate: this._settings.get_boolean(
                SETTINGS_KEYS.TRANSLATE_TO_ENGLISH
            ),
            threads,
            initialPrompt:
                this._settings.get_string(SETTINGS_KEYS.INITIAL_PROMPT) ?? '',
        };
    }

    /**
     * Resuelve el índice de dispositivo GPU para la ejecución activa.
     *
     * El desplegable de preferencias lista los dispositivos reales que el
     * CLI expone vía `--list-devices`, así que el valor `gpu-device`
     * guardado ya coincide con el registro propio del CLI. -1 significa "sin
     * bandera de dispositivo" (deja que el CLI elija el dispositivo 0);
     * cualquier valor >= 0 se reenvía como `--device N`. Deliberadamente no
     * hay auto-detección vía `vulkaninfo`: sus índices no coinciden con el
     * registro del CLI en compilaciones CUDA.
     */
    private _resolveGpuDevice(): number {
        return this._settings.get_int(SETTINGS_KEYS.GPU_DEVICE);
    }
}
