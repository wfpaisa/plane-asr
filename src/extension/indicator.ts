/* indicator.ts
 *
 * Indicador de panel para la extensión Plane ASR.
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
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {recordsDir} from '../config/paths.js';
import {AsrState, type AsrChangeContext} from './asr-service.js';
import {notify} from './notify.js';
import {pickAudioFile} from './file-chooser-portal.js';

/** Clase CSS que se activa/desactiva en el botón mientras se graba. */
const RECORDING_STYLE_CLASS = 'planeasr-recording';

/** Opacidad hasta la que se atenúa el botón en el extremo tenue de cada fase de parpadeo. */
const BLINK_DIM_OPACITY = 90;
/** Duración (ms) de cada fase de desvanecimiento; el ciclo completo tenue-brillante tarda 2x esto. */
const BLINK_PHASE_MS = 1000;

/**
 * Forma mínima que el indicador necesita de su servicio propietario. El
 * {@link AsrService} real se asigna en tiempo de ejecución; esta interfaz
 * mantiene al indicador desacoplado y fácil de probar.
 */
export interface AsrServiceLike {
    toggle(): Promise<void>;
    cancel(): void;
    /** Transcribe un archivo de audio existente elegido por el usuario. */
    transcribeFile(path: string): Promise<void>;
    readonly state: AsrState;
}

/**
 * Botón de panel que expone los controles de Plane ASR al usuario.
 *
 * Comportamiento del clic (GNOME 50+ abre el menú a través de un
 * Clutter.ClickGesture que llama a `menu.toggle()` para *cualquier* botón,
 * así que envolvemos `toggle` para distinguir el botón que disparó el
 * gesto — el mismo enfoque que usa color-picker@tuberry):
 *
 * - Clic izquierdo (primario) -> alterna grabar/transcribir (o cancela).
 * - Clic derecho (y cualquier -> abre el menú contextual.
 *   otra activación)
 *
 * Los estados visuales los conduce {@link onStateChanged}, llamado por el
 * {@link AsrService} en cada transición.
 */
