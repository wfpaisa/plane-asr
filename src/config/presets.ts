/* presets.ts
 *
 * Perfiles de procesamiento predefinidos para Plane ASR. Cada preset es un
 * mapa clave→valor de GSettings que ajusta cómo se procesa el audio
 * (tiempo real vs troceado, solapamiento, hilos), sin tocar las claves de
 * hardware (cli-mode/accelerator/gpu-device): esas tienen lógica
 * interdependiente resuelta en runtime, así que un preset que las fijara
 * podría dejar la configuración en un estado incoherente.
 *
 * El módulo es puro (sin GTK/GJS): expone los datos y la lógica de "adivinar
 * el preset activo", mientras que aplicar los valores (settings.set_*) vive en
 * la UI. Esto lo hace testeable con node --test.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {SETTINGS_KEYS} from './settings.js';

/** Identificadores estables de los presets ofrecidos. */
export type PresetId = 'fast' | 'balanced' | 'accurate';

/** Orden de presentación en la UI. */
export const PRESET_IDS: readonly PresetId[] = ['fast', 'balanced', 'accurate'];

/** Mapa clave de GSettings → valor que aplica un preset. */
export type PresetValues = Readonly<Record<string, boolean | number>>;

/**
 * Valores por preset. Los tres fijan exactamente el mismo conjunto de claves
 * (así "adivinar el activo" es inequívoco) con tuplas de valores distintas:
 *
 *  - `fast`: tiempo real activo (streaming inmediato, sin troceo en vivo),
 *    la menor latencia — ideal para dictado corto.
 *  - `balanced`: troceo en vivo con solapamiento mínimo — buen compromiso
 *    entre latencia y no perder palabras en las costuras.
 *  - `accurate`: trozos más cortos y mayor solapamiento (más
 *    re-transcripción en las costuras) — prioriza completitud sobre
 *    velocidad, para grabaciones largas.
 */
export const PRESETS: Readonly<Record<PresetId, PresetValues>> = {
    fast: {
        [SETTINGS_KEYS.REALTIME_MODE]: true,
        [SETTINGS_KEYS.CHUNK_ENABLED]: false,
        [SETTINGS_KEYS.CHUNK_SECONDS]: 20,
        [SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS]: 0,
        [SETTINGS_KEYS.CPU_THREADS]: 0,
    },
    balanced: {
        [SETTINGS_KEYS.REALTIME_MODE]: false,
        [SETTINGS_KEYS.CHUNK_ENABLED]: true,
        [SETTINGS_KEYS.CHUNK_SECONDS]: 20,
        [SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS]: 1,
        [SETTINGS_KEYS.CPU_THREADS]: 0,
    },
    accurate: {
        [SETTINGS_KEYS.REALTIME_MODE]: false,
        [SETTINGS_KEYS.CHUNK_ENABLED]: true,
        [SETTINGS_KEYS.CHUNK_SECONDS]: 15,
        [SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS]: 2,
        [SETTINGS_KEYS.CPU_THREADS]: 0,
    },
};

/** Devuelve los pares [clave, valor] de un preset, para aplicarlos en la UI. */
export function presetEntries(id: PresetId): [string, boolean | number][] {
    return Object.entries(PRESETS[id]);
}

/**
 * Devuelve el id del preset cuyo mapa completo coincide con el estado actual,
 * o `null` si ninguno lo hace (configuración personalizada). Compara solo las
 * claves que el preset define, así que otras claves (idioma, salida, atajos)
 * no afectan la coincidencia.
 */
export function guessActivePreset(
    current: Record<string, boolean | number>
): PresetId | null {
    for (const id of PRESET_IDS) {
        const values = PRESETS[id];
        const matches = Object.keys(values).every(
            key => current[key] === values[key]
        );
        if (matches) return id;
    }
    return null;
}
