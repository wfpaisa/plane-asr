/* engine-downloader.ts
 *
 * Descargador por streaming del binario `transcribe-cli` (motor CPU),
 * apoyado en libsoup 3.0. Sigue el mismo patrón que model-downloader.ts:
 * descarga a un `.part` con soporte de reanudación (HTTP Range),
 * verificación de SHA-256 y renombrado atómico — pero solo marca el
 * archivo como ejecutable *después* de que el hash coincide con
 * {@link ENGINE_MANIFEST}, así que un binario a medio descargar o
 * manipulado nunca queda en condiciones de ejecutarse.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import type {EngineBuild} from './engine-manifest.js';
import {getEngineStore} from './engine-store.js';
import {
    CHUNK_SIZE,
    errMessage,
    fileAppendToAsync,
    fileQueryInfoAsync,
    fileReplaceAsync,
    hashOfFile,
    hashPrefix,
    isErrorCancelled,
    renameAtomic,
    safeDelete,
    soupSendAsync,
    streamCloseAsync,
    streamReadBytesAsync,
    streamWriteBytesAsync,
} from '../util/gio-async.js';

/** Intervalo mínimo entre emisiones de progreso (ms). */
const PROGRESS_THROTTLE_MS = 250;

/** Resultado de un intento de descarga del motor. */
export type EngineDownloadOutcome =
    | {ok: true; path: string}
    | {ok: false; cancelled: boolean; error: string};

/** Descargador del binario del motor. Mantiene una `Soup.Session` propia. */
export class EngineDownloader {
    private _session: Soup.Session;

    constructor() {
        this._session = new Soup.Session({
            user_agent: 'plane-asr',
            timeout: 0,
        });
    }

    /**
     * Descarga (o reanuda) `build` hacia `destPath` (la ruta final
     * versionada, ej. `engineBinaryPath(build_version)`).
     *
     * Qué hace: descarga a `<destPath>.part`, calcula su SHA-256 y lo
     * compara contra `build.sha256`; solo si coincide lo renombra al
     * nombre final y lo marca ejecutable (`chmod 0755`). Si el hash no
     * coincide, borra el parcial para que el siguiente intento empiece
     * limpio. El progreso y el estado se publican vía {@link EngineStore}.
     */
    async download(
        build: EngineBuild,
        destPath: string
    ): Promise<EngineDownloadOutcome> {
        const store = getEngineStore();
        const cancellable = new Gio.Cancellable();
        store.markStarted(cancellable);

        const partPath = `${destPath}.part`;

        try {
            await this._downloadToFile(build, partPath, cancellable);
            const actual = await hashOfFile(
                partPath,
                GLib.ChecksumType.SHA256,
                cancellable
            );
            if (actual !== build.sha256) {
                await safeDelete(partPath);
                throw new Error(
                    `Hash mismatch for ${build.filename} ` +
                        `(expected ${build.sha256}, got ${actual})`
                );
            }
            await renameAtomic(partPath, destPath);
            markExecutable(destPath);
            store.markComplete();
            return {ok: true, path: destPath};
        } catch (e) {
            const cancelled = isErrorCancelled(e);
            if (cancelled) {
                store.markCancelled();
                return {ok: false, cancelled: true, error: errMessage(e)};
            }
            store.markFailed(errMessage(e));
            return {ok: false, cancelled: false, error: errMessage(e)};
        }
    }

    /** Cancela la descarga en curso (no-op si ninguna está activa). */
    cancel(): void {
        getEngineStore().cancel();
    }

    // -- internos -----------------------------------------------------------

    private async _downloadToFile(
        build: EngineBuild,
        partPath: string,
        cancellable: Gio.Cancellable
    ): Promise<void> {
        const msg = Soup.Message.new('GET', build.url);

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
                resumeOffset = 0;
            }
        }

        const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
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

        const inputStream = await soupSendAsync(
            this._session,
            msg,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );

        const status = msg.get_status();
        if (resumeOffset > 0 && status !== Soup.Status.PARTIAL_CONTENT) {
            await streamCloseAsync(
                outStream,
                GLib.PRIORITY_DEFAULT,
                null
            ).catch(() => {});
            await safeDelete(partPath);
            return this._downloadToFile(build, partPath, cancellable);
        }

        // Descarga nueva: exige un 200. Sin esto, un 404/redirección/página de
        // error se escribiría al `.part` y luego fallaría la verificación de
        // hash con un "Hash mismatch" engañoso (la causa real es que el asset
        // del release no existe o la URL cambió), en vez de un error legible.
        if (resumeOffset === 0 && status !== Soup.Status.OK) {
            await streamCloseAsync(
                outStream,
                GLib.PRIORITY_DEFAULT,
                null
            ).catch(() => {});
            await safeDelete(partPath);
            throw new Error(
                `Download failed for ${build.filename}: HTTP ${status} ` +
                    `${msg.get_reason_phrase() ?? ''} — ${build.url}`.trim()
            );
        }

        const total = resolveTotal(msg, build.size_bytes, resumeOffset);
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
                getEngineStore().markProgress(received, total);
            }
        }

        await streamCloseAsync(outStream, GLib.PRIORITY_DEFAULT, cancellable);
        getEngineStore().markProgress(total, total);
    }
}

/**
 * Deriva el total de bytes esperado a partir de la respuesta, igual que en
 * model-downloader.ts.
 */
function resolveTotal(
    msg: Soup.Message,
    manifestSize: number,
    resumeOffset: number
): number {
    const range = msg.response_headers.get_one('Content-Range');
    if (range) {
        const m = range.match(/\/(\d+)/);
        if (m) return parseInt(m[1], 10);
    }
    const len = msg.response_headers.get_content_length();
    if (len > 0) return len + resumeOffset;
    return manifestSize;
}

/** Marca `path` como ejecutable (0755) — se llama solo tras verificar el hash. */
function markExecutable(path: string): void {
    const file = Gio.File.new_for_path(path);
    file.set_attribute_uint32(
        'unix::mode',
        0o755,
        Gio.FileQueryInfoFlags.NONE,
        null
    );
}

/** Singleton a nivel de proceso (crear una Soup.Session es costoso). */
let _downloader: EngineDownloader | null = null;
export function getEngineDownloader(): EngineDownloader {
    if (!_downloader) _downloader = new EngineDownloader();
    return _downloader;
}