export const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        // Lo asigna la extensión justo después de construirse (ver index.ts).
        extension!: Extension;
        /** Servicio propietario; lo asigna la extensión después de construirse. */
        service!: AsrServiceLike;
        /** Instancia de GSettings propiedad de la extensión. */
        settings!: Gio.Settings;

        private _icon!: St.Icon;
        /** Icono mostrado en reposo (data/icons/sound-symbolic.svg). */
        private _idleIcon!: Gio.Icon;
        /** Primer cuadro de la animación de grabación (data/icons/sound-symbolic.svg). */
        private _recordIconA!: Gio.Icon;
        /** Segundo cuadro de la animación de grabación (data/icons/sound2-symbolic.svg), intercalado con {@link _recordIconA} en cada fase de parpadeo. */
        private _recordIconB!: Gio.Icon;
        private _recordItem!: PopupMenu.PopupImageMenuItem;
        private _copyItem!: PopupMenu.PopupImageMenuItem;
        private _copyAudiosPathItem!: PopupMenu.PopupImageMenuItem;
        private _processFileItem!: PopupMenu.PopupImageMenuItem;
        private _settingsHandlers: number[] = [];
        /** Protege el bucle recursivo de easing en {@link _pulseBlink}; ver {@link _startBlink}. */
        private _blinking = false;

        /** Constructor de GObject: crea el icono y arma el menú del panel. */
        _init() {
            super._init(0.0, _('Plane ASR'));

            this._icon = new St.Icon({
                style_class: 'system-status-icon',
            });
            this.add_child(this._icon);

            this._overrideToggle();
        }

        /**
         * Conecta GSettings y renderiza el estado inicial.
         *
         * Debe llamarlo la extensión justo después de construirse (y
         * después de que se asigne {@link service}), ya que {@link _init}
         * no puede recibir argumentos adicionales sin romper el contrato de
         * firma de `_init` de `PanelMenu.Button`.
         */
        bind(settings: Gio.Settings) {
            this.settings = settings;
            // El menú se arma aquí (no en _init) porque sus iconos se
            // resuelven desde this.extension.path, asignado por la extensión
            // recién tras construir el indicador.
            this._buildMenu();
            this._idleIcon = Gio.icon_new_for_string(
                GLib.build_filenamev([
                    this.extension.path,
                    'data',
                    'icons',
                    'sound-symbolic.svg',
                ])
            );
            this._recordIconA = Gio.icon_new_for_string(
                GLib.build_filenamev([
                    this.extension.path,
                    'data',
                    'icons',
                    'sound-symbolic.svg',
                ])
            );
            this._recordIconB = Gio.icon_new_for_string(
                GLib.build_filenamev([
                    this.extension.path,
                    'data',
                    'icons',
                    'sound2-symbolic.svg',
                ])
            );
            this._connectSettings();
            this.onStateChanged(AsrState.Idle);
        }

        /** Construye los ítems del menú emergente (grabar, copiar, abrir audios, procesar archivo, preferencias). */
        _buildMenu() {
            const menu = this.menu as PopupMenu.PopupMenu;

            this._recordItem = new PopupMenu.PopupImageMenuItem(
                _('Start recording'),
                this._menuIcon('sound-symbolic.svg')
            );
            this._recordItem.connect('activate', () => {
                menu.close();
                this.service?.toggle();
            });
            menu.addMenuItem(this._recordItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._copyItem = new PopupMenu.PopupImageMenuItem(
                _('Copy text'),
                this._menuIcon('copy-symbolic.svg')
            );
            this._copyItem.connect('activate', () => {
                menu.close();
                this._copyLastText();
            });
            menu.addMenuItem(this._copyItem);

            this._copyAudiosPathItem = new PopupMenu.PopupImageMenuItem(
                _('Copy audios path'),
                this._menuIcon('copy-symbolic.svg')
            );
            this._copyAudiosPathItem.connect('activate', () => {
                menu.close();
                this._copyAudiosPath();
            });
            menu.addMenuItem(this._copyAudiosPathItem);

            this._processFileItem = new PopupMenu.PopupImageMenuItem(
                _('Process audio file'),
                this._menuIcon('audio-symbolic.svg')
            );
            this._processFileItem.connect('activate', () => {
                menu.close();
                void this._pickAndTranscribe();
            });
            menu.addMenuItem(this._processFileItem);

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const settingsItem = new PopupMenu.PopupImageMenuItem(
                _('Preferences'),
                this._menuIcon('settings-symbolic.svg')
            );
            settingsItem.connect('activate', () => {
                menu.close();
                this.extension.openPreferences();
            });
            menu.addMenuItem(settingsItem);
        }

        /** Crea un {@link Gio.Icon} a partir de un archivo SVG de data/icons. */
        _menuIcon(name: string): Gio.Icon {
            return Gio.icon_new_for_string(
                GLib.build_filenamev([
                    this.extension.path,
                    'data',
                    'icons',
                    name,
                ])
            );
        }

        /**
         * Envuelve `menu.toggle` para que el botón primario (izquierdo) del
         * mouse se salte el menú y en su lugar alterne el ASR. El gesto ya
         * está en estado COMPLETED para cuando `toggle` se ejecuta, así que
         * podemos leer su botón.
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

        /** Suscribe los cambios de GSettings relevantes para la interfaz del indicador. */
        _connectSettings() {
            const h1 = this.settings.connect(
                `changed::${SETTINGS_KEYS.LAST_TEXT}`,
                () => this._refreshMenuSensitivity()
            );
            this._settingsHandlers.push(h1);
        }

        /** Maneja el clic primario: cancela si está transcribiendo, si no alterna grabar/detener. */
        _onPrimaryClick() {
            switch (this.service?.state) {
                case AsrState.Transcribing:
                    this.service.cancel();
                    break;
                case undefined:
                    notify(
                        this.extension.path,
                        _('Plane ASR is not ready yet')
                    );
                    break;
                default:
                    this.service.toggle();
            }
        }

        /** Llamado por {@link AsrService} en cada transición de estado. */
        onStateChanged(state: AsrState, ctx?: AsrChangeContext): void {
            this.remove_style_class_name(RECORDING_STYLE_CLASS);
            this._stopBlink();

            switch (state) {
                case AsrState.Idle:
                    this._icon.gicon = this._idleIcon;
                    this._recordItem.label.text = _('Start recording');
                    if (ctx?.error) {
                        // El cuerpo de la notificación es donde GNOME
                        // renderiza el texto completo (el título se trunca);
                        // también se registra en el journal para que los
                        // diagnósticos largos del CLI sobrevivan tal cual y
                        // se puedan inspeccionar con:
                        //   journalctl --user -b /usr/bin/gnome-shell | grep planeasr
                        console.warn(`[planeasr] ${ctx.error}`);
                        notify(
                            this.extension.path,
                            _('Plane ASR: transcription failed'),
                            ctx.error
                        );
                    }
                    break;
                case AsrState.Recording:
                    this._icon.gicon = this._recordIconA;
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

        /** Actualiza qué ítems del menú están habilitados según el estado actual. */
        _refreshMenuSensitivity() {
            const lastText =
                this.settings.get_string(SETTINGS_KEYS.LAST_TEXT) ?? '';
            this._copyItem.sensitive = lastText.length > 0;
            // "Copiar ruta de audios" siempre está disponible: solo copia
            // la ruta de la carpeta de grabaciones al portapapeles.
            this._copyAudiosPathItem.sensitive = true;
            // "Procesar archivo de audio" inicia una transcripción, así que
            // solo se habilita en reposo — no debe competir con una
            // grabación o conversión en curso (el servicio también se
            // protege, pero deshabilitarlo aquí evita el lanzamiento inútil).
            this._processFileItem.sensitive =
                this.service?.state === AsrState.Idle;
        }

        /**
         * Inicia un bucle lento de "respiración" de opacidad en el botón
         * para que el estado rojo de grabación sea inconfundible de un
         * vistazo. El motor CSS de St no tiene `@keyframes`, así que el
         * parpadeo se conduce aquí mediante transiciones encadenadas de
         * Clutter en vez de la hoja de estilos.
         */
        _startBlink() {
            if (this._blinking) return;
            this._blinking = true;
            this._pulseBlink(true);
        }

        /** Detiene el bucle de parpadeo y devuelve el botón a opacidad completa de golpe. */
        _stopBlink() {
            if (!this._blinking) return;
            this._blinking = false;
            this.remove_all_transitions();
            this.opacity = 255;
        }

        /**
         * Una fase de desvanecimiento del bucle de parpadeo; se rearma sola
         * hasta que se detiene. Cada fase también intercala el ícono entre
         * {@link _recordIconA} y {@link _recordIconB}, así el efecto de
         * "respiración" viene acompañado de una pequeña animación de forma.
         */
        _pulseBlink(dim: boolean) {
            if (!this._blinking) return;
            this._icon.gicon = dim ? this._recordIconB : this._recordIconA;
            this.ease({
                opacity: dim ? BLINK_DIM_OPACITY : 255,
                duration: BLINK_PHASE_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => this._pulseBlink(!dim),
            });
        }

        /** Copia el último texto transcrito al portapapeles y notifica al usuario. */
        _copyLastText() {
            const text =
                this.settings.get_string(SETTINGS_KEYS.LAST_TEXT) ?? '';
            if (!text) return;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                text
            );
            notify(this.extension.path, _('Plane ASR: copied transcription'));
        }

        /**
         * Abre el selector de archivos de audio vía el portal de escritorio
         * XDG (ver file-chooser-portal.ts) y le pasa la ruta elegida a
         * {@link AsrServiceLike.transcribeFile}. Silencioso al cancelar;
         * cualquier fallo de la llamada D-Bus se registra y se notifica.
         */
        async _pickAndTranscribe(): Promise<void> {
            if (this.service?.state !== AsrState.Idle) {
                notify(this.extension.path, _('Plane ASR is busy'));
                return;
            }

            let path: string | null;
            try {
                path = await pickAudioFile(_('Select audio file'), _('Open'));
            } catch (e) {
                console.warn(
                    `[planeasr] file chooser portal failed: ${this._errMsg(e)}`
                );
                notify(
                    this.extension.path,
                    _('Plane ASR'),
                    _('Could not open the file chooser')
                );
                return;
            }
            // `null` = el usuario canceló / cerró el diálogo.
            if (path) {
                void this.service?.transcribeFile(path);
            }
        }

        /** Copia la ruta de la carpeta de grabaciones al portapapeles. */
        _copyAudiosPath() {
            const dir = recordsDir();
            // Asegura que la carpeta exista para que la ruta copiada sea
            // válida si el usuario la usa de inmediato.
            GLib.mkdir_with_parents(dir, 0o755);
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                dir
            );
            notify(this.extension.path, _('Plane ASR: copied audios path'));
        }

        /** Extrae un mensaje legible de cualquier error capturado. */
        _errMsg(e: unknown): string {
            return e instanceof GLib.Error ? e.message : String(e);
        }

        /** Limpia el parpadeo y desconecta los handlers de settings al destruirse. */
        destroy() {
            this._stopBlink();
            this._settingsHandlers.forEach(h => this.settings.disconnect(h));
            this._settingsHandlers = [];
            super.destroy();
        }
    }
);
