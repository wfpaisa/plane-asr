/* transcriber.ts
 *
 * Runs the configured ASR CLI as a `Gio.Subprocess`, captures its stdout and
 * returns the trimmed transcription text. The active process is exposed so the
 * orchestrator can kill it on cancel.
 *
 * It also resolves the active model (catalog download or free-form model-params)
 * and the semantic backend features (accelerator, language, threads, VAD,
 * prompt) from GSettings, mapping them to CLI flags via the active backend.
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
    parseArgs,
    type BackendFeatures,
    type BuildArgvOptions,
} from './asr-backends.js';
import {resolveAutoCli} from './cli-resolver.js';
import type {GpuDetector} from './gpu-detector.js';

/** Resolved by `Transcriber.transcribe` when the process exits. */
export interface TranscribeResult {
    /** Trimmed transcription text (may be empty). */
    text: string;
    /** The exit was the result of an external `force_exit()` call. */
    cancelled: boolean;
}

/**
 * Extract the transcription from a CLI run.
 *
 * Some backends (e.g. transcribe-cli) print a human-readable report where the
 * transcription sits on a `text: <...>` line surrounded by diagnostics such as
 * `audio:`, `samples:`, `detected-language:`. When that marker is present it is
 * authoritative; otherwise the raw stdout is returned verbatim, which matches
 * CLIs that emit only the transcription.
 */
function extractTranscription(stdout: string, stderr: string): string {
    const marker = /^text:[ \t]*(.*)$/m;
    for (const stream of [stdout, stderr]) {
        const m = stream.match(marker);
        if (m) return m[1].trim();
    }
    return stdout.trim();
}

/**
 * Ensure a free-form `model-params` string carries a `-m`/`--model` flag.
 *
 * When the user configures a custom model path in the UI without typing the
 * flag, treat the whole value as a bare model path and prepend `-m`. If the
 * params already contain the flag, or are empty, they are returned unchanged.
 * Any leading non-flag tokens before a real flag are left as-is (rare; the UI
 * is documented to hold a single path or full args).
 */
function ensureModelFlag(params: string): string {
    const trimmed = params.trim();
    if (!trimmed) return params;
    const toks = parseArgs(trimmed);
    if (toks.some(t => t === '-m' || t === '--model')) return params;
    // Bare path: prepend -m. Split off any trailing flags the user may have
    // added after the path (e.g. "/path/to.gguf --foo bar").
    const firstFlagIdx = toks.findIndex(t => t.startsWith('-'));
    if (firstFlagIdx <= 0) {
        // No flags, or the first token is itself a flag — treat the whole thing
        // as the path when it doesn't start with '-'.
        if (firstFlagIdx === -1) {
            return `-m ${trimmed}`;
        }
        return params;
    }
    const pathPart = toks.slice(0, firstFlagIdx).join(' ');
    const rest = toks.slice(firstFlagIdx).join(' ');
    return `-m ${pathPart} ${rest}`;
}

/**
 * Pull the leading extra-flag tokens (those starting with `-`) out of a
 * free-form params string, discarding any bare positional path that precedes
 * them. Used when a catalog model is active: its own `-m <path>` is injected
 * separately, so only the user's extra flags (e.g. `--verbose`) survive.
 *
 * Tokens that follow a flag expecting a value (e.g. the path after `-m`) are
 * not specially handled — the "Custom model path" mode is the documented way
 * to supply a model, so a catalog user's extra params are expected to be plain
 * flags or `flag value` pairs where the value does not look like a stray path.
 */
function extractExtraFlags(params: string): string {
    const trimmed = params.trim();
    if (!trimmed) return '';
    const toks = parseArgs(trimmed);
    // Keep only tokens from the first flag onward, dropping any bare path that
    // leads the string (the custom-mode model path).
    const firstFlagIdx = toks.findIndex(t => t.startsWith('-'));
    if (firstFlagIdx <= 0) return ''; // no flags, or params are just a path
    return toks.slice(firstFlagIdx).join(' ');
}

/** Options injected into a Transcriber at construction time. */
export interface TranscriberOptions {
    /** Absolute path to the installed extension root (for catalog lookups). */
    extensionDir: string | null;
    /** Vulkan GPU detector used to resolve the 'auto' accelerator. */
    gpuDetector: GpuDetector | null;
}

/**
 * Wrapper around the user-configured transcription binary.
 *
 * A single instance can run one transcription at a time; calling `transcribe`
 * again while busy rejects. Use `forceExit()` to cancel.
 */
export class Transcriber {
    private _settings: Gio.Settings;
    private _opts: TranscriberOptions;
    private _proc: Gio.Subprocess | null = null;
    /** Set by `forceExit()` so the async callback can distinguish cancellation. */
    private _wasForced = false;

    constructor(settings: Gio.Settings, opts: TranscriberOptions) {
        this._settings = settings;
        this._opts = opts;
    }

    /** True while a transcription subprocess is running. */
    isRunning(): boolean {
        return this._proc !== null;
    }

