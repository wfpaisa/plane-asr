/* Tests for the processing presets (pure, no GJS). */

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SETTINGS_KEYS} from '../src/config/settings.js';
import {
    PRESET_IDS,
    PRESETS,
    guessActivePreset,
    presetEntries,
    type PresetId,
} from '../src/config/presets.js';

test('every preset defines the exact same set of keys', () => {
    const keySets = PRESET_IDS.map(id =>
        Object.keys(PRESETS[id]).sort().join(',')
    );
    const [first] = keySets;
    for (const ks of keySets) assert.equal(ks, first);
});

test('preset value tuples are pairwise distinct', () => {
    const tuples = PRESET_IDS.map(id => JSON.stringify(PRESETS[id]));
    const unique = new Set(tuples);
    assert.equal(unique.size, PRESET_IDS.length);
});

test('guessActivePreset returns the id when a preset matches exactly', () => {
    for (const id of PRESET_IDS) {
        assert.equal(guessActivePreset({...PRESETS[id]}), id);
    }
});

test('guessActivePreset ignores unrelated keys', () => {
    const current = {
        ...PRESETS.fast,
        [SETTINGS_KEYS.SELECTED_LANGUAGE]: 'es' as unknown as boolean,
        [SETTINGS_KEYS.OUTPUT_MODE]: 'paste' as unknown as boolean,
    };
    assert.equal(guessActivePreset(current), 'fast');
});

test('guessActivePreset returns null for a custom configuration', () => {
    const custom = {
        ...PRESETS.balanced,
        [SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS]: 4,
    };
    assert.equal(guessActivePreset(custom), null);
});

test('guessActivePreset returns null when a key is missing', () => {
    const partial: Record<string, boolean | number> = {...PRESETS.fast};
    delete partial[SETTINGS_KEYS.CPU_THREADS];
    assert.equal(guessActivePreset(partial), null);
});

test('presetEntries yields the same pairs as the preset map', () => {
    for (const id of PRESET_IDS as PresetId[]) {
        const fromEntries = Object.fromEntries(presetEntries(id));
        assert.deepEqual(fromEntries, PRESETS[id]);
    }
});
