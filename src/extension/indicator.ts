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
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import type {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

/**
 * Panel button that exposes Plane ASR controls to the user.
 *
 * Click behavior (GNOME 50+ opens the menu through a Clutter.ClickGesture that
 * calls `menu.toggle()` on *any* button, so we wrap `toggle` to distinguish the
 * button that triggered the gesture — same approach as color-picker@tuberry):
 *
 * - Left click (primary)  → fire the status notification, never open the menu.
 * - Right click (and any  → open the context menu with the record toggle and
 *   other activation)       the settings entry.
 *
 * NOTE: the menu only emits a status notification for now. Real ASR
 * trigger/handling will be wired here as the feature is implemented.
 */
export const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        // Set by the extension right after construction (see index.ts).
        extension!: Extension;

        _init() {
            super._init(0.0, _('Plane ASR'));

            this.add_child(
                new St.Icon({
                    icon_name: 'audio-input-microphone-symbolic',
                    style_class: 'system-status-icon',
                })
            );

            this._buildMenu();
            this._overrideToggle();
        }

        _buildMenu() {
            const menu = this.menu as PopupMenu.PopupMenu;

            const recordItem = new PopupMenu.PopupMenuItem(
                _('Iniciar/detener grabación')
            );
            recordItem.connect('activate', () => {
                menu.close();
                this._notifyActive();
            });
            menu.addMenuItem(recordItem);

            const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            settingsItem.connect('activate', () => {
                menu.close();
                this.extension.openPreferences();
            });
            menu.addMenuItem(settingsItem);
        }

        /**
         * Wrap `menu.toggle` so the primary (left) mouse button skips the menu
         * and shows the notification instead. The gesture has already committed
         * to COMPLETED by the time `toggle` runs, so we can read its button.
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
                    this._notifyActive();
                } else {
                    originalToggle();
                }
            };
        }

        _notifyActive() {
            Main.notify(_('Plane ASR is active'));
        }
    }
);
