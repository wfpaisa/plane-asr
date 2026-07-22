/* indicator.ts
 *
 * Panel indicator for the Plane ASR extension.
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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import type {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {AsrState, type AsrChangeContext} from './asr-service.js';

/** CSS class toggled on the button while recording. */
const RECORDING_STYLE_CLASS = 'planeasr-recording';

/**
 * Minimal shape the indicator needs from its owning service. The real
 * {@link AsrService} is assigned at runtime; this interface keeps the indicator
 * decoupled and testable.
 */
export interface AsrServiceLike {
    toggle(): Promise<void>;
    cancel(): void;
    readonly state: AsrState;
}

/**
 * Panel button that exposes Plane ASR controls to the user.
 *
 * Click behavior (GNOME 50+ opens the menu through a Clutter.ClickGesture that
 * calls `menu.toggle()` on *any* button, so we wrap `toggle` to distinguish the
 * button that triggered the gesture — same approach as color-picker@tuberry):
 *
 * - Left click (primary)  -> toggle record/transcribe (or cancel).
 * - Right click (and any  -> open the context menu.
 *   other activation)
 *
 * Visual states are driven by {@link onStateChanged}, called by the
 * {@link AsrService} on every transition.
 */
export const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        // Set by the extension right after construction (see index.ts).
        extension!: Extension;
        /** Owning service; assigned by the extension after construction. */
        service!: AsrServiceLike;
        /** GSettings instance owned by the extension. */
        settings!: Gio.Settings;

        private _box!: St.BoxLayout;
        private _icon!: St.Icon;
        private _stopIcon!: St.Icon;
        private _recordItem!: PopupMenu.PopupMenuItem;
        private _copyItem!: PopupMenu.PopupMenuItem;
        private _openAudioItem!: PopupMenu.PopupMenuItem;
        private _settingsHandlers: number[] = [];

        _init() {
            super._init(0.0, _('Plane ASR'));

            this._icon = new St.Icon({
                icon_name: 'audio-input-microphone-symbolic',
                style_class: 'system-status-icon',
            });
            this._stopIcon = new St.Icon({
                icon_name: 'media-playback-stop-symbolic',
                style_class: 'system-status-icon planeasr-stop-icon',
                visible: false,
            });

            this._box = new St.BoxLayout();
            this._box.add_child(this._icon);
            this._box.add_child(this._stopIcon);
            this.add_child(this._box);

            this._buildMenu();
            this._overrideToggle();
        }

        /**
         * Wire up GSettings and render the initial state. Must be called by the
         * extension right after construction (and after {@link service} is
         * assigned), since {@link _init} cannot take extra args without
         * breaking the `PanelMenu.Button` `_init` signature contract.
         */
        bind(settings: Gio.Settings) {
            this.settings = settings;
            this._connectSettings();
            this.onStateChanged(AsrState.Idle);
        }

        _buildMenu() {
            const menu = this.menu as PopupMenu.PopupMenu;

            this._recordItem = new PopupMenu.PopupMenuItem(
                _('Start recording')
            );
            this._recordItem.connect('activate', () => {
                menu.close();
                this.service?.toggle();
            });
            menu.addMenuItem(this._recordItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._copyItem = new PopupMenu.PopupMenuItem(_('Copy last text'));
            this._copyItem.connect('activate', () => {
                menu.close();
                this._copyLastText();
            });
            menu.addMenuItem(this._copyItem);

            this._openAudioItem = new PopupMenu.PopupMenuItem(
                _('Open last audio')
            );
            this._openAudioItem.connect('activate', () => {
                menu.close();
                this._openLastAudio();
            });
            menu.addMenuItem(this._openAudioItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const settingsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
            settingsItem.connect('activate', () => {
                menu.close();
                this.extension.openPreferences();
            });
            menu.addMenuItem(settingsItem);
        }

        /**
         * Wrap `menu.toggle` so the primary (left) mouse button skips the menu
         * and toggles ASR instead. The gesture has already committed to
         * COMPLETED by the time `toggle` runs, so we can read its button.
         */
        _overrideToggle() {
            const menu = this.menu as PopupMenu.PopupMenu;
            const originalToggle = menu.toggle.bind(menu);

            menu.toggle = () => {
                const gesture = this._clickGesture;
                if (
                    gesture.state === Clutter.GestureState.COMPLETED &&
                    gesture.get_button() === Clutter.BUTTON_PRIMARY
                ) {
                    this._onPrimaryClick();
                } else {
                    originalToggle();
                }
            };
        }

        _connectSettings() {
            const h1 = this.settings.connect(
                `changed::${SETTINGS_KEYS.LAST_TEXT}`,
                () => this._refreshMenuSensitivity()
            );
            const h2 = this.settings.connect(
                `changed::${SETTINGS_KEYS.LAST_AUDIO_PATH}`,
                () => this._refreshMenuSensitivity()
            );
            this._settingsHandlers.push(h1, h2);
        }

        _onPrimaryClick() {
            switch (this.service?.state) {
                case AsrState.Transcribing:
                    this.service.cancel();
                    break;
                case undefined:
                    Main.notify(_('Plane ASR is not ready yet'));
                    break;
                default:
                    this.service.toggle();
            }
        }

        /** Called by {@link AsrService} on every state transition. */
        onStateChanged(state: AsrState, ctx?: AsrChangeContext): void {
            this.remove_style_class_name(RECORDING_STYLE_CLASS);
            this._stopIcon.visible = false;

            switch (state) {
                case AsrState.Idle:
                    this._icon.icon_name = 'audio-input-microphone-symbolic';
                    this._recordItem.label.text = _('Start recording');
                    if (ctx?.error) {
                        Main.notify(_('Plane ASR: %s').format(ctx.error));
                    }
                    break;
                case AsrState.Recording:
                    this._icon.icon_name = 'audio-input-microphone-symbolic';
                    this.add_style_class_name(RECORDING_STYLE_CLASS);
                    this._stopIcon.visible = true;
                    this._recordItem.label.text = _('Stop recording');
                    break;
                case AsrState.Transcribing:
                    this._icon.icon_name = 'content-loading-symbolic';
                    this._recordItem.label.text = ctx?.progress
                        ? _('Transcribing %s').format(ctx.progress)
                        : _('Cancel transcription');
                    break;
            }

            this._refreshMenuSensitivity();
        }

        _refreshMenuSensitivity() {
            const lastText =
                this.settings.get_string(SETTINGS_KEYS.LAST_TEXT) ?? '';
            const lastAudio =
                this.settings.get_string(SETTINGS_KEYS.LAST_AUDIO_PATH) ?? '';
            this._copyItem.sensitive = lastText.length > 0;
            this._openAudioItem.sensitive =
                lastAudio.length > 0 &&
                Gio.File.new_for_path(lastAudio).query_exists(null);
        }

        _copyLastText() {
            const text =
                this.settings.get_string(SETTINGS_KEYS.LAST_TEXT) ?? '';
            if (!text) return;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                text
            );
            Main.notify(_('Plane ASR: copied last transcription'));
        }

        _openLastAudio() {
            const path =
                this.settings.get_string(SETTINGS_KEYS.LAST_AUDIO_PATH) ?? '';
            if (!path) return;
            const [uriOk, uri] = GLib.filename_to_uri(path, null);
            if (!uriOk || !uri) return;
            Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
        }

        destroy() {
            this._settingsHandlers.forEach(h => this.settings.disconnect(h));
            this._settingsHandlers = [];
            super.destroy();
        }
    }
);
