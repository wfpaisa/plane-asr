/* gpu-detector.ts
 *
 * Detects Vulkan-capable GPUs by shelling out to `vulkaninfo` (vulkan-tools).
 * Used by the transcriber to choose a backend/device and by the preferences UI
 * to show the user what was detected.
 *
 * Detection is best-effort: if `vulkaninfo` is missing or fails, the detector
 * reports no GPUs and the caller falls back to CPU.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Vulkan device type as reported by vulkaninfo. */
export type GpuKind = 'discrete' | 'integrated' | 'virtual' | 'cpu' | 'unknown';

/** A detected Vulkan GPU. */
export interface GpuInfo {
    /** Registry index (0-based) as exposed by vulkaninfo GPU headers. */
    index: number;
    name: string;
    kind: GpuKind;
    /** Total device-local memory (VRAM) in bytes, or 0 if unknown. */
    vramBytes: number;
}

const VULKANINFO_BIN = 'vulkaninfo';

/**
 * Cacheable Vulkan GPU detector. The probe spawns `vulkaninfo` which takes a
 * few hundred ms, so callers should reuse the result via {@link detect}.
 */
export class GpuDetector {
    private _cache: GpuInfo[] | null = null;

    /** Forget the cached detection (forces a re-probe on next {@link detect}). */
    invalidate(): void {
        this._cache = null;
    }

    /**
     * Detect Vulkan GPUs. Returns an empty array when `vulkaninfo` is not on
     * PATH or fails. The result is cached for the process lifetime unless
     * {@link invalidate} is called.
     */
    async detect(): Promise<GpuInfo[]> {
        if (this._cache) return this._cache;

        if (!GLib.find_program_in_path(VULKANINFO_BIN)) {
            this._cache = [];
            return this._cache;
        }

        // vulkaninfo --summary gives deviceName/deviceType per GPU but no VRAM.
        const summary = await runCapture([VULKANINFO_BIN, '--summary']);
        if (!summary) {
            this._cache = [];
            return this._cache;
        }
        const devices = parseSummary(summary);

        // Enrich with VRAM from the JSON dump when available.
        const json = await runCapture([VULKANINFO_BIN, '-j']);
        if (json) mergeVramFromJson(devices, json);

        this._cache = devices;
        return this._cache;
    }

    /**
     * Pick the optimal device index (preferring discrete GPUs with the most
     * VRAM). Returns -1 when no usable GPU was found.
     */
    pickOptimal(): number {
        if (!this._cache || this._cache.length === 0) return -1;
        const gpus = [...this._cache].sort((a, b) => {
            // discrete first, then integrated, then anything else.
            const score = (g: GpuInfo) =>
                g.kind === 'discrete' ? 2 : g.kind === 'integrated' ? 1 : 0;
            const d = score(b) - score(a);
            if (d !== 0) return d;
            return b.vramBytes - a.vramBytes;
        });
        const best = gpus[0];
        return best.kind === 'cpu' ? -1 : best.index;
    }
}

/**
 * Parse `vulkaninfo --summary` output into device descriptors. Only the device
 * blocks (`GPU0:` ... `GPU1:` ...) are inspected.
 */
export function parseSummary(text: string): GpuInfo[] {
    const out: GpuInfo[] = [];
    const lines = text.split('\n');
    let current: GpuInfo | null = null;

    for (const raw of lines) {
        const line = raw.trim();
        const header = line.match(/^GPU(\d+):/i);
        if (header) {
            if (current) out.push(current);
            current = {
                index: parseInt(header[1], 10),
                name: '',
                kind: 'unknown',
                vramBytes: 0,
            };
            continue;
        }
        if (!current) continue;

        const name = line.match(/^deviceName\s*=\s*(.+)$/i);
        if (name) {
            current.name = name[1].trim();
            continue;
        }
        const type = line.match(/^deviceType\s*=\s*(\S+)/i);
        if (type) {
            current.kind = mapKind(type[1]);
        }
    }
    if (current) out.push(current);
    return out.filter(g => g.name.length > 0);
}

/** Map a vulkaninfo `deviceType` token to our kind enum. */
function mapKind(token: string): GpuKind {
    const t = token.toUpperCase();
    if (t.includes('DISCRETE')) return 'discrete';
    if (t.includes('INTEGRATED')) return 'integrated';
    if (t.includes('VIRTUAL')) return 'virtual';
    if (t.includes('CPU')) return 'cpu';
    return 'unknown';
}

/**
 * Merge VRAM totals from `vulkaninfo -j` (JSON) into already-parsed devices by
 * index. The JSON nests `memoryHeaps[]` where a heap flagged
 * `DEVICE_LOCAL_BIT` is device memory (VRAM).
 */
export function mergeVramFromJson(devices: GpuInfo[], json: string): void {
    try {
        const doc = JSON.parse(json) as VulkanJsonDoc;
        const arr = doc?.VkPhysicalDeviceProperties2
            ? Object.values(doc.VkPhysicalDeviceProperties2)
            : [];
        for (let i = 0; i < arr.length && i < devices.length; i++) {
            const heaps = arr[i]?.memoryProperties?.memoryHeaps;
            if (!Array.isArray(heaps)) continue;
            let vram = 0;
            for (const h of heaps) {
                const flags: string = h.flags ?? '';
                if (flags.includes('DEVICE_LOCAL_BIT')) {
                    vram += h.size ?? 0;
                }
            }
            if (vram > 0) devices[i].vramBytes = vram;
        }
    } catch {
        // JSON shape varies across vulkaninfo versions; ignore failures.
    }
}

interface VulkanJsonMemoryHeap {
    size?: number;
    flags?: string;
}
interface VulkanJsonDevice {
    memoryProperties?: {memoryHeaps?: VulkanJsonMemoryHeap[]};
}
interface VulkanJsonDoc {
    VkPhysicalDeviceProperties2?: Record<string, VulkanJsonDevice>;
}

/**
 * Run `argv` and capture stdout as a string. Returns null when the binary is
 * missing or exits non-zero. Runs synchronously-on-the-thread via
 * `communicate_utf8` (the probe is short-lived and only happens once).
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

/** Human-readable VRAM label, e.g. "12 GB" or "8192 MB". */
export function formatVram(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    if (bytes >= 1024 * 1024 * 1024) {
        return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
    }
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}
