/* settings.ts
 *
 * Centralized GSettings keys and defaults for the Plane ASR extension.
 * Keeps magic strings in one place so the schema, extension and prefs stay
 * in sync.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Keys defined in schemas/org.gnome.shell.extensions.planeasr.gschema.xml. */
export const SETTINGS_KEYS = {
    /** Whether the extension's animated feedback is enabled (boolean). */
    ANIMATE: 'animate',
    /** Inner spacing, in pixels, used by the panel indicator UI (int). */
    PADDING_INNER: 'padding-inner',

    /** Id of the active ASR backend preset (string). */
    ASR_BACKEND: 'asr-backend',
    /** Absolute path to the transcription CLI binary (string). */
    CLI_PATH: 'cli-path',
    /** Extra CLI args: model path, language, etc. (string). */
    MODEL_PARAMS: 'model-params',
    /** Whether to append --stream-chunk-ms 500 for realtime ASR (boolean). */
    REALTIME_MODE: 'realtime-mode',
    /** Argument template used when backend === 'custom' (string). */
    CUSTOM_ARG_TEMPLATE: 'custom-arg-template',

    /** Where to send transcribed text: 'clipboard' or 'paste' (string). */
    OUTPUT_MODE: 'output-mode',

    /** Last successful transcription text (string). */
    LAST_TEXT: 'last-text',
    /** Absolute path of the last recorded WAV file (string). */
    LAST_AUDIO_PATH: 'last-audio-path',

    /** Global keybinding that toggles recording (string array). */
    TOGGLE_RECORD_SHORTCUT: 'toggle-record-shortcut',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

/** Allowed values for the `output-mode` key. */
export type OutputMode = 'clipboard' | 'paste';
