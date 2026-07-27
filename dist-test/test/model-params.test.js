/* Tests for the model-params normalizers (pure, no GJS). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureModelFlag, extractExtraFlags } from '../src/util/model-params.js';
test('ensureModelFlag leaves empty input unchanged', () => {
    assert.equal(ensureModelFlag(''), '');
    assert.equal(ensureModelFlag('   '), '   ');
});
test('ensureModelFlag prepends -m to a bare path', () => {
    assert.equal(ensureModelFlag('/path/to.gguf'), '-m /path/to.gguf');
});
test('ensureModelFlag keeps an existing -m / --model flag', () => {
    assert.equal(ensureModelFlag('-m /path'), '-m /path');
    assert.equal(ensureModelFlag('--model /path'), '--model /path');
});
test('ensureModelFlag injects -m before a path followed by flags', () => {
    assert.equal(ensureModelFlag('/path --verbose'), '-m /path --verbose');
});
test('extractExtraFlags returns nothing when there are no flags', () => {
    assert.equal(extractExtraFlags(''), '');
    assert.equal(extractExtraFlags('/path/to.gguf'), '');
});
test('extractExtraFlags keeps flags after a leading path', () => {
    assert.equal(extractExtraFlags('/path/to.gguf --verbose --beam-size 4'), '--verbose --beam-size 4');
});
//# sourceMappingURL=model-params.test.js.map