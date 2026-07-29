/* general-page.ts
 *
 * La página de preferencias "General": idioma, calidad (prompt), modo de
 * salida y atajos, y depuración (incluye el botón de reset a valores por
 * defecto).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {SETTINGS_KEYS} from '../config/settings.js';
import {comboRow, entryRow, shortcutRow, spinRow} from './widgets.js';

/** Contexto entregado al constructor de la página. */
export interface GeneralPageContext {
    settings: Gio.Settings;
    /** Overlay de notificaciones (toast) de la ventana de preferencias. */
    toast: (title: string) => void;
    window: Adw.PreferencesWindow;
}

/** Códigos de idioma comunes ofrecidos en el combo de idioma. Las etiquetas
 *  se traducen de forma diferida dentro de `buildGeneralPage`, porque
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

/** Construye la página de preferencias "General". */
export function buildGeneralPage(ctx: GeneralPageContext): Adw.PreferencesPage {
    const {settings, toast, window} = ctx;

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

    const lang = comboRow(settings, SETTINGS_KEYS.SELECTED_LANGUAGE, {
        title: _('Spoken language'),
        subtitle: _('Language hint passed to the model'),
        options: languageOptions,
        fallback: 'auto',
    });
    langGroup.add(lang.row);

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

    const output = comboRow(settings, SETTINGS_KEYS.OUTPUT_MODE, {
        title: _('Output mode'),
        subtitle: _('How to deliver the transcription'),
        options: [
            {id: 'clipboard', label: _('Copy to clipboard')},
            {id: 'paste', label: _('Paste at cursor')},
        ] as const,
        fallback: 'clipboard',
    });
    outputGroup.add(output.row);
    outputGroup.add(
        shortcutRow(settings, SETTINGS_KEYS.TOGGLE_RECORD_SHORTCUT, window)
    );
    outputGroup.add(
        shortcutRow(settings, SETTINGS_KEYS.PUSH_TO_TALK_SHORTCUT, window, {
            title: _('Push-to-talk shortcut'),
            subtitle: _(
                'Records only while held; needs a modifier ' +
                    '(e.g. Ctrl+Shift+Space). Release to stop'
            ),
        })
    );

    const keepRecordsRow = spinRow(settings, SETTINGS_KEYS.KEEP_RECORDS, {
        title: _('Keep last recordings'),
        subtitle: _(
            'How many recent recordings to keep under records/. Older ' +
                'WAVs are deleted automatically (0 = keep none)'
        ),
        lower: 0,
        upper: 100,
        step: 1,
        page: 5,
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

    /* ====================================================================
     * BINDINGS
     * ==================================================================== */

    settings.bind(
        SETTINGS_KEYS.TRANSLATE_TO_ENGLISH,
        translateRow,
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
        SETTINGS_KEYS.DEBUG_LOGGING,
        debugRow,
        'active',
        Gio.SettingsBindFlags.DEFAULT
    );

    return generalPage;
}
