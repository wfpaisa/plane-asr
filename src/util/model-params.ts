/* model-params.ts
 *
 * Funciones puras para normalizar el string libre del GSetting `model-params`
 * y convertirlo en argumentos para el CLI. Sin importaciones de GNOME/GJS,
 * así que se puede probar con Node normal.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

import {parseArgs} from '../extension/asr-backends.js';

/**
 * Garantiza que un string libre de `model-params` incluya la bandera
 * `-m`/`--model`.
 *
 * Para qué: cuando el usuario configura una ruta de modelo personalizada en
 * la interfaz sin escribir la bandera, se necesita anteponer `-m` para que
 * el CLI la reconozca como ruta de modelo.
 *
 * Qué hace: si el string ya contiene `-m`/`--model`, o está vacío, se
 * devuelve sin cambios. Si no, se trata todo el valor como una ruta de
 * modelo "pelada" y se le antepone `-m`. Cualquier token inicial que no sea
 * una bandera, antes de la primera bandera real, se deja tal cual (caso
 * poco común; la interfaz documenta que aquí va una sola ruta o argumentos
 * completos).
 */
export function ensureModelFlag(params: string): string {
    const trimmed = params.trim();
    if (!trimmed) return params;
    const toks = parseArgs(trimmed);
    if (toks.some(t => t === '-m' || t === '--model')) return params;
    // Bare path: prepend -m. Split off any trailing flags the user may have
    // added after the path (e.g. "/path/to.gguf --foo bar").
    const firstFlagIdx = toks.findIndex(t => t.startsWith('-'));
    if (firstFlagIdx <= 0) {
        // Sin banderas, o el primer token ya es una bandera — se trata todo
        // el valor como la ruta cuando no empieza con '-'.
        if (firstFlagIdx === -1) {
            return `-m ${trimmed}`;
        }
        return params;
    }
    const pathPart = toks.slice(0, firstFlagIdx).join(' ');
    const rest = toks.slice(firstFlagIdx).join(' ');
    return `-m ${pathPart} ${rest}`;
}

/**
 * Extrae las banderas adicionales (los tokens que empiezan con `-`) de un
 * string libre de parámetros, descartando cualquier ruta posicional que las
 * preceda.
 *
 * Para qué: cuando hay un modelo del catálogo activo, su propio `-m <ruta>`
 * se inyecta por separado, así que solo deben sobrevivir las banderas extra
 * que el usuario haya añadido (por ejemplo `--verbose`).
 *
 * Qué hace: tokeniza el string y devuelve todo desde la primera bandera en
 * adelante, descartando cualquier ruta "pelada" al inicio.
 *
 * Los tokens que siguen a una bandera que espera un valor (por ejemplo la
 * ruta después de `-m`) no reciben tratamiento especial: el modo "ruta de
 * modelo personalizada" es la forma documentada de indicar un modelo, así
 * que los parámetros extra de un usuario de catálogo deberían ser banderas
 * simples o pares `bandera valor` donde el valor no parezca una ruta suelta.
 */
export function extractExtraFlags(params: string): string {
    const trimmed = params.trim();
    if (!trimmed) return '';
    const toks = parseArgs(trimmed);
    // Conserva solo los tokens desde la primera bandera en adelante,
    // descartando cualquier ruta suelta al inicio (la ruta del modo custom).
    const firstFlagIdx = toks.findIndex(t => t.startsWith('-'));
    if (firstFlagIdx <= 0) return ''; // sin banderas, o los parámetros son solo una ruta
    return toks.slice(firstFlagIdx).join(' ');
}
