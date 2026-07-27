/* cli-resolver.ts
 *
 * Resuelve el binario del CLI de transcripción según el `cli-mode` activo:
 *   - 'cpu' → prefiere el `transcribe-cli` solo-CPU incluido con la
 *             extensión (x86_64), recurriendo a un `transcribe-cli`
 *             encontrado en el PATH. No requiere configuración. Esto es lo
 *             que implementa {@link resolveAutoCli} más abajo.
 *   - 'gpu' → usa la ruta absoluta que el usuario definió en `cli-path`
 *             (por ejemplo, una compilación propia con Vulkan/CUDA);
 *             quien llama la resuelve, no este módulo.
 *
 * Esto refleja el GSetting `cli-mode` documentado en src/config/settings.ts
 * (los valores heredados 'auto'/'manual' migran a 'cpu'/'gpu'). Las
 * funciones son puras (sin subproceso), así que son baratas de llamar tanto
 * desde el chequeo previo del servicio como desde el constructor de argv
 * del transcriptor, y también desde la interfaz de preferencias para
 * mostrar el estado.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
/** Componentes de ruta, bajo la raíz de la extensión, del binario del CLI incluido. */
const BUNDLED_SUBPATH = ['bin', 'transcribe-cli'];
/**
 * Ruta absoluta del CLI incluido con la extensión:
 * `${extensionDir}/bin/transcribe-cli`. Devuelve '' cuando no hay directorio de extensión.
 */
export function bundledCliPath(extensionDir) {
    if (!extensionDir)
        return '';
    return GLib.build_filenamev([extensionDir, ...BUNDLED_SUBPATH]);
}
/**
 * Indica si el binario incluido existe y es ejecutable. Es falso cuando no
 * hay binario incluido para la arquitectura en ejecución (ej. hosts que no
 * son x86_64).
 */
export function bundledCliAvailable(extensionDir) {
    const p = bundledCliPath(extensionDir);
    if (!p)
        return false;
    const file = Gio.File.new_for_path(p);
    if (!file.query_exists(null))
        return false;
    try {
        const info = file.query_info('access::can-execute', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_boolean('access::can-execute');
    }
    catch {
        // Error de permisos o similar — se trata como no disponible para que
        // quien llama recurra al respaldo / reporte un mensaje claro en vez
        // de fallar.
        return false;
    }
}
/** Busca un CLI por nombre en el PATH. Devuelve null si no se encuentra. */
export function findCliInPath(name) {
    return GLib.find_program_in_path(name) ?? null;
}
/**
 * Resuelve el binario para el modo automático: primero el binario incluido,
 * luego el PATH.
 *
 * Qué hace: nunca lanza excepción; devuelve `source: 'none'` cuando no hay
 * nada usable disponible, para que quien llama pueda mostrar un error claro.
 */
export function resolveAutoCli(extensionDir, pathName) {
    if (bundledCliAvailable(extensionDir)) {
        return { path: bundledCliPath(extensionDir), source: 'bundled' };
    }
    const found = pathName ? findCliInPath(pathName) : null;
    if (found)
        return { path: found, source: 'path' };
    return { path: '', source: 'none' };
}
//# sourceMappingURL=cli-resolver.js.map