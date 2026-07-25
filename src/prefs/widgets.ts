/* widgets.ts
 *
 * Reusable Adwaita/GTK4 row builders shared across the preferences pages.
 * Extracted so the main prefs file and the models page can compose the same
 * controls without duplicating markup.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Build a full-width row with the label stacked above a Gtk.Entry, so the
 * whole placeholder hint stays visible (a side-by-side entry would clip it).
 */
export function entryRow(
    title: string,
    placeholder: string
): {row: Adw.PreferencesRow; entry: Gtk.Entry; label: Gtk.Label} {
    const label = new Gtk.Label({
        label: title,
        xalign: 0,
        cssClasses: ['heading'],
    });
    const entry = new Gtk.Entry({
        placeholder_text: placeholder,
        hexpand: true,
    });
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        marginTop: 10,
        marginBottom: 10,
        marginStart: 12,
        marginEnd: 12,
    });
    box.append(label);
    box.append(entry);

    const row = new Adw.PreferencesRow({title, activatable: false});
    row.set_child(box);
    return {row, entry, label};
}

/**
 * Make an `Adw.ComboRow` show its full (un-ellipsized) labels in both the
 * collapsed button and the popup, so long option names (e.g.
 * "GPU 5070 Ti · 16GB") are never cut off.
 *
 * libadwaita's default factories wrap the selected value in a label with
 * `ellipsize: END`, which truncates long text. We replace both factories
 * (`factory` for the closed row, `list_factory` for the popup, both available
 * since libadwaita 1.4) with a `Gtk.SignalListItemFactory` that builds a
 * non-ellipsizing label. With `ellipsize: NONE` the popup grows to fit the
 * widest item, so no manual width is needed.
 */
export function widenComboRow(row: Adw.ComboRow): void {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, obj) => {
        const label = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.NONE,
            wrap: true,
            wrapMode: Pango.WrapMode.WORD_CHAR,
        });
        (obj as Gtk.ListItem).set_child(label);
    });
    factory.connect('bind', (_f, obj) => {
        const item = obj as Gtk.ListItem;
        const strObj = item.item as Gtk.StringObject | null;
        const label = item.child as Gtk.Label;
        label.label = strObj?.get_string() ?? '';
    });
    row.factory = factory;
    row.list_factory = factory;
}

/**
 * Show a modal dialog that captures the next key combination and reports it as
 * a GTK accelerator string (empty string means "disable"). Esc cancels.
 */
export function captureShortcut(
    parent: Adw.PreferencesWindow,
    onCaptured: (accel: string) => void
): void {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parent,
        default_width: 440,
        default_height: 200,
    });

    dialog.set_content(
        new Adw.StatusPage({
            title: _('Press the desired combination'),
            description: _('Esc to cancel · Backspace to disable'),
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
        })
    );

    const controller = new Gtk.EventControllerKey();
    dialog.add_controller(controller);
    controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (keyval === Gdk.KEY_Escape && mods === 0) {
            dialog.close();
            return true;
        }
        if (keyval === Gdk.KEY_BackSpace && mods === 0) {
            onCaptured('');
            dialog.close();
            return true;
        }
        if (mods === 0 || !Gtk.accelerator_valid(keyval, mods)) {
            return true;
        }
        onCaptured(Gtk.accelerator_name(keyval, mods));
        dialog.close();
        return true;
    });

    dialog.present();
}

/** Row that displays the current toggle shortcut and lets the user record one. */
export function shortcutRow(
    settings: Gio.Settings,
    key: string,
    window: Adw.PreferencesWindow
): Adw.ActionRow {
    const row = new Adw.ActionRow({
        title: _('Toggle recording shortcut'),
        subtitle: _('Click Set and press the keys you want to use'),
    });

    const display = new Gtk.ShortcutLabel({
        disabled_text: _('Disabled'),
        valign: Gtk.Align.CENTER,
    });
    const setButton = new Gtk.Button({
        label: _('Set'),
        valign: Gtk.Align.CENTER,
    });
    const clearButton = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Disable shortcut'),
        cssClasses: ['flat'],
    });

    row.add_suffix(display);
    row.add_suffix(setButton);
    row.add_suffix(clearButton);
    row.activatable_widget = setButton;

    const sync = () => {
        display.accelerator = settings.get_strv(key)[0] ?? '';
    };
    sync();
    settings.connect(`changed::${key}`, sync);

    setButton.connect('clicked', () => {
        captureShortcut(window, accel => {
            if (accel) settings.set_strv(key, [accel]);
            else settings.set_strv(key, []);
        });
    });
    clearButton.connect('clicked', () => settings.set_strv(key, []));

    return row;
}

/** A pill-shaped badge label used to decorate model rows. */
export function badgeLabel(text: string, cssClass = 'tag'): Gtk.Label {
    return new Gtk.Label({
        label: text,
        cssClasses: [cssClass],
        valign: Gtk.Align.CENTER,
    });
}
