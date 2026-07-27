/* device-parse.ts
 *
 * Pure parser for the textual output of `<cli> --list-devices`. No GNOME/GJS
 * imports, so it can be unit-tested in plain Node; the subprocess that produces
 * the text lives in extension/device-lister.ts.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

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
