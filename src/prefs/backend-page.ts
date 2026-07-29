/* backend-page.ts
 *
 * La página de preferencias "Backend": backend de transcripción, modo del
 * binario (CPU vs GPU), rendimiento (acelerador, dispositivo GPU, hilos) y
 * fragmentación de grabaciones largas — todo lo que afecta cómo se procesa
 * el audio.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SETTINGS_KEYS, normalizeCliMode} from '../config/settings.js';
import {resolveAutoCli} from '../extension/cli-resolver.js';
import {listDevices} from '../extension/device-lister.js';
import {findModel, pickFile, resolveModelDir} from '../models/catalog.js';
import {getEngineStore} from '../models/engine-store.js';
import {
    describeSetupProblems,
    extractModelPath,
    type BinaryState,
    type ModelState,
    type SetupProblem,
} from './validate.js';
import {
    comboRow,
    entryRow,
    rowContentMargins,
    spinRow,
    widenComboRow,
} from './widgets.js';

/** Contexto entregado al constructor de la página. */
export interface BackendPageContext {
    settings: Gio.Settings;
    /** Overlay de notificaciones (toast) de la ventana de preferencias. */
    toast: (title: string) => void;
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

/** Comprueba en disco si un archivo existe y es ejecutable. */
function checkExecutable(path: string): {exists: boolean; executable: boolean} {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) return {exists: false, executable: false};
    const info = file.query_info(
        'access::can-execute',
        Gio.FileQueryInfoFlags.NONE,
        null
    );
    return {
        exists: true,
        executable: info.get_attribute_boolean('access::can-execute'),
    };
}

/** Resuelve el estado en disco del binario configurado (I/O vía Gio.File). */
function resolveBinaryState(settings: Gio.Settings): BinaryState {
    const mode = normalizeCliMode(
        settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
    );
    if (mode === 'gpu') {
        const cliPath = settings.get_string(SETTINGS_KEYS.CLI_PATH) ?? '';
        if (!cliPath) return {kind: 'unset'};
        return {kind: 'resolved', path: cliPath, ...checkExecutable(cliPath)};
    }
    // Modo automático: valida el binario resuelto (descargado o de PATH).
    const resolved = resolveAutoCli('transcribe-cli');
    if (resolved.source === 'none') return {kind: 'unresolved'};
    return {
        kind: 'resolved',
        path: resolved.path,
        ...checkExecutable(resolved.path),
    };
}

