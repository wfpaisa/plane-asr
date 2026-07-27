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
/** Conjunto de features con todo neutralizado (usado como valor por defecto). */
export const NEUTRAL_FEATURES = {
    accelerator: 'auto',
    gpuDevice: -1,
    language: '',
    translate: false,
    threads: 0,
    initialPrompt: '',
};
/** Bandera de tiempo real insertada (cuando se soporta) antes del argumento de audio. */
const REALTIME_ARGS = ['--stream-chunk-ms', '500'];
/**
 * Preset de ASR registrado. Se mantiene como un arreglo (con una sola
 * entrada) para que la búsqueda de `getBackend` y el respaldo
 * `ASR_BACKENDS[0]` sigan funcionando.
 */
export const ASR_BACKENDS = [
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
/** Busca un backend por id, recurriendo al primero si es desconocido. */
export function getBackend(id) {
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
function transcribeCliFeatureArgs(features) {
    if (!features)
        return [];
    const args = [];
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
export function parseArgs(input) {
    const tokens = [];
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
    if (hasToken)
        tokens.push(current);
    return tokens;
}
//# sourceMappingURL=asr-backends.js.map