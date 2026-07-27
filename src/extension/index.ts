/* extension/index.ts
 *
 * Entry point of the Plane ASR GNOME Shell extension.
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

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {AsrService} from './asr-service.js';
import {Indicator} from './indicator.js';

export default class PlaneAsrExtension extends Extension {
    _indicator?: InstanceType<typeof Indicator>;
    _settings?: Gio.Settings;
    _service?: AsrService;

    constructor(metadata: ConstructorParameters<typeof Extension>[0]) {
        super(metadata);
        // Bind the bundled translations under <extdir>/locale for the gettext
        // domain declared in metadata.json, so every _('...') call resolves
        // through them (e.g. the Spanish locale). No-op when no locale/ dir is
        // shipped, in which case the system domain is used.
        this.initTranslations();
    }

    enable() {
        this._settings = this.getSettings();

        this._indicator = new Indicator();
        this._indicator.extension = this;

        this._service = new AsrService(
            this._settings,
            (state, ctx) => this._indicator?.onStateChanged(state, ctx),
            {extensionDir: this.path}
        );
        this._indicator.service = this._service;
        this._indicator.bind(this._settings);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        Main.wm.addKeybinding(
            SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            () => {
                this._service?.toggle();
            }
        );
    }

    disable() {
        if (this._settings) {
            Main.wm.removeKeybinding(SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT);
        }

        this._service?.destroy();
        this._service = undefined;

        this._indicator?.destroy();
        this._indicator = undefined;
        this._settings = undefined;
    }
}
