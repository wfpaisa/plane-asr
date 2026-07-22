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
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {ASR_BACKENDS, getBackend} from '../extension/asr-backends.js';

/** Ids backing the "Output" combo, in display order. */
const OUTPUT_IDS = ['clipboard', 'paste'] as const;

// NOTE: Adw.EntryRow's `title` doubles as the placeholder text (see Adw docs:
// "Adw.EntryRow has a title that doubles as placeholder text"). Setting
// `placeholder_text` on the underlying Gtk.Editable is therefore invisible —
// the title already occupies that slot. Put hint/example text in the title
// directly, or use an ActionRow + Gtk.Entry if you need both separately.

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

        const cliPathRow = new Adw.EntryRow({
            title: _(
                'Binary path — e.g. /home/user/transcribe.cpp/build/bin/transcribe-cli'
            ),
        });
        asrGroup.add(cliPathRow);

        const modelParamsRow = new Adw.EntryRow({
            title: _(
                'Model params — e.g. -m models/parakeet-tdt-0.6b-v2/parakeet-tdt-0.6b-v2-Q8_0.gguf'
            ),
        });
        asrGroup.add(modelParamsRow);

        const realtimeRow = new Adw.SwitchRow({
            title: _('Realtime mode'),
            subtitle: _('Append --stream-chunk-ms 500'),
        });
        asrGroup.add(realtimeRow);

        const customTemplateRow = new Adw.EntryRow({
            title: _('Custom arg template — e.g. {cli} {params} {audio}'),
        });
        asrGroup.add(customTemplateRow);

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

        const shortcutRow = new Adw.EntryRow({
            title: _('Toggle recording shortcut (e.g. <Super>A)'),
            show_apply_button: true,
        });
        outputGroup.add(shortcutRow);

        // -- Appearance (existing scaffold) -------------------------------
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Indicator spacing'),
        });
        page.add(appearanceGroup);

        const feedbackEnabled = new Adw.SwitchRow({
            title: _('Animated feedback'),
            subtitle: _('Show animated feedback while ASR is running'),
        });
        appearanceGroup.add(feedbackEnabled);

        const paddingInner = new Adw.SpinRow({
            title: _('Inner padding'),
            subtitle: _('Spacing around the panel indicator'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1000,
                stepIncrement: 1,
            }),
        });
        appearanceGroup.add(paddingInner);

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
            cliPathRow.title = backend.defaultCliName
                ? _('Binary path (%s)').format(backend.defaultCliName)
                : _('Binary path');
            realtimeRow.sensitive = backend.supportsRealtime;
            customTemplateRow.visible = backend.id === 'custom';
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
            cliPathRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.MODEL_PARAMS,
            modelParamsRow,
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
            customTemplateRow,
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

        // Keybinding: display current value and validate on apply.
        const currentShortcut = settings
            .get_strv(SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT)
            .at(0);
        if (currentShortcut) shortcutRow.text = currentShortcut;
        shortcutRow.connect('apply', () => {
            const text = shortcutRow.text.trim();
            if (!text) {
                settings.set_strv(SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT, []);
                return;
            }
            const [ok] = Gtk.accelerator_parse(text);
            if (ok) {
                settings.set_strv(SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT, [text]);
            } else {
                shortcutRow.add_css_class('error');
            }
        });

        settings.bind(
            SETTINGS_KEYS.ANIMATE,
            feedbackEnabled,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.PADDING_INNER,
            paddingInner,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        return Promise.resolve();
    }
}
