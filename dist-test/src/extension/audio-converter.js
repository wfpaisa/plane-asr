/* audio-converter.ts
 *
 * Convierte un archivo de audio arbitrario al WAV PCM s16le de 16 kHz mono
 * que espera el backend de ASR, replicando lo que captura en vivo el
 * {@link Recorder}. Lo usa `AsrService.transcribeFile` para archivos
 * elegidos por el usuario que no están ya en el formato objetivo (ver
 * {@link getWavDataOffset} para la validación).
 *
 * Primero prueba `ffmpeg` (mejor cobertura de formatos) y recurre a
 * `gst-launch-1.0`, que viene con GNOME Shell y está prácticamente siempre
 * presente. Cuando ninguno está en el PATH, {@link convert} rechaza con
 * {@link NoConverterError} para que quien llama pueda mostrar una
 * advertencia clara de "formato requerido" en vez de un fallo genérico.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
/** Se lanza cuando no hay ningún backend de conversión disponible en el PATH. */
export class NoConverterError extends Error {
    constructor(message = 'No audio converter (ffmpeg or gst-launch-1.0) found in PATH') {
        super(message);
        this.name = 'NoConverterError';
    }
}
/** Resuelve el primer binario conversor disponible, o null si no hay ninguno. */
function resolveConverterBin() {
    return (GLib.find_program_in_path('ffmpeg') ??
        GLib.find_program_in_path('gst-launch-1.0') ??
        null);
}
/**
 * Construye el argv del conversor para el binario dado.
 *
 * - `ffmpeg`: `-y` sobreescribe el destino, `-loglevel error` deja stderr
 *   solo con diagnósticos genuinos, y luego van las banderas canónicas de
 *   remuestreo/mezcla a mono.
 * - `gst-launch-1.0`: un pipeline con decodebin que remuestrea a 16 kHz,
 *   mezcla a mono, formatea a S16LE y envuelve en un contenedor WAV.
 *   `decodebin` selecciona automáticamente el demuxer/decodificador entre
 *   los plugins de GStreamer instalados.
 */
function buildArgv(bin, srcPath, destPath) {
    if (bin.endsWith('ffmpeg')) {
        return [
            bin,
            '-y',
            '-loglevel',
            'error',
            '-i',
            srcPath,
            '-ar',
            '16000',
            '-ac',
            '1',
            '-sample_fmt',
            's16',
            destPath,
        ];
    }
    // Pipeline de gst-launch-1.0 (bin === 'gst-launch-1.0').
    return [
        bin,
        'filesrc',
        `location=${srcPath}`,
        '!',
        'decodebin',
        '!',
        'audioconvert',
        '!',
        'audioresample',
        '!',
        'audio/x-raw,rate=16000,channels=1,format=S16LE',
        '!',
        'wavenc',
        '!',
        'filesink',
        `location=${destPath}`,
    ];
}
/**
 * Conversor de audio de un solo uso. Una misma instancia ejecuta una
 * conversión a la vez; `convert` rechaza si se llama mientras ya hay una en
 * curso. Usa {@link forceExit} para cancelar.
 *
 * Replica el ciclo de vida de {@link Transcriber} para que el orquestador
 * pueda detener una conversión en curso junto con una grabación/transcripción.
 */
export class AudioConverter {
    constructor() {
        this._proc = null;
    }
    /**
     * Convierte `srcPath` a un WAV s16le de 16 kHz mono en `destPath`.
     *
     * Qué hace: resuelve la promesa al terminar con éxito; rechaza con
     * {@link NoConverterError} cuando no hay ningún backend en el PATH (así
     * quien llama puede mostrar la advertencia de formato requerido), o con
     * el stderr del conversor ante cualquier otro fallo.
     */
    convert(srcPath, destPath) {
        if (this._proc) {
            return Promise.reject(new Error('Conversion already running'));
        }
        const bin = resolveConverterBin();
        if (!bin) {
            return Promise.reject(new NoConverterError());
        }
        const argv = buildArgv(bin, srcPath, destPath);
        return new Promise((resolve, reject) => {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            this._proc = proc;
            proc.communicate_utf8_async(null, null, (_self, res) => {
                this._proc = null;
                try {
                    const [, , stderr] = proc.communicate_utf8_finish(res);
                    if (!proc.get_successful()) {
                        // El conversor escribe sus diagnósticos en stderr, así
                        // que se muestran tal cual — esto es lo que el usuario
                        // ve vía Main.notify en caso de fallo.
                        const detail = (stderr ?? '').trim();
                        throw new Error(detail ||
                            `${bin} exited with code ${proc.get_exit_status()}`);
                    }
                    resolve();
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }
    /** Mata el subproceso de conversión en curso, si lo hay. */
    forceExit() {
        this._proc?.force_exit();
    }
}
//# sourceMappingURL=audio-converter.js.map