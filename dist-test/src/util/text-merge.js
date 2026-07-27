/* text-merge.ts
 *
 * Costura de transcripciones consecutivas por trozos, consciente del
 * solapamiento. Cuando el worker de ASR recorta ventanas superpuestas de una
 * grabación, el mismo habla queda transcrito dos veces en cada empalme (la
 * cola del trozo N y el inicio del trozo N+1). Estas funciones detectan y
 * eliminan ese texto duplicado para que la salida unida se lea como una
 * transcripción continua.
 *
 * Puro, sin importaciones de GNOME/GJS — se puede probar con Node normal.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */
/**
 * Normaliza un token para poder compararlo: lo pasa a minúsculas y quita
 * caracteres no alfanuméricos al principio y al final (conserva las letras
 * interiores, así que las tildes y la ñ sobreviven). Devuelve '' para tokens
 * que son puro ruido/puntuación, que quien llama filtra después.
 */
function normalize(token) {
    return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}
/** Tokeniza por espacios en blanco y descarta tokens que normalizan a vacío. */
function tokens(text) {
    const out = [];
    for (const raw of text.split(/\s+/)) {
        const n = normalize(raw);
        if (n)
            out.push(n);
    }
    return out;
}
/**
 * Fracción de tokens de `head` que aparecen, en orden, como subsecuencia de
 * `window`. Devuelve 0 si `head` está vacío.
 *
 * A diferencia de una comparación posicional estricta, esto tolera que el ASR
 * inserte o quite alguna palabra dentro de la zona solapada (por ejemplo,
 * "que siempre aparecía" en un trozo frente a "que aparecía" en el
 * siguiente): mientras las palabras compartidas conserven su orden, la
 * costura se sigue reconociendo. `window` es un sufijo de `prev`, así que las
 * coincidencias quedan ancladas al final del trozo previo.
 */
function subseqMatch(head, window) {
    if (head.length === 0)
        return 0;
    let hi = 0;
    for (let wi = 0; wi < window.length && hi < head.length; wi++) {
        if (window[wi] === head[hi])
            hi++;
    }
    return hi / head.length;
}
/**
 * Decide si los primeros `d` tokens de `curr` re-transcriben la cola de
 * `prev` y por lo tanto es seguro descartarlos.
 *
 * Busca la mejor alineación probando ventanas del sufijo de `prev` de
 * longitud `d` .. `d + SLACK`, para absorber inserciones/omisiones del ASR en
 * la costura sin exigir que ambos trozos tengan exactamente la misma cantidad
 * de palabras solapadas.
 *
 * - Costuras cortas (d < 3) deben coincidir *por completo*: una coincidencia
 *   de 1-2 palabras es demasiado probable que sea una palabra legítimamente
 *   repetida.
 * - Costuras más largas (d >= 3) aceptan una proporción >= 0.7, para que una
 *   palabra mal transcrita no arruine toda la costura.
 */
function isOverlap(prevTail, currHead, d) {
    if (d <= 0 || d > currHead.length)
        return false;
    const SLACK = 2;
    const head = currHead.slice(0, d);
    const threshold = d < 3 ? 1 : 0.7;
    for (let w = d; w <= d + SLACK && w <= prevTail.length; w++) {
        const window = prevTail.slice(prevTail.length - w);
        if (subseqMatch(head, window) >= threshold)
            return true;
    }
    return false;
}
/**
 * Une dos transcripciones de trozos consecutivos, quitando del inicio de
 * `curr` cualquier prefijo que duplique la cola de `prev` (la región
 * solapada).
 *
 * Para qué: producir una transcripción continua y sin repeticiones a partir
 * de trozos de audio que se grabaron con solapamiento.
 *
 * Qué hace: `maxWords` limita cuántas palabras del inicio estamos
 * dispuestos a descartar — pasar 0 desactiva la deduplicación por completo y
 * devuelve `curr` tal cual (usado para ventanas contiguas sin solapamiento).
 * Busca el solapamiento más grande posible primero (la costura más
 * "codiciosa" y correcta). Cuando no se encuentra un solapamiento
 * convincente, `curr` se devuelve sin cambios: duplicar una palabra real
 * siempre es preferible a borrar texto legítimo.
 *
 * @example
 *   dedupChunkJoin('hola mundo', 'mundo cruel', 4)        // 'cruel'
 *   dedupChunkJoin('vamos a hacer', 'hacer una prueba', 4) // 'una prueba'
 *   dedupChunkJoin('fin del uno', 'inicio del dos', 4)     // 'inicio del dos'
 *   dedupChunkJoin('Hola,', 'hola mundo', 0)               // 'hola mundo'
 */
