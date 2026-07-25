/* models-page.ts
 *
 * The "Models" preferences page: a searchable, filterable browser over the
 * bundled catalog with one-click download (libsoup), quantization selection,
 * progress bars, cancellation and delete. Models already on disk are marked
 * downloaded.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {
    formatSize,
    loadModelCatalog,
    type ModelEntry,
    type ModelFile,
    pickFile,
    resolveModelDir,
    scanDownloaded,
} from '../models/catalog.js';
import {getModelStore} from '../models/model-store.js';
import {getModelDownloader} from '../models/model-downloader.js';
import {badgeLabel} from './widgets.js';

/** Context handed to the page builder. */
export interface ModelsPageContext {
    extensionDir: string | null;
    settings: Gio.Settings;
    /** Toast overlay of the prefs window, for status notifications. */
    toast: (title: string) => void;
}

const QUANT_ORDER = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16', 'F32'];

/** Build the Models preferences page. */
export function buildModelsPage(ctx: ModelsPageContext): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        title: _('Models'),
        iconName: 'folder-download-symbolic',
    });

    const catalog = ctx.extensionDir ? loadModelCatalog(ctx.extensionDir) : [];

    // -- Search + filters ------------------------------------------------
    const filterGroup = new Adw.PreferencesGroup({
        title: _('Browse models'),
        description: _(
            'Download GGUF models from HuggingFace. They are verified with ' +
                'SHA-256 and stored locally.'
        ),
    });
    page.add(filterGroup);

    const search = new Gtk.SearchEntry({
        placeholder_text: _('Search by name or language…'),
        hexpand: true,
    });
    const filterBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        marginTop: 6,
        marginBottom: 6,
        marginStart: 12,
        marginEnd: 12,
    });
    filterBox.append(search);
    const filterRow = new Adw.PreferencesRow({activatable: false});
    filterRow.set_child(filterBox);
    filterGroup.add(filterRow);

    // -- Model list ------------------------------------------------------
    const listGroup = new Adw.PreferencesGroup();
    page.add(listGroup);

    // Track each entry's UI so we can refresh on download signals.
    const rows = new Map<string, ModelRowState>();

    const refreshDownloaded = () => {
        const modelDir = resolveModelDir(
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
        );
        return scanDownloaded(ctx.extensionDir, modelDir);
    };

    const applyFilter = () => {
        const q = search.get_text().trim().toLowerCase();
        const present = refreshDownloaded();
        for (const entry of catalog) {
            const state = rows.get(entry.id);
            if (!state) continue;
            const matches =
                q.length === 0 ||
                entry.name.toLowerCase().includes(q) ||
                entry.description.toLowerCase().includes(q) ||
                entry.languages.some(l => l.includes(q));
            state.row.visible = matches;
            state.updatePresence(!!present.get(entry.id));
        }
    };

    for (const entry of catalog) {
        const state = buildModelRow(entry, ctx);
        rows.set(entry.id, state);
        listGroup.add(state.row);
    }
    applyFilter();
    search.connect('search-changed', applyFilter);

    // React to download signals from the shared ModelStore.
    const store = getModelStore();
    const onProgress = (_obj: unknown, modelId: string, fraction: number) => {
        rows.get(modelId)?.updateProgress(fraction);
    };
    const onComplete = (_obj: unknown, modelId: string) => {
        const r = rows.get(modelId);
        if (r) {
            r.updateProgress(1);
            r.updatePresence(true);
        }
        ctx.toast(_('Model downloaded: %s').format(modelId));
    };
    const onFailed = (_obj: unknown, modelId: string, msg: string) => {
        rows.get(modelId)?.updatePresence(false);
        ctx.toast(_('Download failed: %s').format(`${modelId}: ${msg}`));
    };
    const onCancelled = (_obj: unknown, modelId: string) => {
        rows.get(modelId)?.updatePresence(false);
    };
    store.connect('download-progress', onProgress);
    store.connect('download-complete', onComplete);
    store.connect('download-failed', onFailed);
    store.connect('download-cancelled', onCancelled);

    // -- Custom models note ---------------------------------------------
    const customGroup = new Adw.PreferencesGroup({
        title: _('Custom models'),
        description: _(
            'You can also drop any .gguf/.bin file into the models directory ' +
                'and select it with the advanced model params.'
        ),
    });
    page.add(customGroup);

    const dirEntry = new Gtk.Entry({
        placeholder_text: resolveModelDir(''),
        hexpand: true,
    });
    dirEntry.text = resolveModelDir(
        ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
    );
    const openButton = new Gtk.Button({
        icon_name: 'folder-open-symbolic',
        tooltip_text: _('Open folder'),
        valign: Gtk.Align.CENTER,
    });
    openButton.connect('clicked', () => {
        const dir = resolveModelDir(dirEntry.get_text());
        const file = Gio.File.new_for_path(dir);
        Gio.AppInfo.launch_default_for_uri_async(
            file.get_uri(),
            null,
            null,
            null
        );
    });
    const dirBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        marginTop: 8,
        marginBottom: 8,
        marginStart: 12,
        marginEnd: 12,
    });
    dirBox.append(dirEntry);
    dirBox.append(openButton);
    const dirRow = new Adw.PreferencesRow({
        title: _('Models directory'),
        activatable: false,
    });
    dirRow.set_child(dirBox);
    customGroup.add(dirRow);
    ctx.settings.bind(
        SETTINGS_KEYS.MODEL_DIR,
        dirEntry,
        'text',
        Gio.SettingsBindFlags.DEFAULT
    );

    return page;
}

