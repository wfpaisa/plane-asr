/* paths.ts
 *
 * Single source of truth for every filesystem location the extension uses
 * under the user cache directory. Keeps the on-disk layout in one place so
 * recordings, live chunks and models never drift apart.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Top-level directory name this extension owns under the user cache dir. */
const CACHE_DIR_NAME = 'planeasr';

/** Filename pattern for finalized recordings (`recording_<microseconds>.wav`). */
const RECORDING_RE = /^recording_\d+\.wav$/i;

/** Root cache directory: `<user-cache>/planeasr`. */
export function cacheDir(): string {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), CACHE_DIR_NAME]);
}

/**
 * Directory where WAV recordings are persisted:
 * `<user-cache>/planeasr/records`.
 */
export function recordsDir(): string {
    return GLib.build_filenamev([cacheDir(), 'records']);
}

/**
 * Default models directory: `<user-cache>/planeasr/models`. Honors an explicit
 * override via the `model-dir` GSetting when non empty (see {@link resolveModelDir}).
 */
export function defaultModelDir(): string {
    return GLib.build_filenamev([cacheDir(), 'models']);
}

/**
 * Prune finalized recordings under {@link recordsDir} so at most `keep` of the
 * most recent ones survive. Recordings are named `recording_<microseconds>.wav`,
 * so a lexicographic sort matches chronological order. Transient `_live*.wav`
 * chunk files are left alone (they are cleaned up by the streamer itself).
 *
 * @param keep  How many recordings to keep. `<= 0` means keep none.
 */
export function pruneRecordings(keep: number): void {
    if (keep < 0) keep = 0;
    const dir = recordsDir();
    const file = Gio.File.new_for_path(dir);
    let iter: Gio.FileEnumerator;
    try {
        iter = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
    } catch {
        return; // dir missing or unreadable — nothing to prune
    }
    const names: string[] = [];
    try {
        let info = iter.next_file(null);
        while (info !== null) {
            if (
                info.get_file_type() === Gio.FileType.REGULAR &&
                RECORDING_RE.test(info.get_name())
            ) {
                names.push(info.get_name());
            }
            info = iter.next_file(null);
        }
    } finally {
        iter.close(null);
    }
    if (names.length <= keep) return;
    // Oldest first: delete everything before the (names.length - keep) cutoff.
    names.sort();
    const toDelete = names.slice(0, names.length - keep);
    for (const name of toDelete) {
        const victim = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
        try {
            victim.delete(null);
        } catch {
            // Best effort: a failed delete (e.g. locked file) is non-fatal.
        }
    }
}
