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
    /** Id of the active ASR backend preset (string). */
    ASR_BACKEND: 'asr-backend',
    /** How the CLI binary is resolved: 'auto' (bundled/PATH) or 'manual' (string). */
    CLI_MODE: 'cli-mode',
    /** Absolute path to the transcription CLI binary (string). */
    CLI_PATH: 'cli-path',
    /** Extra CLI args: model path, language, etc. (string). */
    MODEL_PARAMS: 'model-params',
    /** Whether to append --stream-chunk-ms 500 for realtime ASR (boolean). */
    REALTIME_MODE: 'realtime-mode',
    /** Argument template used when backend === 'custom' (string). */
    CUSTOM_ARG_TEMPLATE: 'custom-arg-template',

    /** Id of the active catalog model; '' means use the free-form model-params (string). */
    ACTIVE_MODEL_ID: 'active-model-id',
    /** Directory where downloaded models live; '' = ~/.cache/planeasr/models (string). */
    MODEL_DIR: 'model-dir',
    /** Preferred quantization when a model offers several (string, e.g. 'Q8_0'). */
    QUANT_PREFERENCE: 'quant-preference',

    /** Compute accelerator: 'auto', 'cpu' or 'vulkan' (string). */
    ACCELERATOR: 'accelerator',
    /** GPU device index; -1 = auto (int). */
    GPU_DEVICE: 'gpu-device',
    /** Whether to auto-detect a Vulkan GPU at runtime (boolean). */
    AUTO_DETECT_GPU: 'auto-detect-gpu',

    /** Spoken language: 'auto' or an ISO 639-1 code (string). */
    SELECTED_LANGUAGE: 'selected-language',
    /** Translate the transcription to English when supported (boolean). */
    TRANSLATE_TO_ENGLISH: 'translate-to-english',
    /** CPU threads to use; 0 = auto / all cores (int). */
    CPU_THREADS: 'cpu-threads',
    /** Enable Voice Activity Detection (whisper-cli only) (boolean). */
    VAD_ENABLED: 'vad-enabled',
    /** Custom vocabulary / initial-prompt text (string). */
    INITIAL_PROMPT: 'initial-prompt',

    /** Whether to split long recordings into chunks before transcription (boolean). */
    CHUNK_ENABLED: 'chunk-enabled',
    /** Chunk length in seconds when `chunk-enabled` is true (int). */
    CHUNK_SECONDS: 'chunk-seconds',
    /** Seconds of audio re-transcribed between consecutive chunks (int, 0 = off). */
    CHUNK_OVERLAP_SECONDS: 'chunk-overlap-seconds',

    /** Where to send transcribed text: 'clipboard' or 'paste' (string). */
    OUTPUT_MODE: 'output-mode',

    /** Last successful transcription text (string). */
    LAST_TEXT: 'last-text',
    /** Absolute path of the last recorded WAV file (string). */
    LAST_AUDIO_PATH: 'last-audio-path',

    /** Global keybinding that toggles recording (string array). */
    TOGGLE_RECORD_SHORTCUT: 'toggle-record-shortcut',

    /** Whether to log ASR diagnostics to the system journal (boolean). */
    DEBUG_LOGGING: 'debug-logging',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

/** Allowed values for the `output-mode` key. */
export type OutputMode = 'clipboard' | 'paste';

/** Allowed values for the `accelerator` key. */
export type Accelerator = 'auto' | 'cpu' | 'vulkan';

/** Allowed values for the `cli-mode` key. */
export type CliMode = 'auto' | 'manual';

/** Allowed values for the `quant-preference` key. */
export type Quant = 'Q4_K_M' | 'Q5_K_M' | 'Q6_K' | 'Q8_0' | 'F16' | 'F32';
