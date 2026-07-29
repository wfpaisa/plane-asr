/* validate.ts
 *
 * Lógica pura (sin GTK/GJS) para el diagnóstico de "binario y modelo" que
 * muestra la página Backend. Separa qué está mal (aquí, testeable con
 * node --test) de cómo se descubre (Gio.File/GLib, que vive en
 * backend-page.ts junto al resto de la UI).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {parseArgs} from '../extension/asr-backends.js';

/** Extrae la ruta del archivo de modelo desde un string `model-params`, si está presente. */
export function extractModelPath(params: string): string | null {
    const toks = parseArgs(params);
    for (let i = 0; i < toks.length; i++) {
        if ((toks[i] === '-m' || toks[i] === '--model') && toks[i + 1]) {
            return toks[i + 1];
        }
    }
    return toks.find(t => /\.(gguf|bin|onnx|pt)$/i.test(t)) ?? null;
}

/** Estado observado del binario configurado, resuelto por la UI vía Gio.File. */
export type BinaryState =
    /** Modo GPU con el campo de ruta manual dejado en blanco. */
    | {kind: 'unset'}
    /** Modo automático (CPU) sin binario descargado ni en PATH. */
    | {kind: 'unresolved'}
    | {kind: 'resolved'; path: string; exists: boolean; executable: boolean};

/** Estado observado del modelo configurado, resuelto por la UI vía Gio.File. */
export type ModelState =
    /** Ni el catálogo ni model-params apuntan a un archivo. */
    | {kind: 'missing'}
    /** Se encontró una ruta, pero es relativa y no puede verificarse en disco. */
    | {kind: 'relative'; path: string}
    | {kind: 'resolved'; path: string; exists: boolean};

/** Un problema de configuración detectado, con los datos para componer su mensaje. */
export type SetupProblem =
    | {kind: 'binary-path-empty'}
    | {kind: 'binary-unresolved'}
    | {kind: 'binary-not-found'; path: string}
    | {kind: 'binary-not-executable'; path: string}
    | {kind: 'model-not-found'}
    | {kind: 'model-not-on-disk'; path: string}
    | {kind: 'model-path-relative'; path: string};

/** Compone la lista de problemas a partir del estado ya observado del binario. */
function checkBinary(state: BinaryState): SetupProblem[] {
    switch (state.kind) {
        case 'unset':
            return [{kind: 'binary-path-empty'}];
        case 'unresolved':
            return [{kind: 'binary-unresolved'}];
        case 'resolved':
            if (!state.exists) {
                return [{kind: 'binary-not-found', path: state.path}];
            }
            if (!state.executable) {
                return [{kind: 'binary-not-executable', path: state.path}];
            }
            return [];
    }
}

/** Compone la lista de problemas a partir del estado ya observado del modelo. */
function checkModel(state: ModelState): SetupProblem[] {
    switch (state.kind) {
        case 'missing':
            return [{kind: 'model-not-found'}];
        case 'relative':
            return [{kind: 'model-path-relative', path: state.path}];
        case 'resolved':
            return state.exists
                ? []
                : [{kind: 'model-not-on-disk', path: state.path}];
    }
}

/**
 * Agrega los problemas de binario y modelo en un único diagnóstico, en el
 * mismo orden en que la UI los mostraba (binario primero, luego modelo).
 */
export function describeSetupProblems(
    binary: BinaryState,
    model: ModelState
): SetupProblem[] {
    return [...checkBinary(binary), ...checkModel(model)];
}
