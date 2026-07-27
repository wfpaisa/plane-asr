/* catalog.ts
 *
 * Tipos y cargador para el catálogo de modelos incluido sin conexión
 * (data/model-catalog.json). Lo comparten el runtime de la extensión y la
 * interfaz de preferencias, para que ambos vean la misma lista de modelos
 * sin necesidad de una llamada de red.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {defaultModelDir} from '../config/paths.js';

/** Un archivo descargable (una cuantización concreta) de un modelo. */
export interface ModelFile {
    filename: string;
    /** Etiqueta de cuantización, ej. 'Q8_0', 'F16'. */
    quant: string;
    size_bytes: number;
    /**
     * Hash de contenido proveniente de la API de árbol de HuggingFace
     * (`oid`). Su longitud determina el algoritmo: 40 caracteres hex =>
     * SHA-1 (almacenamiento Xet), 64 => SHA-256 (LFS). El descargador elige
     * el tipo de checksum correspondiente al verificar el archivo.
     */
    sha256: string;
}

/** Una entrada del catálogo que describe un modelo y sus archivos descargables. */
export interface ModelEntry {
    id: string;
    name: string;
    /** Repositorio de HuggingFace, ej. 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf'. */
    repo: string;
    /** Preset de backend al que apunta este modelo; siempre 'transcribe-cli' (transcribe.cpp). */
    backend: string;
    architecture: string;
    parameters: string;
    languages: string[];
    language_count: number;
    description: string;
    license: string;
    streaming: boolean;
    translate: boolean;
    lang_detect: boolean;
    recommended: boolean;
    recommended_rank: number;
    default_quant: string;
    files: ModelFile[];
}

/** Forma del archivo data/model-catalog.json. */
export interface ModelCatalog {
    catalog_version: number;
    updated: string;
    models: ModelEntry[];
}

const CATALOG_REL_PATH = 'data/model-catalog.json';

let _cache: ModelEntry[] | null = null;

/**
 * Carga (y memoiza) el catálogo incluido con la extensión.
 *
 * Para qué: dar acceso a la lista de modelos disponibles sin depender de
 * red, leyendo el JSON empaquetado junto al código de la extensión.
 *
 * Qué hace: si ya hay un resultado en caché lo devuelve directamente; si
 * no, localiza `data/model-catalog.json` dentro de `extensionDir`, lo lee y
 * lo parsea, guardando el arreglo de modelos en caché para llamadas futuras.
 * Ante cualquier error (archivo ausente o JSON inválido) registra una
 * advertencia y devuelve una lista vacía.
 *
 * @param extensionDir Ruta absoluta a la raíz de la extensión instalada (el
 * directorio que contiene extension.js compilado / data/). Si se omite, el
 * cargador no puede encontrar el archivo y devuelve una lista vacía.
 */
export function loadModelCatalog(extensionDir: string | null): ModelEntry[] {
    if (_cache) return _cache;
    if (!extensionDir) return [];

    const path = GLib.build_filenamev([extensionDir, CATALOG_REL_PATH]);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        console.warn(`[planeasr] model catalog not found at ${path}`);
        return [];
    }

    try {
        const [, contents] = file.load_contents(null);
        const decoder = new TextDecoder();
        const raw = decoder.decode(contents);
        const catalog = JSON.parse(raw) as ModelCatalog;
        _cache = catalog.models ?? [];
    } catch (e) {
        console.warn(`[planeasr] failed to parse model catalog: ${e}`);
        _cache = [];
    }
    return _cache;
}

/** Busca una entrada del catálogo por id, o devuelve null. */
export function findModel(
    extensionDir: string | null,
    id: string
): ModelEntry | null {
    return loadModelCatalog(extensionDir).find(m => m.id === id) ?? null;
}

/**
 * Elige el archivo correspondiente a una cuantización dada.
 *
 * Para qué: resolver qué archivo concreto descargar/usar cuando el usuario
 * pide una cuantización específica, con un recurso razonable cuando no la
 * especifica o no existe.
 *
 * Qué hace: busca coincidencia exacta con `quant`; si no la hay, recurre a
 * la cuantización por defecto del modelo (`default_quant`); si tampoco
 * existe, toma el primer archivo de la lista.
 */
export function pickFile(
    entry: ModelEntry,
    quant: string | null
): ModelFile | null {
    if (quant) {
        const exact = entry.files.find(f => f.quant === quant);
        if (exact) return exact;
    }
    const def = entry.files.find(f => f.quant === entry.default_quant);
    return def ?? entry.files[0] ?? null;
}

// `defaultModelDir` se reexporta desde ../config/paths.ts para que todos los
// subsistemas coincidan en la disposición de la caché.
export {defaultModelDir};

/**
 * Resuelve el directorio de modelos configurado, respetando una anulación
 * explícita.
 *
 * Qué hace: si el GSetting `model-dir` trae un valor no vacío, lo usa tal
 * cual; si está vacío, cae en {@link defaultModelDir}.
 */
export function resolveModelDir(settingValue: string): string {
    const trimmed = (settingValue ?? '').trim();
    return trimmed.length > 0 ? trimmed : defaultModelDir();
}

/** Ruta completa donde viviría un archivo de modelo dado, una vez descargado. */
export function modelFilePath(modelDir: string, file: ModelFile): string {
    return GLib.build_filenamev([modelDir, file.filename]);
}

/**
 * Escanea un directorio en busca de modelos del catálogo ya descargados.
 *
 * Para qué: permitir que la interfaz de preferencias muestre qué modelos ya
 * están disponibles localmente sin tener que registrar cada descarga por
 * separado (por ejemplo, tras una instalación manual del archivo).
 *
 * Qué hace: enumera los archivos `.gguf`/`.bin` del directorio, y para cada
 * entrada del catálogo comprueba si alguno de sus archivos está presente
 * con un tamaño que coincida (con tolerancia de 1 KiB). Devuelve un mapa de
 * id de modelo del catálogo -> cuantización presente en disco. Un modelo se
 * considera descargado cuando uno de sus archivos existe en el directorio y
 * su tamaño coincide con la entrada del catálogo.
 */
export function scanDownloaded(
    extensionDir: string | null,
    modelDir: string
): Map<string, string> {
    const result = new Map<string, string>();
    const dir = Gio.File.new_for_path(modelDir);
    if (!dir.query_exists(null)) return result;

    let enumerator: Gio.FileEnumerator | null = null;
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        // Construye una tabla de archivos presentes, indexada por nombre.
        const present = new Map<string, number>();
        let info: Gio.FileInfo | null;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (/\.(gguf|bin)$/i.test(name)) {
                present.set(name, info.get_size());
            }
        }

        for (const entry of loadModelCatalog(extensionDir)) {
            for (const f of entry.files) {
                const size = present.get(f.filename);
                if (
                    size !== undefined &&
                    Math.abs(size - f.size_bytes) < 1024 // tolera un margen de 1 KiB
                ) {
                    result.set(entry.id, f.quant);
                    break;
                }
            }
        }
    } catch (e) {
        console.warn(`[planeasr] failed to scan ${modelDir}: ${e}`);
    } finally {
        enumerator?.close(null);
    }
    return result;
}

/** Etiqueta de tamaño legible para humanos, ej. "751 MB" o "1.65 GB". */
export function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${Math.round(bytes / (1024 * 1024))} MB`;
    }
    if (bytes >= 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${bytes} B`;
}
