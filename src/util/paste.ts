/* paste.ts
 *
 * "Auto-paste" helper: writes `text` into the clipboard and simulates Ctrl+V
 * through a Clutter virtual keyboard so the text lands wherever the keyboard
 * focus is. The previous clipboard contents are restored shortly after.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

/** Delay (ms) between sending Ctrl+V and restoring the previous clipboard. */
const RESTORE_DELAY_MS = 300;

/**
 * Paste `text` at the current cursor position by temporarily hijacking the
 * clipboard and synthesizing a Ctrl+V keypress with a virtual keyboard.
 *
 * No-op when `text` is empty.
 */
export function pasteAtCursor(text: string): void {
    if (!text) return;

    const clipboard = St.Clipboard.get_default();
    clipboard.get_text(St.ClipboardType.CLIPBOARD, (cb, previousText) => {
        cb.set_text(St.ClipboardType.CLIPBOARD, text);

        const seat = Clutter.get_default_backend().get_default_seat();
        const keyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );

        // notify_keyval expects microseconds; get_current_event_time() is ms.
        const timeUs = Clutter.get_current_event_time() * 1000;

        keyboard.notify_keyval(
            timeUs,
            Clutter.KEY_Control_L,
            Clutter.KeyState.PRESSED
        );
        keyboard.notify_keyval(timeUs, Clutter.KEY_v, Clutter.KeyState.PRESSED);
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

        // Restore whatever the user had copied before we overwrote it.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_DELAY_MS, () => {
            if (previousText) {
                cb.set_text(St.ClipboardType.CLIPBOARD, previousText);
            }
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** Copy `text` into the system clipboard. No-op when empty. */
export function copyToClipboard(text: string): void {
    if (!text) return;
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}
