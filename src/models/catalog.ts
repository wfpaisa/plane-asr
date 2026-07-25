/* catalog.ts
 *
 * Types and loader for the bundled offline model catalog
 * (data/model-catalog.json). Shared by the extension runtime and the
 * preferences UI so both see the same model list without a network call.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** One downloadable file (a single quantization) of a model. */
export interface ModelFile {
    filename: string;
    /** Quantization label, e.g. 'Q8_0', 'F16'. */
    quant: string;
    size_bytes: number;
    /**
     * Content hash from the HuggingFace tree API (`oid`). Its length determines
     * the algorithm: 40 hex chars => SHA-1 (Xet storage), 64 => SHA-256 (LFS).
     * The downloader picks the matching checksum type at verification time.
     */
    sha256: string;
}

/** A catalog entry describing a model and its downloadable files. */
export interface ModelEntry {
    id: string;
    name: string;
    /** HuggingFace repo, e.g. 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf'. */
    repo: string;
    /** Backend preset this model targets: 'transcribe-cli' or 'whisper-cli'. */
    backend: string;
    architecture: string;
    parameters: string;
    languages: string[];
    language_count: number;
    description: string;
    license: string;
    streaming: boolean;
    translate: boolean;
    lang_detect: boolean;
    recommended: boolean;
    recommended_rank: number;
    default_quant: string;
    files: ModelFile[];
}

/** Shape of data/model-catalog.json. */
export interface ModelCatalog {
    catalog_version: number;
    updated: string;
    models: ModelEntry[];
}

const CATALOG_REL_PATH = 'data/model-catalog.json';

let _cache: ModelEntry[] | null = null;

/**
 * Load (and memoize) the bundled catalog.
 *
 * @param extensionDir Absolute path to the installed extension root (the
 * directory that contains the compiled extension.js / data/). When omitted the
 * loader cannot find the file and returns an empty list.
 */
export function loadModelCatalog(extensionDir: string | null): ModelEntry[] {
    if (_cache) return _cache;
    if (!extensionDir) return [];

    const path = GLib.build_filenamev([extensionDir, CATALOG_REL_PATH]);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        console.warn(`[planeasr] model catalog not found at ${path}`);
        return [];
    }

    try {
        const [, contents] = file.load_contents(null);
        const decoder = new TextDecoder();
        const raw = decoder.decode(contents);
        const catalog = JSON.parse(raw) as ModelCatalog;
        _cache = catalog.models ?? [];
    } catch (e) {
        console.warn(`[planeasr] failed to parse model catalog: ${e}`);
        _cache = [];
    }
    return _cache;
}

/** Forget the cached catalog (used by tests / forced refresh). */
export function resetCatalogCache(): void {
    _cache = null;
}

/** Find a catalog entry by id, or null. */
export function findModel(
    extensionDir: string | null,
    id: string
): ModelEntry | null {
    return loadModelCatalog(extensionDir).find(m => m.id === id) ?? null;
}

/** Pick the file for a quant, falling back to the model default then the first. */
export function pickFile(
    entry: ModelEntry,
    quant: string | null
): ModelFile | null {
    if (quant) {
        const exact = entry.files.find(f => f.quant === quant);
        if (exact) return exact;
    }
    const def = entry.files.find(f => f.quant === entry.default_quant);
    return def ?? entry.files[0] ?? null;
}

/** Default models directory under the user cache, unless overridden by a setting. */
export function defaultModelDir(): string {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'planeasr',
        'models',
    ]);
}

/** Resolve the configured models directory, honoring an explicit override. */
export function resolveModelDir(settingValue: string): string {
    const trimmed = (settingValue ?? '').trim();
    return trimmed.length > 0 ? trimmed : defaultModelDir();
}

/** Full path where a given model file would live once downloaded. */
export function modelFilePath(modelDir: string, file: ModelFile): string {
    return GLib.build_filenamev([modelDir, file.filename]);
}

/**
 * Scan a directory for already-downloaded catalog models.
 *
 * Returns a map of catalog model id -> the quant that is present on disk. A
 * model is considered downloaded when one of its files exists in the directory
 * and its size matches the catalog entry.
 */
export function scanDownloaded(
    extensionDir: string | null,
    modelDir: string
): Map<string, string> {
    const result = new Map<string, string>();
    const dir = Gio.File.new_for_path(modelDir);
    if (!dir.query_exists(null)) return result;

    let enumerator: Gio.FileEnumerator | null = null;
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        // Build a lookup of present files keyed by filename.
        const present = new Map<string, number>();
        let info: Gio.FileInfo | null;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (/\.(gguf|bin)$/i.test(name)) {
                present.set(name, info.get_size());
            }
        }

        for (const entry of loadModelCatalog(extensionDir)) {
            for (const f of entry.files) {
                const size = present.get(f.filename);
                if (
                    size !== undefined &&
                    Math.abs(size - f.size_bytes) < 1024 // tolerate 1 KiB slack
                ) {
                    result.set(entry.id, f.quant);
                    break;
                }
            }
        }
    } catch (e) {
        console.warn(`[planeasr] failed to scan ${modelDir}: ${e}`);
    } finally {
        enumerator?.close(null);
    }
    return result;
}

/** Human-readable size label, e.g. "751 MB" or "1.65 GB". */
export function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${Math.round(bytes / (1024 * 1024))} MB`;
    }
    if (bytes >= 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
}
