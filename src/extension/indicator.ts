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
import Gdk from 'gi://Gdk';
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
import {recordsDir} from '../config/paths.js';
import {AsrState, type AsrChangeContext} from './asr-service.js';

/** CSS class toggled on the button while recording. */
const RECORDING_STYLE_CLASS = 'planeasr-recording';

/** Opacity the button eases down to at the dim end of each blink phase. */
const BLINK_DIM_OPACITY = 90;
/** Duration (ms) of each fade phase; the full dim-bright cycle takes 2x this. */
const BLINK_PHASE_MS = 1000;

/**
 * Minimal shape the indicator needs from its owning service. The real
 * {@link AsrService} is assigned at runtime; this interface keeps the indicator
 * decoupled and testable.
 */
export interface AsrServiceLike {
    toggle(): Promise<void>;
    cancel(): void;
    /** Transcribe an existing audio file picked by the user. */
    transcribeFile(path: string): Promise<void>;
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

        private _icon!: St.Icon;
        /** Icon shown while idle (data/icons/no-sound-symbolic.svg). */
        private _noSoundIcon!: Gio.Icon;
        /** Icon shown while recording (data/icons/sound-symbolic.svg). */
        private _soundIcon!: Gio.Icon;
        private _recordItem!: PopupMenu.PopupMenuItem;
        private _copyItem!: PopupMenu.PopupMenuItem;
        private _openAudioItem!: PopupMenu.PopupMenuItem;
        private _processFileItem!: PopupMenu.PopupMenuItem;
        private _settingsHandlers: number[] = [];
        /** Guards the recursive ease loop in {@link _pulseBlink}; see {@link _startBlink}. */
        private _blinking = false;

        _init() {
            super._init(0.0, _('Plane ASR'));

            this._icon = new St.Icon({
                style_class: 'system-status-icon',
            });
            this.add_child(this._icon);

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
            this._noSoundIcon = Gio.icon_new_for_string(
                GLib.build_filenamev([
                    this.extension.path,
                    'data',
                    'icons',
                    'no-sound-symbolic.svg',
                ])
            );
            this._soundIcon = Gio.icon_new_for_string(
                GLib.build_filenamev([
                    this.extension.path,
                    'data',
                    'icons',
                    'sound-symbolic.svg',
                ])
            );
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

            this._copyItem = new PopupMenu.PopupMenuItem(_('Copy text'));
            this._copyItem.connect('activate', () => {
                menu.close();
                this._copyLastText();
            });
            menu.addMenuItem(this._copyItem);

            this._openAudioItem = new PopupMenu.PopupMenuItem(_('Open audios'));
            this._openAudioItem.connect('activate', () => {
                menu.close();
                this._openAudios();
            });
            menu.addMenuItem(this._openAudioItem);

            this._processFileItem = new PopupMenu.PopupMenuItem(
                _('Process audio file')
            );
            this._processFileItem.connect('activate', () => {
                menu.close();
                this._pickAndTranscribe();
            });
            menu.addMenuItem(this._processFileItem);

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
            this._settingsHandlers.push(h1);
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
            this._stopBlink();

            switch (state) {
                case AsrState.Idle:
                    this._icon.gicon = this._noSoundIcon;
                    this._recordItem.label.text = _('Start recording');
                    if (ctx?.error) {
                        // The notification body is where GNOME renders the full
                        // text (the title is truncated); log it to the journal
                        // too so long CLI diagnostics survive verbatim and can
                        // be inspected with
                        //   journalctl --user -b /usr/bin/gnome-shell | grep planeasr
                        console.warn(`[planeasr] ${ctx.error}`);
                        Main.notify(
                            _('Plane ASR: transcription failed'),
                            ctx.error
                        );
                    }
                    break;
                case AsrState.Recording:
                    this._icon.gicon = this._soundIcon;
                    this.add_style_class_name(RECORDING_STYLE_CLASS);
                    this._recordItem.label.text = _('Stop recording');
                    this._startBlink();
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
            this._copyItem.sensitive = lastText.length > 0;
            // "Open audios" opens the records folder on demand (creating it if
            // missing), so it is always available.
            this._openAudioItem.sensitive = true;
            // "Process audio file" kicks off a transcription run, so it is only
            // enabled while idle — it must not race an in-flight recording or
            // conversion (the service guards too, but disabling here avoids the
            // pointless spawn).
            this._processFileItem.sensitive =
                this.service?.state === AsrState.Idle;
        }

        /**
         * Start a slow opacity "breathing" loop on the button so the red
         * recording state is unmistakable at a glance. St's CSS engine has no
         * `@keyframes`, so the blink is driven here via chained Clutter
         * transitions instead of the stylesheet.
         */
        _startBlink() {
            if (this._blinking) return;
            this._blinking = true;
            this._pulseBlink(true);
        }

        /** Stop the blink loop and snap the button back to full opacity. */
        _stopBlink() {
            if (!this._blinking) return;
            this._blinking = false;
            this.remove_all_transitions();
            this.opacity = 255;
        }

        /** One fade phase of the blink loop; re-arms itself until stopped. */
        _pulseBlink(dim: boolean) {
            if (!this._blinking) return;
            this.ease({
                opacity: dim ? BLINK_DIM_OPACITY : 255,
                duration: BLINK_PHASE_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => this._pulseBlink(!dim),
            });
        }

        _copyLastText() {
            const text =
                this.settings.get_string(SETTINGS_KEYS.LAST_TEXT) ?? '';
            if (!text) return;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                text
            );
            Main.notify(_('Plane ASR: copied transcription'));
        }

