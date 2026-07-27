/* device-parse.ts
 *
 * Parser puro para la salida textual de `<cli> --list-devices`. No importa
 * nada de GNOME/GJS, así que puede probarse con Node normal; el subproceso
 * que genera ese texto vive en extension/device-lister.ts.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */
/**
 * Parsea la salida textual de `<cli> --list-devices`.
 *
 * Para qué: convertir el texto plano que imprime el CLI en una lista de
 * objetos `DeviceInfo` que el resto de la extensión pueda usar (por ejemplo
 * para poblar el selector de dispositivo en las preferencias).
 *
 * Qué hace: recorre el texto línea por línea, detecta encabezados de
 * dispositivo (`[N] Nombre`) y sus líneas de detalle (`kind=...`,
 * `memory: ... total`), y arma un `DeviceInfo` por cada bloque encontrado.
 *
 * Formato esperado (transcribe.cpp):
 * ```
 * 3 compute device(s):
 *   [0] NVIDIA GeForce RTX 5070 Ti
 *       name=CUDA0  kind=cuda  type=gpu  id=0000:01:00.0
 *       memory: 15.51 GiB total, 15.22 GiB free
 *   [1] ...
 * ```
 * Las líneas que no coinciden con un encabezado de dispositivo ni con sus
 * líneas de detalle (por ejemplo los logs `[info] ggml_cuda_init: ...` que
 * emite CUDA al iniciar) se ignoran.
 */
export function parseListDevices(text) {
    const out = [];
    let current = null;
    const flush = () => {
        if (current) {
            out.push(current);
            current = null;
        }
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line)
            continue;
        // Encabezado de dispositivo: "[0] Nombre".
        const header = line.match(/^\[(\d+)\]\s*(.+)$/);
        if (header) {
            flush();
            current = {
                index: parseInt(header[1], 10),
                name: header[2].trim(),
                kind: '',
                vramLabel: '',
            };
            continue;
        }
        if (!current)
            continue;
        // Línea de detalle: "name=CUDA0  kind=cuda  type=gpu  id=...".
        const kind = line.match(/\bkind=(\S+)/);
        if (kind) {
            current.kind = kind[1];
            continue;
        }
        // Línea de memoria: "memory: 15.51 GiB total, 15.22 GiB free".
        const mem = line.match(/memory:\s*([0-9.]+\s*\S+)\s*total/i);
        if (mem) {
            current.vramLabel = mem[1].trim();
        }
    }
    flush();
    // Descarta entradas sin nombre (defensivo: bloques malformados).
    return out.filter(d => d.name.length > 0);
}
//# sourceMappingURL=device-parse.js.map