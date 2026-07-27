/* models-page.ts
 *
 * La página de preferencias "Modelos": un explorador buscable y filtrable
 * sobre el catálogo incluido, con descarga de un clic (libsoup), selección
 * de cuantización, barras de progreso, cancelación y borrado. Los modelos
 * ya presentes en disco se marcan como descargados.
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
    loadModelCatalog,
    modelFilePath,
    type ModelEntry,
    type ModelFile,
    pickFile,
    resolveModelDir,
    scanDownloaded,
} from '../models/catalog.js';
import {getModelStore} from '../models/model-store.js';
import {getModelDownloader} from '../models/model-downloader.js';
import {badgeLabel, entryRow} from './widgets.js';

/** Contexto entregado al constructor de la página. */
export interface ModelsPageContext {
    extensionDir: string | null;
    settings: Gio.Settings;
    /** Overlay de notificaciones (toast) de la ventana de preferencias. */
    toast: (title: string) => void;
}

const QUANT_ORDER = ['Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16', 'F32'];

/** Construye la página de preferencias "Modelos". */
export function buildModelsPage(ctx: ModelsPageContext): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({
        title: _('Models'),
        iconName: 'folder-download-symbolic',
    });

    const catalog = ctx.extensionDir ? loadModelCatalog(ctx.extensionDir) : [];

    // -- Grupo de selección de modelo (radio: catálogo vs ruta personalizada) --
    const selectionGroup = new Adw.PreferencesGroup({
        title: _('Model selection'),
        description: _('Choose between a catalog model or a custom model path'),
    });
    page.add(selectionGroup);

    // Botones de radio para el modo de selección (Gtk.CheckButton agrupados
    // vía set_group). La ruta personalizada se lista PRIMERO; el modelo de
    // catálogo va debajo.
    const customRadio = new Adw.ActionRow({
        title: _('Custom model path'),
        activatable: false,
    });
    const customRadioButton = new Gtk.CheckButton({
        valign: Gtk.Align.CENTER,
    });
    customRadioButton.set_active(true);
    customRadio.add_prefix(customRadioButton);

    const catalogRadio = new Adw.ActionRow({
        title: _('Catalog model'),
        activatable: false,
    });
    const catalogRadioButton = new Gtk.CheckButton({
        valign: Gtk.Align.CENTER,
    });
    catalogRadioButton.set_group(customRadioButton);
    catalogRadio.add_prefix(catalogRadioButton);

    selectionGroup.add(customRadio);
    selectionGroup.add(catalogRadio);

    // Fila de entrada de ruta personalizada (visible cuando el modo custom está activo)
    const modelParamsRow = entryRow(
        _('Model path'),
        'e.g. /home/user/models/parakeet-tdt-0.6b-v2-Q8_0.gguf'
    );
    selectionGroup.add(modelParamsRow.row);

    // Fila de información del modelo activo (visible cuando el modo catálogo está activo)
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
    selectionGroup.add(activeModelInfoRow);

    // Auxiliar para refrescar la visualización del modelo activo
    const refreshActiveModel = () => {
        const id = ctx.settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
        if (id && ctx.extensionDir) {
            const entry = findModel(ctx.extensionDir, id);
            if (entry) {
                const file = pickFile(
                    entry,
                    ctx.settings.get_string(SETTINGS_KEYS.QUANT_PREFERENCE) ??
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
            'No catalog model selected — browse below and click "Use" to select one.'
        );
    };
    refreshActiveModel();

    // Reúne todos los widgets que pertenecen al explorador de catálogo, para
    // poder mostrarlos/ocultarlos como unidad cuando se alterna el radio de catálogo.
    const catalogWidgets: Gtk.Widget[] = [activeModelInfoRow];

    // Alterna la visibilidad según la selección del radio
    const syncSelectionMode = () => {
        const useCatalog = catalogRadioButton.get_active();
        modelParamsRow.row.visible = !useCatalog;
        for (const w of catalogWidgets) {
            w.visible = useCatalog;
        }
    };

    catalogRadioButton.connect('toggled', () => {
        if (!catalogRadioButton.get_active()) {
            // Al cambiar a custom: limpia la selección de modelo de catálogo
            ctx.settings.set_string(SETTINGS_KEYS.ACTIVE_MODEL_ID, '');
        }
        // Al cambiar a catálogo: conserva el modelo activo existente (si lo
        // hay), solo refresca la visualización.
        syncSelectionMode();
        refreshActiveModel();
    });

    // Inicial: fija el radio según la configuración actual. Se invoca
    // DESPUÉS de que cada widget de catálogo (grupos de búsqueda/lista) se
    // haya añadido a catalogWidgets; si no, la primera llamada a
    // syncSelectionMode() correría antes de que esos grupos existan y todo
    // el catálogo quedaría visible sin importar el modo.
    const initSelectionMode = () => {
        const modelId =
            ctx.settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
        const params =
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_PARAMS) ?? '';
        if (modelId) {
            catalogRadioButton.set_active(true);
        } else if (params) {
            customRadioButton.set_active(true);
        } else {
            catalogRadioButton.set_active(true);
        }
        syncSelectionMode();
    };

    // Escucha cambios en el modelo activo para refrescar la visualización
    ctx.settings.connect(`changed::${SETTINGS_KEYS.ACTIVE_MODEL_ID}`, () => {
        refreshActiveModel();
        // Si se seleccionó un modelo de catálogo, asegura que el radio de catálogo esté activo
        const modelId =
            ctx.settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
        if (modelId && !catalogRadioButton.get_active()) {
            catalogRadioButton.set_active(true);
            syncSelectionMode();
        }
    });

    // Vincula la entrada de ruta personalizada al setting
    ctx.settings.bind(
        SETTINGS_KEYS.MODEL_PARAMS,
        modelParamsRow.entry,
        'text',
        Gio.SettingsBindFlags.DEFAULT
    );

    // -- Búsqueda + filtros (sección de catálogo) -----------------------
    const filterGroup = new Adw.PreferencesGroup({
        title: _('Browse models'),
        description: _(
            'Download GGUF models from HuggingFace. They are verified with ' +
                'SHA-256 and stored locally.'
        ),
    });
    page.add(filterGroup);
    catalogWidgets.push(filterGroup);

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

    // -- Lista de modelos (sección de catálogo) --------------------------
    const listGroup = new Adw.PreferencesGroup();
    page.add(listGroup);
    catalogWidgets.push(listGroup);

    // Ahora que cada widget de catálogo está registrado, aplica el modo de
    // selección inicial para que el grupo correcto sea visible en el primer render.
    initSelectionMode();

    // Rastrea la interfaz de cada entrada para poder refrescarla ante señales de descarga.
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

    // Refleja qué modelo de catálogo (si lo hay) es el modelo activo de
    // transcripción. Se llama una vez al construir y de nuevo cada vez que
    // active-model-id cambia — incluido cuando se hace clic en "Usar",
    // cuando se borra el modelo activo, o cuando el usuario vuelve a una
    // ruta de modelo personalizada (id limpiado).
    const syncActiveModel = () => {
        const activeId =
            ctx.settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
        for (const entry of catalog) {
            rows.get(entry.id)?.updateActive(entry.id === activeId);
        }
    };
    syncActiveModel();
    ctx.settings.connect(
        `changed::${SETTINGS_KEYS.ACTIVE_MODEL_ID}`,
        syncActiveModel
    );

    search.connect('search-changed', applyFilter);

    // Reacciona a las señales de descarga del ModelStore compartido.
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
    const onDeleted = (_obj: unknown, modelId: string) => {
        const r = rows.get(modelId);
        if (r) {
            r.updatePresence(false);
            r.refreshPath();
        }
        // Si el modelo borrado era el activo, limpia la selección para que
        // la extensión recurra a la ruta de modelo personalizada en vez de
        // a un archivo faltante.
        if (
            ctx.settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) === modelId
        ) {
            ctx.settings.set_string(SETTINGS_KEYS.ACTIVE_MODEL_ID, '');
        }
        ctx.toast(_('Model deleted: %s').format(modelId));
    };
    store.connect('download-progress', onProgress);
    store.connect('download-complete', onComplete);
    store.connect('download-failed', onFailed);
    store.connect('download-cancelled', onCancelled);
    store.connect('model-deleted', onDeleted);

    // -- Almacenamiento (siempre visible al final) -----------------------
    const customGroup = new Adw.PreferencesGroup({
        title: _('Storage'),
        description: _(
            'Directory where downloaded models are stored. You can also drop ' +
                'any .gguf/.bin file here and point to it with a custom path.'
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

/** Referencias de interfaz por fila de modelo, mantenidas para actualizaciones en vivo. */
interface ModelRowState {
    row: Adw.PreferencesRow;
    quantCombo: Gtk.DropDown;
    progressBar: Gtk.ProgressBar;
    actionButton: Gtk.Button;
    deleteButton: Gtk.Button;
    downloadedBadge: Gtk.Label;
    activeBadge: Gtk.Label;
    pathLabel: Gtk.Label;
    entry: ModelEntry;
    ctx: ModelsPageContext;
    /** Selección en caché al momento del clic, para que los handlers vean el valor vigente. */
    selectedFile: () => ModelFile | null;
    updateProgress: (fraction: number) => void;
    updatePresence: (downloaded: boolean) => void;
    /** Marca/desmarca esta fila como el modelo activo de transcripción. */
    updateActive: (active: boolean) => void;
    /** Refresca la línea de ruta en disco (solo se muestra cuando el modelo está presente). */
    refreshPath: () => void;
}

/** Construye una fila expandible para una entrada del catálogo.
 *
 * Usa un Gtk.Box vertical propio en vez de amontonar sufijos sobre un
 * Adw.ActionRow: demasiados sufijos horizontales le quitan ancho al título
 * y el nombre del modelo termina envuelto un carácter por línea. Un box
 * autocontenido da control total sobre el diseño:
 *   línea 1: nombre (se expande) · insignias
 *   línea 2: cuantización · tamaño · botón de acción (alineado a la derecha)
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
    /** Whether this model is the active transcription model. */
    let isActive = false;

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
    // "Downloaded" badge appears once the model file is on disk; toggled by
    // updatePresence so it stays in sync with the real presence state.
    const downloadedBadge = badgeLabel(_('Downloaded'), 'success');
    downloadedBadge.visible = false;
    badgeBox.append(downloadedBadge);
    // "Active" badge marks the model currently selected for transcription.
    // Toggled by updateActive, which the page calls whenever active-model-id
    // changes (only one model is active at a time).
    const activeBadge = badgeLabel(_('Active'), 'suggested-action');
    activeBadge.visible = false;
    badgeBox.append(activeBadge);

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

    // On-disk path line, shown only once the model is downloaded, so the user
    // sees the concrete file used (and that -m is injected automatically — no
    // need to type it). Refreshed by refreshPath / updatePresence.
    const pathLabel = new Gtk.Label({
        xalign: 0,
        wrap: true,
        selectable: true,
        cssClasses: ['caption', 'dim-label'],
        visible: false,
    });

    // Delete button: removes the downloaded file for the selected quant.
    // Confirmed via a lightweight Adw.MessageDialog to avoid accidental loss.
    const deleteButton = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Delete downloaded file'),
        cssClasses: ['destructive-action'],
        visible: false,
    });
    deleteButton.connect('clicked', () => {
        const file = selectedFile();
        if (!file) return;
        const modelDir = resolveModelDir(
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
        );
        const fullPath = modelFilePath(modelDir, file);
        const dialog = new Adw.MessageDialog({
            heading: _('Delete model file?'),
            body: _('This will remove "%s" from disk.').format(fullPath),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance(
            'delete',
            Adw.ResponseAppearance.DESTRUCTIVE
        );
        dialog.set_default_response('cancel');
        dialog.connect('response', (_d, response: string) => {
            if (response === 'delete') {
                void getModelDownloader().delete(entry, file, modelDir);
            }
        });
        const root = row.get_root();
        if (root instanceof Gtk.Window) dialog.set_transient_for(root);
        dialog.present();
    });

    const controlsLine = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        halign: Gtk.Align.END,
    });
    controlsLine.append(quantCombo);
    controlsLine.append(sizeLabel);
    controlsLine.append(deleteButton);
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
    content.append(pathLabel);
    content.append(controlsLine);
    content.append(progressBar);

    const row = new Adw.PreferencesRow({activatable: false});
    row.set_child(content);

    /** Resolve the on-disk path for the currently selected quant, or '' . */
    const selectedPath = (): string => {
        const file = selectedFile();
        if (!file) return '';
        const modelDir = resolveModelDir(
            ctx.settings.get_string(SETTINGS_KEYS.MODEL_DIR) ?? ''
        );
        return modelFilePath(modelDir, file);
    };

    const refreshPath = () => {
        if (!isPresent) {
            pathLabel.visible = false;
            return;
        }
        const p = selectedPath();
        if (p) {
            pathLabel.label = _('Path: %s').format(p);
            pathLabel.visible = true;
        } else {
            pathLabel.visible = false;
        }
    };

    const updateProgress = (fraction: number) => {
        progressBar.fraction = Math.max(0, Math.min(1, fraction));
        progressBar.visible = fraction > 0 && fraction < 1;
    };
    const updatePresence = (downloaded: boolean) => {
        isPresent = downloaded;
        downloadedBadge.visible = downloaded;
        deleteButton.visible = downloaded;
        // The button label depends on both presence and active state: a
        // downloaded-but-active model shows "Active" rather than "Use".
        if (downloaded) {
            actionButton.label = isActive ? _('Active') : _('Use');
            progressBar.visible = false;
        } else {
            actionButton.label = _('Download');
        }
        refreshPath();
    };
    // Reflect whether this model is the one selected for transcription. Only
    // one model is active at a time, so the page drives this from a single
    // active-model-id listener. A downloaded active model gets an "Active"
    // badge and its button restyled; the row also gains a CSS class for a
    // subtle background highlight.
    const updateActive = (active: boolean) => {
        isActive = active;
        activeBadge.visible = active;
        if (active) {
            row.add_css_class('planeasr-active-model');
            actionButton.add_css_class('suggested-action');
            if (isPresent) actionButton.label = _('Active');
        } else {
            row.remove_css_class('planeasr-active-model');
            actionButton.remove_css_class('suggested-action');
            if (isPresent) actionButton.label = _('Use');
        }
    };

    // Re-evaluate the path line when the selected quant changes, so it always
    // reflects the file the user would actually use / delete.
    quantCombo.connect('notify::selected', refreshPath);

    return {
        row,
        quantCombo,
        progressBar,
        actionButton,
        deleteButton,
        downloadedBadge,
        activeBadge,
        pathLabel,
        entry,
        ctx,
        selectedFile,
        updateProgress,
        updatePresence,
        updateActive,
        refreshPath,
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
