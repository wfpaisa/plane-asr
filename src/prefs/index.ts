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
import GLib from 'gi://GLib';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SETTINGS_KEYS, normalizeCliMode} from '../config/settings.js';
import {parseArgs} from '../extension/asr-backends.js';
import {resolveAutoCli} from '../extension/cli-resolver.js';
import {listDevices} from '../extension/device-lister.js';
import {findModel, pickFile, resolveModelDir} from '../models/catalog.js';
import {buildModelsPage} from './models-page.js';
import {buildSetupPage} from './setup-page.js';
import {
    entryRow,
    registerIconSearchPath,
    rowContentMargins,
    shortcutRow,
    widenComboRow,
} from './widgets.js';

/** Ids que respaldan el combo "Output", en orden de visualización. */
const OUTPUT_IDS = ['clipboard', 'paste'] as const;

/** Ids que respaldan el combo "Accelerator". */
const ACCELERATOR_IDS = ['auto', 'cpu', 'vulkan'] as const;

/** Ids que respaldan el combo "Binary mode", en orden de visualización. */
const CLI_MODE_IDS = ['cpu', 'gpu'] as const;

/** Códigos de idioma comunes ofrecidos en el combo de idioma. Las etiquetas
 *  se traducen de forma diferida dentro de `fillPreferencesWindow`, porque
 *  `gettext` solo puede llamarse una vez que el dominio de la extensión está
 *  registrado (nunca al cargar el módulo). */
const LANGUAGE_CODES = [
    'auto',
    'en',
    'es',
    'fr',
    'de',
    'it',
    'pt',
    'nl',
    'ru',
    'ja',
    'ko',
    'zh',
    'ar',
    'hi',
    'tr',
    'pl',
    'uk',
    'vi',
] as const;

/** Nombres de visualización en inglés para {@link LANGUAGE_CODES} (se dejan sin
 *  traducir a nivel de módulo para que nunca necesiten gettext; se sobrescriben
 *  con la traducción más abajo). */
const LANGUAGE_DEFAULT_NAMES: Record<string, string> = {
    auto: 'Auto-detect',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    ru: 'Russian',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese',
    ar: 'Arabic',
    hi: 'Hindi',
    tr: 'Turkish',
    pl: 'Polish',
    uk: 'Ukrainian',
    vi: 'Vietnamese',
};

/** Extrae la ruta del archivo de modelo desde un string `model-params`, si está presente. */
function extractModelPath(params: string): string | null {
    const toks = parseArgs(params);
    for (let i = 0; i < toks.length; i++) {
        if ((toks[i] === '-m' || toks[i] === '--model') && toks[i + 1]) {
            return toks[i + 1];
        }
    }
    return toks.find(t => /\.(gguf|bin|onnx|pt)$/i.test(t)) ?? null;
}

