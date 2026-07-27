/* prefs/index.ts
 *
 * Preferences window for the Plane ASR extension.
 *
 * Four pages (in user priority order):
 *  - "Setup": three-step onboarding guide plus a one-click button that
 *    downloads and activates the recommended model — the first thing a new
 *    user sees.
 *  - "Models": model selection (catalog vs custom), searchable downloader,
 *    storage directory.
 *  - "Backend": transcription backend, binary mode, performance (accelerator,
 *    GPU, threads), and long-recording chunking — everything that affects how
 *    the audio is processed.
 *  - "General": language, quality (prompt), output mode, shortcut, debug.
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
    rowContentMargins,
    shortcutRow,
    widenComboRow,
} from './widgets.js';

/** Ids backing the "Output" combo, in display order. */
const OUTPUT_IDS = ['clipboard', 'paste'] as const;

/** Ids backing the "Accelerator" combo. */
const ACCELERATOR_IDS = ['auto', 'cpu', 'vulkan'] as const;

/** Ids backing the "Binary mode" combo, in display order. */
const CLI_MODE_IDS = ['cpu', 'gpu'] as const;

/** Common language codes offered in the language combo. Labels are translated
 *  lazily inside `fillPreferencesWindow`, because `gettext` can only be called
 *  once the extension domain is registered (never at module load time). */
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

/** English display names for {@link LANGUAGE_CODES} (kept untranslated at module
 *  scope so they never need gettext; overridden by translation below). */
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

/** Extract the model file path from a `model-params` string, if present. */
function extractModelPath(params: string): string | null {
    const toks = parseArgs(params);
    for (let i = 0; i < toks.length; i++) {
        if ((toks[i] === '-m' || toks[i] === '--model') && toks[i + 1]) {
            return toks[i + 1];
        }
    }
    return toks.find(t => /\.(gguf|bin|onnx|pt)$/i.test(t)) ?? null;
}

/** Quick sanity check over the configured binary and model, for the UI. */
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
        // Automatic mode: validate the resolved binary (bundled or PATH).
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

    // Resolve the model: catalog active model takes precedence over params.
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

