/* file-picker.ts
 *
 * Selector de archivos GTK independiente, ejecutado fuera del proceso
 * principal.
 *
 * La interfaz de GNOME Shell corre sobre St/Clutter, que no tiene un
 * selector de archivos nativo. El `Gtk.FileDialog` de GTK solo funciona
 * dentro de un proceso basado en Gtk, así que cuando el usuario quiere
 * transcribir un archivo de audio existente, el indicador lanza este script
 * vía `gjs -m` (ver `Indicator._pickAndTranscribe`), lee la ruta elegida
 * desde su stdout, y se la pasa a `AsrService.transcribeFile`.
 *
 * Este es un script *hoja*: NO importa nada de `src/` y no tiene acceso al
 * proceso gnome-shell en ejecución (sin dominio gettext, sin settings, sin
 * indicador). Todos los strings traducibles los produce quien lo invoca y
 * se pasan por línea de comandos:
 *   ARGV[0] = título del diálogo
 *   ARGV[1] = etiqueta del botón de aceptar
 *
 * Códigos de salida:
 *   0  → archivo elegido; su ruta absoluta se imprime a stdout
 *   1  → el usuario canceló / cerró el diálogo (sin salida)
 *   2  → error inesperado; se escribe un diagnóstico a stderr
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import system from 'system';
/** Construye el filtro de audio: todos los contenedores comunes, más un respaldo por patrón glob. */
function buildAudioFilter() {
    const filter = new Gtk.FileFilter();
    filter.name = 'Audio';
    // `add_mime_type` no acepta comodines, así que se nombran explícitamente
    // los comunes; los patrones de abajo capturan lo que se nos escape por extensión.
    for (const mime of [
        'audio/wav',
        'audio/x-wav',
        'audio/mpeg',
        'audio/ogg',
        'audio/flac',
        'audio/aac',
        'audio/mp4',
        'audio/x-m4a',
        'audio/opus',
        'audio/webm',
        'audio/x-ms-wma',
    ]) {
        filter.add_mime_type(mime);
    }
    for (const pat of [
        '*.wav',
        '*.mp3',
        '*.ogg',
        '*.oga',
        '*.flac',
        '*.m4a',
        '*.aac',
        '*.opus',
        '*.webm',
        '*.wma',
        '*.aiff',
        '*.aif',
    ]) {
        filter.add_pattern(pat);
    }
    return filter;
}
/**
 * Punto de entrada del script.
 *
 * Qué hace: inicializa GTK, abre el diálogo de selección de archivo con el
 * filtro de audio, y según el resultado imprime la ruta elegida a stdout o
 * sale con el código correspondiente (ver la tabla de códigos de salida
 * arriba).
 */
function main() {
    // Inicializa GTK para que el diálogo tenga una conexión de pantalla
    // funcional incluso cuando se invoca desde un contexto de activación
    // D-Bus no interactivo.
    Gtk.init();
    const title = ARGV[0] ?? 'Select audio file';
    const acceptLabel = ARGV[1] ?? 'Open';
    const loop = new GLib.MainLoop(null, false);
    // Código de salida que se expone tras vaciar el loop. 0 = elegido,
    // 1 = cancelado, 2 = error. Por defecto es 2 para que cualquier retorno
    // temprano inesperado se trate como un fallo en vez de tener éxito
    // silenciosamente con stdout vacío.
    let exitCode = 2;
    const filters = new Gio.ListStore();
    filters.append(buildAudioFilter());
    const dialog = new Gtk.FileDialog({
        title,
        acceptLabel,
        filters,
    });
    dialog.open(null, null, (_self, res) => {
        let file;
        try {
            file = dialog.open_finish(res);
        }
        catch (e) {
            // Gtk.DialogError.DISMISSED es la ruta documentada de
            // "el usuario canceló" — sale silenciosamente (código 1)
            // para que quien llama pueda distinguirlo de un fallo real
            // (código 2). Cualquier otra cosa se registra.
            const err = e;
            if (err?.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) {
                exitCode = 1;
            }
            else {
                printerr(String(e));
            }
            loop.quit();
            return;
        }
        const path = file.get_path();
        if (path) {
            print(path);
            exitCode = 0;
        }
        else {
            exitCode = 2;
        }
        loop.quit();
    });
    loop.run();
    system.exit(exitCode);
}
main();
//# sourceMappingURL=file-picker.js.map