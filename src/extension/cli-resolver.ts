/* cli-resolver.ts
 *
 * Resuelve el binario del CLI de transcripción según el `cli-mode` activo:
 *   - 'cpu' → prefiere un `transcribe-cli` encontrado en el PATH (por
 *             ejemplo, instalado por el sistema o compilado por el
 *             usuario), recurriendo al binario del motor descargado bajo
 *             {@link engineBinaryPath} — nunca se incluye un ejecutable
 *             dentro de la extensión (ver EGO-P-005 en la guía de revisión
 *             de gjs.guide: las extensiones no deben incluir binarios). El
 *             usuario dispara la descarga explícitamente desde la página
 *             "Setup" de preferencias; {@link resolveAutoCli} solo resuelve
 *             qué ya hay disponible en el sistema.
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

import {engineBinaryPath} from '../config/paths.js';
import {ENGINE_MANIFEST} from '../models/engine-manifest.js';

/** Resultado de una búsqueda de binario en modo automático, para runtime e interfaz. */
export interface ResolvedCli {
    /** Ruta absoluta al binario a invocar, o '' cuando no hay nada usable. */
    path: string;
    /** De dónde vino la ruta, para diagnóstico y pistas en la interfaz. */
    source: 'path' | 'downloaded' | 'none';
}

/**
 * Ruta donde vivirá el binario del motor una vez descargado por el usuario:
 * `<datos-usuario>/planeasr/bin/transcribe-cli-<versión del manifiesto>`.
 */
export function downloadedCliPath(
    version: string = ENGINE_MANIFEST.version
): string {
    return engineBinaryPath(version);
}

/**
 * Indica si el binario del motor descargado existe y es ejecutable. Es
 * falso antes de la primera descarga, o si el usuario la borró.
 */
export function downloadedCliAvailable(
    version: string = ENGINE_MANIFEST.version
): boolean {
    const p = downloadedCliPath(version);
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
        // Error de permisos o similar — se trata como no disponible para que
        // quien llama recurra al respaldo / reporte un mensaje claro en vez
        // de fallar.
        return false;
    }
}

/** Busca un CLI por nombre en el PATH. Devuelve null si no se encuentra. */
export function findCliInPath(name: string): string | null {
    return GLib.find_program_in_path(name) ?? null;
}

/**
 * Resuelve el binario para el modo automático: primero el PATH, luego el
 * binario del motor descargado.
 *
 * Qué hace: nunca lanza excepción; devuelve `source: 'none'` cuando no hay
 * nada usable disponible, para que quien llama pueda mostrar un error claro
 * (o, en preferencias, el botón de descarga).
 *
 * El PATH tiene prioridad sobre el binario descargado: si el usuario ya
 * instaló `transcribe-cli` por su distro/gestor de paquetes, no tiene
 * sentido descargar una segunda copia.
 */
export function resolveAutoCli(pathName: string): ResolvedCli {
    const found = pathName ? findCliInPath(pathName) : null;
    if (found) return {path: found, source: 'path'};
    if (downloadedCliAvailable()) {
        return {path: downloadedCliPath(), source: 'downloaded'};
    }
    return {path: '', source: 'none'};
}
