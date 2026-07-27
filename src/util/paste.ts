/* paste.ts
 *
 * Ayudante de "auto-pegado": escribe `text` en el portapapeles y simula
 * Ctrl+V mediante un teclado virtual de Clutter, para que el texto caiga
 * donde sea que esté el foco del teclado. El contenido previo del
 * portapapeles se restaura poco después.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

/** Retraso (ms) entre enviar Ctrl+V y restaurar el portapapeles anterior. */
const RESTORE_DELAY_MS = 300;

/**
 * Pega `text` en la posición actual del cursor, tomando temporalmente el
 * control del portapapeles y sintetizando una pulsación Ctrl+V con un
 * teclado virtual.
 *
 * Para qué: permitir que la extensión inserte el texto transcrito
 * directamente donde el usuario está escribiendo, sin que tenga que pegarlo
 * a mano.
 *
 * Qué hace: guarda el contenido actual del portapapeles, lo reemplaza por
 * `text`, envía Ctrl+V mediante un dispositivo de entrada virtual, y luego
 * de un retraso restaura el contenido original del portapapeles.
 *
 * Solo resuelve la promesa después de restaurar el portapapeles previo, de
 * modo que quien llama pueda pegar varios fragmentos en secuencia haciendo
 * `await` de cada uno sin que las inyecciones de Ctrl+V o las escrituras al
 * portapapeles se solapen entre sí. Es un no-op (resuelve de inmediato)
 * cuando `text` está vacío.
 */
export function pasteAtCursor(text: string): Promise<void> {
    if (!text) return Promise.resolve();

    return new Promise<void>(resolve => {
        const clipboard = St.Clipboard.get_default();
        clipboard.get_text(St.ClipboardType.CLIPBOARD, (cb, previousText) => {
            cb.set_text(St.ClipboardType.CLIPBOARD, text);

            const seat = Clutter.get_default_backend().get_default_seat();
            const keyboard = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE
            );

            // notify_keyval espera microsegundos; get_current_event_time() da ms.
            const timeUs = Clutter.get_current_event_time() * 1000;

            keyboard.notify_keyval(
                timeUs,
                Clutter.KEY_Control_L,
                Clutter.KeyState.PRESSED
            );
            keyboard.notify_keyval(
                timeUs,
                Clutter.KEY_v,
                Clutter.KeyState.PRESSED
            );
            keyboard.notify_keyval(
                timeUs,
                Clutter.KEY_v,
                Clutter.KeyState.RELEASED
            );
            keyboard.notify_keyval(
                timeUs,
                Clutter.KEY_Control_L,
                Clutter.KeyState.RELEASED
            );

            // Restaura lo que el usuario tenía copiado antes de sobrescribirlo,
            // y luego resuelve para que los pegados secuenciales no compitan
            // entre sí.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_DELAY_MS, () => {
                if (previousText) {
                    cb.set_text(St.ClipboardType.CLIPBOARD, previousText);
                }
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    });
}

/**
 * Copia `text` al portapapeles del sistema.
 *
 * Para qué: dejar el texto transcrito disponible para que el usuario lo
 * pegue manualmente cuando no se use el auto-pegado.
 *
 * Qué hace: escribe directamente en el portapapeles; no hace nada si
 * `text` está vacío.
 */
export function copyToClipboard(text: string): void {
    if (!text) return;
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}
