/* asr-backends.ts
 *
 * Abstracción sobre el CLI de ASR local. El preset sabe cómo construir el
 * `argv` para un `Gio.Subprocess` a partir de la configuración del usuario
 * (ruta del binario, parámetros del modelo, bandera de tiempo real y la
 * ruta del WAV objetivo).
 *
 * Más allá de los parámetros crudos del modelo, el backend también
 * traduce un conjunto semántico {@link BackendFeatures} (acelerador,
 * idioma, hilos, prompt) a las banderas CLI exactas de su binario,
 * manteniendo los detalles de banderas de transcribe-cli contenidos aquí
 * en vez de filtrarse a quienes lo llaman.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type {Accelerator} from '../config/settings.js';

/** Conjunto de entrada usado para ensamblar el argv. */
export interface BuildArgvOptions {
    /** Ruta absoluta al binario del CLI configurado. */
    cliPath: string;
    /** String crudo (posiblemente con comillas) de parámetros del modelo/extra. */
    modelParams: string;
    /**
     * Banderas extra opcionales que el usuario quiere añadir a cada
     * invocación, después de los parámetros del modelo y los argumentos de
     * features, antes de la ruta de audio. '' = ninguna.
     */
    extraFlags: string;
    /** Ruta del archivo WAV a transcribir. */
    audioPath: string;
    /**
     * Si se define (> 0), añade `--stream-chunk-ms N` para conducir la API
     * de streaming del CLI sobre el archivo completo, emitiendo parciales
     * incrementales por stdout. Lo usa el modo en tiempo real para pegar la
     * transcripción a medida que la librería la va produciendo.
     */
    streamChunkMs?: number;
    /**
     * Features semánticas opcionales (acelerador, idioma, ...). Si se
     * omiten, el preset se comporta exactamente como antes y solo emite
     * parámetros del modelo + audio.
     */
    features?: BackendFeatures;
}

/**
 * Ajustes de transcripción semánticos, independientes del CLI concreto. El
 * backend los mapea a sus propios nombres de bandera. Los campos que
 * quedan en su valor por defecto (0 / '' / false) se omiten para que el
 * CLI use el suyo propio.
 */
export interface BackendFeatures {
    /** Selección de backend de cómputo. */
    accelerator: Accelerator;
    /** Índice del dispositivo GPU; -1 = auto. */
    gpuDevice: number;
    /** Idioma hablado: 'auto' o un código ISO 639-1. */
    language: string;
    /** Traducir la transcripción al inglés cuando el modelo lo soporte. */
    translate: boolean;
    /** Hilos de CPU; 0 = auto (no se emite). */
    threads: number;
    /** Prompt inicial / vocabulario personalizado; '' = ninguno. */
    initialPrompt: string;
}

/** Conjunto de features con todo neutralizado (usado como valor por defecto). */
export const NEUTRAL_FEATURES: BackendFeatures = {
    accelerator: 'auto',
    gpuDevice: -1,
    language: '',
    translate: false,
    threads: 0,
    initialPrompt: '',
};

/** Banderas de capacidad por backend, para que la interfaz muestre/oculte controles. */
export interface BackendCapabilities {
    /** Si el backend entiende las banderas de acelerador/dispositivo. */
    accelerator: boolean;
    /** Si el backend respeta la bandera de idioma. */
    language: boolean;
    /** Si el backend respeta la bandera de hilos. */
    threads: boolean;
    /** Si el backend respeta una bandera de prompt inicial. */
    initialPrompt: boolean;
}

/** Un backend de transcripción conectable (plugin). */
export interface AsrBackend {
    /** Id estable guardado en GSettings (`asr-backend`). */
    id: string;
    /** Etiqueta legible mostrada en el combo de preferencias. */
    label: string;
    /** Nombre de binario por defecto, usado como placeholder del campo en preferencias. */
    defaultCliName: string;
    /**
     * Si el modo en tiempo real (pegado/copiado progresivo por trozos que
     * gestiona la propia extensión) tiene sentido para este CLI.
     */
    supportsRealtime: boolean;
    /** Qué features semánticas entiende este backend. */
    capabilities: BackendCapabilities;
    /** Construye el argv para `Gio.Subprocess`. */
    buildArgv(opts: BuildArgvOptions): string[];
}

/**
 * Preset de ASR registrado. Se mantiene como un arreglo (con una sola
 * entrada) para que la búsqueda de `getBackend` y el respaldo
 * `ASR_BACKENDS[0]` sigan funcionando.
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
            ...(opts.streamChunkMs && opts.streamChunkMs > 0
                ? ['--stream-chunk-ms', String(opts.streamChunkMs)]
                : []),
            ...parseArgs(opts.extraFlags),
            opts.audioPath,
        ],
    },
];

const FALLBACK_BACKEND = ASR_BACKENDS[0];

/** Busca un backend por id, recurriendo al primero si es desconocido. */
export function getBackend(id: string): AsrBackend {
    return ASR_BACKENDS.find(b => b.id === id) ?? FALLBACK_BACKEND;
}

/**
 * Traduce las features semánticas a banderas de transcribe-cli.
 *
 * transcribe-cli usa `--backend {auto,cpu,vulkan,...}` + `--device N`
 * (índice de registro, 0 = auto). Nota: NO existe una bandera
 * `-ngl`/n-gpu-layers; el offload es automático una vez elegido un backend
 * GPU. La bandera corta `-t` significa "translate", así que los hilos deben
 * usar la forma larga `--threads`.
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
            // 'auto' es el valor por defecto del CLI; no se emite nada.
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
 * Tokeniza un string de argumentos al estilo de una shell.
 *
 * Divide por espacios en blanco respetando comillas simples, comillas
 * dobles y escapes con barra invertida, para que rutas o nombres de modelo
 * con espacios sobrevivan intactos. Una entrada vacía produce un arreglo vacío.
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
