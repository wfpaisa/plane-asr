/* settings.ts
 *
 * Claves y valores por defecto de GSettings, centralizados, para la
 * extensión Plane ASR. Mantiene los strings "mágicos" en un solo lugar para
 * que el esquema, la extensión y las preferencias no se desincronicen.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Claves definidas en schemas/org.gnome.shell.extensions.planeasr.gschema.xml. */
export const SETTINGS_KEYS = {
    /** Id del preset de backend ASR activo (string). */
    ASR_BACKEND: 'asr-backend',
    /** Cómo se resuelve el binario del CLI: 'cpu' (incluido/PATH) o 'gpu' (string). */
    CLI_MODE: 'cli-mode',
    /** Ruta absoluta al binario del CLI de transcripción (string). */
    CLI_PATH: 'cli-path',
    /** Argumentos extra del CLI: ruta del modelo, idioma, etc. (string). */
    MODEL_PARAMS: 'model-params',
    /**
     * Modo en tiempo real: al detener la grabación, procesa la toma completa
     * en una sola pasada con el streaming del CLI (`--stream-chunk-ms`) y
     * entrega el texto progresivamente. Con salida "paste" lo escribe en el
     * cursor de forma secuencial; con "clipboard" copia el texto completo una
     * vez al terminar. Deshabilita el troceo en vivo (`chunk-enabled`) e
     * ignora el idioma elegido en favor de la autodetección (boolean).
     */
    REALTIME_MODE: 'realtime-mode',
    /** Banderas extra opcionales añadidas a cada comando de transcripción (string). */
    EXTRA_CLI_FLAGS: 'extra-cli-flags',

    /** Id del modelo de catálogo activo; '' significa usar el model-params libre (string). */
    ACTIVE_MODEL_ID: 'active-model-id',
    /** Directorio donde viven los modelos descargados; '' = ~/.cache/planeasr/models (string). */
    MODEL_DIR: 'model-dir',
    /** Cuantización preferida cuando un modelo ofrece varias (string, ej. 'Q8_0'). */
    QUANT_PREFERENCE: 'quant-preference',

    /** Acelerador de cómputo: 'auto', 'cpu' o 'vulkan' (string). */
    ACCELERATOR: 'accelerator',
    /** Índice del dispositivo GPU; -1 = auto (int). */
    GPU_DEVICE: 'gpu-device',

    /** Idioma hablado: 'auto' o un código ISO 639-1 (string). */
    SELECTED_LANGUAGE: 'selected-language',
    /** Traducir la transcripción al inglés cuando el modelo lo soporte (boolean). */
    TRANSLATE_TO_ENGLISH: 'translate-to-english',
    /** Hilos de CPU a usar; 0 = auto / todos los núcleos (int). */
    CPU_THREADS: 'cpu-threads',
    /** Vocabulario personalizado / texto de initial-prompt (string). */
    INITIAL_PROMPT: 'initial-prompt',

    /** Si se deben dividir grabaciones largas en trozos antes de transcribir (boolean). */
    CHUNK_ENABLED: 'chunk-enabled',
    /** Duración de cada trozo en segundos cuando `chunk-enabled` está activo (int). */
    CHUNK_SECONDS: 'chunk-seconds',
    /** Segundos de audio re-transcritos entre trozos consecutivos (int, 0 = desactivado). */
    CHUNK_OVERLAP_SECONDS: 'chunk-overlap-seconds',

    /** A dónde enviar el texto transcrito: 'clipboard' o 'paste' (string). */
    OUTPUT_MODE: 'output-mode',

    /**
     * Cuántas de las grabaciones más recientes conservar bajo records/. Los
     * WAV más antiguos se podan después de cada ejecución. 0 no conserva
     * ninguna (borra justo después de transcribir); un valor alto desactiva
     * la poda.
     */
    KEEP_RECORDS: 'keep-records',

    /** Último texto transcrito con éxito (string). */
    LAST_TEXT: 'last-text',

    /** Atajo de teclado global que alterna la grabación (arreglo de strings). */
    TOGGLE_RECORD_SHORTCUT: 'toggle-record-shortcut',

    /**
     * Atajo de teclado global de "mantener para hablar": graba mientras se
     * mantiene oprimido y se detiene al soltar los modificadores (arreglo de
     * strings).
     */
    PUSH_TO_TALK_SHORTCUT: 'push-to-talk-shortcut',

    /** Si se deben registrar diagnósticos de ASR en el journal del sistema (boolean). */
    DEBUG_LOGGING: 'debug-logging',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

/** Valores permitidos para la clave `output-mode`. */
export type OutputMode = 'clipboard' | 'paste';

/** Valores permitidos para la clave `accelerator`. */
export type Accelerator = 'auto' | 'cpu' | 'vulkan';

/**
 * Valores permitidos para la clave `cli-mode`.
 *
 * - `cpu`: usa el `transcribe-cli` solo-CPU incluido con la extensión
 *   (x86_64), recurriendo a uno encontrado en el PATH si falta.
 * - `gpu`: usa la ruta absoluta que el usuario definió en `cli-path` (por
 *   ejemplo, una compilación propia con Vulkan/CUDA). Elegir esta opción en
 *   la interfaz también fuerza el acelerador Vulkan.
 *
 * Los valores heredados `auto` y `manual` se migran a `cpu` y `gpu`
 * respectivamente mediante {@link normalizeCliMode}.
 */
export type CliMode = 'cpu' | 'gpu';

/**
 * Normaliza un valor crudo del GSetting `cli-mode` al enum actual, migrando
 * las opciones heredadas `auto`/`manual`.
 *
 * Para qué: mantener compatibilidad con configuraciones guardadas por
 * versiones anteriores de la extensión sin tener que migrar el esquema.
 *
 * Qué hace: mapea `gpu`/`manual` a `'gpu'`; cualquier otro valor,
 * reconocido o no, cae en `'cpu'` por defecto.
 */
export function normalizeCliMode(value: string | undefined | null): CliMode {
    if (value === 'gpu' || value === 'manual') return 'gpu';
    return 'cpu';
}

/** Valores permitidos para la clave `quant-preference`. */
export type Quant = 'Q4_K_M' | 'Q5_K_M' | 'Q6_K' | 'Q8_0' | 'F16' | 'F32';