/** Resuelve el estado en disco del modelo configurado (I/O vía Gio.File). */
function resolveModelState(settings: Gio.Settings): ModelState {
    // El modelo activo del catálogo tiene precedencia sobre los parámetros.
    const modelId = settings.get_string(SETTINGS_KEYS.ACTIVE_MODEL_ID) ?? '';
    let modelPath: string | null = null;
    if (modelId) {
        const entry = findModel(modelId);
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

    if (!modelPath) return {kind: 'missing'};
    if (!modelPath.startsWith('/')) return {kind: 'relative', path: modelPath};
    const exists = Gio.File.new_for_path(modelPath).query_exists(null);
    return {kind: 'resolved', path: modelPath, exists};
}

/** Traduce un problema de configuración detectado a su mensaje para la UI. */
function formatSetupProblem(problem: SetupProblem): string {
    switch (problem.kind) {
        case 'binary-path-empty':
            return _('binary path is empty');
        case 'binary-unresolved':
            return _('no transcription binary found (downloaded or on PATH)');
        case 'binary-not-found':
            return _('binary not found: %s').format(problem.path);
        case 'binary-not-executable':
            return _('binary is not executable: %s').format(problem.path);
        case 'model-not-found':
            return _('no model file found');
        case 'model-not-on-disk':
            return _('model not found: %s').format(problem.path);
        case 'model-path-relative':
            return _(
                'model path is relative and cannot be verified: %s'
            ).format(problem.path);
    }
}

/** Verificación rápida de cordura sobre el binario y el modelo configurados, para la UI. */
function validateSetup(settings: Gio.Settings): string {
    const problems = describeSetupProblems(
        resolveBinaryState(settings),
        resolveModelState(settings)
    );
    return problems.length === 0
        ? _('Binary and model look OK')
        : problems.map(formatSetupProblem).join('; ');
}

/** Construye la página de preferencias "Backend". */
export function buildBackendPage(ctx: BackendPageContext): Adw.PreferencesPage {
    const {settings, toast} = ctx;

    const backendPage = new Adw.PreferencesPage({
        title: _('Backend'),
        iconName: 'utilities-terminal-symbolic',
    });

    // -- Transcripción -----------------------------------------------------
    const asrGroup = new Adw.PreferencesGroup({
        title: _('Transcription'),
        description: _('Configure the transcribe-cli binary (transcribe.cpp)'),
    });
    backendPage.add(asrGroup);

    const cliModeOptions = [
        {id: 'cpu', label: _('CPU')},
        {id: 'gpu', label: _('GPU')},
    ] as const;
    const cliMode = comboRow(settings, SETTINGS_KEYS.CLI_MODE, {
        title: _('Binary mode'),
        subtitle: _(
            'CPU prefers a transcribe-cli found on PATH, falling back ' +
                'to the CPU engine (x86_64) downloaded from the ' +
                '"Setup" tab. GPU lets you point to your own ' +
                'Vulkan/CUDA build.'
        ),
        options: cliModeOptions,
        fallback: 'cpu',
        normalize: normalizeCliMode,
    });
    const cliModeRow = cliMode.row;
    asrGroup.add(cliModeRow);

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
        subtitle: _(
            'When recording stops, the whole take is processed in one ' +
                'streaming pass. With paste output the text is typed at ' +
                'the cursor sequentially as the model produces it; with ' +
                'clipboard output the full text is copied once when done. ' +
                'Language is auto-detected in this mode, and it disables ' +
                'the Long recordings options below.'
        ),
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
        toast(validateSetup(settings));
    });

    // -- Rendimiento / cómputo -----------------------------------------
    const perfGroup = new Adw.PreferencesGroup({
        title: _('Performance'),
        description: _('Tune CPU vs GPU acceleration and threading'),
    });
    backendPage.add(perfGroup);

    const accel = comboRow(settings, SETTINGS_KEYS.ACCELERATOR, {
        title: _('Accelerator'),
        subtitle: _('Compute backend for inference'),
        options: [
            {id: 'auto', label: _('Auto')},
            {id: 'cpu', label: _('CPU')},
            {id: 'vulkan', label: _('Vulkan')},
        ] as const,
        fallback: 'auto',
    });
    const accelRow = accel.row;
    perfGroup.add(accelRow);

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

    const threadsRow = spinRow(settings, SETTINGS_KEYS.CPU_THREADS, {
        title: _('CPU threads'),
        subtitle: _('0 = auto (use all cores)'),
        lower: 0,
        upper: 128,
        step: 1,
        page: 4,
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

    const chunkSecondsRow = spinRow(settings, SETTINGS_KEYS.CHUNK_SECONDS, {
        title: _('Seconds per chunk'),
        subtitle: _('Lower values are safer for models that cap output tokens'),
        lower: 5,
        upper: 60,
        step: 1,
        page: 5,
    });
    chunkGroup.add(chunkSecondsRow);

    const chunkOverlapRow = spinRow(
        settings,
        SETTINGS_KEYS.CHUNK_OVERLAP_SECONDS,
        {
            title: _('Overlap seconds'),
            subtitle: _(
                'Re-transcribe this much at each chunk boundary so words ' +
                    'split across the seam are not lost (0 = off)'
            ),
            lower: 0,
            upper: 5,
            step: 1,
            page: 1,
        }
    );
    chunkGroup.add(chunkOverlapRow);

    /* ====================================================================
     * BINDINGS
     * ==================================================================== */

    // transcribe-cli es el único backend. El ajuste 'asr-backend' se deja
    // fijo por compatibilidad, pero ya no hay un combo que lo maneje.
    cliPathRow.label.label = _('Binary path (%s)').format('transcribe-cli');
    realtimeRow.sensitive = true; // transcribe-cli admite tiempo real

    // --- Visibilidad derivada del modo del binario: CPU vs GPU ---------
    // El propio índice del combo ya lo mantiene sincronizado `comboRow`;
    // aquí solo se deriva la visibilidad/sensibilidad de las filas
    // vecinas, que no es un mapeo 1:1 de una sola clave.
    const syncCliMode = () => {
        const id = normalizeCliMode(
            settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
        );
        const gpu = id === 'gpu';
        cliPathRow.row.visible = gpu;
        cliPathRow.row.sensitive = gpu;
        gpuNoteRow.visible = gpu;
        cliStatusRow.visible = !gpu;
        if (!gpu) {
            const resolved = resolveAutoCli('transcribe-cli');
            if (resolved.source === 'downloaded') {
                cliStatusRow.subtitle = _(
                    'Using downloaded CPU engine (transcribe-cli, x86_64).'
                ).format();
            } else if (resolved.source === 'path') {
                cliStatusRow.subtitle = _(
                    'Using transcribe-cli from PATH: %s'
                ).format(resolved.path);
            } else {
                cliStatusRow.subtitle = _(
                    'No binary found. Download the engine from the ' +
                        '"Setup" tab, switch to GPU and set the binary ' +
                        'path, or install transcribe-cli.'
                );
            }
        }
    };
    syncCliMode();
    cliModeRow.connect('notify::selected', () => {
        const modeId = cliModeOptions[cliModeRow.selected]?.id;
        if (!modeId) return;
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
    // Refresca el estado del binario resuelto cuando el usuario descarga
    // el motor desde la página "Setup", sin necesidad de cambiar de modo.
    getEngineStore().connect('download-complete', syncCliMode);

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

    // --- Sensibilidad derivada del acelerador + menú de dispositivo GPU --
    // El propio índice del combo ya lo mantiene `comboRow`; aquí solo se
    // deriva la sensibilidad/visibilidad de filas vecinas según el modo
    // del binario, que no es un mapeo 1:1 de una sola clave.
    const syncAccel = () => {
        const id = settings.get_string(SETTINGS_KEYS.ACCELERATOR) ?? 'auto';
        // El binario CPU empaquetado no tiene soporte de GPU, así que en
        // modo CPU el acelerador queda fijo en 'cpu' (lo fija
        // syncCliMode) y el combo es de solo lectura para evitar una
        // selección Vulkan fuera de banda.
        const cliModeId = normalizeCliMode(
            settings.get_string(SETTINGS_KEYS.CLI_MODE) ?? 'cpu'
        );
        accelRow.sensitive = cliModeId !== 'cpu';
        // El menú de dispositivo GPU solo importa cuando puede usarse un
        // backend de GPU; se oculta en modo CPU (no hay GPU para elegir).
        gpuDeviceRow.visible = cliModeId !== 'cpu';
        gpuDeviceRow.sensitive = id === 'vulkan' || id === 'auto';
    };
    syncAccel();
    settings.connect(`changed::${SETTINGS_KEYS.ACCELERATOR}`, syncAccel);
    // Reevalúa la sensibilidad del acelerador cuando cambia el modo del
    // binario: el modo CPU fija el acelerador en 'cpu' y deshabilita el
    // combo.
    settings.connect(`changed::${SETTINGS_KEYS.CLI_MODE}`, syncAccel);

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
                : resolveAutoCli('transcribe-cli').path;

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
        settings.set_int(SETTINGS_KEYS.GPU_DEVICE, m ? parseInt(m[1], 10) : -1);
    });
    settings.connect(
        `changed::${SETTINGS_KEYS.CLI_MODE}`,
        () => void refreshGpuDevices()
    );
    settings.connect(
        `changed::${SETTINGS_KEYS.CLI_PATH}`,
        () => void refreshGpuDevices()
    );

    // --- Sensibilidad de fragmentación ----------------------------------
    settings.bind(
        SETTINGS_KEYS.CHUNK_ENABLED,
        chunkEnabledRow,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );
    // Ambas relaciones son 1:1 contra una propiedad de otro widget que ya
    // está sincronizada con GSettings (realtimeRow.active <-> REALTIME_MODE,
    // chunkEnabledRow.active <-> CHUNK_ENABLED arriba), así que se expresan
    // como bindings declarativos en vez de un sync manual por señal.
    //
    // El modo en tiempo real procesa la grabación completa al detener (no
    // trocea en vivo), así que el grupo "Long recordings" entero queda
    // deshabilitado (en gris) mientras esté activo.
    realtimeRow.bind_property(
        'active',
        chunkGroup,
        'sensitive',
        GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN
    );
    // Dentro del grupo, la duración y el solapamiento solo aplican cuando el
    // troceo en vivo está encendido.
    chunkEnabledRow.bind_property(
        'active',
        chunkSecondsRow,
        'sensitive',
        GObject.BindingFlags.SYNC_CREATE
    );
    chunkEnabledRow.bind_property(
        'active',
        chunkOverlapRow,
        'sensitive',
        GObject.BindingFlags.SYNC_CREATE
    );

    return backendPage;
}
