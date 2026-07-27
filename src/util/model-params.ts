/* model-params.ts
 *
 * Pure helpers for normalizing the free-form `model-params` GSetting string
 * into CLI arguments. Kept free of GNOME/GJS imports so it can be unit-tested
 * in plain Node.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

import {parseArgs} from '../extension/asr-backends.js';

/**
 * Ensure a free-form `model-params` string carries a `-m`/`--model` flag.
 *
 * When the user configures a custom model path in the UI without typing the
 * flag, treat the whole value as a bare model path and prepend `-m`. If the
 * params already contain the flag, or are empty, they are returned unchanged.
 * Any leading non-flag tokens before a real flag are left as-is (rare; the UI
 * is documented to hold a single path or full args).
 */
export function ensureModelFlag(params: string): string {
    const trimmed = params.trim();
    if (!trimmed) return params;
    const toks = parseArgs(trimmed);
    if (toks.some(t => t === '-m' || t === '--model')) return params;
    // Bare path: prepend -m. Split off any trailing flags the user may have
    // added after the path (e.g. "/path/to.gguf --foo bar").
    const firstFlagIdx = toks.findIndex(t => t.startsWith('-'));
    if (firstFlagIdx <= 0) {
        // No flags, or the first token is itself a flag — treat the whole thing
        // as the path when it doesn't start with '-'.
        if (firstFlagIdx === -1) {
            return `-m ${trimmed}`;
        }
        return params;
    }
    const pathPart = toks.slice(0, firstFlagIdx).join(' ');
    const rest = toks.slice(firstFlagIdx).join(' ');
    return `-m ${pathPart} ${rest}`;
}

/**
 * Pull the leading extra-flag tokens (those starting with `-`) out of a
 * free-form params string, discarding any bare positional path that precedes
 * them. Used when a catalog model is active: its own `-m <path>` is injected
 * separately, so only the user's extra flags (e.g. `--verbose`) survive.
 *
 * Tokens that follow a flag expecting a value (e.g. the path after `-m`) are
 * not specially handled — the "Custom model path" mode is the documented way
 * to supply a model, so a catalog user's extra params are expected to be plain
 * flags or `flag value` pairs where the value does not look like a stray path.
 */
export function extractExtraFlags(params: string): string {
    const trimmed = params.trim();
    if (!trimmed) return '';
    const toks = parseArgs(trimmed);
    // Keep only tokens from the first flag onward, dropping any bare path that
    // leads the string (the custom-mode model path).
    const firstFlagIdx = toks.findIndex(t => t.startsWith('-'));
    if (firstFlagIdx <= 0) return ''; // no flags, or params are just a path
    return toks.slice(firstFlagIdx).join(' ');
}