        /**
         * Open a native file picker (an out-of-process Gtk.FileDialog, since GTK
         * dialogs can't run inside the gnome-shell St/Clutter process) and feed
         * the chosen path to {@link AsrServiceLike.transcribeFile}. Silent on
         * cancel; any spawn failure is logged and notified.
         */
        _pickAndTranscribe(): Promise<void> {
            if (this.service?.state !== AsrState.Idle) {
                Main.notify(_('Plane ASR is busy'));
                return Promise.resolve();
            }

            const gjs = GLib.find_program_in_path('gjs');
            if (!gjs) {
                Main.notify(
                    _('Plane ASR'),
                    _('gjs runtime not found; cannot open the file picker')
                );
                return Promise.resolve();
            }
            // The picker ships at <extdir>/src/extension/file-picker.js
            // (compiled from src/extension/file-picker.ts; the build preserves
            // the src/ layout under the extension root).
            const pickerPath = GLib.build_filenamev([
                this.extension.path,
                'src',
                'extension',
                'file-picker.js',
            ]);
            if (!Gio.File.new_for_path(pickerPath).query_exists(null)) {
                console.warn(
                    `[planeasr] file picker script missing: ${pickerPath}`
                );
                Main.notify(
                    _('Plane ASR'),
                    _('File picker helper is missing; reinstall the extension')
                );
                return Promise.resolve();
            }

            // The picker is i18n-agnostic (it can't reach the shell's gettext
            // domain), so the translated title/accept-label are passed on the
            // command line as ARGV[0]/ARGV[1].
            const argv = [
                gjs,
                '-m',
                pickerPath,
                _('Select audio file'),
                _('Open'),
            ];

            return new Promise<void>(resolve => {
                let proc: Gio.Subprocess;
                try {
                    proc = new Gio.Subprocess({
                        argv,
                        flags: Gio.SubprocessFlags.STDOUT_PIPE,
                    });
                    proc.init(null);
                } catch (e) {
                    console.warn(
                        `[planeasr] could not spawn file picker: ${this._errMsg(e)}`
                    );
                    Main.notify(
                        _('Plane ASR'),
                        _('Could not open the file picker')
                    );
                    resolve();
                    return;
                }

                proc.communicate_utf8_async(null, null, (_self, res) => {
                    let stdout = '';
                    try {
                        const [, out] = proc.communicate_utf8_finish(res);
                        stdout = (out ?? '').trim();
                    } catch (e) {
                        console.warn(
                            `[planeasr] file picker failed: ${this._errMsg(e)}`
                        );
                        resolve();
                        return;
                    }
                    // Empty stdout = user cancelled / dismissed the dialog.
                    if (stdout) {
                        void this.service?.transcribeFile(stdout);
                    }
                    resolve();
                });
            });
        }

        _openAudios() {
            const dir = recordsDir();
            // Ensure the folder exists so the file manager actually shows it.
            GLib.mkdir_with_parents(dir, 0o755);
            const [uriOk, uri] = GLib.filename_to_uri(dir, null);
            if (!uriOk || !uri) {
                console.warn(`[planeasr] could not build URI for ${dir}`);
                return;
            }
            // Inside GNOME Shell we need a real AppLaunchContext: passing null
            // makes launch_default_for_uri() silently succeed on Wayland
            // without ever showing a window (no startup-notification ID, no
            // activation timestamp). Build one from the default GdkDisplay so
            // the spawned app gets the right focus/activation semantics.
            let launchContext: Gio.AppLaunchContext | null = null;
            try {
                const display = Gdk.Display.get_default();
                if (display) {
                    launchContext = display.get_app_launch_context();
                }
            } catch (e) {
                console.warn(
                    `[planeasr] could not build Gdk launch context: ${this._errMsg(e)}`
                );
            }
            try {
                Gio.AppInfo.launch_default_for_uri_async(
                    uri,
                    launchContext,
                    null,
                    (_self, res) => {
                        try {
                            Gio.AppInfo.launch_default_for_uri_finish(res);
                        } catch (e) {
                            console.warn(
                                `[planeasr] launch_default_for_uri_async failed: ${this._errMsg(e)}`
                            );
                            this._openAudiosFallback(uri);
                        }
                    }
                );
            } catch (e) {
                console.warn(
                    `[planeasr] launch_default_for_uri_async threw: ${this._errMsg(e)}`
                );
                this._openAudiosFallback(uri);
            }
        }

        /**
         * Last-resort fallback: spawn `xdg-open` directly. Only used when the
         * proper AppInfo launch path threw (e.g. no default handler for
         * `inode/directory`). Fire-and-forget.
         */
        _openAudiosFallback(uri: string) {
            try {
                new Gio.Subprocess({
                    argv: ['xdg-open', uri],
                    flags: Gio.SubprocessFlags.NONE,
                }).init(null);
            } catch (e) {
                console.warn(`[planeasr] xdg-open failed: ${this._errMsg(e)}`);
                Main.notify(
                    _('Plane ASR'),
                    _('Could not open the audios folder')
                );
            }
        }

        _errMsg(e: unknown): string {
            return e instanceof GLib.Error ? e.message : String(e);
        }

        destroy() {
            this._stopBlink();
            this._settingsHandlers.forEach(h => this.settings.disconnect(h));
            this._settingsHandlers = [];
            super.destroy();
        }
    }
);
