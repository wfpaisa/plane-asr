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

    // -- ensamblado del argv ------------------------------------------------

    /**
     * Ensambla las BuildArgvOptions para el backend activo: resuelve la
     * ruta del modelo (descarga del catálogo o parámetros libres), construye
     * el conjunto de features semánticas y resuelve el acelerador/dispositivo.
     */
    private async _buildArgvOptions(
        audioPath: string
    ): Promise<BuildArgvOptions> {
        const modelParams = await this._resolveModelParams();
        const features = await this._resolveFeatures();
        const realtime = this._settings.get_boolean('realtime-mode');
        const extraFlags =
            this._settings.get_string(SETTINGS_KEYS.EXTRA_CLI_FLAGS) ?? '';

        return {
            cliPath: this._resolveCliPath(),
            modelParams,
            realtime,
            extraFlags,
            audioPath,
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
        const language = this._settings.get_string(
            SETTINGS_KEYS.SELECTED_LANGUAGE
        );
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
