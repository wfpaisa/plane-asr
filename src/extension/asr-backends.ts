/* asr-backends.ts
 *
 * Abstraction over the local ASR CLI. The preset knows how to build the
 * `argv` for a `Gio.Subprocess` from the user's settings (binary path, model
 * params, realtime flag and the target WAV path).
 *
 * Beyond raw model params, the backend also translates a semantic
 * {@link BackendFeatures} bundle (accelerator, language, threads, prompt)
 * into the exact CLI flags of its binary, keeping the flag details of
 * transcribe-cli contained here instead of leaking into callers.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type {Accelerator} from '../config/settings.js';

/** Input bundle used to assemble the argv. */
export interface BuildArgvOptions {
    /** Absolute path to the configured CLI binary. */
    cliPath: string;
    /** Raw, possibly quoted, model/extra parameters string. */
    modelParams: string;
    /** Whether the realtime flag should be appended. */
    realtime: boolean;
    /**
     * Optional extra flags the user wants appended to every invocation, after
     * the model params and feature args, before the audio path. '' = none.
     */
    extraFlags: string;
    /** Path of the WAV file to transcribe. */
    audioPath: string;
    /**
     * Optional semantic features (accelerator, language, ...). When omitted the
     * preset behaves exactly as before and only emits model params + audio.
     */
    features?: BackendFeatures;
}

/**
 * Semantic, CLI-agnostic transcription knobs. The backend maps these to its
 * own flag names. Fields left at their default (0 / '' / false) are omitted so
 * the CLI uses its built-in default.
 */
export interface BackendFeatures {
    /** Compute backend selection. */
    accelerator: Accelerator;
    /** GPU device index; -1 = auto. */
    gpuDevice: number;
    /** Spoken language: 'auto' or an ISO 639-1 code. */
    language: string;
    /** Translate the transcription to English when supported. */
    translate: boolean;
    /** CPU threads; 0 = auto (don't emit). */
    threads: number;
    /** Initial prompt / custom vocabulary text; '' = none. */
    initialPrompt: string;
}

/** Feature set with everything neutralized (used as a default). */
export const NEUTRAL_FEATURES: BackendFeatures = {
    accelerator: 'auto',
    gpuDevice: -1,
    language: '',
    translate: false,
    threads: 0,
    initialPrompt: '',
};

/** Per-backend capability flags, so the UI can show/hide controls. */
export interface BackendCapabilities {
    /** Whether the backend understands the accelerator/device flags. */
    accelerator: boolean;
    /** Whether the backend honors the language flag. */
    language: boolean;
    /** Whether the backend honors the threads flag. */
    threads: boolean;
    /** Whether the backend honors an initial-prompt flag. */
    initialPrompt: boolean;
}

/** A pluggable transcription backend. */
export interface AsrBackend {
    /** Stable id stored in GSettings (`asr-backend`). */
    id: string;
    /** Human label shown in the preferences combo. */
    label: string;
    /** Default binary name, used as the Entry placeholder in prefs. */
    defaultCliName: string;
    /** Whether appending `--stream-chunk-ms 500` makes sense for this CLI. */
    supportsRealtime: boolean;
    /** Which semantic features this backend understands. */
    capabilities: BackendCapabilities;
    /** Build the argv for `Gio.Subprocess`. */
    buildArgv(opts: BuildArgvOptions): string[];
}

/** Realtime flag inserted (when supported) before the audio argument. */
const REALTIME_ARGS = ['--stream-chunk-ms', '500'];

/**
 * Registered ASR preset. Kept as an array (with a single entry) so the
 * `getBackend` lookup and the `ASR_BACKENDS[0]` fallback keep working.
 */
export const ASR_BACKENDS: AsrBackend[] = [
    {
        id: 'transcribe-cli',
        label: 'transcribe-cli (transcribe.cpp / Parakeet)',
        defaultCliName: 'transcribe-cli',
        supportsRealtime: true,
        capabilities: {
            accelerator: true,
            language: true,
            threads: true,
            initialPrompt: true,
        },
        buildArgv: opts => [
            opts.cliPath,
            ...transcribeCliFeatureArgs(opts.features),
            ...parseArgs(opts.modelParams),
            ...(opts.realtime ? REALTIME_ARGS : []),
            ...parseArgs(opts.extraFlags),
            opts.audioPath,
        ],
    },
];

const FALLBACK_BACKEND = ASR_BACKENDS[0];

/** Look up a backend by id, falling back to the first one if unknown. */
export function getBackend(id: string): AsrBackend {
    return ASR_BACKENDS.find(b => b.id === id) ?? FALLBACK_BACKEND;
}

/**
 * Translate semantic features into transcribe-cli flags.
 *
 * transcribe-cli uses `--backend {auto,cpu,vulkan,...}` + `--device N`
 * (registry index, 0 = auto). Note: there is NO `-ngl`/n-gpu-layers flag;
 * offload is automatic once a GPU backend is chosen. Short-flag `-t` means
 * translate, so threads must use the long `--threads` form.
 */
function transcribeCliFeatureArgs(features?: BackendFeatures): string[] {
    if (!features) return [];
    const args: string[] = [];

    switch (features.accelerator) {
        case 'cpu':
            args.push('--backend', 'cpu');
            break;
        case 'vulkan':
            args.push('--backend', 'vulkan');
            if (features.gpuDevice >= 0) {
                args.push('--device', String(features.gpuDevice));
            }
            break;
        case 'auto':
        default:
            // 'auto' is the CLI default; emit nothing.
            break;
    }

    if (features.language && features.language !== 'auto') {
        args.push('--language', features.language);
    }
    if (features.translate) {
        args.push('--translate', '--target-language', 'en');
    }
    if (features.threads > 0) {
        args.push('--threads', String(features.threads));
    }
    if (features.initialPrompt) {
        args.push('--initial-prompt', features.initialPrompt);
    }
    return args;
}

/**
 * Tokenize a shell-like argument string.
 *
 * Splits on whitespace while honoring single quotes, double quotes and
 * backslash escapes, so paths or model names that contain spaces survive
 * intact. Empty input yields an empty array.
 */
export function parseArgs(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaping = false;
    let hasToken = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (escaping) {
            current += ch;
            escaping = false;
            hasToken = true;
            continue;
        }

        if (ch === '\\' && !inSingle) {
            escaping = true;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            hasToken = true;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            hasToken = true;
            continue;
        }

        if (!inSingle && !inDouble && /\s/.test(ch)) {
            if (hasToken) {
                tokens.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }

        current += ch;
        hasToken = true;
    }

    if (hasToken) tokens.push(current);
    return tokens;
}
