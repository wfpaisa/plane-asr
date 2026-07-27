/* notify.ts
 *
 * Notificaciones del sistema para Plane ASR. Envuelve la API de
 * `MessageTray` en vez de usar `Main.notify` directamente para que todas
 * las notificaciones lleven el ícono propio de la extensión
 * (data/icons/sound-symbolic.svg) en lugar del genérico que GNOME Shell
 * usa por defecto.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

/** Fuente compartida por toda la extensión; se reconstruye si el shell la destruye (ej. tras cerrarse todas sus notificaciones). */
let _source: MessageTray.Source | null = null;

/** Ícono de la extensión (data/icons/sound-symbolic.svg), o null si no se puede resolver `extensionDir`. */
function extensionIcon(extensionDir: string | null): Gio.Icon | null {
    if (!extensionDir) return null;
    return Gio.icon_new_for_string(
        GLib.build_filenamev([
            extensionDir,
            'data',
            'icons',
            'sound-symbolic.svg',
        ])
    );
}

/** Obtiene (creando si hace falta) la `MessageTray.Source` de la extensión. */
function getSource(extensionDir: string | null): MessageTray.Source {
    if (_source) return _source;
    const icon =
        extensionIcon(extensionDir) ??
        new Gio.ThemedIcon({name: 'audio-input-microphone-symbolic'});
    _source = new MessageTray.Source({title: _('Plane ASR'), icon});
    _source.connect('destroy', () => {
        _source = null;
    });
    Main.messageTray.add(_source);
    return _source;
}

/**
 * Igual que `Main.notify(title, body)`, pero mostrando el ícono propio de
 * la extensión en vez del genérico del sistema.
 */
export function notify(
    extensionDir: string | null,
    title: string,
    body?: string
): void {
    const source = getSource(extensionDir);
    const notification = new MessageTray.Notification({
        source,
        title,
        body: body ?? null,
        isTransient: true,
        gicon: extensionIcon(extensionDir),
    });
    source.addNotification(notification);
}
