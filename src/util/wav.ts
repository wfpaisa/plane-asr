/* wav.ts
 *
 * Funciones puras, a nivel de bytes, para el formato canónico WAV PCM de
 * 16 kHz mono y 16 bits que produce el grabador y consume el CLI de ASR. Sin
 * importaciones de GNOME/GJS, así que la lógica de construcción/parseo del
 * encabezado se puede probar con Node normal; el I/O de archivos que usa
 * estas funciones vive en audio-chunker.ts.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

/** Formato de captura esperado, producido por el `Recorder`. */
export const SAMPLE_RATE = 16000;
export const BYTES_PER_SAMPLE = 2;

/**
 * Convierte un código de cuatro caracteres ASCII (ej. "RIFF") en el entero
 * de 32 bits little-endian que usan los encabezados WAV/RIFF.
 */
export function fourCc(code: string): number {
    return (
        code.charCodeAt(0) |
        (code.charCodeAt(1) << 8) |
        (code.charCodeAt(2) << 16) |
        (code.charCodeAt(3) << 24)
    );
}

/**
 * Construye un encabezado RIFF/WAVE canónico de 44 bytes para un flujo mono
 * de 16 kHz y 16 bits con signo.
 *
 * Para qué: permitir que el grabador escriba de entrada un archivo WAV
 * válido (aunque el tamaño de datos aún no se conozca) para que el CLI de
 * ASR pueda empezar a leerlo mientras la grabación sigue en curso.
 *
 * Qué hace: rellena cada campo del encabezado RIFF/fmt/data con los valores
 * fijos del formato de captura y el `dataBytes` recibido.
 */
export function buildWavHeader(dataBytes: number): Uint8Array {
    const header = new Uint8Array(44);
    const dv = new DataView(header.buffer);
    const byteRate = SAMPLE_RATE * 1 * BYTES_PER_SAMPLE;
    const blockAlign = 1 * BYTES_PER_SAMPLE;

    dv.setUint32(0, fourCc('RIFF'), true);
    dv.setUint32(4, 36 + dataBytes, true);
    dv.setUint32(8, fourCc('WAVE'), true);
    dv.setUint32(12, fourCc('fmt '), true);
    dv.setUint32(16, 16, true); // tamaño del chunk fmt para PCM
    dv.setUint16(20, 1, true); // audioFormat = PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, SAMPLE_RATE, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true); // bits por muestra
    dv.setUint32(36, fourCc('data'), true);
    dv.setUint32(40, dataBytes, true);
    return header;
}

/**
 * Dados los primeros bytes de un archivo, devuelve el offset en bytes donde
 * empiezan las muestras PCM, o `null` cuando el encabezado (todavía) no está
 * presente o el formato no es el esperado (16 kHz mono, 16 bits PCM).
 *
 * Para qué: permitir que quien lee un WAV que aún se está grabando localice
 * dónde empiezan los datos de audio reales, saltándose el encabezado y
 * cualquier chunk adicional (`LIST`, `fact`, etc.).
 *
 * Qué hace: valida las firmas RIFF/WAVE y los campos de formato, y luego
 * recorre la lista de chunks hasta encontrar el chunk `data`.
 *
 * Los campos de tamaño que escribe un grabador todavía abierto son
 * marcadores de posición poco fiables, así que solo se usan para avanzar el
 * cursor al recorrer chunks, nunca como una longitud real.
 */
export function wavDataOffsetFromHeader(head: Uint8Array): number | null {
    if (head.length < 44) return null;

    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (
        view.getUint32(0, true) !== fourCc('RIFF') ||
        view.getUint32(8, true) !== fourCc('WAVE')
    ) {
        return null;
    }

    const audioFormat = view.getUint16(20, true);
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    if (
        audioFormat !== 1 ||
        channels !== 1 ||
        sampleRate !== SAMPLE_RATE ||
        bitsPerSample !== 16
    ) {
        return null;
    }

    // Recorre la lista de chunks para localizar `data`; los WAV pueden traer
    // chunks `LIST`/`fact` antes de él.
    let offset = 12;
    while (offset + 8 <= head.length) {
        const id = view.getUint32(offset, true);
        const size = view.getUint32(offset + 4, true);
        offset += 8;
        if (id === fourCc('data')) return offset;
        offset += size + (size % 2);
    }
    return null;
}