/** Per-model row UI handles kept for live updates. */
interface ModelRowState {
    row: Adw.PreferencesRow;
    quantCombo: Gtk.DropDown;
    progressBar: Gtk.ProgressBar;
    actionButton: Gtk.Button;
    entry: ModelEntry;
    /** Cached selection at click time so the action handlers see the live value. */
    selectedFile: () => ModelFile | null;
    updateProgress: (fraction: number) => void;
    updatePresence: (downloaded: boolean) => void;
}

/** Build one expandable row for a catalog entry.
 *
 * Uses a custom vertical Gtk.Box instead of piling suffixes onto an
 * Adw.ActionRow: too many horizontal suffixes starve the title of width and
 * the model name ends up wrapped one character per line. A self-contained
 * box gives full control over the layout:
 *   line 1: name (expands)  · badges
 *   line 2: quant · size · action button  (right aligned)
 */
function buildModelRow(
    entry: ModelEntry,
    ctx: ModelsPageContext
): ModelRowState {
    // -- Quantization dropdown ------------------------------------------
    const quants = entry.files
        .map(f => f.quant)
        .sort((a, b) => QUANT_ORDER.indexOf(a) - QUANT_ORDER.indexOf(b));
    const quantModel = new Gtk.StringList({strings: quants});
    const quantCombo = new Gtk.DropDown({model: quantModel});
    quantCombo.valign = Gtk.Align.CENTER;
    const prefQuant = ctx.settings.get_string('quant-preference') ?? '';
    const prefIdx = quants.indexOf(prefQuant);
    if (prefIdx >= 0) quantCombo.selected = prefIdx;

    const sizeLabel = new Gtk.Label({cssClasses: ['caption']});
    const refreshSize = () => {
        const file = entry.files[quantCombo.selected];
        sizeLabel.label = file ? formatSize(file.size_bytes) : '';
    };
    refreshSize();
    quantCombo.connect('notify::selected', refreshSize);

    const selectedFile = (): ModelFile | null =>
        pickFile(entry, entry.files[quantCombo.selected]?.quant ?? null);

    let isPresent = false;

    const actionButton = new Gtk.Button({
        label: _('Download'),
        valign: Gtk.Align.CENTER,
        cssClasses: ['suggested-action'],
    });
    actionButton.connect('clicked', () => {
        if (isPresent) {
            ctx.settings.set_string(SETTINGS_KEYS.ACTIVE_MODEL_ID, entry.id);
            ctx.settings.set_string(SETTINGS_KEYS.ASR_BACKEND, entry.backend);
            ctx.toast(_('Active model: %s').format(entry.name));
            return;
        }
        const file = selectedFile();
        if (!file) return;
        const modelDir = resolveModelDir(
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
        );
        try {
            Gio.File.new_for_path(modelDir).make_directory_with_parents(null);
        } catch {
            // Already exists is fine; real download errors surface via toast.
        }
        void getModelDownloader().download(entry, file, modelDir);
    });

    // -- Title line: name + badges --------------------------------------
    const nameLabel = new Gtk.Label({
        label: entry.name,
        hexpand: true,
        halign: Gtk.Align.START,
        xalign: 0,
        wrap: true,
        cssClasses: ['heading'],
    });
    const badgeBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.END,
        valign: Gtk.Align.START,
    });
    if (entry.recommended)
        badgeBox.append(badgeLabel(_('Recommended'), 'success'));
    if (entry.streaming) badgeBox.append(badgeLabel(_('Streaming'), 'tag'));
    badgeBox.append(badgeLabel(entry.parameters, 'caption'));
    badgeBox.append(badgeLabel(entry.backend, 'caption'));

    const titleLine = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        hexpand: true,
    });
    titleLine.append(nameLabel);
    titleLine.append(badgeBox);

    // -- Controls line: quant · size · button --------------------------
    const descLabel = new Gtk.Label({
        label: buildSubtitle(entry),
        xalign: 0,
        wrap: true,
        cssClasses: ['caption'],
    });

    const controlsLine = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.END,
    });
    controlsLine.append(quantCombo);
    controlsLine.append(sizeLabel);
    controlsLine.append(actionButton);

    // -- Progress bar (shown under everything during download) ---------
    const progressBar = new Gtk.ProgressBar({visible: false, hexpand: true});

    // -- Assemble the row content ---------------------------------------
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        marginTop: 10,
        marginBottom: 10,
        marginStart: 14,
        marginEnd: 14,
    });
    content.append(titleLine);
    content.append(descLabel);
    content.append(controlsLine);
    content.append(progressBar);

    const row = new Adw.PreferencesRow({activatable: false});
    row.set_child(content);

    const updateProgress = (fraction: number) => {
        progressBar.fraction = Math.max(0, Math.min(1, fraction));
        progressBar.visible = fraction > 0 && fraction < 1;
    };
    const updatePresence = (downloaded: boolean) => {
        isPresent = downloaded;
        if (downloaded) {
            actionButton.label = _('Use');
            progressBar.visible = false;
        } else {
            actionButton.label = _('Download');
        }
    };

    return {
        row,
        quantCombo,
        progressBar,
        actionButton,
        entry,
        selectedFile,
        updateProgress,
        updatePresence,
    };
}

/** Compose the subtitle line for a model row. */
function buildSubtitle(entry: ModelEntry): string {
    const langs =
        entry.language_count <= 4
            ? entry.languages.join(', ').toUpperCase()
            : _('%d languages').format(entry.language_count);
    const file = pickFile(entry, null);
    const size = file ? formatSize(file.size_bytes) : '';
    return [entry.description, langs, size].filter(Boolean).join(' · ');
}
