/* wav.ts
 *
 * Pure, byte-level helpers for the canonical 16 kHz mono 16-bit PCM WAV format
 * the recorder produces and the ASR CLI consumes. No GNOME/GJS imports, so the
 * header build/parse logic can be unit-tested in plain Node; the file I/O that
 * uses these lives in audio-chunker.ts.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

/** Expected capture format produced by the `Recorder`. */
export const SAMPLE_RATE = 16000;
export const BYTES_PER_SAMPLE = 2;

/** ASCII four-cc helper. */
export function fourCc(code: string): number {
    return (
        code.charCodeAt(0) |
        (code.charCodeAt(1) << 8) |
        (code.charCodeAt(2) << 16) |
        (code.charCodeAt(3) << 24)
    );
}

/** Build a 44-byte canonical RIFF/WAVE header for a 16 kHz mono s16 stream. */
export function buildWavHeader(dataBytes: number): Uint8Array {
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
 * Given the first bytes of a file, return the byte offset where PCM samples
 * begin, or `null` when the header is not (yet) present or the format is not
 * the expected 16 kHz mono 16-bit PCM.
 *
 * The size fields written by a still-open recorder are unreliable placeholders,
 * so they are only used to advance the chunk-walking cursor, never as a length.
 */
export function wavDataOffsetFromHeader(head: Uint8Array): number | null {
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
    // before it.
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
