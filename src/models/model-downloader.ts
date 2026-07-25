/* model-downloader.ts
 *
 * Streaming model downloader backed by libsoup 3.0. Downloads GGUF files from
 * HuggingFace with resume support (HTTP Range), incremental SHA-256
 * verification, cancellation and throttled progress reporting.
 *
 * The download never loads the whole file in memory: bytes flow network ->
 * 1 MiB buffer -> output file -> checksum, so it works for multi-GB models.
 *
 * NOTE on async style: GJS async GI methods require a C-style callback and do
 * NOT honour promise overloads or `Gio._promisify` reliably in all runtimes
 * (the prototype patch can be silently dropped for native methods). Every
 * async operation here is wrapped in a hand-rolled Promise that invokes the
 * method with its native callback signature, which is the only form guaranteed
 * to work.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import type {ModelEntry, ModelFile} from './catalog.js';
import {getModelStore} from './model-store.js';

/** HuggingFace resolve URL for a single file in a repo. */
export function hfResolveUrl(repo: string, filename: string): string {
    return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

/** 1 MiB streaming buffer — small enough for low memory, big enough for throughput. */
const CHUNK_SIZE = 1024 * 1024;
/** Minimum interval between progress emissions (ms). */
const PROGRESS_THROTTLE_MS = 250;

/** Outcome of a download attempt. */
export type DownloadOutcome =
    | {ok: true}
    | {ok: false; cancelled: boolean; error: string};

// =============================================================================
// Promise wrappers for GJS async methods (native callback signature).
// Each calls the method with its required `(source, result) => ...` callback and
// resolves/rejects from it. This is the ONLY async form GJS reliably supports.
// =============================================================================

/** Wrap a Gio async file-stream opener in a Promise. */
function fileReplaceAsync(
    file: Gio.File,
    etag: string | null,
    makeBackup: boolean,
    flags: Gio.FileCreateFlags,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<Gio.FileOutputStream> {
    return new Promise((resolve, reject) => {
        file.replace_async(
            etag,
            makeBackup,
            flags,
            ioPriority,
            cancellable,
            (_src, res) => {
                try {
                    resolve(file.replace_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/** Append-to async wrapper (resume path opens the existing partial for append). */
function fileAppendToAsync(
    file: Gio.File,
    flags: Gio.FileCreateFlags,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<Gio.FileOutputStream> {
    return new Promise((resolve, reject) => {
        file.append_to_async(flags, ioPriority, cancellable, (_src, res) => {
            try {
                resolve(file.append_to_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** query_info_async wrapper. */
function fileQueryInfoAsync(
    file: Gio.File,
    attributes: string,
    flags: Gio.FileQueryInfoFlags,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<Gio.FileInfo> {
    return new Promise((resolve, reject) => {
        file.query_info_async(
            attributes,
            flags,
            ioPriority,
            cancellable,
            (_src, res) => {
                try {
                    resolve(file.query_info_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/** read_async wrapper (opens a FileInputStream). */
function fileReadAsync(
    file: Gio.File,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<Gio.FileInputStream> {
    return new Promise((resolve, reject) => {
        file.read_async(ioPriority, cancellable, (_src, res) => {
            try {
                resolve(file.read_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** set_display_name_async wrapper. */
function fileSetDisplayNameAsync(
    file: Gio.File,
    displayName: string,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<Gio.File> {
    return new Promise((resolve, reject) => {
        file.set_display_name_async(
            displayName,
            ioPriority,
            cancellable,
            (_src, res) => {
                try {
                    resolve(file.set_display_name_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/** delete_async wrapper. */
function fileDeleteAsync(
    file: Gio.File,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        file.delete_async(ioPriority, cancellable, (_src, res) => {
            try {
                resolve(file.delete_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** InputStream.read_bytes_async wrapper. */
function streamReadBytesAsync(
    stream: Gio.InputStream,
    count: number,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<GLib.Bytes> {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(
            count,
            ioPriority,
            cancellable,
            (_src, res) => {
                try {
                    resolve(stream.read_bytes_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/** OutputStream.write_bytes_async wrapper. */
function streamWriteBytesAsync(
    stream: Gio.OutputStream,
    bytes: GLib.Bytes,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<number> {
    return new Promise((resolve, reject) => {
        stream.write_bytes_async(
            bytes,
            ioPriority,
            cancellable,
            (_src, res) => {
                try {
                    resolve(stream.write_bytes_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/** OutputStream/InputStream.close_async wrapper. */
function streamCloseAsync(
    stream: Gio.InputStream | Gio.OutputStream,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        stream.close_async(ioPriority, cancellable, (_src, res) => {
            try {
                resolve(stream.close_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Soup.Session.send_async wrapper (returns the body InputStream). */
function soupSendAsync(
    session: Soup.Session,
    msg: Soup.Message,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<Gio.InputStream> {
    return new Promise((resolve, reject) => {
        session.send_async(msg, ioPriority, cancellable, (_src, res) => {
            try {
                resolve(session.send_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// =============================================================================
// Downloader
// =============================================================================

/**
 * HuggingFace model downloader. Owns a long-lived `Soup.Session` shared across
 * downloads. Safe to keep as a singleton.
 */
export class ModelDownloader {
    private _session: Soup.Session;

    constructor() {
        this._session = new Soup.Session({
            user_agent: 'plane-asr',
            // No socket timeout: large models can stall briefly on slow links.
            timeout: 0,
        });
    }

    /**
     * Download (or resume) `file` of `entry` into `modelDir`.
     *
     * Resolves once the file is on disk and its SHA-256 matches the catalog.
     * Cancellation resolves with `{ok:false, cancelled:true}`. On a hash
     * mismatch the partial file is deleted so the next attempt starts clean.
     *
     * Progress + state are published through the global {@link ModelStore}.
     */
    async download(
        entry: ModelEntry,
        file: ModelFile,
        modelDir: string
    ): Promise<DownloadOutcome> {
        const store = getModelStore();
        const cancellable = new Gio.Cancellable();
        store.markStarted(entry.id, file, cancellable);

        const destPath = `${modelDir}/${file.filename}`;
        const partPath = `${destPath}.part`;

        try {
            await this._downloadToFile(entry, file, partPath, cancellable);
            // Verify the content hash against the catalog oid before promoting
            // the file. The algorithm is chosen from the oid length (SHA-1 for
            // Xet 40-hex, SHA-256 for LFS 64-hex).
            const actual = await hashOfFile(
                partPath,
                checksumTypeFor(file.sha256),
                cancellable
            );
            if (actual !== file.sha256) {
                await safeDelete(partPath);
                throw new Error(
                    `Hash mismatch for ${file.filename} ` +
                        `(expected ${file.sha256}, got ${actual})`
                );
            }
            await renameAtomic(partPath, destPath);
            store.markComplete(entry.id);
            return {ok: true};
        } catch (e) {
            const cancelled = isErrorCancelled(e);
            if (cancelled) {
                // Keep the .part so the next attempt resumes.
                store.markCancelled(entry.id);
                return {ok: false, cancelled: true, error: errMessage(e)};
            }
            store.markFailed(entry.id, errMessage(e));
            return {ok: false, cancelled: false, error: errMessage(e)};
        }
    }

    /** Cancel an in-flight download by model id (no-op if none active). */
    cancel(modelId: string): void {
        getModelStore()
            .getActiveDownload(modelId)
            ?.cancellable.cancel();
    }

    /** Delete a downloaded model file (final path only; leaves no .part). */
    async delete(
        entry: ModelEntry,
        file: ModelFile,
        modelDir: string
    ): Promise<void> {
        await safeDelete(`${modelDir}/${file.filename}`);
        getModelStore().markDeleted(entry.id);
    }

    // -- internals --------------------------------------------------------

    /**
     * Stream `file` into `partPath`, resuming from an existing `.part` when
     * present. Resumes by sending an HTTP `Range:` header; if the server
     * ignores it (full 200 re-send), the partial is discarded and the download
     * restarts from byte 0.
     */
    private async _downloadToFile(
        entry: ModelEntry,
        file: ModelFile,
        partPath: string,
        cancellable: Gio.Cancellable
    ): Promise<void> {
        const url = hfResolveUrl(entry.repo, file.filename);
        const msg = Soup.Message.new('GET', url);

        // Probe the existing partial to compute a resume offset.
        let resumeOffset = 0;
        const partFile = Gio.File.new_for_path(partPath);
        if (partFile.query_exists(null)) {
            try {
                const info = await fileQueryInfoAsync(
                    partFile,
                    'standard::size',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    cancellable
                );
                resumeOffset = info.get_size();
            } catch {
                resumeOffset = 0; // ignore probe failure, restart fresh
            }
        }

        // The checksum must cover the whole file, so when resuming we hash the
        // already-on-disk prefix first, then continue with the new tail. The
        // algorithm matches the catalog oid length (SHA-1 for Xet, SHA-256 for
        // LFS) so the final digest compares equal to file.sha256.
        const checksum = new GLib.Checksum(checksumTypeFor(file.sha256));
        let received = 0;
        let outStream: Gio.FileOutputStream;

        if (resumeOffset > 0) {
            msg.request_headers.append('Range', `bytes=${resumeOffset}-`);
            outStream = await fileAppendToAsync(
                partFile,
                Gio.FileCreateFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
            await hashPrefix(checksum, partPath, resumeOffset, cancellable);
            received = resumeOffset;
        } else {
            outStream = await fileReplaceAsync(
                partFile,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
        }

        // Send the request and get the body stream (Soup follows redirects).
        const inputStream = await soupSendAsync(
            this._session,
            msg,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );

        // If we asked for a range but the server ignored it (200 instead of
        // 206), restart cleanly so we don't append a second copy of the prefix.
        const status = msg.get_status();
        if (resumeOffset > 0 && status !== Soup.Status.PARTIAL_CONTENT) {
            await streamCloseAsync(
                outStream,
                GLib.PRIORITY_DEFAULT,
                null
            ).catch(() => {});
            await safeDelete(partPath);
            return this._downloadToFile(entry, file, partPath, cancellable);
        }

        const total = resolveTotal(msg, file.size_bytes, resumeOffset);
        let lastEmit = 0;

        for (;;) {
            const bytes = await streamReadBytesAsync(
                inputStream,
                CHUNK_SIZE,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
            const size = bytes.get_size();
            if (size === 0) break;

            const data = bytes.get_data();
            if (data) checksum.update(data);
            await streamWriteBytesAsync(
                outStream,
                bytes,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
            received += size;

            const now = GLib.get_monotonic_time() / 1000;
            if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
                lastEmit = now;
                getModelStore().markProgress(entry.id, received, total);
            }
        }

        await streamCloseAsync(outStream, GLib.PRIORITY_DEFAULT, cancellable);
        // Final progress emission so the UI shows 100%.
        getModelStore().markProgress(entry.id, total, total);
    }
}

/**
 * Derive the total expected bytes from the response. For a 206 the
 * `Content-Range` carries `bytes start-end/total`; for a 200 we fall back to
 * the catalog size plus any resumed prefix.
 */
function resolveTotal(
    msg: Soup.Message,
    catalogSize: number,
    resumeOffset: number
): number {
    const range = msg.response_headers.get_one('Content-Range');
    if (range) {
        const m = range.match(/\/(\d+)/);
        if (m) return parseInt(m[1], 10);
    }
    const len = msg.response_headers.get_content_length();
    if (len > 0) return len + resumeOffset;
    return catalogSize;
}

/**
 * Pick the checksum algorithm from the catalog hash length.
 *
 * HuggingFace exposes the file oid via its tree API: 40 hex chars means the
 * file lives in Xet storage and the oid is SHA-1; 64 hex chars means classic
 * Git-LFS with a SHA-256 oid. Computing the wrong algorithm guarantees a
 * mismatch, so the type is chosen per-file.
 */
function checksumTypeFor(hash: string): GLib.ChecksumType {
    return hash.length === 40
        ? GLib.ChecksumType.SHA1
        : GLib.ChecksumType.SHA256;
}

/** Compute the content hash of a whole file by streaming (low memory). */
async function hashOfFile(
    path: string,
    type: GLib.ChecksumType,
    cancellable: Gio.Cancellable
): Promise<string> {
    const checksum = new GLib.Checksum(type);
    const file = Gio.File.new_for_path(path);
    const stream = await fileReadAsync(
        file,
        GLib.PRIORITY_DEFAULT,
        cancellable
    );
    for (;;) {
        const bytes = await streamReadBytesAsync(
            stream,
            CHUNK_SIZE,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );
        const data = bytes.get_data();
        if (!data || bytes.get_size() === 0) break;
        checksum.update(data);
    }
    await streamCloseAsync(stream, GLib.PRIORITY_DEFAULT, null).catch(() => {});
    return checksum.get_string();
}

/** Feed the first `offset` bytes of `path` into `checksum` (resume path). */
async function hashPrefix(
    checksum: GLib.Checksum,
    path: string,
    offset: number,
    cancellable: Gio.Cancellable
): Promise<void> {
    const file = Gio.File.new_for_path(path);
    const stream = await fileReadAsync(
        file,
        GLib.PRIORITY_DEFAULT,
        cancellable
    );
    let remaining = offset;
    while (remaining > 0) {
        const want = Math.min(CHUNK_SIZE, remaining);
        const bytes = await streamReadBytesAsync(
            stream,
            want,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );
        const data = bytes.get_data();
        if (!data || bytes.get_size() === 0) break;
        checksum.update(data);
        remaining -= bytes.get_size();
    }
    await streamCloseAsync(stream, GLib.PRIORITY_DEFAULT, null).catch(() => {});
}

/** Atomic rename via Gio.File.set_display_name, falling back to a sync move. */
async function renameAtomic(from: string, to: string): Promise<void> {
    const fromFile = Gio.File.new_for_path(from);
    // set_display_name is atomic on the same filesystem (the .part lives in
    // the same dir as the destination), which is the common case here.
    try {
        await fileSetDisplayNameAsync(
            fromFile,
            GLib.path_get_basename(to),
            GLib.PRIORITY_DEFAULT,
            null
        );
        return;
    } catch {
        // Cross-filesystem fallback: Gio.File.move is synchronous and accepts
        // a progress callback (null here). Rare path, so blocking is fine.
        await safeDelete(to);
        fromFile.move(
            Gio.File.new_for_path(to),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null
        );
    }
}

/** Best-effort delete; never rejects. */
async function safeDelete(path: string): Promise<void> {
    try {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null)) {
            await fileDeleteAsync(file, GLib.PRIORITY_DEFAULT, null);
        }
    } catch {
        // ignore — partial cleanup is best-effort
    }
}

function isErrorCancelled(e: unknown): boolean {
    if (e instanceof GLib.Error) {
        return e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
    }
    return false;
}

function errMessage(e: unknown): string {
    return e instanceof GLib.Error ? e.message : String(e);
}

/** Process-wide singleton (the Soup.Session is expensive to create). */
let _downloader: ModelDownloader | null = null;
export function getModelDownloader(): ModelDownloader {
    if (!_downloader) _downloader = new ModelDownloader();
    return _downloader;
}