/** Verificación rápida de cordura sobre el binario y el modelo configurados, para la UI. */
function validateSetup(
    settings: Gio.Settings,
    extensionDir: string | null
): string {
    const problems: string[] = [];

    const mode = normalizeCliMode(
        settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
    );
    let cliPath: string;
    if (mode === 'gpu') {
        cliPath = settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
        if (!cliPath) {
            problems.push(_('binary path is empty'));
        } else {
            const file = Gio.File.new_for_path(cliPath);
            if (!file.query_exists(null)) {
                problems.push(_('binary not found: %s').format(cliPath));
            } else {
                const info = file.query_info(
                    'access::can-execute',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                if (!info.get_attribute_boolean('access::can-execute')) {
                    problems.push(
                        _('binary is not executable: %s').format(cliPath)
                    );
                }
            }
        }
    } else {
        // Modo automático: valida el binario resuelto (empaquetado o de PATH).
        const resolved = resolveAutoCli(extensionDir, 'transcribe-cli');
        if (resolved.source === 'none') {
            problems.push(
                _('no transcription binary found (bundled or on PATH)')
            );
        } else {
            const info = Gio.File.new_for_path(resolved.path).query_info(
                'access::can-execute',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            if (!info.get_attribute_boolean('access::can-execute')) {
                problems.push(
                    _('binary is not executable: %s').format(resolved.path)
                );
            }
        }
    }

    // Resuelve el modelo: el modelo activo del catálogo tiene precedencia
    // sobre los parámetros.
    const modelId = settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
    let modelPath: string | null = null;
    if (modelId && extensionDir) {
        const entry = findModel(extensionDir, modelId);
        if (entry) {
            const file = pickFile(
                entry,
                settings.get_string(SETTINGS_KEYS.QUANT_PREFERENCE) ?? ''
            );
            if (file) {
                modelPath = resolveModelFilePath(settings, file.filename);
            }
        }
    }
    if (!modelPath) {
        const params = settings.get_string(SETTINGS_KEYS.MODEL_PARAMS) ?? '';
        modelPath = extractModelPath(params);
    }

    if (!modelPath) {
        problems.push(_('no model file found'));
    } else if (modelPath.startsWith('/')) {
        if (!Gio.File.new_for_path(modelPath).query_exists(null)) {
            problems.push(_('model not found: %s').format(modelPath));
        }
    } else {
        problems.push(
            _('model path is relative and cannot be verified: %s').format(
                modelPath
            )
        );
    }

    return problems.length === 0
        ? _('Binary and model look OK')
        : problems.join('; ');
}

/** Resuelve dónde vive un nombre de archivo de modelo dado el ajuste model-dir. */
function resolveModelFilePath(
    settings: Gio.Settings,
    filename: string
): string {
    const dir = resolveModelDir(
        settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
    );
    return GLib.build_filenamev([dir, filename]);
}

/**
 * Muestra un diálogo de confirmación destructivo sobre la ventana de
 * preferencias y ejecuta `onConfirm` solo cuando el usuario elige "Reset".
 * Refleja el patrón de GNOME de proteger acciones irreversibles detrás de un
 * `Adw.MessageDialog` con una respuesta afirmativa DESTRUCTIVE.
 */
function confirmReset(
    parent: Adw.PreferencesWindow,
    onConfirm: () => void
): void {
    const dialog = new Adw.MessageDialog({
        heading: _('Reset all settings?'),
        body: _(
            'This restores every option to its default value. Your downloaded ' +
                'model files are kept on disk.'
        ),
    });
    dialog.set_transient_for(parent);
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('reset', _('Reset'));
    dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.default_response = 'cancel';
    dialog.close_response = 'cancel';
    dialog.connect('response', (_d, response) => {
        if (response === 'reset') onConfirm();
        dialog.destroy();
    });
    dialog.present();
}

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
        const setupPage = buildSetupPage({
            extensionDir,
            settings,
            toast,
        });
        window.add(setupPage);

        /* ================================================================
         * PÁGINA 2: Models  (selección de modelo, catálogo, almacenamiento)
         * ================================================================ */
        const modelsPage = buildModelsPage({
            extensionDir,
            settings,
            toast,
        });
        window.add(modelsPage);

        /* ================================================================
         * PÁGINA 3: Backend  (transcripción + rendimiento + fragmentación)
         * ================================================================ */
        const backendPage = new Adw.PreferencesPage({
            title: _('Backend'),
            iconName: 'utilities-terminal-symbolic',
        });

        // -- Transcripción -----------------------------------------------------
        const asrGroup = new Adw.PreferencesGroup({
            title: _('Transcription'),
            description: _(
                'Configure the transcribe-cli binary (transcribe.cpp)'
            ),
        });
        backendPage.add(asrGroup);

        const cliModeModel = new Gtk.StringList({
            strings: [_('CPU'), _('GPU')],
        });
        const cliModeRow = new Adw.ComboRow({
            title: _('Binary mode'),
            subtitle: _(
                'CPU uses the transcribe-cli shipped with the extension ' +
                    '(x86_64), falling back to one found on PATH. GPU lets ' +
                    'you point to your own Vulkan/CUDA build.'
            ),
            titleLines: 0,
            subtitleLines: 0,
            model: cliModeModel,
        });
        asrGroup.add(cliModeRow);
        widenComboRow(cliModeRow);

        // Nota explicativa mostrada solo en modo GPU
        const gpuNoteLabel = new Gtk.Label({
            xalign: 0,
            cssClasses: ['caption'],
            wrap: true,
            label: _(
                'GPU mode uses a manually configured binary (e.g. a ' +
                    'transcribe.cpp build with Vulkan/CUDA/Metal). Point it ' +
                    'to the compiled transcribe-cli; the accelerator is left ' +
                    'on Auto so the CLI uses whatever GPU it was built for.'
            ),
        });
        const gpuNoteBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            ...rowContentMargins(),
        });
        gpuNoteBox.append(gpuNoteLabel);
        const gpuNoteRow = new Adw.PreferencesRow({activatable: false});
        gpuNoteRow.set_child(gpuNoteBox);
        asrGroup.add(gpuNoteRow);

        // Línea de estado mostrada solo en modo CPU
        const cliStatusRow = new Adw.ActionRow({
            title: _('Resolved binary'),
        });
        asrGroup.add(cliStatusRow);

        const cliPathRow = entryRow(
            _('Binary path'),
            'e.g. /home/user/transcribe.cpp/build/bin/transcribe-cli'
        );
        asrGroup.add(cliPathRow.row);

        const extraFlagsRow = entryRow(
            _('Optional extra flags'),
            _('e.g. --verbose --beam-size 4 (left blank = none)')
        );
        asrGroup.add(extraFlagsRow.row);

        const realtimeRow = new Adw.SwitchRow({
            title: _('Realtime mode'),
            subtitle: _('Append --stream-chunk-ms 500'),
        });
        asrGroup.add(realtimeRow);

        const validateButton = new Gtk.Button({
            label: _('Validate'),
            valign: Gtk.Align.CENTER,
        });
        const validateRow = new Adw.ActionRow({
            title: _('Check binary and model'),
            subtitle: _('Verify the paths exist and the binary is executable'),
        });
        validateRow.add_suffix(validateButton);
        validateRow.activatable_widget = validateButton;
        asrGroup.add(validateRow);

        validateButton.connect('clicked', () => {
            toast(validateSetup(settings, extensionDir));
        });

        // -- Rendimiento / cómputo -----------------------------------------
        const perfGroup = new Adw.PreferencesGroup({
            title: _('Performance'),
            description: _('Tune CPU vs GPU acceleration and threading'),
        });
        backendPage.add(perfGroup);

        const accelModel = new Gtk.StringList({
            strings: [_('Auto'), _('CPU'), _('Vulkan')],
        });
        const accelRow = new Adw.ComboRow({
            title: _('Accelerator'),
            subtitle: _('Compute backend for inference'),
            model: accelModel,
        });
        perfGroup.add(accelRow);
        widenComboRow(accelRow);

        // Menú desplegable de dispositivo GPU: se rellena a partir de la
        // salida de `--list-devices` del CLI configurado, así el índice al
        // que mapea una selección coincide con lo que `--device N`
        // realmente interpreta (vital para builds CUDA, cuyo orden de
        // registro difiere del de `vulkaninfo`). La primera entrada siempre
        // es "Auto" (= sin flag --device, deja que el CLI elija el
        // dispositivo 0).
        const gpuDeviceModel = new Gtk.StringList({
            strings: [_('Auto (let CLI choose)')],
        });
        const gpuDeviceRow = new Adw.ComboRow({
            title: _('GPU device'),
            subtitle: _('Which compute device the CLI uses'),
            model: gpuDeviceModel,
        });
        perfGroup.add(gpuDeviceRow);
        widenComboRow(gpuDeviceRow);

        const threadsRow = new Adw.SpinRow({
            title: _('CPU threads'),
            subtitle: _('0 = auto (use all cores)'),
            titleLines: 0,
            subtitleLines: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 128,
                step_increment: 1,
                page_increment: 4,
                value: 0,
            }),
            digits: 0,
        });
        perfGroup.add(threadsRow);

        // -- Grabaciones largas (fragmentación) -------------------------------
        const chunkGroup = new Adw.PreferencesGroup({
            title: _('Long recordings'),
            description: _(
                'Split live recordings into chunks so transcription streams ' +
                    'progressively and backends with token limits do not ' +
                    'truncate the output.'
            ),
        });
        backendPage.add(chunkGroup);

        const chunkEnabledRow = new Adw.SwitchRow({
            title: _('Live chunked transcription'),
            subtitle: _('Process each N-second chunk as you speak'),
        });
        chunkGroup.add(chunkEnabledRow);

        const chunkSecondsRow = new Adw.SpinRow({
            title: _('Seconds per chunk'),
            subtitle: _(
                'Lower values are safer for models that cap output tokens'
            ),
            titleLines: 0,
            subtitleLines: 0,
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: 10,
            }),
            digits: 0,
        });
        chunkGroup.add(chunkSecondsRow);

        const chunkOverlapRow = new Adw.SpinRow({
            title: _('Overlap seconds'),
            subtitle: _(
                'Re-transcribe this much at each chunk boundary so words ' +
                    'split across the seam are not lost (0 = off)'
            ),
            titleLines: 0,
            subtitleLines: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 5,
                step_increment: 1,
                page_increment: 1,
                value: 1,
            }),
            digits: 0,
        });
        chunkGroup.add(chunkOverlapRow);

        window.add(backendPage);

        /* ================================================================
         * PÁGINA 4: General  (idioma, calidad, salida, depuración)
         * ================================================================ */
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'emblem-system-symbolic',
        });

        // -- Idioma --------------------------------------------------------
        const langGroup = new Adw.PreferencesGroup({
            title: _('Language'),
            description: _('Spoken language and translation settings'),
        });
        generalPage.add(langGroup);

        const languageOptions = LANGUAGE_CODES.map(id => ({
            id,
            label: _(LANGUAGE_DEFAULT_NAMES[id] ?? id),
        }));

        const langModel = new Gtk.StringList({
            strings: languageOptions.map(o => o.label),
        });
        const langRow = new Adw.ComboRow({
            title: _('Spoken language'),
            subtitle: _('Language hint passed to the model'),
            model: langModel,
        });
        langGroup.add(langRow);
        widenComboRow(langRow);

        const translateRow = new Adw.SwitchRow({
            title: _('Translate to English'),
            subtitle: _('When the model supports translation'),
        });
        langGroup.add(translateRow);

        // -- Calidad ---------------------------------------------------------
        const qualityGroup = new Adw.PreferencesGroup({
            title: _('Quality'),
            description: _(
                'Custom vocabulary to bias the transcription toward specific ' +
                    'names or terms'
            ),
        });
        generalPage.add(qualityGroup);

        const promptRow = entryRow(
            _('Initial prompt / custom words'),
            'e.g. García, UPB, Kubernetes, PostgreSQL'
        );
        qualityGroup.add(promptRow.row);

        // -- Salida ----------------------------------------------------------
        const outputGroup = new Adw.PreferencesGroup({
            title: _('Output & Recording'),
            description: _(
                'Where the transcribed text goes and how to trigger recording'
            ),
        });
        generalPage.add(outputGroup);

        const outputModel = new Gtk.StringList({
            strings: [_('Copy to clipboard'), _('Paste at cursor')],
        });
        const outputRow = new Adw.ComboRow({
            title: _('Output mode'),
            subtitle: _('How to deliver the transcription'),
            model: outputModel,
        });
        outputGroup.add(outputRow);
        widenComboRow(outputRow);
        outputGroup.add(
            shortcutRow(settings, SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT, window)
        );

        const keepRecordsRow = new Adw.SpinRow({
            title: _('Keep last recordings'),
            subtitle: _(
                'How many recent recordings to keep under records/. Older ' +
                    'WAVs are deleted automatically (0 = keep none)'
            ),
            titleLines: 0,
            subtitleLines: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: 3,
            }),
            digits: 0,
        });
        outputGroup.add(keepRecordsRow);

        // -- Depuración --------------------------------------------------------
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debug'),
            description: _(
                'Logs every transcription run to the system journal. ' +
                    'Inspect with:\n' +
                    'journalctl --user -b /usr/bin/gnome-shell | grep planeasr'
            ),
        });
        generalPage.add(debugGroup);

        const debugRow = new Adw.SwitchRow({
            title: _('Debug logging'),
            subtitle: _(
                'Record the ASR command and its raw output for troubleshooting'
            ),
            titleLines: 0,
            subtitleLines: 0,
        });
        debugGroup.add(debugRow);

        // -- Restablecer valores por defecto ------------------------------------
        // Acción destructiva: revierte cada clave de GSettings a su valor por
        // defecto del esquema y luego dispara un toast. Un diálogo de
        // confirmación protege contra clics accidentales.
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            cssClasses: ['destructive-action'],
        });
        const resetRow = new Adw.ActionRow({
            title: _('Reset settings'),
            subtitle: _(
                'Restore every option to its default value (binary, model, ' +
                    'language, shortcut…)'
            ),
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;
        debugGroup.add(resetRow);

        resetButton.connect('clicked', () => {
            void confirmReset(window, () => {
                for (const key of Object.values(SETTINGS_KEYS)) {
                    settings.reset(key);
                }
                toast(_('Settings reset to their defaults'));
            });
        });

        window.add(generalPage);

        /* ================================================================
         * BINDINGS  (sincronización bidireccional entre widgets de la UI y Gio.Settings)
         * ================================================================ */

        // transcribe-cli es el único backend. El ajuste 'asr-backend' se deja
        // fijo por compatibilidad, pero ya no hay un combo que lo maneje.
        cliPathRow.label.label = _('Binary path (%s)').format('transcribe-cli');
        realtimeRow.sensitive = true; // transcribe-cli admite tiempo real

        // --- Combo de modo del binario: CPU vs GPU -------------------------
        const syncCliMode = () => {
            const raw = settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu';
            const id = normalizeCliMode(raw);
            const idx = Math.max(0, CLI_MODE_IDS.indexOf(id));
            cliModeRow.selected = idx;
            const gpu = id === 'gpu';
            cliPathRow.row.visible = gpu;
            cliPathRow.row.sensitive = gpu;
            gpuNoteRow.visible = gpu;
            cliStatusRow.visible = !gpu;
            if (!gpu) {
                const resolved = resolveAutoCli(extensionDir, 'transcribe-cli');
                if (resolved.source === 'bundled') {
                    cliStatusRow.subtitle = _(
                        'Using bundled CPU binary (transcribe-cli, x86_64).'
                    ).format();
                } else if (resolved.source === 'path') {
                    cliStatusRow.subtitle = _(
                        'Using transcribe-cli from PATH: %s'
                    ).format(resolved.path);
                } else {
                    cliStatusRow.subtitle = _(
                        'No binary found for this system. Switch to GPU and ' +
                            'set the binary path, or install transcribe-cli.'
                    );
                }
            }
        };
        syncCliMode();
        cliModeRow.connect('notify::selected', () => {
            const modeId = CLI_MODE_IDS[cliModeRow.selected];
            if (!modeId) return;
            settings.set_string(SETTINGS_KEYS.CLI_MODE, modeId);
            // Mantiene el acelerador sincronizado con el modo del binario
            // para que el binario resuelto y el flag --backend nunca
            // discrepen:
            //  - El modo GPU apunta a un binario compilado por el usuario que
            //    puede ser un build Vulkan, CUDA o Metal. Forzar 'vulkan'
            //    rompe los builds CUDA ("vulkan backend requested but not
            //    available"); en vez de eso se deja el acelerador en 'auto'
            //    para que transcribe-cli elija la primera GPU disponible sin
            //    importar el fabricante.
            //  - El modo CPU usa el binario CPU-only empaquetado/de PATH, que
            //    no tiene soporte de GPU, así que se fuerza CPU (de lo
            //    contrario un acelerador desactualizado hace fallar al CLI).
            if (modeId === 'gpu') {
                settings.set_string(SETTINGS_KEYS.ACCELERATOR, 'auto');
            } else {
                settings.set_string(SETTINGS_KEYS.ACCELERATOR, 'cpu');
            }
        });
        settings.connect(`changed::${SETTINGS_KEYS.CLI_MODE}`, syncCliMode);

        // --- Bindings directos de ajustes (página backend) -----------------
        settings.bind(
            SETTINGS_KEYS.CLI_PATH,
            cliPathRow.entry,
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
            SETTINGS_KEYS.EXTRA_CLI_FLAGS,
            extraFlagsRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- Combo de idioma (sincronización bidireccional basada en índice) --
        const syncLang = () => {
            const id =
                settings.get_string(SETTINGS_KEYS.SELECTED_LANGUAGE) ?? 'auto';
            const idx = Math.max(
                0,
                languageOptions.findIndex(o => o.id === id)
            );
            langRow.selected = idx;
        };
        syncLang();
        langRow.connect('notify::selected', () => {
            const opt = languageOptions[langRow.selected];
            if (opt)
                settings.set_string(SETTINGS_KEYS.SELECTED_LANGUAGE, opt.id);
        });
        settings.bind(
            SETTINGS_KEYS.TRANSLATE_TO_ENGLISH,
            translateRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- Combo de acelerador + menú de dispositivo GPU + hilos ---------
        const syncAccel = () => {
            const id = settings.get_string(SETTINGS_KEYS.ACCELERATOR) ?? 'auto';
            const idx = Math.max(0, ACCELERATOR_IDS.indexOf(id as never));
            accelRow.selected = idx;
            // El binario CPU empaquetado no tiene soporte de GPU, así que en
            // modo CPU el acelerador queda fijo en 'cpu' (lo fija
            // syncCliMode) y el combo es de solo lectura para evitar una
            // selección Vulkan fuera de banda.
            const cliMode = normalizeCliMode(
                settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
            );
            accelRow.sensitive = cliMode !== 'cpu';
            // El menú de dispositivo GPU solo importa cuando puede usarse un
            // backend de GPU; se oculta en modo CPU (no hay GPU para elegir).
            gpuDeviceRow.visible = cliMode !== 'cpu';
            gpuDeviceRow.sensitive = id === 'vulkan' || id === 'auto';
        };
        syncAccel();
        accelRow.connect('notify::selected', () => {
            const id = ACCELERATOR_IDS[accelRow.selected];
            if (id) settings.set_string(SETTINGS_KEYS.ACCELERATOR, id);
        });
        settings.connect(`changed::${SETTINGS_KEYS.ACCELERATOR}`, syncAccel);
        // Reevalúa la sensibilidad del acelerador cuando cambia el modo del
        // binario: el modo CPU fija el acelerador en 'cpu' y deshabilita el
        // combo.
        settings.connect(`changed::${SETTINGS_KEYS.CLI_MODE}`, syncAccel);

        settings.bind(
            SETTINGS_KEYS.CPU_THREADS,
            threadsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- Menú de dispositivo GPU (dinámico, desde <cli> --list-devices) --
        // La lista de dispositivos depende de qué binario está activo, así
        // que debe reconstruirse cada vez que cambian cli-mode / cli-path /
        // asr-backend. Cada reconstrucción conserva la selección de
        // gpu-device guardada cuando es posible.
        const refreshGpuDevices = async () => {
            // Reinicia el modelo a solo "Auto" antes de sondear, para que un
            // sondeo transitorio vacío/fallido nunca deje entradas de
            // dispositivo obsoletas.
            gpuDeviceModel.splice(0, gpuDeviceModel.n_items, []);
            gpuDeviceModel.append(_('Auto (let CLI choose)'));

            const mode = normalizeCliMode(
                settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
            );
            const cliPath =
                mode === 'gpu'
                    ? (settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '')
                    : resolveAutoCli(extensionDir, 'transcribe-cli').path;

            let devices = await listDevices(cliPath);
            if (devices.length === 0) {
                gpuDeviceRow.subtitle = cliPath
                    ? _('No devices detected by %s').format(cliPath)
                    : _('No transcription binary configured');
                gpuDeviceRow.selected = 0;
                return;
            }
            // Conserva solo dispositivos de cómputo usables (descarta la
            // entrada CPU que algunos CLIs añaden): seleccionarla sería
            // equivalente al modo CPU.
            devices = devices.filter(d => d.kind !== 'cpu');
            for (const d of devices) {
                const mem = d.vramLabel ? `, ${d.vramLabel}` : '';
                gpuDeviceModel.append(
                    _('%d · %s (%s%s)').format(d.index, d.name, d.kind, mem)
                );
            }
            gpuDeviceRow.subtitle = _('Which compute device the CLI uses');

            // Restaura la selección guardada. -1 (o un índice que ya no
            // existe) mapea a "Auto" (posición 0); la entrada N mapea a la
            // posición N+1.
            const stored = settings.get_int(SETTINGS_KEYS.GPU_DEVICE);
            const matchIdx = devices.findIndex(d => d.index === stored);
            gpuDeviceRow.selected = matchIdx >= 0 ? matchIdx + 1 : 0;
        };
        void refreshGpuDevices();
        // Reconstruye cada vez que cambia el binario que expone la lista de
        // dispositivos.
        gpuDeviceRow.connect('notify::selected', () => {
            const i = gpuDeviceRow.selected;
            // Posición 0 = "Auto". Las posiciones 1..n llevan el índice del
            // dispositivo en el mismo orden en que se añadieron, pero se lee
            // de vuelta desde la etiqueta del modelo en vez de cachear un
            // array paralelo.
            if (i <= 0) {
                settings.set_int(SETTINGS_KEYS.GPU_DEVICE, -1);
                return;
            }
            const label = gpuDeviceModel.get_item(i)?.get_string() ?? '';
            const m = label.match(/^(\d+) ·/);
            settings.set_int(
                SETTINGS_KEYS.GPU_DEVICE,
                m ? parseInt(m[1], 10) : -1
            );
        });
        settings.connect(
            `changed::${SETTINGS_KEYS.CLI_MODE}`,
            () => void refreshGpuDevices()
        );
        settings.connect(
            `changed::${SETTINGS_KEYS.CLI_PATH}`,
            () => void refreshGpuDevices()
        );

        // --- Calidad ---------------------------------------------------------
        settings.bind(
            SETTINGS_KEYS.INITIAL_PROMPT,
            promptRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- Sensibilidad de fragmentación ----------------------------------
        settings.bind(
            SETTINGS_KEYS.CHUNK_ENABLED,
            chunkEnabledRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.CHUNK_SECONDS,
            chunkSecondsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS,
            chunkOverlapRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        const syncChunkSensitivity = () => {
            const on = settings.get_boolean(SETTINGS_KEYS.CHUNK_ENABLED);
            chunkSecondsRow.sensitive = on;
            chunkOverlapRow.sensitive = on;
        };
        syncChunkSensitivity();
        settings.connect(
            `changed::${SETTINGS_KEYS.CHUNK_ENABLED}`,
            syncChunkSensitivity
        );

        // --- Modo de salida --------------------------------------------------
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
        settings.bind(
            SETTINGS_KEYS.KEEP_RECORDS,
            keepRecordsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- Depuración --------------------------------------------------------
        settings.bind(
            SETTINGS_KEYS.DEBUG_LOGGING,
            debugRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        return Promise.resolve();
    }
}
