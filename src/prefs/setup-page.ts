/* setup-page.ts
 *
 * La página de preferencias "Setup": una guía rápida de tres pasos para
 * dejar la extensión funcionando, más un botón grande centrado que
 * descarga (y activa) el modelo recomendado con un solo clic.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {
    findModel,
    formatSize,
    pickFile,
    resolveModelDir,
    scanDownloaded,
} from '../models/catalog.js';
import {getModelStore} from '../models/model-store.js';
import {getModelDownloader} from '../models/model-downloader.js';
import {rowContentMargins} from './widgets.js';

/** Contexto entregado al constructor de la página. */
export interface SetupPageContext {
    extensionDir: string | null;
    settings: Gio.Settings;
    /** Overlay de notificaciones (toast) de la ventana de preferencias. */
    toast: (title: string) => void;
}

/** Modelo y cuantización que instala el botón grande "Setup". */
const SETUP_MODEL_ID = 'parakeet-tdt-0.6b-v3';
const SETUP_MODEL_QUANT = 'Q8_0';

/** Construye la página de preferencias "Setup". */
export function buildSetupPage(ctx: SetupPageContext): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        title: _('Setup'),
        iconName: 'starred-symbolic',
    });

    // -- Guía de tres pasos ------------------------------------------------
    const guideGroup = new Adw.PreferencesGroup({
        title: _('Getting started'),
        description: _('Three steps to get transcription working'),
    });
    page.add(guideGroup);

    const steps: Array<[string, string]> = [
        [
            _('1. Choose a processor'),
            _(
                'CPU works out of the box with the transcribe-cli binary ' +
                    'bundled with the extension — nothing to install. To use ' +
                    'your GPU (Vulkan/CUDA/Metal) instead, you need to build ' +
                    'transcribe.cpp yourself and point to the resulting ' +
                    'binary in the "Backend" tab (Binary mode → GPU).'
            ),
        ],
        [
            _('2. Get a model'),
            _(
                'Click the big "Setup" button below to download and ' +
                    'activate the recommended model. You can pick a ' +
                    'different one later in the "Models" tab.'
            ),
        ],
        [
            _('3. Set a shortcut and speak'),
            _(
                'Set the recording shortcut in the "General" tab, press it, ' +
                    'speak, and press it again — your words are transcribed ' +
                    'automatically.'
            ),
        ],
    ];
    for (const [title, subtitle] of steps) {
        guideGroup.add(
            new Adw.ActionRow({
                title,
                subtitle,
                titleLines: 0,
                subtitleLines: 0,
            })
        );
    }

    // -- Botón grande de instalación ---------------------------------------
    const actionGroup = new Adw.PreferencesGroup();
    page.add(actionGroup);

    const entry = findModel(ctx.extensionDir, SETUP_MODEL_ID);
    const file = entry ? pickFile(entry, SETUP_MODEL_QUANT) : null;

    const setupButton = new Gtk.Button({
        label: _('Setup'),
        cssClasses: ['suggested-action', 'pill', 'planeasr-setup-button'],
    });

    const statusLabel = new Gtk.Label({
        xalign: 0.5,
        justify: Gtk.Justification.CENTER,
        wrap: true,
        cssClasses: ['caption', 'dim-label'],
    });

    const progressBar = new Gtk.ProgressBar({visible: false});

    const buttonBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        halign: Gtk.Align.CENTER,
        ...rowContentMargins(24),
    });
    buttonBox.append(setupButton);
    buttonBox.append(statusLabel);
    buttonBox.append(progressBar);
    const actionRow = new Adw.PreferencesRow({activatable: false});
    actionRow.set_child(buttonBox);
    actionGroup.add(actionRow);

    /** Refresca el texto/estado del botón según lo que hay en disco/activo. */
    const updateStatus = () => {
        if (!entry || !file) {
            setupButton.sensitive = false;
            statusLabel.label = _('Model catalog unavailable.');
            return;
        }
        const modelDir = resolveModelDir(
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
        );
        const present = scanDownloaded(ctx.extensionDir, modelDir).has(
            entry.id
        );
        const activeId =
            ctx.settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';

        if (activeId === entry.id) {
            setupButton.label = _('Ready ✓');
            setupButton.sensitive = false;
            statusLabel.label = _('%s is downloaded and active.').format(
                entry.name
            );
        } else if (present) {
            setupButton.label = _('Use this model');
            setupButton.sensitive = true;
            statusLabel.label = _(
                '%s is already downloaded — click to activate it.'
            ).format(entry.name);
        } else {
            setupButton.label = _('Setup');
            setupButton.sensitive = true;
            statusLabel.label = _('Downloads %s (%s) and activates it.').format(
                entry.name,
                formatSize(file.size_bytes)
            );
        }
    };
    updateStatus();

    setupButton.connect('clicked', () => {
        if (!entry || !file) return;
        const modelDir = resolveModelDir(
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
        );
        const present = scanDownloaded(ctx.extensionDir, modelDir).has(
            entry.id
        );
        if (present) {
            ctx.settings.set_string(SETTINGS_KEYS.ACTIVE_MODEL_ID, entry.id);
            ctx.settings.set_string(SETTINGS_KEYS.ASR_BACKEND, entry.backend);
            ctx.toast(_('Active model: %s').format(entry.name));
            updateStatus();
            return;
        }
        try {
            Gio.File.new_for_path(modelDir).make_directory_with_parents(null);
        } catch {
            // Ya existe; los errores reales de descarga se reportan vía toast.
        }
        setupButton.sensitive = false;
        progressBar.visible = true;
        progressBar.fraction = 0;
        void getModelDownloader().download(entry, file, modelDir);
    });

    // -- Progreso de descarga (señales del ModelStore compartido) ---------
    const store = getModelStore();
    const onProgress = (_obj: unknown, modelId: string, fraction: number) => {
        if (modelId !== SETUP_MODEL_ID) return;
        progressBar.fraction = Math.max(0, Math.min(1, fraction));
    };
    const onComplete = (_obj: unknown, modelId: string) => {
        if (modelId !== SETUP_MODEL_ID || !entry) return;
        progressBar.visible = false;
        ctx.settings.set_string(SETTINGS_KEYS.ACTIVE_MODEL_ID, entry.id);
        ctx.settings.set_string(SETTINGS_KEYS.ASR_BACKEND, entry.backend);
        ctx.toast(
            _('Model downloaded and set as active: %s').format(entry.name)
        );
        updateStatus();
    };
    const onFailed = (_obj: unknown, modelId: string, msg: string) => {
        if (modelId !== SETUP_MODEL_ID) return;
        progressBar.visible = false;
        ctx.toast(_('Download failed: %s').format(msg));
        updateStatus();
    };
    const onCancelled = (_obj: unknown, modelId: string) => {
        if (modelId !== SETUP_MODEL_ID) return;
        progressBar.visible = false;
        updateStatus();
    };
    store.connect('download-progress', onProgress);
    store.connect('download-complete', onComplete);
    store.connect('download-failed', onFailed);
    store.connect('download-cancelled', onCancelled);

    ctx.settings.connect(
        `changed::${SETTINGS_KEYS.ACTIVE_MODEL_ID}`,
        updateStatus
    );
    ctx.settings.connect(`changed::${SETTINGS_KEYS.MODEL_DIR}`, updateStatus);

    return page;
}
