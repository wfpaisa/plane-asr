/* asr-backends.ts
 *
 * Reusable abstraction over local ASR CLIs. Each preset knows how to build the
 * `argv` for a `Gio.Subprocess` from the user's settings (binary path, model
 * params, realtime flag and the target WAV path). A `custom` preset lets the
 * user provide an arbitrary template.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Input bundle used by every preset to assemble its argv. */
export interface BuildArgvOptions {
    /** Absolute path to the configured CLI binary. */
    cliPath: string;
    /** Raw, possibly quoted, model/extra parameters string. */
    modelParams: string;
    /** Whether the realtime flag should be appended. */
    realtime: boolean;
    /** Argument template (only used by the `custom` backend). */
    customTemplate: string;
    /** Path of the WAV file to transcribe. */
    audioPath: string;
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
    /** Build the argv for `Gio.Subprocess`. */
    buildArgv(opts: BuildArgvOptions): string[];
}

/** Realtime flag inserted (when supported) before the audio argument. */
const REALTIME_ARGS = ['--stream-chunk-ms', '500'];

/**
 * Registered ASR presets. Order matters: the prefs combo renders them in this
 * order and maps the selected index back to the id.
 */
export const ASR_BACKENDS: AsrBackend[] = [
    {
        id: 'transcribe-cli',
        label: 'transcribe-cli (transcribe.cpp / Parakeet)',
        defaultCliName: 'transcribe-cli',
        supportsRealtime: true,
        buildArgv: opts => [
            opts.cliPath,
            ...parseArgs(opts.modelParams),
            ...(opts.realtime ? REALTIME_ARGS : []),
            opts.audioPath,
        ],
    },
    {
        id: 'whisper-cli',
        label: 'whisper-cli (whisper.cpp)',
        defaultCliName: 'whisper-cli',
        supportsRealtime: false,
        buildArgv: opts => [
            opts.cliPath,
            ...parseArgs(opts.modelParams),
            opts.audioPath,
        ],
    },
    {
        id: 'nero-asr',
        label: 'nero-asr',
        defaultCliName: 'nero-asr',
        supportsRealtime: false,
        buildArgv: opts => [
            opts.cliPath,
            ...parseArgs(opts.modelParams),
            opts.audioPath,
        ],
    },
    {
        id: 'custom',
        label: 'Custom (use argument template)',
        defaultCliName: '',
        supportsRealtime: false,
        buildArgv: opts => {
            const rendered = opts.customTemplate
                .replaceAll('{cli}', opts.cliPath)
                .replaceAll('{params}', opts.modelParams)
                .replaceAll('{audio}', opts.audioPath);
            return parseArgs(rendered);
        },
    },
];

const FALLBACK_BACKEND = ASR_BACKENDS[0];

/** Look up a backend by id, falling back to the first one if unknown. */
export function getBackend(id: string): AsrBackend {
    return ASR_BACKENDS.find(b => b.id === id) ?? FALLBACK_BACKEND;
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
