/* Tests for the `--list-devices` output parser (pure, no GJS). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseListDevices } from '../src/util/device-parse.js';
test('parses device headers, kind and memory across mixed backends', () => {
    const text = [
        '3 compute device(s):',
        '  [0] NVIDIA GeForce RTX 5070 Ti',
        '      name=CUDA0  kind=cuda  type=gpu  id=0000:01:00.0',
        '      memory: 15.51 GiB total, 15.22 GiB free',
        '  [1] Intel UHD Graphics',
        '      name=VULKAN0  kind=vulkan  type=gpu',
    ].join('\n');
    assert.deepEqual(parseListDevices(text), [
        {
            index: 0,
            name: 'NVIDIA GeForce RTX 5070 Ti',
            kind: 'cuda',
            vramLabel: '15.51 GiB',
        },
        { index: 1, name: 'Intel UHD Graphics', kind: 'vulkan', vramLabel: '' },
    ]);
});
test('ignores non-device log lines', () => {
    const text = [
        '[info] ggml_cuda_init: found 1 CUDA devices',
        '  [0] Some GPU',
        '      kind=cuda',
    ].join('\n');
    const devices = parseListDevices(text);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'Some GPU');
});
test('empty output yields no devices', () => {
    assert.deepEqual(parseListDevices(''), []);
});
//# sourceMappingURL=device-parse.test.js.map