/** Resolve where a model filename lives given the model-dir setting. */
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
 * Show a destructive confirmation dialog over the prefs window and run
 * `onConfirm` only when the user picks "Reset". Mirrors the GNOME pattern of
 * gating irreversible actions behind `Adw.MessageDialog` with a DESTRUCTIVE
 * affirmative response.
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
        // Bind the bundled translations under <extdir>/locale for the gettext
        // domain declared in metadata.json, so every _('...') call in the prefs
        // UI resolves through them (e.g. the Spanish locale).
        this.initTranslations();
    }

    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._settings = this.getSettings();
        const settings = this._settings!;
        const extensionDir = this.path ?? null;

        const toast = (title: string) =>
            window.add_toast(new Adw.Toast({title, timeout: 5}));

        // Load a small CSS provider for prefs-only styling that libadwaita
        // does not expose as a built-in class — currently the highlight of the
        // active catalog model row. Attached to the window's display so every
        // prefs window instance picks it up.
        const provider = new Gtk.CssProvider();
        const css =
            '.planeasr-active-model {\n' +
            '  background-color: alpha(@accent_bg_color, 0.12);\n' +
            '  outline: 1px solid alpha(@accent_color, 0.4);\n' +
            '  outline-offset: -1px;\n' +
            '}\n' +
            '.planeasr-setup-button {\n' +
            '  min-width: 200px;\n' +
            '  min-height: 72px;\n' +
            '  font-size: 1.3em;\n' +
            '  font-weight: bold;\n' +
            '}\n';
        provider.load_from_data(css, css.length);
        Gtk.StyleContext.add_provider_for_display(
            window.get_display(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        /* ================================================================
         * PAGE 1: Setup  (onboarding guide + one-click model install)
         * ================================================================ */
        const setupPage = buildSetupPage({
            extensionDir,
            settings,
            toast,
        });
        window.add(setupPage);

        /* ================================================================
         * PAGE 2: Models  (model selection, catalog, storage)
         * ================================================================ */
        const modelsPage = buildModelsPage({
            extensionDir,
            settings,
            toast,
        });
        window.add(modelsPage);

        /* ================================================================
         * PAGE 3: Backend  (transcription + performance + chunking)
         * ================================================================ */
        const backendPage = new Adw.PreferencesPage({
            title: _('Backend'),
            iconName: 'utilities-terminal-symbolic',
        });

        // -- Transcription ---------------------------------------------------
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

        // Explanatory note shown only in GPU mode
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

        // Status line shown only in CPU mode
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

        // -- Performance / compute -------------------------------------------
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

        // GPU device dropdown: populated from the configured CLI's
        // `--list-devices` output, so the index a selection maps to matches
        // what `--device N` actually interprets (vital for CUDA builds, whose
        // registry order differs from `vulkaninfo`). The first entry is always
        // "Auto" (= no --device flag, let the CLI pick device 0).
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

        // -- Long recordings (chunking) --------------------------------------
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
         * PAGE 4: General  (language, quality, output, debug)
         * ================================================================ */
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'emblem-system-symbolic',
        });

        // -- Language --------------------------------------------------------
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

        // -- Quality ---------------------------------------------------------
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

        // -- Output ----------------------------------------------------------
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

        // -- Debug -----------------------------------------------------------
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

        // -- Reset to defaults ------------------------------------------------
        // Destructive action: rolls every GSettings key back to its schema
        // default, then fires a toast. A confirmation dialog guards against
        // accidental clicks.
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
         * BINDINGS  (two-way sync between UI widgets and Gio.Settings)
         * ================================================================ */

        // transcribe-cli is the only backend. The 'asr-backend' setting is
        // pinned for compatibility but there is no combo to drive anymore.
        cliPathRow.label.label = _('Binary path (%s)').format('transcribe-cli');
        realtimeRow.sensitive = true; // transcribe-cli supports realtime

        // --- Binary mode combo: CPU vs GPU ---------------------------------
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
            // Keep the accelerator in sync with the binary mode so the
            // resolved binary and the --backend flag never disagree:
            //  - GPU mode points at a user-compiled binary that may be a
            //    Vulkan, CUDA or Metal build. Forcing 'vulkan' breaks CUDA
            //    builds ("vulkan backend requested but not available"); instead
            //    leave the accelerator on 'auto' so transcribe-cli picks the
            //    first available GPU regardless of vendor.
            //  - CPU mode uses the bundled/PATH CPU-only binary, which has no
            //    GPU support, so force CPU (otherwise a stale accelerator makes
            //    the CLI fail).
            if (modeId === 'gpu') {
                settings.set_string(SETTINGS_KEYS.ACCELERATOR, 'auto');
            } else {
                settings.set_string(SETTINGS_KEYS.ACCELERATOR, 'cpu');
            }
        });
        settings.connect(`changed::${SETTINGS_KEYS.CLI_MODE}`, syncCliMode);

        // --- Direct settings bindings (backend page) -----------------------
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

        // --- Language combo (index-based two-way sync) ---------------------
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

        // --- Accelerator combo + GPU device dropdown + threads -------------
        const syncAccel = () => {
            const id = settings.get_string(SETTINGS_KEYS.ACCELERATOR) ?? 'auto';
            const idx = Math.max(0, ACCELERATOR_IDS.indexOf(id as never));
            accelRow.selected = idx;
            // The bundled CPU binary has no GPU support, so in CPU mode the
            // accelerator is locked to 'cpu' (set by syncCliMode) and the
            // combo is read-only to prevent an out-of-band Vulkan selection.
            const cliMode = normalizeCliMode(
                settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
            );
            accelRow.sensitive = cliMode !== 'cpu';
            // The GPU device dropdown only matters when a GPU backend may be
            // used; hide it in CPU mode (no GPU to choose from).
            gpuDeviceRow.visible = cliMode !== 'cpu';
            gpuDeviceRow.sensitive = id === 'vulkan' || id === 'auto';
        };
        syncAccel();
        accelRow.connect('notify::selected', () => {
            const id = ACCELERATOR_IDS[accelRow.selected];
            if (id) settings.set_string(SETTINGS_KEYS.ACCELERATOR, id);
        });
        settings.connect(`changed::${SETTINGS_KEYS.ACCELERATOR}`, syncAccel);
        // Re-evaluate accelerator sensitivity when the binary mode changes:
        // CPU mode locks the accelerator to 'cpu' and disables the combo.
        settings.connect(`changed::${SETTINGS_KEYS.CLI_MODE}`, syncAccel);

        settings.bind(
            SETTINGS_KEYS.CPU_THREADS,
            threadsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- GPU device dropdown (dynamic, from <cli> --list-devices) ------
        // The device list depends on which binary is active, so it must be
        // rebuilt whenever cli-mode / cli-path / asr-backend changes. Each
        // rebuild preserves the stored gpu-device selection when possible.
        const refreshGpuDevices = async () => {
            // Reset the model to just "Auto" before probing, so a transient
            // empty/failed probe never leaves stale device entries.
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
            // Keep only usable compute devices (drop the CPU entry some CLIs
            // append): selecting it would be equivalent to CPU mode.
            devices = devices.filter(d => d.kind !== 'cpu');
            for (const d of devices) {
                const mem = d.vramLabel ? `, ${d.vramLabel}` : '';
                gpuDeviceModel.append(
                    _('%d · %s (%s%s)').format(d.index, d.name, d.kind, mem)
                );
            }
            gpuDeviceRow.subtitle = _('Which compute device the CLI uses');

            // Restore the stored selection. -1 (or an index no longer present)
            // maps to "Auto" (position 0); entry N maps to position N+1.
            const stored = settings.get_int(SETTINGS_KEYS.GPU_DEVICE);
            const matchIdx = devices.findIndex(d => d.index === stored);
            gpuDeviceRow.selected = matchIdx >= 0 ? matchIdx + 1 : 0;
        };
        void refreshGpuDevices();
        // Rebuild whenever the binary that exposes the device list changes.
        gpuDeviceRow.connect('notify::selected', () => {
            const i = gpuDeviceRow.selected;
            // Position 0 = "Auto". Positions 1..n carry the device index in
            // the same order they were appended, but we read it back from the
            // model label rather than caching a parallel array.
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

        // --- Quality -------------------------------------------------------
        settings.bind(
            SETTINGS_KEYS.INITIAL_PROMPT,
            promptRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        // --- Chunking sensitivity ------------------------------------------
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

        // --- Output mode ---------------------------------------------------
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

        // --- Debug ---------------------------------------------------------
        settings.bind(
            SETTINGS_KEYS.DEBUG_LOGGING,
            debugRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        return Promise.resolve();
    }
}
