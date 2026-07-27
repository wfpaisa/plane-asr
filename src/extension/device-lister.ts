/* device-lister.ts
 *
 * Lists the compute devices a transcription CLI exposes via its
 * `--list-devices` flag. The indices reported here are the *same* ones
 * `--device N` (transcribe-cli) interprets, so the prefs dropdown can present
 * the user with the exact device a selection maps to — including CUDA builds
 * where the CLI's internal registry order differs from `vulkaninfo`.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';

import {parseListDevices, type DeviceInfo} from '../util/device-parse.js';

export {parseListDevices, type DeviceInfo};

/**
 * Run `<cliPath> --list-devices` and return the parsed devices. Returns an
 * empty array when the binary is missing, exits non-zero, or prints nothing
 * usable — callers fall back to a single "Auto" entry.
 */
export async function listDevices(cliPath: string): Promise<DeviceInfo[]> {
    if (!cliPath) return [];
    const stdout = await runCapture([cliPath, '--list-devices']);
    if (!stdout) return [];
    return parseListDevices(stdout);
}

/**
 * Run `argv` and capture stdout as a string. Returns null when the binary is
 * missing or exits non-zero.
 */
async function runCapture(argv: string[]): Promise<string | null> {
    try {
        const proc = new Gio.Subprocess({
            argv,
            flags:
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        return await new Promise<string | null>(resolve => {
            proc.communicate_utf8_async(null, null, (_self, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    resolve(proc.get_successful() ? (stdout ?? '') : null);
                } catch {
                    resolve(null);
                }
            });
        });
    } catch {
        return null;
    }
}
