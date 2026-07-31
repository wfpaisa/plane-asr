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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {AsrService} from './asr-service.js';
import {Indicator} from './indicator.js';
import {
    addGlobalKeybinding,
    addPanelIndicator,
    pointerModifiers,
    removeKeybinding,
} from './shell-compat.js';

/**
 * Clase principal de la extensión, registrada por GNOME Shell.
 *
 * Para qué: cablear entre sí los distintos subsistemas (servicio de ASR,
 * indicador de la barra superior, atajo de teclado) al activarse, y
 * liberarlos limpiamente al desactivarse.
 */
/**
 * Máscara de los modificadores que vigila el modo "mantener para hablar".
 * `global.get_pointer()` devuelve el estado actual de estos, así que basta
 * con sondearlos para saber cuándo el usuario suelta la combinación.
 */
const PTT_MOD_MASK =
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK;

/** Cada cuántos ms se sondea si el usuario ya soltó las teclas. */
const PTT_POLL_INTERVAL_MS = 40;

export default class PlaneAsrExtension extends Extension {
    _indicator?: InstanceType<typeof Indicator>;
    _settings?: Gio.Settings;
    _service?: AsrService;
    /** Id del sondeo de release activo (0 = ninguno). */
    _pttPollId = 0;

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
     * sí, los añade a la barra superior y registra los atajos de teclado
     * globales: uno que alterna la grabación y otro de "mantener para hablar".
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

        addPanelIndicator(this.uuid, this._indicator);

        addGlobalKeybinding(
            SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT,
            this._settings,
            () => {
                this._service?.toggle();
            }
        );

        addGlobalKeybinding(
            SETTINGS_KEYS.PUSH_TO_TALK_SHORTCUT,
            this._settings,
            () => {
                this._onPushToTalk();
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
        if (this._pttPollId) {
            GLib.source_remove(this._pttPollId);
            this._pttPollId = 0;
        }

        if (this._settings) {
            removeKeybinding(SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT);
            removeKeybinding(SETTINGS_KEYS.PUSH_TO_TALK_SHORTCUT);
        }

        this._service?.destroy();
        this._service = undefined;

        this._indicator?.destroy();
        this._indicator = undefined;
        this._settings = undefined;
    }

    /**
     * Maneja el atajo de "mantener para hablar".
     *
     * Qué hace: al presionarse la combinación arranca la grabación y comienza
     * a sondear la máscara de modificadores. GNOME solo entrega el evento de
     * pulsación (no el de soltar), así que se vigila `global.get_pointer()`
     * cada pocos ms y, cuando todos los modificadores que estaban oprimidos al
     * disparar se sueltan, se detiene y transcribe.
     *
     * Si la combinación no incluye ningún modificador (no se puede detectar el
     * release) se degrada a un simple alternar, preservando algo de utilidad.
     */
    _onPushToTalk() {
        // Ya hay un mantener-pulsado en curso: ignora el auto-repeat del
        // teclado, que reenvía el atajo mientras la tecla sigue oprimida.
        if (this._pttPollId) return;

        const service = this._service;
        if (!service) return;

        const held = pointerModifiers() & PTT_MOD_MASK;
        if (held === 0) {
            // Sin modificadores que vigilar: no hay forma de saber cuándo se
            // suelta, así que se comporta como el atajo de alternar.
            service.toggle();
            return;
        }

        service.beginHold();
        this._pttPollId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PTT_POLL_INTERVAL_MS,
            () => {
                // Sigue oprimido mientras cualquiera de los modificadores
                // iniciales permanezca activo.
                if ((pointerModifiers() & held) !== 0) {
                    return GLib.SOURCE_CONTINUE;
                }
                this._pttPollId = 0;
                service.endHold();
                return GLib.SOURCE_REMOVE;
            }
        );
    }
}
