/* prefs/index.ts
 *
 * Preferences window for the Plane ASR extension.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { SETTINGS_KEYS } from '../config/settings.js';
import {
    ASR_BACKENDS,
    getBackend,
    parseArgs,
} from '../extension/asr-backends.js';

/** Ids backing the "Output" combo, in display order. */
const OUTPUT_IDS = ['clipboard', 'paste'] as const;

/**
 * Build a full-width row with the label stacked above a Gtk.Entry, so the
 * whole placeholder hint stays visible (a side-by-side entry would clip it).
 */
function entryRow(
    title: string,
    placeholder: string
): { row: Adw.PreferencesRow; entry: Gtk.Entry; label: Gtk.Label } {
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

    const row = new Adw.PreferencesRow({ title, activatable: false });
    row.set_child(box);
    return { row, entry, label };
}

/**
 * Show a modal dialog that captures the next key combination and reports it as
 * a GTK accelerator string (empty string means "disable"). Esc cancels.
 */
function captureShortcut(
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
        // Require at least one modifier and a valid accelerator so we don't
        // capture stray plain keys.
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
function shortcutRow(
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

/** Extract the model file path from a `model-params` string, if present. */
function extractModelPath(params: string): string | null {
    const toks = parseArgs(params);
    for (let i = 0; i < toks.length; i++) {
        if ((toks[i] === '-m' || toks[i] === '--model') && toks[i + 1]) {
            return toks[i + 1];
        }
    }
    return toks.find(t => /\.(gguf|bin|onnx|pt)$/i.test(t)) ?? null;
}

/** Quick sanity check over the configured binary and model, for the UI. */
function validateSetup(settings: Gio.Settings): string {
    const problems: string[] = [];

    const cliPath = settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
    if (!cliPath) {
        problems.push(_('binary path is empty'));
    } else {
        const file = Gio.File.new_for_path(cliPath);
        if (!file.query_exists(null)) {
            problems.push(_('binary not found: %s').format(cliPath));
        } else {
            const info = file.query_info(
                'access::can-execute',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            if (!info.get_attribute_boolean('access::can-execute')) {
                problems.push(
                    _('binary is not executable: %s').format(cliPath)
                );
            }
        }
    }

    const params = settings.get_string(SETTINGS_KEYS.MODEL_PARAMS) ?? '';
    const modelPath = extractModelPath(params);
    if (!modelPath) {
        problems.push(_('no model file found in model params'));
    } else if (modelPath.startsWith('/')) {
        if (!Gio.File.new_for_path(modelPath).query_exists(null)) {
            problems.push(_('model not found: %s').format(modelPath));
        }
    } else {
        problems.push(
            _('model path is relative and cannot be verified: %s').format(
                modelPath
            )
        );
    }

    return problems.length === 0
        ? _('Binary and model look OK')
        : problems.join('; ');
}

export default class PlaneAsrPreferences extends ExtensionPreferences {
    _settings?: Gio.Settings;

    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._settings = this.getSettings();
        const settings = this._settings!;

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'dialog-information-symbolic',
        });

        // -- ASR backend ---------------------------------------------------
        const asrGroup = new Adw.PreferencesGroup({
            title: _('Transcription'),
            description: _('Configure the local ASR backend'),
        });
        page.add(asrGroup);

        const backendModel = new Gtk.StringList({
            strings: ASR_BACKENDS.map(b => b.label),
        });
        const backendRow = new Adw.ComboRow({
            title: _('ASR backend'),
            subtitle: _('Which transcription CLI to invoke'),
            model: backendModel,
        });
        asrGroup.add(backendRow);

        const cliPathRow = entryRow(
            _('Binary path'),
            'e.g. /home/user/transcribe.cpp/build/bin/transcribe-cli'
        );
        asrGroup.add(cliPathRow.row);

        const modelParamsRow = entryRow(
            _('Model params'),
            'e.g. -m /home/user/models/parakeet-tdt-0.6b-v2-Q8_0.gguf'
        );
        asrGroup.add(modelParamsRow.row);

        const realtimeRow = new Adw.SwitchRow({
            title: _('Realtime mode'),
            subtitle: _('Append --stream-chunk-ms 500'),
        });
        asrGroup.add(realtimeRow);

        const customTemplateRow = entryRow(
            _('Custom arg template'),
            'e.g. {cli} {params} {audio}'
        );
        asrGroup.add(customTemplateRow.row);

        const validateButton = new Gtk.Button({
            label: _('Validate'),
            valign: Gtk.Align.CENTER,
        });
        const validateRow = new Adw.ActionRow({
            title: _('Check binary and model'),
            subtitle: _('Verify the paths exist and the binary is executable'),
        });
        validateRow.add_suffix(validateButton);
        validateRow.activatable_widget = validateButton;
        asrGroup.add(validateRow);

        validateButton.connect('clicked', () => {
            window.add_toast(
                new Adw.Toast({ title: validateSetup(settings), timeout: 5 })
            );
        });

        // -- Output --------------------------------------------------------
        const outputGroup = new Adw.PreferencesGroup({
            title: _('Output'),
            description: _('Where the transcribed text goes'),
        });
        page.add(outputGroup);

        const outputModel = new Gtk.StringList({
            strings: [_('Copy to clipboard'), _('Paste at cursor')],
        });
        const outputRow = new Adw.ComboRow({
            title: _('Output mode'),
            subtitle: _('How to deliver the transcription'),
            model: outputModel,
        });
        outputGroup.add(outputRow);

        outputGroup.add(
            shortcutRow(settings, SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT, window)
        );

        // -- Debug ---------------------------------------------------------
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debug'),
            description: _(
                'When enabled, every transcription run is logged to the ' +
                'system journal (command line, exit status and the raw ' +
                'stdout/stderr of the ASR CLI). Inspect it with:\n' +
                'journalctl --user -b /usr/bin/gnome-shell | grep planeasr'
            ),
        });
        page.add(debugGroup);

        const debugRow = new Adw.SwitchRow({
            title: _('Debug logging'),
            subtitle: _(
                'Record the ASR command and its raw output for troubleshooting'
            ),
        });
        debugGroup.add(debugRow);

        window.add(page);

        // -- Bindings ------------------------------------------------------
        const syncBackendRows = () => {
            const id =
                settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ??
                'transcribe-cli';
            const backend = getBackend(id);
            const idx = Math.max(
                0,
                ASR_BACKENDS.findIndex(b => b.id === backend.id)
            );
            backendRow.selected = idx;
            cliPathRow.label.label = backend.defaultCliName
                ? _('Binary path (%s)').format(backend.defaultCliName)
                : _('Binary path');
            realtimeRow.sensitive = backend.supportsRealtime;
            customTemplateRow.row.visible = backend.id === 'custom';
        };
        // Initialize combo position + derived rows from the stored id.
        syncBackendRows();

        backendRow.connect('notify::selected', () => {
            const backend = ASR_BACKENDS[backendRow.selected];
            if (backend)
                settings.set_string(SETTINGS_KEYS.ASR_BACKEND, backend.id);
        });
        settings.connect(
            `changed::${SETTINGS_KEYS.ASR_BACKEND}`,
            syncBackendRows
        );

        settings.bind(
            SETTINGS_KEYS.CLI_PATH,
            cliPathRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.MODEL_PARAMS,
            modelParamsRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.REALTIME_MODE,
            realtimeRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.CUSTOM_ARG_TEMPLATE,
            customTemplateRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        outputRow.selected = Math.max(
            0,
            OUTPUT_IDS.indexOf(
                (settings.get_string(SETTINGS_KEYS.OUTPUT_MODE) ??
                    'clipboard') as (typeof OUTPUT_IDS)[number]
            )
        );
        outputRow.connect('notify::selected', () => {
            const id = OUTPUT_IDS[outputRow.selected];
            if (id) settings.set_string(SETTINGS_KEYS.OUTPUT_MODE, id);
        });

        settings.bind(
            SETTINGS_KEYS.DEBUG_LOGGING,
            debugRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        return Promise.resolve();
    }
}
