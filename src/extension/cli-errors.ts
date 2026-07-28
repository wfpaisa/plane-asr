/* cli-errors.ts
 *
 * Traduce el stderr crudo del CLI de ASR a un mensaje descriptivo y
 * accionable para el usuario. Los binarios de transcripción vuelcan mucho
 * ruido de diagnóstico (`[info] ggml_cuda_init: ...`, listado de
 * dispositivos, carga del modelo) y, cuando fallan, la línea de error real
 * queda enterrada en ese volcado — o es tan técnica que no dice al usuario
 * qué hacer. Este módulo detecta las causas conocidas y devuelve una
 * explicación clara en el idioma de la interfaz, conservando el detalle
 * técnico relevante para depurar.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * Un patrón conocido de fallo del CLI: si `test` casa contra el stderr,
 * `message()` produce la explicación que verá el usuario.
 */
interface CliErrorRule {
    /** Expresión regular contra la que se prueba el stderr completo. */
    test: RegExp;
    /** Explicación accionable (evaluada perezosamente para que gettext use el idioma activo). */
    message: () => string;
}

/**
 * Reglas ordenadas por especificidad: la primera que case gana. Las causas
 * más concretas (p. ej. "el modelo no soporta tiempo real") van antes que
 * las genéricas (p. ej. "error de CUDA") para no perder el matiz accionable.
 */
const RULES: CliErrorRule[] = [
    {
        // El modo en tiempo real conduce la API de streaming del CLI
        // (`--stream-chunk-ms`); un modelo que no la anuncia aborta con
        // "stream: model does not advertise ...".
        test: /\bstream\b.*\bmodel does not advert|does not (?:support|advertise)[^.\n]*(?:stream|real.?time)/i,
        message: () =>
            _(
                'The active model does not support real-time transcription. Turn off “Real-time mode” in preferences, or pick a model that supports streaming.'
            ),
    },
    {
        // El CLI rechaza el código de idioma corto (ISO) cuando el modelo
        // solo anuncia variantes BCP-47, o el idioma pedido no existe.
        test: /unsupported language|unknown language|invalid language|language[^.\n]*not supported/i,
        message: () =>
            _(
                'The selected language is not supported by this model. Set the language to “Auto” in preferences, or choose a different model.'
            ),
    },
    {
        // Sin VRAM suficiente para cargar el modelo en la GPU.
        test: /out of memory|cudaMalloc|cudaErrorMemoryAllocation|failed to allocate|ggml_backend[^.\n]*alloc[^.\n]*fail|CUDA error: out of memory/i,
        message: () =>
            _(
                'The GPU ran out of memory (VRAM). Try a smaller model or a lower quantization, select a GPU with more VRAM, or switch to CPU mode in preferences.'
            ),
    },
    {
        // GPU/driver no disponible: build CUDA sin dispositivo, driver
        // desactualizado, o Vulkan sin ICD.
        test: /no CUDA-capable device|CUDA driver version is insufficient|forward compatibility|failed to initialize (?:cuda|vulkan)|no (?:vulkan|compatible) device|vk::|VK_ERROR/i,
        message: () =>
            _(
                'The GPU could not be initialized. Check that the graphics driver is installed and up to date, select another device, or switch to CPU mode in preferences.'
            ),
    },
    {
        // Archivo de modelo ausente, corrupto o de formato desconocido.
        test: /failed to load model|unable to load model|no such file or directory|cannot open|invalid model|unknown model (?:format|architecture)|gguf[^.\n]*(?:magic|invalid|corrupt)/i,
        message: () =>
            _(
                'The model could not be loaded. The model file may be missing or incomplete — re-download it from the Models page in preferences, or verify the custom model path.'
            ),
    },
    {
        // Argv mal formado: casi siempre una ruta de modelo obsoleta que se
        // filtra como segundo argumento posicional (ver Transcriber).
        test: /multiple positional|unexpected (?:argument|positional)|unrecognized (?:argument|option)|the following arguments are required/i,
        message: () =>
            _(
                'The CLI rejected its arguments. This usually means a stale model path or an invalid extra flag — re-select the model on the Models page, or review the extra CLI flags in preferences.'
            ),
    },
    {
        // El audio no llegó o quedó vacío (grabación demasiado corta, sin
        // micrófono capturado).
        test: /empty (?:audio|input)|no audio|failed to (?:read|decode|open) audio|0 samples|too short/i,
        message: () =>
            _(
                'No audio could be read from the recording. Check that the microphone is working and try recording again for a bit longer.'
            ),
    },
];

