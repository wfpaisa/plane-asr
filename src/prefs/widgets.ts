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
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
export function rowContentMargins(vertical = 12): {
    marginStart: number;
    marginEnd: number;
    marginTop: number;
    marginBottom: number;
} {
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
        spacing: ROW_INNER_SPACING,
        ...rowContentMargins(),
    });
    box.append(label);
    box.append(entry);

    const row = new Adw.PreferencesRow({title, activatable: false});
    row.set_child(box);
    return {row, entry, label};
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
export function widenComboRow(row: Adw.ComboRow): void {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, obj) => {
        const label = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.NONE,
            wrap: true,
            wrapMode: Pango.WrapMode.WORD_CHAR,
            widthChars: 4,
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
 * Muestra un diálogo modal que captura la siguiente combinación de teclas y
 * la reporta como un string acelerador de GTK (un string vacío significa
 * "deshabilitar"). Esc cancela.
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

/** Fila que muestra el atajo actual y le permite al usuario grabar uno nuevo. */
export function shortcutRow(
    settings: Gio.Settings,
    key: string,
    window: Adw.PreferencesWindow,
    opts: {title?: string; subtitle?: string} = {}
): Adw.ActionRow {
    const row = new Adw.ActionRow({
        title: opts.title ?? _('Toggle recording shortcut'),
        subtitle:
            opts.subtitle ?? _('Click Set and press the keys you want to use'),
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

/**
 * Construye un `Adw.ComboRow` cableado a una clave GSettings de tipo string,
 * mapeando cada opción a un id estable en vez de al índice crudo del combo
 * (el orden de las opciones puede cambiar sin romper el valor guardado).
 *
 * Encapsula el patrón que se repetía para los combos de modo del binario,
 * acelerador, idioma y modo de salida: crear el `Gtk.StringList`, ensanchar
 * las etiquetas del combo, leer el string guardado y mapearlo a un índice al
 * poblar, y escribir de vuelta el id al seleccionar. Expone `sync()` para que
 * el caller pueda forzar una relectura (p. ej. antes de leer `row.selected`
 * en lógica que depende del valor, sin esperar a la señal `changed::`).
 *
 * `normalize` es un gancho opcional para migrar valores heredados/inválidos
 * (ver `normalizeCliMode`) antes de buscarlos en `options`; sin él, el valor
 * crudo de GSettings se usa tal cual.
 */
export function comboRow<T extends string>(
    settings: Gio.Settings,
    key: string,
    opts: {
        title: string;
        subtitle?: string;
        options: readonly {id: T; label: string}[];
        fallback: T;
        normalize?: (raw: string) => T;
    }
): {row: Adw.ComboRow; sync: () => void} {
    const model = new Gtk.StringList({strings: opts.options.map(o => o.label)});
    const row = new Adw.ComboRow({
        title: opts.title,
        ...(opts.subtitle !== undefined ? {subtitle: opts.subtitle} : {}),
        model,
    });
    widenComboRow(row);

    const sync = () => {
        const raw = settings.get_string(key) ?? opts.fallback;
        const id = opts.normalize ? opts.normalize(raw) : (raw as T);
        row.selected = Math.max(
            0,
            opts.options.findIndex(o => o.id === id)
        );
    };
    sync();
    row.connect('notify::selected', () => {
        const opt = opts.options[row.selected];
        if (opt) settings.set_string(key, opt.id);
    });
    settings.connect(`changed::${key}`, sync);

    return {row, sync};
}

/**
 * Construye un `Adw.SpinRow` entero cableado bidireccionalmente a una clave
 * GSettings numérica vía `settings.bind()`.
 *
 * Encapsula el trío `Gtk.Adjustment` + `Adw.SpinRow` + `settings.bind()` que
 * se repetía para hilos de CPU, duración/solapamiento de fragmentos y
 * cantidad de grabaciones a conservar. El valor inicial del `Adjustment` no
 * importa: `bind()` lo sincroniza desde GSettings de inmediato.
 */
export function spinRow(
    settings: Gio.Settings,
    key: string,
    opts: {
        title: string;
        subtitle?: string;
        lower: number;
        upper: number;
        step?: number;
        page?: number;
    }
): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title: opts.title,
        ...(opts.subtitle !== undefined ? {subtitle: opts.subtitle} : {}),
        adjustment: new Gtk.Adjustment({
            lower: opts.lower,
            upper: opts.upper,
            step_increment: opts.step ?? 1,
            page_increment: opts.page ?? opts.step ?? 1,
        }),
        digits: 0,
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Una etiqueta insignia en forma de píldora, usada para decorar filas de modelo. */
export function badgeLabel(text: string, cssClass = 'tag'): Gtk.Label {
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
export function badgeIcon(
    iconName: string,
    tooltip: string,
    cssClass = 'tag'
): Gtk.Image {
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
export function registerIconSearchPath(
    display: Gdk.Display,
    extensionDir: string
): void {
    Gtk.IconTheme.get_for_display(display).add_search_path(
        `${extensionDir}/data/icons`
    );
}
