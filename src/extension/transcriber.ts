/* transcriber.ts
 *
 * Runs the configured ASR CLI as a `Gio.Subprocess`, captures its stdout and
 * returns the trimmed transcription text. The active process is exposed so the
 * orchestrator can kill it on cancel.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';

import { SETTINGS_KEYS } from '../config/settings.js';
import { getBackend, type BuildArgvOptions } from './asr-backends.js';

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
 * Wrapper around the user-configured transcription binary.
 *
 * A single instance can run one transcription at a time; calling `transcribe`
 * again while busy rejects. Use `forceExit()` to cancel.
 */
export class Transcriber {
    private _settings: Gio.Settings;
    private _proc: Gio.Subprocess | null = null;
    /** Set by `forceExit()` so the async callback can distinguish cancellation. */
    private _wasForced = false;

    constructor(settings: Gio.Settings) {
        this._settings = settings;
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
    transcribe(audioPath: string): Promise<TranscribeResult> {
        if (this._proc) {
            return Promise.reject(new Error('Transcription already running'));
        }

        const opts: BuildArgvOptions = {
            cliPath: this._settings.get_string('cli-path') ?? '',
            modelParams: this._settings.get_string('model-params') ?? '',
            realtime: this._settings.get_boolean('realtime-mode'),
            customTemplate:
                this._settings.get_string('custom-arg-template') ?? '',
            audioPath,
        };

        const argv = getBackend(
            this._settings.get_string('asr-backend') ?? 'transcribe-cli'
        ).buildArgv(opts);

        if (!argv[0]) {
            return Promise.reject(new Error('No CLI binary configured'));
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
                    resolve({ text: '', cancelled: true });
                    return;
                }
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(res);
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
}