    /**
     * Run the ASR CLI on `audioPath` and resolve with its stdout.
     *
     * The active `Gio.Subprocess` is tracked so the caller can cancel it via
     * `forceExit()`; cancellation resolves the promise with `cancelled: true`.
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
                    // `force_exit()` was requested before the callback fired.
                    resolve({text: '', cancelled: true});
                    return;
                }
                try {
                    const [, stdout, stderr] =
                        proc.communicate_utf8_finish(res);
                    const ok = proc.get_successful();
                    // Optional diagnostic dump: argv, exit status and both
                    // captured streams. Gated behind the "Debug logging"
                    // preference; read it with:
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
                        // Exit code != 0 (or signal). The CLIs write their
                        // diagnostics to stderr, so include it verbatim — this
                        // is what surfaces via `Main.notify` on failure.
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

    /** Kill the running transcription subprocess, if any. */
    forceExit(): void {
        this._wasForced = true;
        this._proc?.force_exit();
    }

    // -- argv assembly ----------------------------------------------------

    /**
     * Assemble the BuildArgvOptions for the active backend: resolve the model
     * path (catalog download or free-form params), build the semantic feature
     * bundle and resolve the accelerator/device.
     */
    private async _buildArgvOptions(
        audioPath: string
    ): Promise<BuildArgvOptions> {
        const modelParams = await this._resolveModelParams();
        const features = await this._resolveFeatures();
        const realtime = this._settings.get_boolean('realtime-mode');
        const customTemplate =
            this._settings.get_string('custom-arg-template') ?? '';
        const extraFlags =
            this._settings.get_string(SETTINGS_KEYS.EXTRA_CLI_FLAGS) ?? '';

        return {
            cliPath: this._resolveCliPath(),
            modelParams,
            realtime,
            customTemplate,
            extraFlags,
            audioPath,
            features,
        };
    }

    /**
     * Resolve the CLI binary path according to `cli-mode`. In 'gpu' mode the
     * user-provided `cli-path` is used verbatim (e.g. a Vulkan/CUDA build). In
     * 'cpu' mode the CPU-only binary bundled with the extension is preferred,
     * falling back to a `transcribe-cli` discovered on PATH. Legacy 'auto' /
     * 'manual' values are migrated via {@link normalizeCliMode}.
     */
    private _resolveCliPath(): string {
        const raw = this._settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu';
        const mode = normalizeCliMode(raw);
        if (mode === 'gpu') {
            return this._settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
        }
        const backendId =
            this._settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ?? 'transcribe-cli';
        const pathName = getBackend(backendId).defaultCliName;
        return resolveAutoCli(this._opts.extensionDir, pathName).path;
    }

    /**
     * Resolve the effective model params. When a catalog model is active and
     * its file is on disk, inject `-m <path>` and ignore the free-form
     * `model-params` (which belongs to the "Custom model path" mode and would
     * otherwise leak a stale path as a stray positional argument). Only extra
     * flag tokens the user appended after a catalog model are kept.
     *
     * Without a catalog model, fall back to the free-form `model-params`: if it
     * does not already carry a `-m`/`--model` token, the value is treated as a
     * bare model path and `-m` is injected automatically.
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

        // Inject the catalog model path. The free-form `model-params` belongs
        // to the "Custom model path" mode and is NOT appended here: doing so
        // would leak a stale bare path (e.g. a previously-selected Qwen model)
        // as a second positional argument and make the CLI reject the run with
        // "multiple positional arguments". Only explicit extra flag tokens
        // (those starting with '-') after a catalog selection are honored.
        const extraFlags = extractExtraFlags(userParams);
        return extraFlags ? `-m ${path} ${extraFlags}` : `-m ${path}`;
    }

    /**
     * Build the semantic feature bundle from settings, resolving the 'auto'
     * accelerator against the GPU detector when enabled.
     */
    private async _resolveFeatures(): Promise<BackendFeatures> {
        const accelerator = (this._settings.get_string(
            SETTINGS_KEYS.ACCELERATOR
        ) ?? 'auto') as Accelerator;
        const language = this._settings.get_string(
            SETTINGS_KEYS.SELECTED_LANGUAGE
        );
        const threads = this._settings.get_int(SETTINGS_KEYS.CPU_THREADS);

        const gpuDevice = await this._resolveGpuDevice();
        return {
            accelerator,
            gpuDevice,
            language: language || 'auto',
            translate: this._settings.get_boolean(
                SETTINGS_KEYS.TRANSLATE_TO_ENGLISH
            ),
            threads,
            vad: this._settings.get_boolean(SETTINGS_KEYS.VAD_ENABLED),
            initialPrompt:
                this._settings.get_string(SETTINGS_KEYS.INITIAL_PROMPT) ?? '',
        };
    }

    /**
     * Resolve the GPU device index for the active run.
     *
     * The preferences dropdown now lists the real devices the CLI exposes via
     * `--list-devices`, so the stored `gpu-device` value already matches the
     * CLI's own registry. -1 means "no device flag" (let the CLI pick device
     * 0); any value >= 0 is forwarded as `--device N`. The previous Vulkan
     * auto-detection path is intentionally dropped: it used `vulkaninfo`
     * indices that do not match the CLI registry on CUDA builds.
     */
    private async _resolveGpuDevice(): Promise<number> {
        return this._settings.get_int(SETTINGS_KEYS.GPU_DEVICE);
    }
}
