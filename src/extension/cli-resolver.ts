/* cli-resolver.ts
 *
 * Resolves the transcription CLI binary according to the active `cli-mode`:
 *   - 'cpu' → prefer the CPU-only `transcribe-cli` bundled with the extension
 *             (x86_64), falling back to a `transcribe-cli` discovered on PATH.
 *             Zero configuration required. This is what {@link resolveAutoCli}
 *             below implements.
 *   - 'gpu' → use the absolute path the user set in `cli-path` (e.g. a
 *             personally compiled Vulkan/CUDA build); resolved by the caller,
 *             not here.
 *
 * This mirrors the `cli-mode` GSetting documented in
 * src/config/settings.ts (legacy 'auto'/'manual' values migrate to
 * 'cpu'/'gpu'). The functions are pure (no subprocess) so they are cheap to
 * call from both the service pre-flight gate and the transcriber argv builder,
 * as well as from the preferences UI for status display.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Path components, below the extension root, of the bundled CLI binary. */
const BUNDLED_SUBPATH = ['bin', 'transcribe-cli'];

/** Outcome of an auto-mode binary lookup, for both runtime and UI display. */
export interface ResolvedCli {
    /** Absolute path to the binary to invoke, or '' when nothing usable. */
    path: string;
    /** Where the path came from, for diagnostics and UI hints. */
    source: 'bundled' | 'path' | 'none';
}

/**
 * Absolute path of the CLI bundled with the extension:
 * `${extensionDir}/bin/transcribe-cli`. Returns '' when no extension dir.
 */
export function bundledCliPath(extensionDir: string | null): string {
    if (!extensionDir) return '';
    return GLib.build_filenamev([extensionDir, ...BUNDLED_SUBPATH]);
}

/**
 * Whether the bundled binary exists and is executable. False when there is no
 * bundled binary for the running architecture (e.g. non-x86_64 hosts).
 */
export function bundledCliAvailable(extensionDir: string | null): boolean {
    const p = bundledCliPath(extensionDir);
    if (!p) return false;
    const file = Gio.File.new_for_path(p);
    if (!file.query_exists(null)) return false;
    try {
        const info = file.query_info(
            'access::can-execute',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        return info.get_attribute_boolean('access::can-execute');
    } catch {
        // Permission error or similar — treat as unavailable so the caller
        // falls back / reports a clear message rather than crashing.
        return false;
    }
}

/** Look a CLI up by name on PATH. Returns null if not found. */
export function findCliInPath(name: string): string | null {
    return GLib.find_program_in_path(name) ?? null;
}

/**
 * Resolve the binary for auto mode: bundled binary first, then PATH. Never
 * throws; returns `source: 'none'` when nothing usable is available so the
 * caller can surface a clear error.
 */
export function resolveAutoCli(
    extensionDir: string | null,
    pathName: string
): ResolvedCli {
    if (bundledCliAvailable(extensionDir)) {
        return {path: bundledCliPath(extensionDir), source: 'bundled'};
    }
    const found = pathName ? findCliInPath(pathName) : null;
    if (found) return {path: found, source: 'path'};
    return {path: '', source: 'none'};
}
