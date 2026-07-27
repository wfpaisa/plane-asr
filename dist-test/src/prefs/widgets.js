/* widgets.ts
 *
 * Constructores de filas Adwaita/GTK4 reutilizables, compartidos entre las
 * páginas de preferencias. Se extrajeron para que el archivo principal de
 * preferencias y la página de modelos compongan los mismos controles sin
 * duplicar marcado.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';
import Pango from 'gi://Pango';
import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
/**
 * Inset estándar (libadwaita) para el contenido dentro de las filas
 * compuestas de estas páginas. libadwaita aplica 12px de margen horizontal al
 * contenido de sus filas nativas; centralizarlo aquí hace que las filas hechas
 * a mano (etiqueta + entrada, notas, cajas de controles) igualen la altura y el
 * ritmo vertical de las filas Adw nativas, en vez de mezclar 10/12/14px.
 *
 * `vertical` controla el alto: 12px para contenido apilado (etiqueta sobre
 * entrada, notas de varias líneas), 8px para una sola fila horizontal de
 * controles (una entrada, una búsqueda), acercándose a la altura mínima de
 * ~50px de una fila Adw sin inflarla.
 */
export function rowContentMargins(vertical = 12) {
    return {
        marginStart: 12,
        marginEnd: 12,
        marginTop: vertical,
        marginBottom: vertical,
    };
}
/** Espaciado vertical entre la etiqueta y su control dentro de una fila apilada. */
export const ROW_INNER_SPACING = 6;
/**
 * Construye una fila de ancho completo con la etiqueta apilada encima de un
 * Gtk.Entry, para que toda la pista del placeholder quede visible (una
 * entrada lado a lado la recortaría).
 */
export function entryRow(title, placeholder) {
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
        spacing: ROW_INNER_SPACING,
        ...rowContentMargins(),
    });
    box.append(label);
    box.append(entry);
    const row = new Adw.PreferencesRow({ title, activatable: false });
    row.set_child(box);
    return { row, entry, label };
}
/**
 * Hace que un `Adw.ComboRow` muestre sus etiquetas completas (sin elipsis)
 * tanto en el botón colapsado como en el popup, para que nombres de opción
 * largos (ej. "GPU 5070 Ti · 16GB") nunca se corten.
 *
 * Las fábricas por defecto de libadwaita envuelven el valor seleccionado en
 * una etiqueta con `ellipsize: END`, que trunca el texto largo. Aquí se
 * reemplazan ambas fábricas (`factory` para la fila cerrada, `list_factory`
 * para el popup, ambas disponibles desde libadwaita 1.4) por una
 * `Gtk.SignalListItemFactory` que construye una etiqueta sin elipsis. Con
 * `ellipsize: NONE` el popup crece para ajustarse al ítem más ancho, así
 * que no hace falta un ancho manual.
 *
 * `width_chars` fija un mínimo de 4 caracteres: sin él, `wrapMode:
 * WORD_CHAR` permite partir el texto en cualquier punto, así que cuando
 * el subtítulo de la fila es largo y compite por espacio horizontal, el
 * selector se encoge hasta mostrar una sola letra (ej. "C" en vez de
 * "CPU"). El mínimo no le impide crecer a su ancho natural cuando hay
 * espacio, ni impide que opciones más largas (ej. nombres de GPU) sigan
 * envolviendo en varias líneas.
 */
export function widenComboRow(row) {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, obj) => {
        const label = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.NONE,
            wrap: true,
            wrapMode: Pango.WrapMode.WORD_CHAR,
            widthChars: 4,
        });
        obj.set_child(label);
    });
    factory.connect('bind', (_f, obj) => {
        const item = obj;
        const strObj = item.item;
        const label = item.child;
        label.label = strObj?.get_string() ?? '';
    });
    row.factory = factory;
    row.list_factory = factory;
}
/**
 * Muestra un diálogo modal que captura la siguiente combinación de teclas y
 * la reporta como un string acelerador de GTK (un string vacío significa
 * "deshabilitar"). Esc cancela.
 */
export function captureShortcut(parent, onCaptured) {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: parent,
        default_width: 440,
        default_height: 200,
    });
    dialog.set_content(new Adw.StatusPage({
        title: _('Press the desired combination'),
        description: _('Esc to cancel · Backspace to disable'),
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    }));
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
/** Fila que muestra el atajo actual y le permite al usuario grabar uno nuevo. */
export function shortcutRow(settings, key, window) {
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
            if (accel)
                settings.set_strv(key, [accel]);
            else
                settings.set_strv(key, []);
        });
    });
    clearButton.connect('clicked', () => settings.set_strv(key, []));
    return row;
}
/** Una etiqueta insignia en forma de píldora, usada para decorar filas de modelo. */
export function badgeLabel(text, cssClass = 'tag') {
    return new Gtk.Label({
        label: text,
        cssClasses: [cssClass],
        valign: Gtk.Align.CENTER,
    });
}
/**
 * Una insignia en forma de ícono, usada para decorar filas de modelo con
 * estados (recomendado, streaming, descargado) sin el ancho extra de una
 * etiqueta de texto. El texto original queda disponible como tooltip.
 */
export function badgeIcon(iconName, tooltip, cssClass = 'tag') {
    return new Gtk.Image({
        icon_name: iconName,
        tooltip_text: tooltip,
        cssClasses: [cssClass],
        valign: Gtk.Align.CENTER,
    });
}
/**
 * Registra `<extensionDir>/data/icons` como ruta de búsqueda del tema de
 * iconos de GTK, para que los símbolos propios de la extensión (nombre
 * terminado en `-symbolic`) se resuelvan por nombre igual que los del tema
 * del sistema. Esto es lo que permite recolorearlos vía CSS (`color: ...`)
 * en vez de hornear un color fijo dentro del SVG.
 */
export function registerIconSearchPath(display, extensionDir) {
    Gtk.IconTheme.get_for_display(display).add_search_path(`${extensionDir}/data/icons`);
}
//# sourceMappingURL=widgets.js.map