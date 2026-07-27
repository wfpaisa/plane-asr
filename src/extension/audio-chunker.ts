/* audio-chunker.ts
 *
 * Funciones para recortar trozos de N segundos de un WAV PCM de 16 kHz mono
 * y 16 bits *mientras el grabador todavía lo está escribiendo*. Esto
 * permite transcribir tomas largas en vivo, un trozo a la vez, así que los
 * backends con un límite de generación por llamada (por ejemplo Qwen3-ASR,
 * que trunca a 256 tokens de salida) nunca lo alcanzan, y las primeras
 * palabras se pegan mientras el usuario sigue hablando. Sin efectos
 * secundarios salvo los archivos de trozo que escribe.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    BYTES_PER_SAMPLE,
    SAMPLE_RATE,
    buildWavHeader,
    wavDataOffsetFromHeader,
} from '../util/wav.js';

export {SAMPLE_RATE};

/**
 * Lee `length` bytes de `path` empezando en `offset` usando un flujo con
 * posicionamiento (seekable), para nunca cargar en memoria una grabación
 * completa (potencialmente larga). Devuelve menos bytes de los pedidos solo
 * si se alcanza el EOF antes de completar la lectura.
 */
function readRange(path: string, offset: number, length: number): Uint8Array {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        if (offset > 0) {
            stream.seek(offset, GLib.SeekType.SET, null);
        }
        const out = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
            const bytes = stream.read_bytes(length - filled, null);
            const arr = bytes.toArray() as Uint8Array;
            if (arr.length === 0) break; // fin de archivo
            out.set(arr, filled);
            filled += arr.length;
        }
        return filled === length ? out : out.subarray(0, filled);
    } finally {
        stream.close(null);
    }
}

/** Tamaño actual en disco de `path`, en bytes (0 si no se puede consultar). */
function fileSize(path: string): number {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'standard::size',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        return info.get_size();
    } catch {
        return 0;
    }
}

/**
 * Parsea el encabezado WAV de `path` y devuelve el offset en bytes donde
 * empiezan las muestras PCM, o `null` cuando el encabezado (todavía) no
 * está presente o el formato no es el esperado (16 kHz mono, 16 bits PCM).
 * Seguro de llamar repetidamente mientras el archivo crece — solo se leen
 * los primeros KiB.
 */
export function getWavDataOffset(path: string): number | null {
    let head: Uint8Array;
    try {
        head = readRange(path, 0, 4096);
    } catch {
        return null;
    }
    return wavDataOffsetFromHeader(head);
}

/**
 * Cantidad de muestras PCM completas disponibles actualmente en `path` a
 * partir de `dataOffset`, calculada a partir del tamaño real del archivo
 * (no de la longitud de marcador del encabezado).
 */
export function wavAvailableSamples(path: string, dataOffset: number): number {
    const dataBytes = Math.max(0, fileSize(path) - dataOffset);
    return Math.floor(dataBytes / BYTES_PER_SAMPLE);
}

/**
 * Copia el rango de muestras `[sampleStart, sampleStart + sampleCount)` de
 * la grabación en crecimiento `srcPath` y lo escribe en `outPath` como un
 * WAV independiente con encabezado canónico, listo para alimentar al CLI de ASR.
 */
export function writeWavChunk(
    srcPath: string,
    dataOffset: number,
    sampleStart: number,
    sampleCount: number,
    outPath: string
): void {
    const byteStart = dataOffset + sampleStart * BYTES_PER_SAMPLE;
    const byteLen = sampleCount * BYTES_PER_SAMPLE;
    const payload = readRange(srcPath, byteStart, byteLen);

    const header = buildWavHeader(payload.length);
    const out = new Uint8Array(header.length + payload.length);
    out.set(header, 0);
    out.set(payload, header.length);

    Gio.File.new_for_path(outPath).replace_contents(
        out,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

/**
 * Elimina, en modo "mejor esfuerzo", los archivos de trozo producidos por
 * {@link sliceWav16kMono}. Nunca lanza excepción — se usa en bloques
 * `finally` donde quien llama ya tiene su propia ruta de manejo de errores.
 */
export function cleanupChunks(paths: string[]): void {
    for (const p of paths) {
        try {
            Gio.File.new_for_path(p).delete(null);
        } catch {
            // Se ignora: la limpieza es solo orientativa.
        }
    }
}
