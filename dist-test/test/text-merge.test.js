/* Tests for the overlap-aware chunk stitcher (pure, no GJS). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupChunkJoin, finalizeTranscript, stripPlaceholders, } from '../src/util/text-merge.js';
test('drops the overlapping head when tail and head match', () => {
    assert.equal(dedupChunkJoin('hola mundo', 'mundo cruel', 4), 'cruel');
    assert.equal(dedupChunkJoin('vamos a hacer', 'hacer una prueba', 4), 'una prueba');
});
test('returns curr unchanged when there is no convincing overlap', () => {
    assert.equal(dedupChunkJoin('fin del uno', 'inicio del dos', 4), 'inicio del dos');
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
    assert.equal(dedupChunkJoin('w uno dos tres cuatro', 'uno dos tres XXXX resto', 5), 'resto');
});
test('drops the overlap even when the ASR inserts a word inside it', () => {
    // El trozo previo oyó "que siempre aparecía"; el siguiente re-transcribe
    // la misma zona como "que aparecía". El desfase de una palabra no debe
    // impedir reconocer la costura ni dejar el duplicado.
    assert.equal(dedupChunkJoin('una estrella que siempre aparecía', 'que aparecía sobre el mismo árbol', 7), 'sobre el mismo árbol');
});
test('does not over-drop when only a lone word coincides', () => {
    // "sobre" aparece en ambos lados pero no es una costura solapada real:
    // una sola palabra coincidente no debe descartarse.
    assert.equal(dedupChunkJoin('caminaba sobre', 'sobre todo esto', 7), 'todo esto');
    assert.equal(dedupChunkJoin('el árbol crecía', 'sobre la colina lejana', 7), 'sobre la colina lejana');
});
test('stripPlaceholders removes silence markers', () => {
    assert.equal(stripPlaceholders('(empty)'), '');
    assert.equal(stripPlaceholders('[BLANK_AUDIO]'), '');
    assert.equal(stripPlaceholders('hola mundo (empty)'), 'hola mundo');
    assert.equal(stripPlaceholders('[silence] hola [música]'), 'hola');
    assert.equal(stripPlaceholders('todo bien'), 'todo bien');
});
test('finalizeTranscript: no leading uppercase, no trailing period', () => {
    assert.equal(finalizeTranscript('La última estrella. Cada noche.'), 'la última estrella. Cada noche');
});
test('finalizeTranscript drops seam periods before a lowercase continuation', () => {
    assert.equal(finalizeTranscript('miraba el cielo desde la. ventana de su habitación'), 'miraba el cielo desde la ventana de su habitación');
    // Un punto seguido de mayúscula es una frase real: se conserva.
    assert.equal(finalizeTranscript('brillar más que las demás. Una noche desapareció'), 'brillar más que las demás. Una noche desapareció');
});
test('finalizeTranscript strips trailing "(empty)" and lone periods', () => {
    assert.equal(finalizeTranscript('sobre el mismo árbol y que parecía brillar más. (empty)'), 'sobre el mismo árbol y que parecía brillar más');
    assert.equal(finalizeTranscript('una noche la estrella desaparece .'), 'una noche la estrella desaparece');
});
//# sourceMappingURL=text-merge.test.js.map