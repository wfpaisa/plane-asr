/* prefs/index.ts
 *
 * Preferences window for the Plane ASR extension.
 *
 * Two pages:
 *  - "General": model selection, language, compute (CPU/Vulkan), ASR quality,
 *    output, long recordings, debug.
 *  - "Models": searchable downloader for the bundled GGUF catalog.
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

import {SETTINGS_KEYS} from '../config/settings.js';
import {
    ASR_BACKENDS,
    getBackend,
    parseArgs,
} from '../extension/asr-backends.js';
import {resolveAutoCli} from '../extension/cli-resolver.js';
import {GpuDetector, formatVram} from '../extension/gpu-detector.js';
import {
    findModel,
    formatSize,
    pickFile,
    resolveModelDir,
} from '../models/catalog.js';
import {buildModelsPage} from './models-page.js';
import {entryRow, shortcutRow} from './widgets.js';

/** Ids backing the "Output" combo, in display order. */
const OUTPUT_IDS = ['clipboard', 'paste'] as const;

/** Ids backing the "Accelerator" combo. */
const ACCELERATOR_IDS = ['auto', 'cpu', 'vulkan'] as const;

/** Ids backing the "Binary mode" combo, in display order. */
const CLI_MODE_IDS = ['auto', 'manual'] as const;

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

