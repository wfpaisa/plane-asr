/* file-chooser-portal.ts
 *
 * Abre el selector de archivos de audio vía el portal de escritorio XDG
 * (`org.freedesktop.portal.FileChooser`), invocado directamente por D-Bus
 * desde el propio proceso de gnome-shell — sin lanzar un subproceso GTK
 * aparte.
 *
 * El indicador St/Clutter de GNOME Shell no puede alojar un `Gtk.FileDialog`
 * (ese widget solo funciona dentro de un proceso GTK), pero el portal en sí
 * es un servicio D-Bus corriente: cualquier cliente puede invocar
 * `OpenFile` sin necesitar una ventana GTK propia — el diálogo lo renderiza
 * el backend del portal (xdg-desktop-portal-gnome/gtk) en su propio
 * proceso. Esto reemplaza al antiguo `file-picker.ts`, que se lanzaba vía
 * `gjs -m` como script hoja independiente y que las herramientas de
 * revisión de extensiones GNOME señalan como código muerto porque no es
 * alcanzable por import desde extension.js/prefs.js (EGO-P-007).
 *
 * Mecánica del portal (ver especificación de xdg-desktop-portal):
 *   1. Se predice la ruta del objeto `Request` de la respuesta a partir del
 *      nombre único de esta conexión D-Bus y de un `handle_token` propio,
 *      y se suscribe a su señal `Response` *antes* de llamar a `OpenFile`,
 *      para no perder una respuesta que llegara antes de suscribirse.
 *   2. `OpenFile` devuelve de inmediato la misma ruta de objeto (no el
 *      resultado); el resultado real llega después, de forma asíncrona,
 *      como la señal `Response` en esa ruta.
 *   3. La señal trae un código (`0` = archivo elegido) y un diccionario de
 *      resultados cuya clave `uris` es a su vez una variante anidada (GJS
 *      no la desempaqueta con el `deep_unpack()` del contenedor externo;
 *      hace falta un `deep_unpack()` adicional sobre ella).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop';
const FILE_CHOOSER_IFACE = 'org.freedesktop.portal.FileChooser';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

/** Extensiones/MIME comunes de audio — igual a los que ofrecía el selector GTK independiente. */
const AUDIO_MIME_TYPES = [
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
];
const AUDIO_PATTERNS = [
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
];

/** Genera un `handle_token` aleatorio para distinguir esta petición de cualquier otra concurrente. */
function randomToken(): string {
    return `planeasr${GLib.uuid_string_random().replace(/-/g, '')}`;
}

/**
 * Predice la ruta del objeto `Request` de esta petición, tal como la
 * especifica xdg-desktop-portal: el nombre único de la conexión (ej.
 * `:1.123`) sin los dos puntos y con los puntos reemplazados por guiones
 * bajos, seguido del `handle_token` propio.
 */
function predictRequestPath(
    conn: Gio.DBusConnection,
    token: string
): string {
    const unique = conn.get_unique_name() ?? '';
    const sender = unique.replace(/^:/, '').replace(/\./g, '_');
    return `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
}

/**
 * Abre el selector de archivos de audio del sistema vía el portal XDG.
 *
 * Qué hace: llama a `FileChooser.OpenFile` con un filtro de audio,
 * suscribiéndose antes a la señal `Request.Response` en la ruta predicha.
 * Devuelve la ruta absoluta elegida, o `null` si el usuario canceló.
 * Rechaza la promesa si el portal no está disponible o la llamada D-Bus
 * falla.
 */
export function pickAudioFile(
    title: string,
    acceptLabel: string
): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const conn = Gio.DBus.session;
        const token = randomToken();
        const requestPath = predictRequestPath(conn, token);

        let subId = 0;
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (subId) conn.signal_unsubscribe(subId);
            fn();
        };

        subId = conn.signal_subscribe(
            null,
            REQUEST_IFACE,
            'Response',
            requestPath,
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _sender, _path, _iface, _signal, params) => {
                const [response, results] = params.deep_unpack() as [
                    number,
                    Record<string, GLib.Variant>,
                ];
                finish(() => {
                    if (response !== 0) {
                        resolve(null);
                        return;
                    }
                    const uris = (results.uris?.deep_unpack() ??
                        []) as string[];
                    const uri = uris[0];
                    resolve(uri ? Gio.File.new_for_uri(uri).get_path() : null);
                });
            }
        );

        const filterRules: Array<[number, string]> = [
            ...AUDIO_MIME_TYPES.map((m): [number, string] => [1, m]),
            ...AUDIO_PATTERNS.map((p): [number, string] => [0, p]),
        ];
        const options = {
            handle_token: new GLib.Variant('s', token),
            accept_label: new GLib.Variant('s', acceptLabel),
            modal: new GLib.Variant('b', true),
            multiple: new GLib.Variant('b', false),
            filters: new GLib.Variant('a(sa(us))', [['Audio', filterRules]]),
        };

        // Sin ventana padre (`''`): el indicador es St/Clutter, no un
        // Gtk.Window del que exportar un handle — el portal igual
        // presenta el diálogo sin problema, solo sin quedar anclado a una
        // ventana concreta.
        conn.call(
            PORTAL_BUS_NAME,
            PORTAL_OBJECT_PATH,
            FILE_CHOOSER_IFACE,
            'OpenFile',
            new GLib.Variant('(ssa{sv})', ['', title, options]),
            new GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (source, res) => {
                try {
                    source?.call_finish(res);
                } catch (e) {
                    finish(() => reject(e));
                }
            }
        );
    });
}
