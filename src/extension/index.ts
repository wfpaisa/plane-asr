/* extension/index.ts
 *
 * Punto de entrada de la extensión de GNOME Shell Plane ASR.
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

/**
 * Clase principal de la extensión, registrada por GNOME Shell.
 *
 * Para qué: cablear entre sí los distintos subsistemas (servicio de ASR,
 * indicador de la barra superior, atajo de teclado) al activarse, y
 * liberarlos limpiamente al desactivarse.
 */
export default class PlaneAsrExtension extends Extension {
    _indicator?: InstanceType<typeof Indicator>;
    _settings?: Gio.Settings;
    _service?: AsrService;

    constructor(metadata: ConstructorParameters<typeof Extension>[0]) {
        super(metadata);
        // Vincula las traducciones incluidas bajo <extdir>/locale para el
        // dominio gettext declarado en metadata.json, así toda llamada a
        // _('...') se resuelve a través de ellas (ej. el locale español).
        // No hace nada si no se distribuye un directorio locale/, en cuyo
        // caso se usa el dominio del sistema.
        this.initTranslations();
    }

    /**
     * Llamado por GNOME Shell cuando el usuario activa la extensión.
     *
     * Qué hace: crea el servicio de ASR y el indicador, los conecta entre
     * sí, los añade a la barra superior y registra el atajo de teclado
     * global que alterna la grabación.
     */
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

    /**
     * Llamado por GNOME Shell cuando el usuario desactiva la extensión (o al
     * cerrar sesión).
     *
     * Qué hace: retira el atajo de teclado y destruye el servicio y el
     * indicador para liberar todos sus recursos.
     */
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
