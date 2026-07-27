/* model-downloader.ts
 *
 * Descargador de modelos por streaming, apoyado en libsoup 3.0. Descarga
 * archivos GGUF desde HuggingFace con soporte de reanudación (HTTP Range),
 * verificación incremental de SHA-256, cancelación y reporte de progreso
 * con limitación de frecuencia.
 *
 * La descarga nunca carga el archivo completo en memoria: los bytes fluyen
 * red -> buffer de 1 MiB -> archivo de salida -> checksum, así que funciona
 * incluso con modelos de varios GB.
 *
 * NOTA sobre el estilo async: los métodos async de GJS/GI requieren un
 * callback de estilo C y NO respetan de forma confiable los overloads con
 * promesas ni `Gio._promisify` en todos los runtimes (el parche del
 * prototipo puede perderse silenciosamente para métodos nativos). Por eso
 * cada operación asíncrona aquí se envuelve en una Promise hecha a mano que
 * invoca el método con su firma de callback nativa, que es la única forma
 * garantizada de funcionar.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import type {ModelEntry, ModelFile} from './catalog.js';
import {getModelStore} from './model-store.js';

/** URL de resolución de HuggingFace para un archivo concreto de un repo. */
export function hfResolveUrl(repo: string, filename: string): string {
    return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

/** Buffer de streaming de 1 MiB — suficientemente pequeño para poca memoria, suficientemente grande para buen rendimiento. */
const CHUNK_SIZE = 1024 * 1024;
/** Intervalo mínimo entre emisiones de progreso (ms). */
const PROGRESS_THROTTLE_MS = 250;

/** Resultado de un intento de descarga. */
export type DownloadOutcome =
    {ok: true} | {ok: false; cancelled: boolean; error: string};

// =============================================================================
// Envoltorios en Promise para los métodos async de GJS (firma de callback
// nativa). Cada uno llama al método con su callback requerido
// `(source, result) => ...` y resuelve/rechaza desde ahí. Esta es la ÚNICA
// forma async que GJS soporta de manera confiable.
// =============================================================================

/** Envuelve en una Promise el abridor async de flujo de archivo (para escritura). */
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

/** Envoltorio async de "append" (la ruta de reanudación abre el parcial existente para añadir al final). */
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

/** Envoltorio de query_info_async. */
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

/** Envoltorio de read_async (abre un FileInputStream). */
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

/** Envoltorio de set_display_name_async. */
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

/** Envoltorio de delete_async. */
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

/** Envoltorio de InputStream.read_bytes_async. */
function streamReadBytesAsync(
    stream: Gio.InputStream,
    count: number,
    ioPriority: number,
    cancellable: Gio.Cancellable | null
): Promise<GLib.Bytes> {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(count, ioPriority, cancellable, (_src, res) => {
            try {
                resolve(stream.read_bytes_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Envoltorio de OutputStream.write_bytes_async. */
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

/** Envoltorio de OutputStream/InputStream.close_async. */
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

/** Envoltorio de Soup.Session.send_async (devuelve el InputStream del cuerpo). */
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
 * Descargador de modelos de HuggingFace. Mantiene una `Soup.Session` de
 * larga duración compartida entre descargas. Es seguro mantenerlo como
 * singleton.
 */
export class ModelDownloader {
    private _session: Soup.Session;

    constructor() {
        this._session = new Soup.Session({
            user_agent: 'plane-asr',
            // Sin timeout de socket: los modelos grandes pueden atascarse
            // brevemente en conexiones lentas.
            timeout: 0,
        });
    }

    /**
     * Descarga (o reanuda) `file` de `entry` hacia `modelDir`.
     *
     * Para qué: obtener el archivo de modelo de forma confiable incluso con
     * conexiones inestables, verificando su integridad antes de darlo por
     * bueno.
     *
     * Qué hace: descarga el archivo a un `.part` temporal (reanudando si ya
     * existe uno parcial), calcula su SHA-256/SHA-1 y lo compara contra el
     * catálogo, y solo si coincide renombra el `.part` al nombre final.
     * Resuelve una vez que el archivo está en disco y su hash coincide con
     * el catálogo. La cancelación resuelve con `{ok:false, cancelled:true}`.
     * Si el hash no coincide, se borra el archivo parcial para que el
     * siguiente intento empiece limpio.
     *
     * El progreso y el estado se publican a través del {@link ModelStore} global.
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
            // Verifica el hash de contenido contra el oid del catálogo antes de
            // promover el archivo. El algoritmo se elige según la longitud del
            // oid (SHA-1 para Xet de 40 hex, SHA-256 para LFS de 64 hex).
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
                // Conserva el .part para que el próximo intento reanude.
                store.markCancelled(entry.id);
                return {ok: false, cancelled: true, error: errMessage(e)};
            }
            store.markFailed(entry.id, errMessage(e));
            return {ok: false, cancelled: false, error: errMessage(e)};
        }
    }

    /** Cancela una descarga en curso por id de modelo (no-op si ninguna está activa). */
    cancel(modelId: string): void {
        getModelStore().getActiveDownload(modelId)?.cancellable.cancel();
    }

    /** Borra un archivo de modelo ya descargado (solo la ruta final; no deja `.part`). */
    async delete(
        entry: ModelEntry,
        file: ModelFile,
        modelDir: string
    ): Promise<void> {
        await safeDelete(`${modelDir}/${file.filename}`);
        getModelStore().markDeleted(entry.id);
    }

    // -- internos -----------------------------------------------------------

    /**
     * Transmite `file` por streaming hacia `partPath`, reanudando desde un
     * `.part` existente cuando lo hay.
     *
     * Qué hace: reanuda enviando una cabecera HTTP `Range:`; si el servidor
     * la ignora (reenvía todo con un 200 en vez de 206), el parcial se
     * descarta y la descarga reinicia desde el byte 0.
     */
    private async _downloadToFile(
        entry: ModelEntry,
        file: ModelFile,
        partPath: string,
        cancellable: Gio.Cancellable
    ): Promise<void> {
        const url = hfResolveUrl(entry.repo, file.filename);
        const msg = Soup.Message.new('GET', url);

        // Sondea el parcial existente para calcular un offset de reanudación.
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
                resumeOffset = 0; // ignora el fallo del sondeo, reinicia desde cero
            }
        }

        // El checksum debe cubrir el archivo completo, así que al reanudar
        // primero se hashea el prefijo que ya está en disco y luego se
        // continúa con la cola nueva. El algoritmo coincide con la longitud
        // del oid del catálogo (SHA-1 para Xet, SHA-256 para LFS) para que
        // el digest final se compare igual a file.sha256.
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

        // Envía la petición y obtiene el flujo del cuerpo (Soup sigue redirecciones).
        const inputStream = await soupSendAsync(
            this._session,
            msg,
            GLib.PRIORITY_DEFAULT,
            cancellable
        );

        // Si pedimos un rango pero el servidor lo ignoró (200 en vez de 206),
        // reinicia limpiamente para no añadir una segunda copia del prefijo.
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
        // Emisión final de progreso para que la interfaz muestre 100%.
        getModelStore().markProgress(entry.id, total, total);
    }
}

/**
 * Deriva el total de bytes esperado a partir de la respuesta. Para un 206,
 * `Content-Range` trae `bytes start-end/total`; para un 200 se recurre al
 * tamaño del catálogo más cualquier prefijo reanudado.
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
 * Elige el algoritmo de checksum según la longitud del hash del catálogo.
 *
 * HuggingFace expone el oid del archivo mediante su API de árbol: 40
 * caracteres hex significa que el archivo vive en almacenamiento Xet y el
 * oid es SHA-1; 64 caracteres hex significa Git-LFS clásico con un oid
 * SHA-256. Calcular con el algoritmo equivocado garantiza una discrepancia,
 * así que el tipo se elige por archivo.
 */
function checksumTypeFor(hash: string): GLib.ChecksumType {
    return hash.length === 40
        ? GLib.ChecksumType.SHA1
        : GLib.ChecksumType.SHA256;
}

/** Calcula el hash de contenido de un archivo completo por streaming (bajo consumo de memoria). */
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

/** Alimenta los primeros `offset` bytes de `path` a `checksum` (ruta de reanudación). */
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

/** Renombrado atómico vía Gio.File.set_display_name, con reserva de mover de forma síncrona. */
async function renameAtomic(from: string, to: string): Promise<void> {
    const fromFile = Gio.File.new_for_path(from);
    // set_display_name es atómico dentro del mismo sistema de archivos (el
    // .part vive en el mismo directorio que el destino), que es el caso
    // común aquí.
    try {
        await fileSetDisplayNameAsync(
            fromFile,
            GLib.path_get_basename(to),
            GLib.PRIORITY_DEFAULT,
            null
        );
        return;
    } catch {
        // Reserva entre sistemas de archivos: Gio.File.move es síncrono y
        // acepta un callback de progreso (null aquí). Es una ruta poco
        // frecuente, así que bloquear está bien.
        await safeDelete(to);
        fromFile.move(
            Gio.File.new_for_path(to),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null
        );
    }
}

/** Borrado en modo "mejor esfuerzo"; nunca rechaza la promesa. */
async function safeDelete(path: string): Promise<void> {
    try {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null)) {
            await fileDeleteAsync(file, GLib.PRIORITY_DEFAULT, null);
        }
    } catch {
        // ignora — la limpieza parcial es solo mejor esfuerzo
    }
}

/** Indica si el error capturado corresponde a una cancelación del Cancellable. */
function isErrorCancelled(e: unknown): boolean {
    if (e instanceof GLib.Error) {
        return e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
    }
    return false;
}

/** Extrae un mensaje legible de cualquier error capturado. */
function errMessage(e: unknown): string {
    return e instanceof GLib.Error ? e.message : String(e);
}

/** Singleton a nivel de proceso (crear una Soup.Session es costoso). */
let _downloader: ModelDownloader | null = null;
export function getModelDownloader(): ModelDownloader {
    if (!_downloader) _downloader = new ModelDownloader();
    return _downloader;
}
