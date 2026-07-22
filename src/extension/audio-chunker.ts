/* audio-chunker.ts
 *
 * Helpers to carve N-second chunks out of a 16 kHz mono 16-bit PCM WAV *while it
 * is still being written* by the recorder. This lets long takes be transcribed
 * live, one chunk at a time, so backends with a per-call generation cap (e.g.
 * Qwen3-ASR truncating at 256 output tokens) never hit it and the first words
 * are pasted while the user keeps speaking. Side-effect free except for the
 * chunk files it writes.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Expected capture format produced by the `Recorder`. */
export const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** ASCII four-cc helpers. */
function fourCc(code: string): number {
    return (
        code.charCodeAt(0) |
        (code.charCodeAt(1) << 8) |
        (code.charCodeAt(2) << 16) |
        (code.charCodeAt(3) << 24)
    );
}

/** Build a 44-byte canonical RIFF/WAVE header for a 16 kHz mono s16 stream. */
function buildWavHeader(dataBytes: number): Uint8Array {
    const header = new Uint8Array(44);
    const dv = new DataView(header.buffer);
    const byteRate = SAMPLE_RATE * 1 * BYTES_PER_SAMPLE;
    const blockAlign = 1 * BYTES_PER_SAMPLE;

    dv.setUint32(0, fourCc('RIFF'), true);
    dv.setUint32(4, 36 + dataBytes, true);
    dv.setUint32(8, fourCc('WAVE'), true);
    dv.setUint32(12, fourCc('fmt '), true);
    dv.setUint32(16, 16, true); // PCM fmt chunk size
    dv.setUint16(20, 1, true); // audioFormat = PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, SAMPLE_RATE, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true); // bits per sample
    dv.setUint32(36, fourCc('data'), true);
    dv.setUint32(40, dataBytes, true);
    return header;
}

/**
 * Read `length` bytes from `path` starting at `offset` using a seekable stream,
 * so we never load a whole (possibly long) recording into memory. Returns fewer
 * bytes than requested only if EOF is reached first.
 */
function readRange(path: string, offset: number, length: number): Uint8Array {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        if (offset > 0) {
            stream.seek(offset, GLib.SeekType.SET, null);
        }
        const out = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
            const bytes = stream.read_bytes(length - filled, null);
            const arr = bytes.toArray() as Uint8Array;
            if (arr.length === 0) break; // EOF
            out.set(arr, filled);
            filled += arr.length;
        }
        return filled === length ? out : out.subarray(0, filled);
    } finally {
        stream.close(null);
    }
}

/** Current on-disk size of `path` in bytes (0 if it cannot be queried). */
function fileSize(path: string): number {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        return info.get_size();
    } catch {
        return 0;
    }
}

/**
 * Parse the WAV header of `path` and return the byte offset where PCM samples
 * begin, or `null` when the header is not (yet) present or the format is not the
 * expected 16 kHz mono 16-bit PCM. Safe to call repeatedly while the file grows
 * — only the first few KiB are read.
 */
export function getWavDataOffset(path: string): number | null {
    let head: Uint8Array;
    try {
        head = readRange(path, 0, 4096);
    } catch {
        return null;
    }
    if (head.length < 44) return null;

    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (
        view.getUint32(0, true) !== fourCc('RIFF') ||
        view.getUint32(8, true) !== fourCc('WAVE')
    ) {
        return null;
    }

    const audioFormat = view.getUint16(20, true);
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    if (
        audioFormat !== 1 ||
        channels !== 1 ||
        sampleRate !== SAMPLE_RATE ||
        bitsPerSample !== 16
    ) {
        return null;
    }

    // Walk the chunk list to locate `data`; WAVs may carry `LIST`/`fact` chunks
    // before it. The size fields written by a still-open recorder are unreliable
    // placeholders, so we only use them to advance the cursor, never as a length.
    let offset = 12;
    while (offset + 8 <= head.length) {
        const id = view.getUint32(offset, true);
        const size = view.getUint32(offset + 4, true);
        offset += 8;
        if (id === fourCc('data')) return offset;
        offset += size + (size % 2);
    }
    return null;
}

/**
 * Number of whole PCM samples currently available in `path` past `dataOffset`,
 * derived from the live file size (not the header's placeholder length).
 */
export function wavAvailableSamples(path: string, dataOffset: number): number {
    const dataBytes = Math.max(0, fileSize(path) - dataOffset);
    return Math.floor(dataBytes / BYTES_PER_SAMPLE);
}

/**
 * Copy the sample range `[sampleStart, sampleStart + sampleCount)` out of the
 * growing recording `srcPath` and write it to `outPath` as a standalone,
 * canonically-headered WAV ready to feed the ASR CLI.
 */
export function writeWavChunk(
    srcPath: string,
    dataOffset: number,
    sampleStart: number,
    sampleCount: number,
    outPath: string
): void {
    const byteStart = dataOffset + sampleStart * BYTES_PER_SAMPLE;
    const byteLen = sampleCount * BYTES_PER_SAMPLE;
    const payload = readRange(srcPath, byteStart, byteLen);

    const header = buildWavHeader(payload.length);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header, 0);
    out.set(payload, header.length);

    Gio.File.new_for_path(outPath).replace_contents(
        out,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

/**
 * Best-effort removal of the chunk files produced by {@link sliceWav16kMono}.
 * Never throws — used in `finally` blocks where the caller already has its own
 * error path.
 */
export function cleanupChunks(paths: string[]): void {
    for (const p of paths) {
        try {
            Gio.File.new_for_path(p).delete(null);
        } catch {
            // Swallow: cleanup is advisory.
        }
    }
}
