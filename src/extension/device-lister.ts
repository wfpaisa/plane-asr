/* device-lister.ts
 *
 * Lists the compute devices a transcription CLI exposes via its
 * `--list-devices` flag. Unlike the Vulkan-based `GpuDetector`, the indices
 * reported here are the *same* ones `--device N` (transcribe-cli) interprets,
 * so the prefs dropdown can present the user with the exact device a selection
 * maps to — including CUDA builds where the CLI's internal registry order
 * differs from `vulkaninfo`.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';

/** A compute device as reported by the CLI's `--list-devices`. */
export interface DeviceInfo {
    /** Registry index the CLI uses for `--device N` (0-based). */
    index: number;
    /** Human-readable device name. */
    name: string;
    /** Backend kind string emitted by the CLI (cuda, vulkan, cpu, ...). */
    kind: string;
    /** Total memory label as printed by the CLI (e.g. "15.51 GiB"), or ''. */
    vramLabel: string;
}

/**
 * Parse the textual output of `<cli> --list-devices`.
 *
 * Expected layout (transcribe.cpp):
 * ```
 * 3 compute device(s):
 *   [0] NVIDIA GeForce RTX 5070 Ti
 *       name=CUDA0  kind=cuda  type=gpu  id=0000:01:00.0
 *       memory: 15.51 GiB total, 15.22 GiB free
 *   [1] ...
 * ```
 * Lines that don't match a device header or its detail lines (e.g. the
 * `[info] ggml_cuda_init: ...` logs CUDA emits on startup) are ignored.
 */
export function parseListDevices(text: string): DeviceInfo[] {
    const out: DeviceInfo[] = [];
    let current: DeviceInfo | null = null;

    const flush = () => {
        if (current) {
            out.push(current);
            current = null;
        }
    };

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;

        // Device header: "[0] Name".
        const header = line.match(/^\[(\d+)\]\s*(.+)$/);
        if (header) {
            flush();
            current = {
                index: parseInt(header[1], 10),
                name: header[2].trim(),
                kind: '',
                vramLabel: '',
            };
            continue;
        }
        if (!current) continue;

        // Detail line: "name=CUDA0  kind=cuda  type=gpu  id=...".
        const kind = line.match(/\bkind=(\S+)/);
        if (kind) {
            current.kind = kind[1];
            continue;
        }
        // Memory line: "memory: 15.51 GiB total, 15.22 GiB free".
        const mem = line.match(/memory:\s*([0-9.]+\s*\S+)\s*total/i);
        if (mem) {
            current.vramLabel = mem[1].trim();
        }
    }
    flush();

    // Drop entries without a name (defensive: malformed blocks).
    return out.filter(d => d.name.length > 0);
}

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
 * missing or exits non-zero. Mirrors the capture helper in `gpu-detector.ts`.
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
