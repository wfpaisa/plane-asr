/* Tests for the overlap-aware chunk stitcher (pure, no GJS). */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {dedupChunkJoin} from '../src/util/text-merge.js';

test('drops the overlapping head when tail and head match', () => {
    assert.equal(dedupChunkJoin('hola mundo', 'mundo cruel', 4), 'cruel');
    assert.equal(
        dedupChunkJoin('vamos a hacer', 'hacer una prueba', 4),
        'una prueba'
    );
});

test('returns curr unchanged when there is no convincing overlap', () => {
    assert.equal(
        dedupChunkJoin('fin del uno', 'inicio del dos', 4),
        'inicio del dos'
    );
});

test('maxWords = 0 disables dedup entirely', () => {
    assert.equal(dedupChunkJoin('Hola,', 'hola mundo', 0), 'hola mundo');
});

test('empty curr or empty prev is a no-op', () => {
    assert.equal(dedupChunkJoin('algo', '', 4), '');
    assert.equal(dedupChunkJoin('', 'algo nuevo', 4), 'algo nuevo');
});

test('matches on normalized tokens but preserves raw casing/punctuation', () => {
    // 'Mundo,' normalizes to 'mundo' and overlaps 'mundo'; the surviving
    // suffix keeps its original form.
    assert.equal(dedupChunkJoin('hola mundo', 'Mundo, cruel', 4), 'cruel');
});

test('tolerates one mishearing at a long seam (fuzzy >= 0.7)', () => {
    assert.equal(
        dedupChunkJoin('w uno dos tres cuatro', 'uno dos tres XXXX resto', 5),
        'resto'
    );
});
