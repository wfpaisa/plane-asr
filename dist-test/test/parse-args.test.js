/* Tests for the shell-like argument tokenizer (pure, no GJS). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/extension/asr-backends.js';
test('empty input yields an empty array', () => {
    assert.deepEqual(parseArgs(''), []);
    assert.deepEqual(parseArgs('   '), []);
});
test('splits on whitespace and collapses runs', () => {
    assert.deepEqual(parseArgs('-m /path/model.gguf'), [
        '-m',
        '/path/model.gguf',
    ]);
    assert.deepEqual(parseArgs('  a   b '), ['a', 'b']);
});
test('single quotes keep spaces intact', () => {
    assert.deepEqual(parseArgs("-m '/path with space/m.gguf'"), [
        '-m',
        '/path with space/m.gguf',
    ]);
});
test('double quotes keep commas and spaces intact', () => {
    assert.deepEqual(parseArgs('--initial-prompt "García, UPB"'), [
        '--initial-prompt',
        'García, UPB',
    ]);
});
test('backslash escapes the next character', () => {
    assert.deepEqual(parseArgs('a\\ b'), ['a b']);
});
test('empty quotes still produce an (empty) token', () => {
    assert.deepEqual(parseArgs("''"), ['']);
});
//# sourceMappingURL=parse-args.test.js.map