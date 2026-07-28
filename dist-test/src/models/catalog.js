/* catalog.ts
 *
 * Tipos y accesor para el catálogo de modelos incluido sin conexión
 * (data/model-catalog.json). Lo comparten el runtime de la extensión y la
 * interfaz de preferencias, para que ambos vean la misma lista de modelos
 * sin necesidad de una llamada de red.
 *
 * El catálogo se importa como el módulo ESM generado
 * model-catalog-data.ts (ver scripts/gen-model-catalog.mjs) en vez de
 * leerse con `Gio.File.load_contents()` en runtime: las directrices de
 * revisión de extensiones GNOME desaconsejan IO de archivo síncrono en
 * código del shell, y un import de módulo no cuenta como tal — es la misma
 * forma en que ya se carga cualquier otro archivo .js de la extensión.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { defaultModelDir } from '../config/paths.js';
import { MODEL_CATALOG } from './model-catalog-data.js';
/** Devuelve el catálogo de modelos incluido con la extensión. */
export function loadModelCatalog() {
    return MODEL_CATALOG.models;
}
/** Busca una entrada del catálogo por id, o devuelve null. */
export function findModel(id) {
    return loadModelCatalog().find(m => m.id === id) ?? null;
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
export function pickFile(entry, quant) {
    if (quant) {
        const exact = entry.files.find(f => f.quant === quant);
        if (exact)
            return exact;
    }
    const def = entry.files.find(f => f.quant === entry.default_quant);
    return def ?? entry.files[0] ?? null;
}
// `defaultModelDir` se reexporta desde ../config/paths.ts para que todos los
// subsistemas coincidan en la disposición de la caché.
export { defaultModelDir };
/**
 * Resuelve el directorio de modelos configurado, respetando una anulación
 * explícita.
 *
 * Qué hace: si el GSetting `model-dir` trae un valor no vacío, lo usa tal
 * cual; si está vacío, cae en {@link defaultModelDir}.
 */
export function resolveModelDir(settingValue) {
    const trimmed = (settingValue ?? '').trim();
    return trimmed.length > 0 ? trimmed : defaultModelDir();
}
/** Ruta completa donde viviría un archivo de modelo dado, una vez descargado. */
export function modelFilePath(modelDir, file) {
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
 * entrada del catálogo comprueba qué de sus archivos están presentes con un
 * tamaño que coincida (con tolerancia de 1 KiB). Devuelve un mapa de id de
 * modelo del catálogo -> lista de cuantizaciones presentes en disco (un
 * modelo puede tener varias descargadas a la vez, p. ej. Q4_K_M y Q8_0). Un
 * modelo se considera descargado cuando al menos uno de sus archivos existe
 * en el directorio y su tamaño coincide con la entrada del catálogo.
 */
export function scanDownloaded(modelDir) {
    const result = new Map();
    const dir = Gio.File.new_for_path(modelDir);
    if (!dir.query_exists(null))
        return result;
    let enumerator = null;
    try {
        enumerator = dir.enumerate_children('standard::name,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        // Construye una tabla de archivos presentes, indexada por nombre.
        const present = new Map();
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (/\.(gguf|bin)$/i.test(name)) {
                present.set(name, info.get_size());
            }
        }
        for (const entry of loadModelCatalog()) {
            for (const f of entry.files) {
                const size = present.get(f.filename);
                if (size !== undefined &&
                    Math.abs(size - f.size_bytes) < 1024 // tolera un margen de 1 KiB
                ) {
                    const quants = result.get(entry.id);
                    if (quants)
                        quants.push(f.quant);
                    else
                        result.set(entry.id, [f.quant]);
                }
            }
        }
    }
    catch (e) {
        console.warn(`[planeasr] failed to scan ${modelDir}: ${e}`);
    }
    finally {
        enumerator?.close(null);
    }
    return result;
}
/** Etiqueta de tamaño legible para humanos, ej. "751 MB" o "1.65 GB". */
export function formatSize(bytes) {
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
//# sourceMappingURL=catalog.js.map