/** Máximo de caracteres del detalle técnico que se anexa al mensaje. */
const DETAIL_MAX = 600;

/** Patrón de la etiqueta de nivel de log que anteponen los CLIs. */
const LOG_TAG = /^\[(?:info|debug|trace|warn|warning|error)\]\s*/i;

/** Palabras que delatan la línea de fallo dentro del volcado. */
const ERROR_HINT =
    /error|fail|fatal|abort|unsupported|invalid|cannot|unable|panic|exception|not (?:support|advert)/i;

/**
 * Extrae la señal útil del stderr crudo del CLI. Prioriza las líneas que se
 * parecen a un error —incluso cuando el CLI las etiqueta como `[info]`, como
 * hace transcribe-cli con su línea de "aborting"— quitándoles la etiqueta de
 * nivel para legibilidad. Si ninguna línea parece un error, cae a las líneas
 * sin etiqueta de puro diagnóstico y, en último caso, al texto original.
 */
function extractSignal(raw: string): string {
    const lines = raw
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    // Las líneas con pinta de error mandan, sin importar su etiqueta: el CLI
    // a veces registra la causa del aborto como `[info]`. Se les quita el
    // prefijo `[nivel]` para que el mensaje quede limpio.
    const errorLike = lines
        .filter(l => ERROR_HINT.test(l))
        .map(l => l.replace(LOG_TAG, ''));
    if (errorLike.length) return errorLike.join('\n').trim();

    // Sin línea de error clara: descarta el diagnóstico de arranque
    // (`[info]`/`[debug]`/`[trace]`) que solo describe dispositivos y modelo.
    const noise = /^\[(?:info|debug|trace)\]/i;
    const meaningful = lines.filter(l => !noise.test(l));
    return (meaningful.join('\n') || raw).trim();
}

/**
 * Traduce el stderr crudo del CLI a un mensaje descriptivo para el usuario.
 *
 * Qué hace: prueba el stderr contra las reglas conocidas; si alguna casa,
 * antepone su explicación accionable y anexa el detalle técnico relevante
 * (recortado) para poder depurar. Si ninguna regla casa, devuelve la señal
 * extraída del stderr sin el ruido `[info]`. El volcado completo sin recortar
 * sigue yendo al journal desde quien llama, así que aquí se prioriza la
 * legibilidad.
 */
export function describeCliError(raw: string): string {
    const text = (raw ?? '').trim();
    if (!text) return _('The transcription process failed with no output.');

    const detail = extractSignal(text);

    for (const rule of RULES) {
        if (rule.test.test(text)) {
            const trimmed =
                detail.length > DETAIL_MAX
                    ? `${detail.slice(0, DETAIL_MAX)}…`
                    : detail;
            // Se anexa el detalle técnico bajo una etiqueta para que quede
            // claro qué es explicación y qué es la salida cruda del CLI.
            return `${rule.message()}\n\n${_('Details')}: ${trimmed}`;
        }
    }

    // Sin coincidencia: al menos se devuelve la señal sin el ruido `[info]`,
    // recortada para que la notificación siga siendo legible.
    return detail.length > DETAIL_MAX
        ? `${detail.slice(0, DETAIL_MAX)}…`
        : detail;
}
