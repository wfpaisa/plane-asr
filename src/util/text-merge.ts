/* text-merge.ts
 *
 * Overlap-aware stitching of consecutive chunk transcripts. When the ASR worker
 * carves overlapping windows out of a recording, the same speech is transcribed
 * twice at each seam (the tail of chunk N and the head of chunk N+1). These
 * helpers detect and remove that duplicated text so the joined output reads as
 * one continuous transcript.
 *
 * Pure, no GNOME/GJS imports — safe to unit-test in plain Node.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

/**
 * Normalize a token for comparison: lowercase and strip leading/trailing
 * non-alphanumeric characters (keeps interior letters, so accented characters
 * and ñ survive). Returns '' for tokens that are pure punctuation/noise, which
 * the caller filters out.
 */
function normalize(token: string): string {
    return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Tokenize on whitespace and drop tokens that normalize to empty. */
function tokens(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/\s+/)) {
        const n = normalize(raw);
        if (n) out.push(n);
    }
    return out;
}

/**
 * Fraction of positions where `a` and `b` (equal length) hold equal tokens.
 * Returns 0 for empty input.
 */
function matchRatio(a: string[], b: string[]): number {
    if (a.length === 0) return 0;
    let hits = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) hits++;
    }
    return hits / a.length;
}

/**
 * Decide whether the last `k` tokens of `prev` and the first `k` tokens of
 * `curr` represent the same overlapping speech, and are safe to collapse.
 *
 * - Short windows (k < 3) must match *exactly*: a 1-2 word coincidence is too
 *   likely to be a legitimately repeated word ("y el" ... "y el").
 * - Longer windows (k >= 3) tolerate ASR variation: a ratio >= 0.7 is accepted,
 *   so a word misheard at the seam doesn't defeat the whole stitch.
 */
function isOverlap(prevTail: string[], currHead: string[], k: number): boolean {
    if (k <= 0 || k > prevTail.length || k > currHead.length) return false;
    const a = prevTail.slice(prevTail.length - k);
    const b = currHead.slice(0, k);
    if (k < 3) return matchRatio(a, b) === 1;
    return matchRatio(a, b) >= 0.7;
}

/**
 * Join two chunk transcripts, removing from the head of `curr` any prefix that
 * duplicates the tail of `prev` (the overlap region). `maxWords` bounds how
 * many words of head we are willing to drop — pass 0 to disable dedup entirely
 * and return `curr` verbatim (used for contiguous, non-overlapping windows).
 *
 * When no convincing overlap is found, `curr` is returned unchanged: duplicating
 * a real word is always preferable to deleting legitimate text.
 *
 * @example
 *   dedupChunkJoin('hola mundo', 'mundo cruel', 4)        // 'cruel'
 *   dedupChunkJoin('vamos a hacer', 'hacer una prueba', 4) // 'una prueba'
 *   dedupChunkJoin('fin del uno', 'inicio del dos', 4)     // 'inicio del dos'
 *   dedupChunkJoin('Hola,', 'hola mundo', 0)               // 'hola mundo'
 */
export function dedupChunkJoin(
    prev: string,
    curr: string,
    maxWords: number
): string {
    if (!curr) return curr;
    if (maxWords <= 0 || !prev) return curr;

    // Operate on the raw (original-cased, punctuation-bearing) tokens so the
    // returned suffix preserves the transcript's formatting; only the *match*
    // is done on normalized forms.
    const rawCurr = curr.split(/\s+/).filter(t => t.length > 0);
    const normPrev = tokens(prev);
    const normCurr = tokens(curr);
    if (normPrev.length === 0 || normCurr.length === 0) return curr;

    // Search for the largest overlap first (greediest correct stitch).
    const limit = Math.min(maxWords, normPrev.length, normCurr.length);
    for (let k = limit; k >= 1; k--) {
        if (isOverlap(normPrev, normCurr, k)) {
            // Map the normalized overlap length back to raw tokens. Normalization
            // only removes tokens (pure punctuation), so the raw head has at
            // least `k` significant tokens; scan forward to drop exactly the raw
            // tokens that normalize to the overlapping set.
            let dropped = 0;
            let i = 0;
            for (; i < rawCurr.length && dropped < k; i++) {
                if (normalize(rawCurr[i])) dropped++;
            }
            return rawCurr.slice(i).join(' ');
        }
    }
    return curr;
}
