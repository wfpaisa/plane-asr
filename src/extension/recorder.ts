/* recorder.ts
 *
 * Grabador de WAV construido sobre PipeWire (`pw-record`) o PulseAudio
 * (`parecord`), lo que esté disponible en el PATH. Ambos se lanzan con el
 * formato exacto que esperan los CLI de ASR (16 kHz, mono, entero de 16
 * bits con signo, little-endian), así que no hace falta ningún paso de
 * conversión con `ffmpeg`.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/** SIGINT, usado para pedirle a pw-record/parecord que cierre el WAV limpiamente. */
const SIGINT = 2;

/**
 * Captura audio a un archivo WAV usando el primer backend disponible.
 *
 * El grabador posee un único `Gio.Subprocess` a la vez; `start()` lanza una
 * excepción si se llama mientras ya está grabando, y `stop()` resuelve la
 * promesa una vez que el proceso subyacente ha terminado.
 */
export class Recorder {
    private _proc: Gio.Subprocess | null = null;

    /** Verdadero mientras un proceso de captura está en ejecución. */
    isRecording(): boolean {
        return this._proc !== null;
    }

    /**
     * Empieza a capturar hacia `outputPath`.
     *
     * Qué hace: construye el comando del backend disponible y lo lanza como
     * subproceso. Lanza una excepción si no hay ningún backend disponible o
     * si ya hay una grabación en curso.
     */
    start(outputPath: string): void {
        if (this._proc) {
            throw new Error(_('A recording is already in progress'));
        }

        const argv = this._buildArgv(outputPath);
        const proc = new Gio.Subprocess({
            argv,
            flags: Gio.SubprocessFlags.NONE,
        });
        proc.init(null);
        this._proc = proc;
    }

    /**
     * Detiene la grabación actual y resuelve la promesa una vez que el WAV
     * se ha finalizado. Seguro de llamar en reposo (resuelve de inmediato).
     */
    stop(): Promise<void> {
        const proc = this._proc;
        this._proc = null;
        if (!proc) return Promise.resolve();

        // SIGINT permite que pw-record/parecord vuelquen el buffer y cierren
        // el encabezado del WAV.
        try {
            proc.send_signal(SIGINT);
        } catch {
            // Si la señal falla, igual queremos esperar la terminación.
        }

        return new Promise(resolve => {
            proc.wait_async(null, (_self, res) => {
                try {
                    // Enviamos SIGINT al grabador deliberadamente para
                    // finalizar el WAV, así que una salida distinta de cero
                    // (o la muerte por nuestra propia señal) es el resultado
                    // esperado — `wait_finish` solo recoge el proceso sin
                    // validar su estado, a diferencia de `wait_check_*`.
                    proc.wait_finish(res);
                } catch (e) {
                    // Aquí solo llegan fallos genuinos de espera (ej. cancelación).
                    logError(e as object);
                }
                resolve();
            });
        });
    }

    /** Construye el argv específico del backend para la ruta de salida dada. */
    private _buildArgv(outputPath: string): string[] {
        if (GLib.find_program_in_path('pw-record')) {
            return [
                'pw-record',
                '--rate',
                '16000',
                '--channels',
                '1',
                '--format',
                's16',
                outputPath,
            ];
        }

        if (GLib.find_program_in_path('parecord')) {
            return [
                'parecord',
                '--rate=16000',
                '--channels=1',
                '--format=s16le',
                '--file-format=wav',
                outputPath,
            ];
        }

        throw new Error(_('Neither pw-record nor parecord was found in PATH'));
    }
}
