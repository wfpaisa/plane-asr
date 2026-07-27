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
    /** How the CLI binary is resolved: 'cpu' (bundled/PATH) or 'gpu' (string). */
    CLI_MODE: 'cli-mode',
    /** Absolute path to the transcription CLI binary (string). */
    CLI_PATH: 'cli-path',
    /** Extra CLI args: model path, language, etc. (string). */
    MODEL_PARAMS: 'model-params',
    /** Whether to append --stream-chunk-ms 500 for realtime ASR (boolean). */
    REALTIME_MODE: 'realtime-mode',
    /** Optional extra flags appended to every transcription command (string). */
    EXTRA_CLI_FLAGS: 'extra-cli-flags',

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

    /** Spoken language: 'auto' or an ISO 639-1 code (string). */
    SELECTED_LANGUAGE: 'selected-language',
    /** Translate the transcription to English when supported (boolean). */
    TRANSLATE_TO_ENGLISH: 'translate-to-english',
    /** CPU threads to use; 0 = auto / all cores (int). */
    CPU_THREADS: 'cpu-threads',
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

    /**
     * How many of the most recent recordings to keep under records/. Older
     * WAVs are pruned after each run. 0 keeps none (delete right after
     * transcription); keep a high value to disable pruning.
     */
    KEEP_RECORDS: 'keep-records',

    /** Last successful transcription text (string). */
    LAST_TEXT: 'last-text',

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

/**
 * Allowed values for the `cli-mode` key.
 *
 * - `cpu`: use the CPU-only `transcribe-cli` bundled with the extension
 *   (x86_64), falling back to one found on PATH.
 * - `gpu`: use the absolute path the user set in `cli-path` (e.g. a
 *   personally compiled Vulkan/CUDA build). Selecting this in the UI also
 *   forces the Vulkan accelerator.
 *
 * Legacy values `auto` and `manual` are migrated to `cpu` and `gpu`
 * respectively by {@link normalizeCliMode}.
 */
export type CliMode = 'cpu' | 'gpu';

/**
 * Normalize a raw `cli-mode` GSetting value to the current enum, migrating
 * the legacy `auto`/`manual` choices. Anything unrecognized defaults to `cpu`.
 */
export function normalizeCliMode(value: string | undefined | null): CliMode {
    if (value === 'gpu' || value === 'manual') return 'gpu';
    return 'cpu';
}

/** Allowed values for the `quant-preference` key. */
export type Quant = 'Q4_K_M' | 'Q5_K_M' | 'Q6_K' | 'Q8_0' | 'F16' | 'F32';
