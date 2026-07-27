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
 * Fracción de posiciones en las que `a` y `b` (de igual longitud) tienen
 * tokens iguales. Devuelve 0 si la entrada está vacía.
 */
function matchRatio(a, b) {
    if (a.length === 0)
        return 0;
    let hits = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i])
            hits++;
    }
    return hits / a.length;
}
/**
 * Decide si los últimos `k` tokens de `prev` y los primeros `k` tokens de
 * `curr` representan el mismo habla solapado, y por lo tanto es seguro
 * colapsarlos.
 *
 * - Ventanas cortas (k < 3) deben coincidir *exactamente*: una coincidencia
 *   de 1-2 palabras es demasiado probable que sea una palabra legítimamente
 *   repetida ("y el" ... "y el").
 * - Ventanas más largas (k >= 3) toleran variación del ASR: se acepta una
 *   proporción >= 0.7, para que una palabra mal transcrita en el empalme no
 *   arruine toda la costura.
 */
function isOverlap(prevTail, currHead, k) {
    if (k <= 0 || k > prevTail.length || k > currHead.length)
        return false;
    const a = prevTail.slice(prevTail.length - k);
    const b = currHead.slice(0, k);
    if (k < 3)
        return matchRatio(a, b) === 1;
    return matchRatio(a, b) >= 0.7;
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
    const limit = Math.min(maxWords, normPrev.length, normCurr.length);
    for (let k = limit; k >= 1; k--) {
        if (isOverlap(normPrev, normCurr, k)) {
            // Traduce la longitud del solapamiento normalizado de vuelta a
            // tokens crudos. La normalización solo elimina tokens (puntuación
            // pura), así que el inicio crudo tiene al menos `k` tokens
            // significativos; se avanza hasta descartar exactamente los
            // tokens crudos que normalizan al conjunto solapado.
            let dropped = 0;
            let i = 0;
            for (; i < rawCurr.length && dropped < k; i++) {
                if (normalize(rawCurr[i]))
                    dropped++;
            }
            return rawCurr.slice(i).join(' ');
        }
    }
    return curr;
}
//# sourceMappingURL=text-merge.js.map