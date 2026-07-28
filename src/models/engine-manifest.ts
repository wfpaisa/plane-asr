/* engine-manifest.ts
 *
 * Metadatos firmados en código del binario `transcribe-cli` (CPU, x86_64)
 * que la extensión ofrece descargar bajo acción explícita del usuario.
 *
 * A diferencia de data/model-catalog.json, este manifiesto es un módulo
 * ESM literal (no un archivo leído en runtime): es pequeño, cambia solo en
 * cada release del motor, y así evita cualquier IO de archivo — el
 * checksum queda fijo en el código ya revisado en vez de obtenerse de la
 * red, para que la descarga solo pueda traer el artefacto exacto que este
 * módulo describe.
 *
 * El binario se compila fuera de este repo (transcribe.cpp, CPU-only) y se
 * publica como asset de un GitHub Release mediante
 * .github/workflows/release-engine.yml quien dispara con tags `engine-v*`.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Una compilación descargable del motor para una arquitectura de CPU dada. */
export interface EngineBuild {
    arch: string;
    filename: string;
    url: string;
    size_bytes: number;
    sha256: string;
}

/** Forma del manifiesto del motor. */
export interface EngineManifest {
    /** Versión del motor (no necesariamente igual a la de la extensión). */
    version: string;
    builds: EngineBuild[];
}

/**
 * Manifiesto activo. Actualizar `version`, `url` y `sha256` en cada release
 * del motor; `sha256` debe calcularse sobre el asset ya publicado antes de
 * hacer commit de este archivo (nunca al revés).
 */
export const ENGINE_MANIFEST: EngineManifest = {
    version: '1.0.2',
    builds: [
        {
            arch: 'x86_64',
            filename: 'transcribe-cli-x86_64',
            url: 'https://github.com/wfpaisa/plane-asr/releases/download/engine-v1.0.2/transcribe-cli-x86_64',
            size_bytes: 4359648,
            sha256:
                '22277aacf37eb5d1badfa6b1be56a4320959d23febffda898ef86fbc67412f85',
        },
    ],
};

/**
 * Arquitectura de CPU asumida en tiempo de ejecución.
 *
 * Qué hace: GJS no expone una API portable para detectar la arquitectura
 * del host, así que — igual que el binario incluido anteriormente, que
 * también era exclusivamente x86_64 — se asume esta única arquitectura
 * hasta que el catálogo ofrezca más de una.
 */
export const CURRENT_ARCH = 'x86_64';

/** Busca la compilación del motor para una arquitectura dada, o null si no hay. */
export function findEngineBuild(
    arch: string = CURRENT_ARCH
): EngineBuild | null {
    return ENGINE_MANIFEST.builds.find(b => b.arch === arch) ?? null;
}
