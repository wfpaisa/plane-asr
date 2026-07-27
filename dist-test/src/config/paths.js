/* paths.ts
 *
 * Fuente única de verdad para todas las rutas del sistema de archivos que
 * usa la extensión bajo el directorio de caché del usuario. Mantiene la
 * disposición en disco en un solo lugar para que grabaciones, trozos en
 * vivo y modelos nunca se desincronicen entre sí.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
/** Nombre del directorio de nivel superior que posee esta extensión dentro de la caché del usuario. */
const CACHE_DIR_NAME = 'planeasr';
/** Patrón de nombre para grabaciones finalizadas (`recording_<microsegundos>.wav`). */
const RECORDING_RE = /^recording_\d+\.wav$/i;
/**
 * Directorio raíz de caché: `<caché-usuario>/planeasr`.
 *
 * Qué hace: construye la ruta absoluta combinando el directorio de caché
 * del usuario (provisto por GLib) con el nombre reservado de la extensión.
 */
export function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), CACHE_DIR_NAME]);
}
/**
 * Directorio donde se persisten las grabaciones WAV:
 * `<caché-usuario>/planeasr/records`.
 */
export function recordsDir() {
    return GLib.build_filenamev([cacheDir(), 'records']);
}
/**
 * Directorio de modelos por defecto: `<caché-usuario>/planeasr/models`.
 * Se puede sobreescribir explícitamente mediante el GSetting `model-dir`
 * cuando no está vacío (ver {@link resolveModelDir}).
 */
export function defaultModelDir() {
    return GLib.build_filenamev([cacheDir(), 'models']);
}
/**
 * Poda las grabaciones finalizadas bajo {@link recordsDir} para que como
 * máximo sobrevivan las `keep` más recientes.
 *
 * Para qué: evitar que el directorio de grabaciones crezca sin límite,
 * respetando la preferencia del usuario de cuántas conservar (GSetting
 * `keep-records`).
 *
 * Qué hace: enumera los archivos que cumplen el patrón de nombre de
 * grabación, los ordena (el nombre incluye microsegundos, así que el orden
 * lexicográfico coincide con el cronológico) y borra los más antiguos hasta
 * dejar solo `keep`. Los archivos temporales de trozos `_live*.wav` no se
 * tocan (el streamer los limpia por su cuenta).
 *
 * @param keep  Cuántas grabaciones conservar. `<= 0` significa no conservar ninguna.
 */
export function pruneRecordings(keep) {
    if (keep < 0)
        keep = 0;
    const dir = recordsDir();
    const file = Gio.File.new_for_path(dir);
    let iter;
    try {
        iter = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    }
    catch {
        return; // el directorio no existe o no se puede leer — nada que podar
    }
    const names = [];
    try {
        let info = iter.next_file(null);
        while (info !== null) {
            if (info.get_file_type() === Gio.FileType.REGULAR &&
                RECORDING_RE.test(info.get_name())) {
                names.push(info.get_name());
            }
            info = iter.next_file(null);
        }
    }
    finally {
        iter.close(null);
    }
    if (names.length <= keep)
        return;
    // Las más antiguas primero: borra todo antes del corte (names.length - keep).
    names.sort();
    const toDelete = names.slice(0, names.length - keep);
    for (const name of toDelete) {
        const victim = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
        try {
            victim.delete(null);
        }
        catch {
            // Mejor esfuerzo: un borrado fallido (ej. archivo bloqueado) no es fatal.
        }
    }
}
//# sourceMappingURL=paths.js.map