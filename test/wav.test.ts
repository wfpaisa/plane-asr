/* Tests for the pure WAV header build/parse helpers (no GJS). */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    buildWavHeader,
    fourCc,
    wavDataOffsetFromHeader,
} from '../src/util/wav.js';

test('buildWavHeader writes a canonical 44-byte 16 kHz mono s16 header', () => {
    const header = buildWavHeader(1000);
    assert.equal(header.length, 44);
    const dv = new DataView(header.buffer);
    assert.equal(dv.getUint32(0, true), fourCc('RIFF'));
    assert.equal(dv.getUint32(4, true), 36 + 1000); // RIFF chunk size
    assert.equal(dv.getUint32(8, true), fourCc('WAVE'));
    assert.equal(dv.getUint16(20, true), 1); // PCM
    assert.equal(dv.getUint16(22, true), 1); // mono
    assert.equal(dv.getUint32(24, true), 16000); // sample rate
    assert.equal(dv.getUint16(34, true), 16); // bits per sample
    assert.equal(dv.getUint32(40, true), 1000); // data size
});

test('a freshly built header parses back to offset 44', () => {
    assert.equal(wavDataOffsetFromHeader(buildWavHeader(0)), 44);
});

test('rejects buffers shorter than a full header', () => {
    assert.equal(wavDataOffsetFromHeader(new Uint8Array(20)), null);
});

test('rejects a non-RIFF/WAVE buffer', () => {
    const bad = buildWavHeader(0);
    bad[0] = 0; // corrupt the RIFF magic
    assert.equal(wavDataOffsetFromHeader(bad), null);
});

test('rejects a wrong sample rate (not 16 kHz)', () => {
    const header = buildWavHeader(0);
    new DataView(header.buffer).setUint32(24, 8000, true);
    assert.equal(wavDataOffsetFromHeader(header), null);
});

test('walks past a LIST chunk to find the data chunk', () => {
    // RIFF(12) + fmt(8+16) + LIST(8+4) + data header(8) => data offset 56.
    const buf = new Uint8Array(56);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, fourCc('RIFF'), true);
    dv.setUint32(4, 48, true);
    dv.setUint32(8, fourCc('WAVE'), true);
    dv.setUint32(12, fourCc('fmt '), true);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    dv.setUint32(36, fourCc('LIST'), true);
    dv.setUint32(40, 4, true); // 4-byte LIST payload at 44..47
    dv.setUint32(48, fourCc('data'), true);
    dv.setUint32(52, 0, true);
    assert.equal(wavDataOffsetFromHeader(buf), 56);
});
