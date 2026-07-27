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

import {
    BYTES_PER_SAMPLE,
    SAMPLE_RATE,
    buildWavHeader,
    wavDataOffsetFromHeader,
} from '../util/wav.js';

export {SAMPLE_RATE};

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
    return wavDataOffsetFromHeader(head);
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
