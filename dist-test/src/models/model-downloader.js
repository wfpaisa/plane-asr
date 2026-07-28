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
 * Los envoltorios en Promise de las APIs async de GJS/GIO viven en
 * ../util/gio-async.js, compartidos con el descargador del motor
 * (engine-downloader.ts), que sigue el mismo patrón streaming + checksum +
 * renombrado atómico para el binario `transcribe-cli`.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { getModelStore } from './model-store.js';
import { CHUNK_SIZE, errMessage, fileAppendToAsync, fileQueryInfoAsync, fileReplaceAsync, hashOfFile, hashPrefix, isErrorCancelled, renameAtomic, safeDelete, soupSendAsync, streamCloseAsync, streamReadBytesAsync, streamWriteBytesAsync, } from '../util/gio-async.js';
/** URL de resolución de HuggingFace para un archivo concreto de un repo. */
export function hfResolveUrl(repo, filename) {
    return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}
/** Intervalo mínimo entre emisiones de progreso (ms). */
const PROGRESS_THROTTLE_MS = 250;
/**
 * Descargador de modelos de HuggingFace. Mantiene una `Soup.Session` de
 * larga duración compartida entre descargas. Es seguro mantenerlo como
 * singleton.
 */
export class ModelDownloader {
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
    async download(entry, file, modelDir) {
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
            const actual = await hashOfFile(partPath, checksumTypeFor(file.sha256), cancellable);
            if (actual !== file.sha256) {
                await safeDelete(partPath);
                throw new Error(`Hash mismatch for ${file.filename} ` +
                    `(expected ${file.sha256}, got ${actual})`);
            }
            await renameAtomic(partPath, destPath);
            store.markComplete(entry.id);
            return { ok: true };
        }
        catch (e) {
            const cancelled = isErrorCancelled(e);
            if (cancelled) {
                // Conserva el .part para que el próximo intento reanude.
                store.markCancelled(entry.id);
                return { ok: false, cancelled: true, error: errMessage(e) };
            }
            store.markFailed(entry.id, errMessage(e));
            return { ok: false, cancelled: false, error: errMessage(e) };
        }
    }
    /** Cancela una descarga en curso por id de modelo (no-op si ninguna está activa). */
    cancel(modelId) {
        getModelStore().getActiveDownload(modelId)?.cancellable.cancel();
    }
    /** Borra un archivo de modelo ya descargado (solo la ruta final; no deja `.part`). */
    async delete(entry, file, modelDir) {
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
    async _downloadToFile(entry, file, partPath, cancellable) {
        const url = hfResolveUrl(entry.repo, file.filename);
        const msg = Soup.Message.new('GET', url);
        // Sondea el parcial existente para calcular un offset de reanudación.
        let resumeOffset = 0;
        const partFile = Gio.File.new_for_path(partPath);
        if (partFile.query_exists(null)) {
            try {
                const info = await fileQueryInfoAsync(partFile, 'standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
                resumeOffset = info.get_size();
            }
            catch {
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
        let outStream;
        if (resumeOffset > 0) {
            msg.request_headers.append('Range', `bytes=${resumeOffset}-`);
            outStream = await fileAppendToAsync(partFile, Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
            await hashPrefix(checksum, partPath, resumeOffset, cancellable);
            received = resumeOffset;
        }
        else {
            outStream = await fileReplaceAsync(partFile, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, GLib.PRIORITY_DEFAULT, cancellable);
        }
        // Envía la petición y obtiene el flujo del cuerpo (Soup sigue redirecciones).
        const inputStream = await soupSendAsync(this._session, msg, GLib.PRIORITY_DEFAULT, cancellable);
        // Si pedimos un rango pero el servidor lo ignoró (200 en vez de 206),
        // reinicia limpiamente para no añadir una segunda copia del prefijo.
        const status = msg.get_status();
        if (resumeOffset > 0 && status !== Soup.Status.PARTIAL_CONTENT) {
            await streamCloseAsync(outStream, GLib.PRIORITY_DEFAULT, null).catch(() => { });
            await safeDelete(partPath);
            return this._downloadToFile(entry, file, partPath, cancellable);
        }
        const total = resolveTotal(msg, file.size_bytes, resumeOffset);
        let lastEmit = 0;
        for (;;) {
            const bytes = await streamReadBytesAsync(inputStream, CHUNK_SIZE, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (size === 0)
                break;
            const data = bytes.get_data();
            if (data)
                checksum.update(data);
            await streamWriteBytesAsync(outStream, bytes, GLib.PRIORITY_DEFAULT, cancellable);
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
function resolveTotal(msg, catalogSize, resumeOffset) {
    const range = msg.response_headers.get_one('Content-Range');
    if (range) {
        const m = range.match(/\/(\d+)/);
        if (m)
            return parseInt(m[1], 10);
    }
    const len = msg.response_headers.get_content_length();
    if (len > 0)
        return len + resumeOffset;
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
function checksumTypeFor(hash) {
    return hash.length === 40
        ? GLib.ChecksumType.SHA1
        : GLib.ChecksumType.SHA256;
}
/** Singleton a nivel de proceso (crear una Soup.Session es costoso). */
let _downloader = null;
export function getModelDownloader() {
    if (!_downloader)
        _downloader = new ModelDownloader();
    return _downloader;
}
//# sourceMappingURL=model-downloader.js.map