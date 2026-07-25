/* audio-converter.ts
 *
 * Converts an arbitrary audio file into the 16 kHz mono s16le PCM WAV the ASR
 * backend expects, mirroring what the {@link Recorder} captures live. Used by
 * `AsrService.transcribeFile` for user-picked files that are not already in the
 * target format (see {@link getWavDataOffset} for the validation).
 *
 * Probes `ffmpeg` first (best format coverage) and falls back to
 * `gst-launch-1.0`, which ships with GNOME Shell and is virtually always
 * present. When neither is on PATH, {@link convert} rejects with
 * {@link NoConverterError} so the caller can surface a clear "format required"
 * warning instead of a generic failure.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Resolved when no conversion backend is available on PATH. */
export class NoConverterError extends Error {
    constructor(
        message = 'No audio converter (ffmpeg or gst-launch-1.0) found in PATH'
    ) {
        super(message);
        this.name = 'NoConverterError';
    }
}

/** Resolve the first available converter binary, or null when none is present. */
function resolveConverterBin(): string | null {
    return (
        GLib.find_program_in_path('ffmpeg') ??
        GLib.find_program_in_path('gst-launch-1.0') ??
        null
    );
}

/**
 * Build the converter argv for the given binary.
 *
 * - `ffmpeg`: `-y` overwrites the destination, `-loglevel error` keeps stderr
 *   to genuine diagnostics, then the canonical resample/mixdown flags.
 * - `gst-launch-1.0`: a decodebin pipeline that resamples to 16 kHz, mixes to
 *   mono, formats to S16LE and wraps in a WAV container. `decodebin` auto-
 *   selects the demuxer/decoder from installed GStreamer plugins.
 */
function buildArgv(bin: string, srcPath: string, destPath: string): string[] {
    if (bin.endsWith('ffmpeg')) {
        return [
            bin,
            '-y',
            '-loglevel',
            'error',
            '-i',
            srcPath,
            '-ar',
            '16000',
            '-ac',
            '1',
            '-sample_fmt',
            's16',
            destPath,
        ];
    }
    // gst-launch-1.0 pipeline (bin === 'gst-launch-1.0').
    return [
        bin,
        'filesrc',
        `location=${srcPath}`,
        '!',
        'decodebin',
        '!',
        'audioconvert',
        '!',
        'audioresample',
        '!',
        'audio/x-raw,rate=16000,channels=1,format=S16LE',
        '!',
        'wavenc',
        '!',
        'filesink',
        `location=${destPath}`,
    ];
}

/**
 * One-shot audio converter. A single instance runs one conversion at a time;
 * `convert` rejects if called while busy. Use {@link forceExit} to cancel.
 *
 * Mirrors the lifecycle of {@link Transcriber} so the orchestrator can stop a
 * conversion in flight alongside a recording/transcription.
 */
export class AudioConverter {
    private _proc: Gio.Subprocess | null = null;

    /** True while a conversion subprocess is running. */
    isRunning(): boolean {
        return this._proc !== null;
    }

    /**
     * Convert `srcPath` to a 16 kHz mono s16le WAV at `destPath`. Resolves on
     * success; rejects with {@link NoConverterError} when no backend is on PATH
     * (so the caller can show the format-required warning), or with the
     * converter's stderr on any other failure.
     */
    convert(srcPath: string, destPath: string): Promise<void> {
        if (this._proc) {
            return Promise.reject(new Error('Conversion already running'));
        }

        const bin = resolveConverterBin();
        if (!bin) {
            return Promise.reject(new NoConverterError());
        }

        const argv = buildArgv(bin, srcPath, destPath);
        return new Promise<void>((resolve, reject) => {
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
                try {
                    const [, , stderr] = proc.communicate_utf8_finish(res);
                    if (!proc.get_successful()) {
                        // The converter writes its diagnostics to stderr, so
                        // surface them verbatim — this is what the user sees via
                        // Main.notify on failure.
                        const detail = (stderr ?? '').trim();
                        throw new Error(
                            detail ||
                                `${bin} exited with code ${proc.get_exit_status()}`
                        );
                    }
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** Kill the running conversion subprocess, if any. */
    forceExit(): void {
        this._proc?.force_exit();
    }
}