export function dedupChunkJoin(prev, curr, maxWords) {
    if (!curr)
        return curr;
    if (maxWords <= 0 || !prev)
        return curr;
    // Trabaja sobre los tokens crudos (con mayúsculas/minúsculas originales y
    // puntuación) para que el sufijo devuelto conserve el formato de la
    // transcripción; la *comparación* en sí se hace sobre las formas
    // normalizadas.
    const rawCurr = curr.split(/\s+/).filter(t => t.length > 0);
    const normPrev = tokens(prev);
    const normCurr = tokens(curr);
    if (normPrev.length === 0 || normCurr.length === 0)
        return curr;
    // Busca primero el solapamiento más grande (la costura correcta más codiciosa).
    const limit = Math.min(maxWords, normCurr.length);
    for (let d = limit; d >= 1; d--) {
        if (isOverlap(normPrev, normCurr, d)) {
            // Traduce la longitud del solapamiento normalizado de vuelta a
            // tokens crudos. La normalización solo elimina tokens (puntuación
            // pura), así que el inicio crudo tiene al menos `d` tokens
            // significativos; se avanza hasta descartar exactamente los
            // tokens crudos que normalizan al conjunto solapado.
            let dropped = 0;
            let i = 0;
            for (; i < rawCurr.length && dropped < d; i++) {
                if (normalize(rawCurr[i]))
                    dropped++;
            }
            return rawCurr.slice(i).join(' ');
        }
    }
    return curr;
}
/**
 * Marcadores que el CLI/modelo emite cuando un trozo es silencio o no
 * contiene habla: `(empty)`, `[BLANK_AUDIO]`, `[silence]`, `(música)`, etc.
 * Al transcribir en vivo, la cola final de una grabación suele caer en uno de
 * estos, y sin filtrarlo se cuela literalmente en la transcripción.
 */
const PLACEHOLDER_RE = /[([]\s*(?:empty|blank(?:[_ ]?audio)?|silence|silencio|inaudible|no[_ ]?(?:audio|speech|sound)|music|música|sonido|noise|ruido|\.{2,})\s*[)\]]/giu;
/**
 * Quita los marcadores de silencio/vacío de una transcripción y normaliza los
 * espacios. Devuelve `''` cuando el texto era solo marcadores, para que quien
 * llama lo trate igual que un trozo vacío.
 */
export function stripPlaceholders(text) {
    return text.replace(PLACEHOLDER_RE, ' ').replace(/\s+/gu, ' ').trim();
}
/**
 * Da el formato final a la transcripción completa unida, pensada para
 * dictado (se copia o se pega en la posición del cursor, no es una frase
 * independiente):
 *
 *  - Elimina los marcadores de silencio ({@link stripPlaceholders}).
 *  - Borra los puntos de costura falsos: un punto seguido de una palabra en
 *    minúscula nunca inicia una frase real, así que proviene de que el modelo
 *    cerró un trozo a mitad de una oración ("desde la. ventana" ->
 *    "desde la ventana"). Las frases reales, que empiezan con mayúscula, no
 *    se tocan.
 *  - No empieza con mayúscula: es texto que continúa donde esté el cursor.
 *  - No termina en punto.
 */
export function finalizeTranscript(text) {
    let t = stripPlaceholders(text);
    // Punto de costura (seguido de continuación en minúscula) -> quítalo.
    t = t.replace(/\.\s+(?=\p{Ll})/gu, ' ');
    // Junta la puntuación con la palabra previa y colapsa espacios.
    t = t.replace(/\s+([,.;:!?])/gu, '$1').replace(/\s+/gu, ' ').trim();
    // No terminar en punto (ni "..." ni un punto suelto).
    t = t.replace(/[.…\s]+$/gu, '');
    // Primera letra en minúscula.
    if (t)
        t = t[0].toLowerCase() + t.slice(1);
    return t;
}
//# sourceMappingURL=text-merge.js.map