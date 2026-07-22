/* recorder.ts
 *
 * WAV recorder built on top of PipeWire (`pw-record`) or PulseAudio
 * (`parecord`), whichever is on PATH. Both are launched with the exact format
 * the ASR CLIs expect (16 kHz, mono, signed 16-bit little-endian), so no
 * `ffmpeg` conversion step is needed.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** SIGINT, used to ask pw-record/parecord to close the WAV cleanly. */
const SIGINT = 2;

/**
 * Capture audio to a WAV file using the first available backend.
 *
 * The recorder owns a single `Gio.Subprocess` at a time; `start()` throws if
 * called while already recording, and `stop()` resolves once the underlying
 * process has terminated.
 */
export class Recorder {
    private _proc: Gio.Subprocess | null = null;

    /** True while a capture process is running. */
    isRecording(): boolean {
        return this._proc !== null;
    }

    /**
     * Start capturing to `outputPath`. Throws if no backend is available or if
     * a recording is already in progress.
     */
    start(outputPath: string): void {
        if (this._proc) {
            throw new Error(_('A recording is already in progress'));
        }

        const argv = this._buildArgv(outputPath);
        const proc = new Gio.Subprocess({
            argv,
            flags: Gio.SubprocessFlags.NONE,
        });
        proc.init(null);
        this._proc = proc;
    }

    /**
     * Stop the current recording and resolve once the WAV has been finalized.
     * Safe to call when idle (resolves immediately).
     */
    stop(): Promise<void> {
        const proc = this._proc;
        this._proc = null;
        if (!proc) return Promise.resolve();

        // SIGINT lets pw-record/parecord flush and close the WAV header.
        try {
            proc.send_signal(SIGINT);
        } catch {
            // If signaling fails we still want to await termination.
        }

        return new Promise((resolve, reject) => {
            proc.wait_check_async(null, (_self, res) => {
                try {
                    proc.wait_check_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** Build the backend-specific argv for the given output path. */
    private _buildArgv(outputPath: string): string[] {
        if (GLib.find_program_in_path('pw-record')) {
            return [
                'pw-record',
                '--rate',
                '16000',
                '--channels',
                '1',
                '--format',
                's16',
                outputPath,
            ];
        }

        if (GLib.find_program_in_path('parecord')) {
            return [
                'parecord',
                '--rate=16000',
                '--channels=1',
                '--format=s16le',
                '--file-format=wav',
                outputPath,
            ];
        }

        throw new Error(_('Neither pw-record nor parecord was found in PATH'));
    }
}
