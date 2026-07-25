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

import {SETTINGS_KEYS, type Accelerator} from '../config/settings.js';
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

        return {
            cliPath: this._resolveCliPath(),
            modelParams,
            realtime,
            customTemplate,
            audioPath,
            features,
        };
    }

    /**
     * Resolve the CLI binary path according to `cli-mode`. In 'manual' mode the
     * user-provided `cli-path` is used verbatim (e.g. a Vulkan/CUDA build). In
     * 'auto' mode the CPU-only binary bundled with the extension is preferred,
     * falling back to a `transcribe-cli` discovered on PATH.
     */
    private _resolveCliPath(): string {
        const mode = this._settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'auto';
        if (mode === 'manual') {
            return this._settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
        }
        const backendId =
            this._settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ?? 'transcribe-cli';
        const pathName = getBackend(backendId).defaultCliName;
        return resolveAutoCli(this._opts.extensionDir, pathName).path;
    }

    /**
     * Resolve the effective model params. When a catalog model is active and
     * its file is on disk, inject `-m <path>` ahead of any user extra params.
     * Otherwise fall back to the free-form `model-params` setting (legacy).
     */
    private async _resolveModelParams(): Promise<string> {
        const userParams = this._settings.get_string('model-params') ?? '';
        const modelId = this._settings.get_string('active-model-id') ?? '';
        if (!modelId || !this._opts.extensionDir) return userParams;

        const entry = findModel(this._opts.extensionDir, modelId);
        if (!entry) return userParams;

        const quant = this._settings.get_string('quant-preference') ?? '';
        const file = pickFile(entry, quant);
        if (!file) return userParams;

        const modelDir = resolveModelDir(
            this._settings.get_string('model-dir') ?? ''
        );
        const path = modelFilePath(modelDir, file);
        if (!Gio.File.new_for_path(path).query_exists(null)) return userParams;

        // Prepend the model path. Existing user params (e.g. extra flags) are
        // preserved and appended after.
        const injected = `-m ${path}`;
        return userParams.trim() ? `${injected} ${userParams}` : injected;
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

        const gpuDevice = await this._resolveGpuDevice(accelerator);
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
     * Resolve the GPU device index for the chosen accelerator. For 'auto' with
     * auto-detection enabled, probe Vulkan and use the optimal device; if none
     * is found, fall back to CPU semantics (gpuDevice stays -1, accelerator
     * stays 'auto' so the CLI picks its default).
     */
    private async _resolveGpuDevice(accelerator: Accelerator): Promise<number> {
        const explicit = this._settings.get_int(SETTINGS_KEYS.GPU_DEVICE);
        if (accelerator !== 'auto') {
            return explicit; // honor user choice for cpu/vulkan
        }
        if (!this._settings.get_boolean(SETTINGS_KEYS.AUTO_DETECT_GPU)) {
            return explicit;
        }
        if (!this._opts.gpuDetector) return explicit;
        try {
            const gpus = await this._opts.gpuDetector.detect();
            if (gpus.length === 0) return explicit;
            return this._opts.gpuDetector.pickOptimal();
        } catch {
            return explicit;
        }
    }
}
