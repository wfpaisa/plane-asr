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
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {recordsDir} from '../config/paths.js';
import {AsrState, type AsrChangeContext} from './asr-service.js';

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
        private _recordItem!: PopupMenu.PopupMenuItem;
        private _copyItem!: PopupMenu.PopupMenuItem;
        private _openAudioItem!: PopupMenu.PopupMenuItem;
        private _processFileItem!: PopupMenu.PopupMenuItem;
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

            this._buildMenu();
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
                    Main.notify(_('Plane ASR is not ready yet'));
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
                        Main.notify(
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
            // "Abrir audios" abre la carpeta de grabaciones bajo demanda
            // (creándola si falta), así que siempre está disponible.
            this._openAudioItem.sensitive = true;
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
            Main.notify(_('Plane ASR: copied transcription'));
        }

        /**
         * Abre un selector de archivos nativo (un Gtk.FileDialog fuera del
         * proceso, ya que los diálogos GTK no pueden correr dentro del
         * proceso St/Clutter de gnome-shell) y le pasa la ruta elegida a
         * {@link AsrServiceLike.transcribeFile}. Silencioso al cancelar;
         * cualquier fallo al lanzar el proceso se registra y se notifica.
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
            // El selector se distribuye en <extdir>/src/extension/file-picker.js
            // (compilado desde src/extension/file-picker.ts; el build
            // preserva la disposición de src/ bajo la raíz de la extensión).
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

            // El selector es agnóstico de i18n (no puede acceder al dominio
            // gettext del shell), así que el título/etiqueta traducidos se
            // pasan por línea de comandos como ARGV[0]/ARGV[1].
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
                    // stdout vacío = el usuario canceló / cerró el diálogo.
                    if (stdout) {
                        void this.service?.transcribeFile(stdout);
                    }
                    resolve();
                });
            });
        }

        /** Abre la carpeta de grabaciones en el gestor de archivos predeterminado. */
        _openAudios() {
            const dir = recordsDir();
            // Asegura que la carpeta exista para que el gestor de archivos
            // realmente la muestre.
            GLib.mkdir_with_parents(dir, 0o755);
            const [uriOk, uri] = GLib.filename_to_uri(dir, null);
            if (!uriOk || !uri) {
                console.warn(`[planeasr] could not build URI for ${dir}`);
                return;
            }
            // Dentro de GNOME Shell necesitamos un AppLaunchContext real.
            // Gdk es una biblioteca cliente de GTK y NO está inicializada en
            // el proceso del compositor (`Gdk.Display.get_default()`
            // devuelve null ahí), así que un contexto basado en Gdk siempre
            // es null y el lanzamiento falla en Wayland con "Operation not
            // supported". El shell expone su propio contexto vía
            // `global.create_app_launch_context(timestamp, workspace)` — la
            // forma canónica de lanzar aplicaciones desde una extensión.
            let launchContext: Gio.AppLaunchContext | null = null;
            try {
                launchContext = global.create_app_launch_context(0, -1);
            } catch (e) {
                console.warn(
                    `[planeasr] could not build shell launch context: ${this._errMsg(e)}`
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
         * Respaldo de último recurso: lanza `xdg-open` directamente. Solo se
         * usa cuando la ruta apropiada de lanzamiento con AppInfo falló
         * (por ejemplo, sin manejador por defecto para `inode/directory`).
         * Se dispara sin esperar el resultado.
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
