/* device-lister.ts
 *
 * Lista los dispositivos de cómputo que expone un CLI de transcripción
 * mediante su bandera `--list-devices`. Los índices reportados aquí son
 * *los mismos* que interpreta `--device N` (transcribe-cli), así que el
 * desplegable de preferencias puede mostrarle al usuario exactamente a qué
 * dispositivo corresponde una selección — incluidas las compilaciones CUDA
 * donde el orden interno del registro del CLI difiere del de `vulkaninfo`.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import { parseListDevices } from '../util/device-parse.js';
export { parseListDevices };
/**
 * Ejecuta `<cliPath> --list-devices` y devuelve los dispositivos parseados.
 *
 * Qué hace: lanza el subproceso, captura su stdout y lo pasa por
 * {@link parseListDevices}. Devuelve un arreglo vacío cuando el binario
 * falta, sale con código distinto de cero, o no imprime nada usable —
 * quien llama recurre entonces a una única entrada "Auto".
 */
export async function listDevices(cliPath) {
    if (!cliPath)
        return [];
    const stdout = await runCapture([cliPath, '--list-devices']);
    if (!stdout)
        return [];
    return parseListDevices(stdout);
}
/**
 * Ejecuta `argv` y captura su stdout como string. Devuelve null cuando el
 * binario falta o sale con código distinto de cero.
 */
async function runCapture(argv) {
    try {
        const proc = new Gio.Subprocess({
            argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);
        return await new Promise(resolve => {
            proc.communicate_utf8_async(null, null, (_self, res) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(res);
                    resolve(proc.get_successful() ? (stdout ?? '') : null);
                }
                catch {
                    resolve(null);
                }
            });
        });
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=device-lister.js.map