/** Default language labels are resolved through gettext at runtime, inside
 *  `fillPreferencesWindow`, using {@link LANGUAGE_DEFAULT_NAMES}. */

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

    const mode = settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'auto';
    let cliPath: string;
    if (mode === 'manual') {
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
        const backendId =
            settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ?? 'transcribe-cli';
        const pathName = getBackend(backendId).defaultCliName;
        const resolved = resolveAutoCli(extensionDir, pathName);
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

export default class PlaneAsrPreferences extends ExtensionPreferences {
    _settings?: Gio.Settings;

    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._settings = this.getSettings();
        const settings = this._settings!;
        const extensionDir = this.path ?? null;
        const gpuDetector = new GpuDetector();

        const toast = (title: string) =>
            window.add_toast(new Adw.Toast({title, timeout: 5}));

        // ===== General page ==============================================
        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'dialog-information-symbolic',
        });

        // -- Active model --------------------------------------------------
        const modelGroup = new Adw.PreferencesGroup({
            title: _('Model'),
            description: _('Pick a downloaded model or use advanced params'),
        });
        page.add(modelGroup);

        const activeModelRow = new Adw.ActionRow({
            title: _('Active model'),
            subtitle: _('Open the Models page to download and select'),
        });
        const openModelsBtn = new Gtk.Button({
            label: _('Models →'),
            valign: Gtk.Align.CENTER,
        });
        activeModelRow.add_suffix(openModelsBtn);
        activeModelRow.activatable_widget = openModelsBtn;
        modelGroup.add(activeModelRow);

        const activeModelLabel = new Gtk.Label({
            xalign: 0,
            cssClasses: ['caption'],
            wrap: true,
        });
        const activeModelBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            marginStart: 12,
            marginEnd: 12,
            marginBottom: 8,
        });
        activeModelBox.append(activeModelLabel);
        const activeModelInfoRow = new Adw.PreferencesRow({
            activatable: false,
        });
        activeModelInfoRow.set_child(activeModelBox);
        modelGroup.add(activeModelInfoRow);

        const modelParamsRow = entryRow(
            _('Advanced model params'),
            'e.g. -m /home/user/models/parakeet-tdt-0.6b-v2-Q8_0.gguf'
        );
        modelGroup.add(modelParamsRow.row);

        const refreshActiveModel = () => {
            const id = settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
            const showAdvanced = !id;
            modelParamsRow.row.visible = showAdvanced;
            if (id && extensionDir) {
                const entry = findModel(extensionDir, id);
                if (entry) {
                    const file = pickFile(
                        entry,
                        settings.get_string(SETTINGS_KEYS.QUANT_PREFERENCE) ??
                            ''
                    );
                    activeModelLabel.label =
                        `${entry.name} · ${entry.parameters} · ` +
                        `${file ? formatSize(file.size_bytes) : ''} · ` +
                        `${entry.backend}`;
                    return;
                }
            }
            activeModelLabel.label = _(
                'No catalog model selected — using advanced params.'
            );
        };
        refreshActiveModel();
        settings.connect(
            `changed::${SETTINGS_KEYS.ACTIVE_MODEL_ID}`,
            refreshActiveModel
        );

        // -- ASR backend ---------------------------------------------------
        const asrGroup = new Adw.PreferencesGroup({
            title: _('Transcription'),
            description: _('Configure the local ASR backend'),
        });
        page.add(asrGroup);

        const backendModel = new Gtk.StringList({
            strings: ASR_BACKENDS.map(b => b.label),
        });
        const backendRow = new Adw.ComboRow({
            title: _('ASR backend'),
            subtitle: _('Which transcription CLI to invoke'),
            model: backendModel,
        });
        asrGroup.add(backendRow);

        const cliModeModel = new Gtk.StringList({
            strings: [_('Automatic (bundled CPU)'), _('Manual (custom path)')],
        });
        const cliModeRow = new Adw.ComboRow({
            title: _('Binary mode'),
            subtitle: _(
                'Automatic uses the transcribe-cli shipped with the extension (CPU, x86_64). Manual lets you point to your own build, e.g. with Vulkan/CUDA.'
            ),
            model: cliModeModel,
        });
        asrGroup.add(cliModeRow);

        // Status line shown only in Automatic mode: reports where the binary
        // was resolved from (bundled / PATH) or that none was found.
        const cliStatusRow = new Adw.ActionRow({
            title: _('Resolved binary'),
        });
        asrGroup.add(cliStatusRow);

        const cliPathRow = entryRow(
            _('Binary path'),
            'e.g. /home/user/transcribe.cpp/build/bin/transcribe-cli'
        );
        asrGroup.add(cliPathRow.row);

        const realtimeRow = new Adw.SwitchRow({
            title: _('Realtime mode'),
            subtitle: _('Append --stream-chunk-ms 500'),
        });
        asrGroup.add(realtimeRow);

        const customTemplateRow = entryRow(
            _('Custom arg template'),
            'e.g. {cli} {params} {audio}'
        );
        asrGroup.add(customTemplateRow.row);

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

        // -- Language ------------------------------------------------------
        const langGroup = new Adw.PreferencesGroup({title: _('Language')});
        page.add(langGroup);

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

        const translateRow = new Adw.SwitchRow({
            title: _('Translate to English'),
            subtitle: _('When the model supports translation'),
        });
        langGroup.add(translateRow);

        // -- Performance / compute ----------------------------------------
        const perfGroup = new Adw.PreferencesGroup({
            title: _('Performance'),
            description: _('CPU vs Vulkan GPU acceleration'),
        });
        page.add(perfGroup);

        const accelModel = new Gtk.StringList({
            strings: [_('Auto'), _('CPU'), _('Vulkan')],
        });
        const accelRow = new Adw.ComboRow({
            title: _('Accelerator'),
            subtitle: _('Compute backend for inference'),
            model: accelModel,
        });
        perfGroup.add(accelRow);

        const autoDetectRow = new Adw.SwitchRow({
            title: _('Auto-detect GPU'),
            subtitle: _('Probe for a Vulkan GPU when accelerator is Auto'),
        });
        perfGroup.add(autoDetectRow);

        const gpuRow = new Adw.SpinRow({
            title: _('GPU device index'),
            subtitle: _('-1 = auto'),
            adjustment: new Gtk.Adjustment({
                lower: -1,
                upper: 7,
                step_increment: 1,
                page_increment: 1,
                value: -1,
            }),
            digits: 0,
        });
        perfGroup.add(gpuRow);

        const gpuInfoLabel = new Gtk.Label({
            xalign: 0,
            cssClasses: ['caption'],
            wrap: true,
        });
        const gpuInfoBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            marginStart: 12,
            marginEnd: 12,
            marginBottom: 8,
        });
        gpuInfoBox.append(gpuInfoLabel);
        const gpuInfoRow = new Adw.PreferencesRow({activatable: false});
        gpuInfoRow.set_child(gpuInfoBox);
        perfGroup.add(gpuInfoRow);

        const threadsRow = new Adw.SpinRow({
            title: _('CPU threads'),
            subtitle: _('0 = auto (use all cores)'),
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

        const refreshGpuInfo = async () => {
            const on = settings.get_boolean(SETTINGS_KEYS.AUTO_DETECT_GPU);
            const accel =
                settings.get_string(SETTINGS_KEYS.ACCELERATOR) ?? 'auto';
            if (!on || accel === 'cpu') {
                gpuInfoLabel.label =
                    accel === 'cpu'
                        ? _('CPU mode: GPU detection disabled.')
                        : _('GPU auto-detection is off.');
                return;
            }
            gpuInfoLabel.label = _('Detecting GPU…');
            try {
                const gpus = await gpuDetector.detect();
                if (gpus.length === 0) {
                    gpuInfoLabel.label = _(
                        'No Vulkan GPU detected. ' +
                            'Install vulkan-tools (vulkaninfo) to enable detection.'
                    );
                } else {
                    gpuInfoLabel.label = gpus
                        .map(
                            g =>
                                `${g.name} (${g.kind}, ${formatVram(
                                    g.vramBytes
                                )})`
                        )
                        .join('\n');
                }
            } catch {
                gpuInfoLabel.label = _('GPU detection failed.');
            }
        };
        void refreshGpuInfo();
        settings.connect(
            `changed::${SETTINGS_KEYS.AUTO_DETECT_GPU}`,
            () => void refreshGpuInfo()
        );
        settings.connect(
            `changed::${SETTINGS_KEYS.ACCELERATOR}`,
            () => void refreshGpuInfo()
        );

        // -- Quality -------------------------------------------------------
        const qualityGroup = new Adw.PreferencesGroup({
            title: _('Quality'),
            description: _('Voice activity detection and custom vocabulary'),
        });
        page.add(qualityGroup);

        const vadRow = new Adw.SwitchRow({
            title: _('Voice Activity Detection (VAD)'),
            subtitle: _(
                'Filter silence before transcription. whisper-cli only.'
            ),
        });
        qualityGroup.add(vadRow);

        const promptRow = entryRow(
            _('Initial prompt / custom words'),
            'e.g. García, UPB, Kubernetes, PostgreSQL'
        );
        qualityGroup.add(promptRow.row);

        // -- Output --------------------------------------------------------
        const outputGroup = new Adw.PreferencesGroup({
            title: _('Output'),
            description: _('Where the transcribed text goes'),
        });
        page.add(outputGroup);

        const outputModel = new Gtk.StringList({
            strings: [_('Copy to clipboard'), _('Paste at cursor')],
        });
        const outputRow = new Adw.ComboRow({
            title: _('Output mode'),
            subtitle: _('How to deliver the transcription'),
            model: outputModel,
        });
        outputGroup.add(outputRow);
        outputGroup.add(
            shortcutRow(settings, SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT, window)
        );

        // -- Long recordings ----------------------------------------------
        const chunkGroup = new Adw.PreferencesGroup({
            title: _('Long recordings'),
            description: _(
                'Transcribe live in N-second chunks while you keep ' +
                    'speaking, so the first words are pasted right away and ' +
                    'backends with a per-call generation cap ' +
                    '(e.g. Qwen3-ASR at 256 tokens) do not truncate the output.'
            ),
        });
        page.add(chunkGroup);

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

        // -- Debug ---------------------------------------------------------
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debug'),
            description: _(
                'When enabled, every transcription run is logged to the ' +
                    'system journal (command line, exit status and the raw ' +
                    'stdout/stderr of the ASR CLI). Inspect it with:\n' +
                    'journalctl --user -b /usr/bin/gnome-shell | grep planeasr'
            ),
        });
        page.add(debugGroup);

        const debugRow = new Adw.SwitchRow({
            title: _('Debug logging'),
            subtitle: _(
                'Record the ASR command and its raw output for troubleshooting'
            ),
        });
        debugGroup.add(debugRow);

        window.add(page);

        // ===== Models page ===============================================
        const modelsPage = buildModelsPage({
            extensionDir,
            settings,
            toast,
        });
        window.add(modelsPage);

        openModelsBtn.connect('clicked', () => {
            window.visible_page = modelsPage;
        });

        // ===== Bindings ===================================================
        // Backend combo + derived rows.
        const syncBackendRows = () => {
            const id =
                settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ??
                'transcribe-cli';
            const backend = getBackend(id);
            const idx = Math.max(
                0,
                ASR_BACKENDS.findIndex(b => b.id === backend.id)
            );
            backendRow.selected = idx;
            cliPathRow.label.label = backend.defaultCliName
                ? _('Binary path (%s)').format(backend.defaultCliName)
                : _('Binary path');
            realtimeRow.sensitive = backend.supportsRealtime;
            customTemplateRow.row.visible = backend.id === 'custom';
            // VAD is only meaningful for whisper-cli.
            vadRow.sensitive = backend.capabilities.vad;
        };
        syncBackendRows();

        backendRow.connect('notify::selected', () => {
            const backend = ASR_BACKENDS[backendRow.selected];
            if (backend)
                settings.set_string(SETTINGS_KEYS.ASR_BACKEND, backend.id);
        });
        settings.connect(
            `changed::${SETTINGS_KEYS.ASR_BACKEND}`,
            syncBackendRows
        );

        // Binary mode combo: Automatic vs Manual. Drives which rows are shown
        // and reports where the automatic binary was resolved from.
        const syncCliMode = () => {
            const id =
                settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'auto';
            const idx = Math.max(
                0,
                CLI_MODE_IDS.indexOf(id as (typeof CLI_MODE_IDS)[number])
            );
            cliModeRow.selected = idx;
            const manual = id === 'manual';
            cliPathRow.row.visible = manual;
            cliPathRow.row.sensitive = manual;
            cliStatusRow.visible = !manual;
            if (!manual) {
                const backendId =
                    settings.get_string(SETTINGS_KEYS.ASR_BACKEND) ??
                    'transcribe-cli';
                const pathName = getBackend(backendId).defaultCliName;
                const resolved = resolveAutoCli(extensionDir, pathName);
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
                        'No binary found for this system. Switch to Manual or install transcribe-cli.'
                    );
                }
            }
        };
        syncCliMode();
        cliModeRow.connect('notify::selected', () => {
            const modeId = CLI_MODE_IDS[cliModeRow.selected];
            if (modeId)
                settings.set_string(SETTINGS_KEYS.CLI_MODE, modeId);
        });
        settings.connect(`changed::${SETTINGS_KEYS.CLI_MODE}`, syncCliMode);
        // Re-evaluate the status line when the backend changes too, since the
        // PATH lookup name depends on the active backend.
        settings.connect(`changed::${SETTINGS_KEYS.ASR_BACKEND}`, syncCliMode);

        settings.bind(
            SETTINGS_KEYS.CLI_PATH,
            cliPathRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.MODEL_PARAMS,
            modelParamsRow.entry,
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
            SETTINGS_KEYS.CUSTOM_ARG_TEMPLATE,
            customTemplateRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Language combo (index-based two-way sync).
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

        // Accelerator combo + GPU device + threads.
        const syncAccel = () => {
            const id = settings.get_string(SETTINGS_KEYS.ACCELERATOR) ?? 'auto';
            const idx = Math.max(0, ACCELERATOR_IDS.indexOf(id as never));
            accelRow.selected = idx;
            gpuRow.sensitive = id === 'vulkan' || id === 'auto';
        };
        syncAccel();
        accelRow.connect('notify::selected', () => {
            const id = ACCELERATOR_IDS[accelRow.selected];
            if (id) settings.set_string(SETTINGS_KEYS.ACCELERATOR, id);
        });
        settings.connect(`changed::${SETTINGS_KEYS.ACCELERATOR}`, syncAccel);

        settings.bind(
            SETTINGS_KEYS.AUTO_DETECT_GPU,
            autoDetectRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.GPU_DEVICE,
            gpuRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.CPU_THREADS,
            threadsRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        settings.bind(
            SETTINGS_KEYS.VAD_ENABLED,
            vadRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        settings.bind(
            SETTINGS_KEYS.INITIAL_PROMPT,
            promptRow.entry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

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
            SETTINGS_KEYS.DEBUG_LOGGING,
            debugRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        return Promise.resolve();
    }
}
