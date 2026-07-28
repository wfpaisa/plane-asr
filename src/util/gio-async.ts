/* gio-async.ts
 *
 * Envoltorios en Promise para las APIs async de estilo callback de GJS/GIO,
 * compartidos por los descargadores de modelos y del motor de transcripción
 * (ambos transmiten un archivo por streaming, lo verifican por checksum y lo
 * renombran de forma atómica).
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

/** Buffer de streaming de 1 MiB — suficientemente pequeño para poca memoria, suficientemente grande para buen rendimiento. */
export const CHUNK_SIZE = 1024 * 1024;

/** Envuelve en una Promise el abridor async de flujo de archivo (para escritura). */
export function fileReplaceAsync(
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
export function fileAppendToAsync(
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
export function fileQueryInfoAsync(
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
export function fileReadAsync(
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
export function fileSetDisplayNameAsync(
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
export function fileDeleteAsync(
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
export function streamReadBytesAsync(
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
export function streamWriteBytesAsync(
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
export function streamCloseAsync(
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
export function soupSendAsync(
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

/** Calcula el hash de contenido de un archivo completo por streaming (bajo consumo de memoria). */
export async function hashOfFile(
    path: string,
    type: GLib.ChecksumType,
    cancellable: Gio.Cancellable | null
): Promise<string> {
    const checksum = new GLib.Checksum(type);
    const file = Gio.File.new_for_path(path);
    const stream = await fileReadAsync(file, GLib.PRIORITY_DEFAULT, cancellable);
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
export async function hashPrefix(
    checksum: GLib.Checksum,
    path: string,
    offset: number,
    cancellable: Gio.Cancellable | null
): Promise<void> {
    const file = Gio.File.new_for_path(path);
    const stream = await fileReadAsync(file, GLib.PRIORITY_DEFAULT, cancellable);
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
export async function renameAtomic(from: string, to: string): Promise<void> {
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
export async function safeDelete(path: string): Promise<void> {
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
export function isErrorCancelled(e: unknown): boolean {
    if (e instanceof GLib.Error) {
        return e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED);
    }
    return false;
}

/** Extrae un mensaje legible de cualquier error capturado. */
export function errMessage(e: unknown): string {
    return e instanceof GLib.Error ? e.message : String(e);
}
