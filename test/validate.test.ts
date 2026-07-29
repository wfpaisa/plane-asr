/* Tests for the Backend page setup diagnostics (pure, no GJS). */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    describeSetupProblems,
    extractModelPath,
    type BinaryState,
    type ModelState,
} from '../src/prefs/validate.js';

test('extractModelPath finds the path after -m', () => {
    assert.equal(extractModelPath('-m /models/ggml.bin'), '/models/ggml.bin');
});

test('extractModelPath finds the path after --model', () => {
    assert.equal(
        extractModelPath('--beam-size 4 --model /models/ggml.bin'),
        '/models/ggml.bin'
    );
});

test('extractModelPath falls back to a token with a known model extension', () => {
    assert.equal(
        extractModelPath('/models/ggml.gguf --verbose'),
        '/models/ggml.gguf'
    );
});

test('extractModelPath returns null when nothing matches', () => {
    assert.equal(extractModelPath('--verbose --beam-size 4'), null);
    assert.equal(extractModelPath(''), null);
});

const OK_BINARY: BinaryState = {
    kind: 'resolved',
    path: '/bin/transcribe-cli',
    exists: true,
    executable: true,
};
const OK_MODEL: ModelState = {
    kind: 'resolved',
    path: '/models/ggml.bin',
    exists: true,
};

test('describeSetupProblems reports nothing when both are OK', () => {
    assert.deepEqual(describeSetupProblems(OK_BINARY, OK_MODEL), []);
});

test('describeSetupProblems: GPU mode with an empty binary path', () => {
    assert.deepEqual(describeSetupProblems({kind: 'unset'}, OK_MODEL), [
        {kind: 'binary-path-empty'},
    ]);
});

test('describeSetupProblems: auto mode with nothing resolved', () => {
    assert.deepEqual(describeSetupProblems({kind: 'unresolved'}, OK_MODEL), [
        {kind: 'binary-unresolved'},
    ]);
});

test('describeSetupProblems: configured binary missing on disk', () => {
    const binary: BinaryState = {
        kind: 'resolved',
        path: '/bin/missing',
        exists: false,
        executable: false,
    };
    assert.deepEqual(describeSetupProblems(binary, OK_MODEL), [
        {kind: 'binary-not-found', path: '/bin/missing'},
    ]);
});

test('describeSetupProblems: binary exists but is not executable', () => {
    const binary: BinaryState = {
        kind: 'resolved',
        path: '/bin/transcribe-cli',
        exists: true,
        executable: false,
    };
    assert.deepEqual(describeSetupProblems(binary, OK_MODEL), [
        {kind: 'binary-not-executable', path: '/bin/transcribe-cli'},
    ]);
});

test('describeSetupProblems: no model file found anywhere', () => {
    assert.deepEqual(describeSetupProblems(OK_BINARY, {kind: 'missing'}), [
        {kind: 'model-not-found'},
    ]);
});

test('describeSetupProblems: model path is relative', () => {
    const model: ModelState = {kind: 'relative', path: 'models/ggml.bin'};
    assert.deepEqual(describeSetupProblems(OK_BINARY, model), [
        {kind: 'model-path-relative', path: 'models/ggml.bin'},
    ]);
});

test('describeSetupProblems: resolved model missing on disk', () => {
    const model: ModelState = {
        kind: 'resolved',
        path: '/models/gone.bin',
        exists: false,
    };
    assert.deepEqual(describeSetupProblems(OK_BINARY, model), [
        {kind: 'model-not-on-disk', path: '/models/gone.bin'},
    ]);
});

test('describeSetupProblems: reports binary and model problems together, binary first', () => {
    const problems = describeSetupProblems(
        {kind: 'unresolved'},
        {kind: 'missing'}
    );
    assert.deepEqual(problems, [
        {kind: 'binary-unresolved'},
        {kind: 'model-not-found'},
    ]);
});
