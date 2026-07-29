/* prefs/index.ts
 *
 * Ventana de preferencias de la extensión Plane ASR.
 *
 * Cuatro páginas (en orden de prioridad para el usuario):
 *  - "Setup": guía de incorporación en tres pasos más un botón de un clic que
 *    descarga y activa el modelo recomendado — lo primero que ve un usuario
 *    nuevo.
 *  - "Models": selección de modelo (catálogo vs personalizado), descargador
 *    con búsqueda, directorio de almacenamiento.
 *  - "Backend": backend de transcripción, modo del binario, rendimiento
 *    (acelerador, GPU, hilos) y fragmentación de grabaciones largas — todo lo
 *    que afecta cómo se procesa el audio.
 *  - "General": idioma, calidad (prompt), modo de salida, atajo, depuración.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildBackendPage} from './backend-page.js';
import {buildGeneralPage} from './general-page.js';
import {buildModelsPage} from './models-page.js';
import {buildSetupPage} from './setup-page.js';
import {registerIconSearchPath} from './widgets.js';

export default class PlaneAsrPreferences extends ExtensionPreferences {
    _settings?: Gio.Settings;

    constructor(
        metadata: ConstructorParameters<typeof ExtensionPreferences>[0]
    ) {
        super(metadata);
        // Vincula las traducciones incluidas bajo <extdir>/locale para el
        // dominio gettext declarado en metadata.json, así toda llamada a
        // _('...') en la UI de preferencias se resuelve a través de ellas
        // (ej. el locale español).
        this.initTranslations();
    }

    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._settings = this.getSettings();
        const settings = this._settings!;
        const extensionDir = this.path ?? null;

        const toast = (title: string) =>
            window.add_toast(new Adw.Toast({title, timeout: 5}));

        // Carga el mismo stylesheet.css que usa la extensión (St/Clutter)
        // también como proveedor CSS de GTK, para las clases exclusivas de
        // preferencias que libadwaita no expone como clase incorporada. Se
        // adjunta al display de la ventana para que toda instancia de la
        // ventana de preferencias lo recoja.
        if (extensionDir) {
            const provider = new Gtk.CssProvider();
            provider.load_from_path(`${extensionDir}/stylesheet.css`);
            Gtk.StyleContext.add_provider_for_display(
                window.get_display(),
                provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );
        }

        // Registra data/icons como ruta de búsqueda del tema para que los
        // símbolos propios (heart-symbolic, flash-symbolic,
        // downloaded-symbolic) se resuelvan por nombre y se puedan
        // recolorear vía CSS igual que cualquier ícono symbolic del tema.
        if (extensionDir) {
            registerIconSearchPath(window.get_display(), extensionDir);
        }

        /* ================================================================
         * PÁGINA 1: Setup  (guía de incorporación + instalación de modelo de un clic)
         * ================================================================ */
        window.add(buildSetupPage({settings, toast}));

        /* ================================================================
         * PÁGINA 2: Models  (selección de modelo, catálogo, almacenamiento)
         * ================================================================ */
        window.add(buildModelsPage({settings, toast}));

        /* ================================================================
         * PÁGINA 3: Backend  (transcripción + rendimiento + fragmentación)
         * ================================================================ */
        window.add(buildBackendPage({settings, toast}));

        /* ================================================================
         * PÁGINA 4: General  (idioma, calidad, salida, depuración)
         * ================================================================ */
        window.add(buildGeneralPage({settings, toast, window}));

        return Promise.resolve();
    }
}
