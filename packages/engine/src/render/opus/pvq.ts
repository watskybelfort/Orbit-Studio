/**
 * PVQ: cuantización vectorial piramidal.
 *
 * Es la idea central de CELT y merece explicarse, porque no se parece a lo que
 * hacen otros códecs. Cada banda se normaliza a norma 1 —su energía va aparte, a
 * su propio canal— y lo que queda, la **forma**, se representa con `K` pulsos
 * enteros repartidos entre las `N` muestras de la banda: un vector `y` de enteros
 * con signo tal que `Σ|y[i]| = K`.
 *
 * Lo que se gana con eso es una garantía que un cuantizador normal no da: como
 * la energía se transmite por separado, **la banda nunca puede quedarse en
 * silencio por falta de bits**. Con pocos bits sonará imprecisa, pero sonará. Ese
 * es el motivo de que Opus no tenga el "chapoteo" que otros códecs sacan a
 * bitrates bajos.
 *
 * Y como el conjunto de vectores válidos es finito y contable, no hace falta
 * ningún diccionario: se numeran. El codificador manda el número, el
 * decodificador reconstruye el vector. De ahí que aquí haya tres cosas —contar,
 * indexar y desindexar— y que el test sea el que es: una **biyección**, probada
 * agotando todos los vectores.
 *
 * ## El orden de numeración es el de la RFC, no uno mío
 *
 * Esto importa más que cualquier otra cosa del módulo: el decodificador
 * desindexa con UN orden concreto, así que numerar "de forma consistente" no
 * basta — hay que numerar **igual**. La primera versión de esto ordenaba por el
 * valor absoluto de la primera coordenada, hacia delante. La RFC va al revés:
 * recorre el vector **desde el final**, con una tabla `U(n,k)` distinta de la
 * cuenta `V(n,k)`, relacionadas por `V(n,k) = U(n,k) + U(n,k+1)`.
 *
 * Aquí está portado el algoritmo de `celt/cwrs.c` de la implementación de
 * referencia (`icwrs`, `cwrsi`, `ncwrs_urow`, `unext`, `uprev`), con los mismos
 * nombres para que se pueda cotejar línea a línea.
 *
 * `pvqSize` NO se ha tocado: sigue calculando `V` con su propia recurrencia,
 * independiente de la de la referencia. Eso lo convierte en un testigo — si las
 * dos cuentas coinciden en todo el rango, es que el port está bien.
 *
 * ---
 * Las constantes y el algoritmo de esta parte derivan de la implementación de
 * referencia incluida en la RFC 6716, bajo licencia BSD de 3 cláusulas:
 * Copyright 1994-2011 IETF Trust, Xiph.Org, Skype Limited, Octasic,
 * Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell,
 * Mark Borgerding, Erik de Castro Lopo. Todos los derechos reservados.
 */

/** Tope prudente: por encima de esto los conteos dejan de ser exactos en double. */
const MAX_EXACT = Number.MAX_SAFE_INTEGER;

/**
 * `V(n, k)`: cuántos vectores de `n` dimensiones suman `k` pulsos.
 *
 * Recurrencia: o la primera coordenada es 0, o gasta pulsos con signo.
 * `V(n,k) = V(n-1,k) + V(n,k-1) + V(n-1,k-1)`
 */
/** Filas ya calculadas de V, por dimension. Indexar sin esto es cuadratico. */
const sizeCache = new Map<number, Float64Array>();

/**
 * Fila `V(n, 0..k)`. Se construye desde `V(0, .) = [1, 0, 0, ...]` — que es la
 * base que importa: en cero dimensiones solo cabe el vector vacio, y solo si no
 * quedan pulsos por repartir.
 */
function sizeRow(n: number, k: number): Float64Array {
  const cached = sizeCache.get(n);
  if (cached && cached.length > k) return cached;

  let row = new Float64Array(k + 1);
  row[0] = 1;
  for (let dim = 1; dim <= n; dim++) {
    const next = new Float64Array(k + 1);
    next[0] = 1;
    for (let pulses = 1; pulses <= k; pulses++) {
      next[pulses] = next[pulses - 1]! + row[pulses]! + row[pulses - 1]!;
    }
    const existing = sizeCache.get(dim);
    if (!existing || existing.length <= k) sizeCache.set(dim, next);
    row = next;
  }
  return row;
}

export function pvqSize(n: number, k: number): number {
  if (n < 0 || k < 0) throw new Error(`V(${n}, ${k}) no existe`);
  if (k === 0) return 1;
  if (n === 0) return 0;
  const out = sizeRow(n, k)[k]!;
  if (out > MAX_EXACT) throw new Error(`V(${n}, ${k}) no cabe exacto en un double`);
  return out;
}

/**
 * Techo de bits por palabra de código: libopus guarda `V(n,k)` en un `uint32`.
 *
 * No es un detalle de implementación suyo, es lo que fija el formato: si el
 * codificador numerara con más de 32 bits, el decodificador no podría leer el
 * número. Por eso existe `pvqNeedsSplit`.
 */
export const PVQ_MAX_BITS = 32;

/**
 * ¿Hay que partir esta banda en dos antes de cuantizarla?
 *
 * Aquí se ve por qué CELT parte bandas y no es un capricho de eficiencia: una
 * banda de 176 muestras con 32 pulsos tiene `V ≈ 1,3·10⁴⁶` vectores posibles —
 * **153 bits para una sola palabra**. Ni cabe en el `uint32` del formato ni cabe
 * exacto en un double. La salida es dividir la banda por la mitad, repartir los
 * pulsos entre las dos y numerar cada mitad por separado, recursivamente.
 */
export function pvqNeedsSplit(n: number, k: number): boolean {
  if (k === 0) return false;
  // Se cuenta con logaritmos a propósito: preguntar por el tamaño exacto sería
  // justamente lo que desborda.
  return pvqBitsApprox(n, k) > PVQ_MAX_BITS;
}

/**
 * Bits de la palabra, sin construir el número. Sirve donde `V` ya no es exacto,
 * que es precisamente donde hay que decidir si se parte.
 */
export function pvqBitsApprox(n: number, k: number): number {
  if (k === 0) return 0;
  if (n === 0) return 0;
  let log = 0;
  let row = new Float64Array(k + 1);
  row[0] = 1;
  for (let dim = 1; dim <= n; dim++) {
    const next = new Float64Array(k + 1);
    next[0] = 1;
    for (let pulses = 1; pulses <= k; pulses++) {
      next[pulses] = next[pulses - 1]! + row[pulses]! + row[pulses - 1]!;
    }
    // Reescalado por filas: se guarda el exponente aparte y la fila se mantiene
    // en un rango donde el double no pierde nada.
    const peak = next[k]!;
    if (peak > 1e250) {
      log += Math.log2(peak);
      for (let i = 0; i <= k; i++) next[i] = next[i]! / peak;
    }
    row = next;
  }
  return log + Math.log2(row[k]!);
}

/** Bits que cuesta mandar la forma de una banda de `n` con `k` pulsos. */
export function pvqBits(n: number, k: number): number {
  return Math.log2(pvqSize(n, k));
}

// ── Enumeración normativa (celt/cwrs.c) ──────────────────────────────────────
//
// `U(n,k)` cuenta los vectores de n dimensiones con k pulsos cuya PRIMERA
// coordenada no es cero. De ahí sale `V(n,k) = U(n,k) + U(n,k+1)`, y de ahí que
// el recorrido pueda ir sumando filas de U en vez de buscar.

/** `U(n,·)` → `U(n+1,·)`, in situ. `U(n+1,k) = U(n,k) + U(n,k-1) + U(n+1,k-1)`. */
function unext(u: Float64Array): void {
  let carry = 0;
  for (let j = 1; j < u.length; j++) {
    const next = u[j]! + u[j - 1]! + carry;
    u[j - 1] = carry;
    carry = next;
  }
  u[u.length - 1] = carry;
}

/** `U(n,·)` → `U(n-1,·)`, in situ. La inversa exacta de `unext`. */
function uprev(u: Float64Array, len: number): void {
  let carry = 0;
  for (let j = 1; j < len; j++) {
    const next = u[j]! - u[j - 1]! - carry;
    u[j - 1] = carry;
    carry = next;
  }
  u[len - 1] = carry;
}

/** Fila `U(n, 0..k+1)`. Arranca en `U(2,k) = 2k-1` y sube con `unext`. */
function urow(n: number, k: number): Float64Array {
  const u = new Float64Array(k + 2);
  for (let i = 1; i < u.length; i++) u[i] = 2 * i - 1;
  for (let dim = 2; dim < n; dim++) unext(u);
  return u;
}

/**
 * `V(n,k)` calculada como la calcula la referencia: `U(n,k) + U(n,k+1)`.
 *
 * Existe **sólo para contrastarla con `pvqSize`**, que la calcula con otra
 * recurrencia distinta. Dos caminos independientes que dan el mismo número en
 * todo el rango es lo que convierte "mi port se cree a sí mismo" en "mi port
 * coincide con la spec".
 */
export function pvqSizeFromUrow(n: number, k: number): number {
  if (k === 0) return 1;
  if (n === 0) return 0;
  if (n === 1) return 2;
  const u = urow(n, k);
  return u[k]! + u[k + 1]!;
}

/**
 * Numera un vector de pulsos. Devuelve un entero en `[0, V(n,k))`.
 *
 * Port de `icwrs`. El recorrido va de la ÚLTIMA coordenada hacia la primera,
 * acumulando la fila de `U` que corresponde a las dimensiones que quedan; el
 * signo negativo suma un bloque entero, que es lo que separa `+m` de `−m`.
 */
export function pvqIndex(y: readonly number[]): number {
  const n = y.length;
  const total = y.reduce((sum, v) => sum + Math.abs(v), 0);
  if (total === 0) return 0;
  if (n === 1) return y[0]! < 0 ? 1 : 0;

  const u = new Float64Array(total + 2);
  for (let i = 1; i < u.length; i++) u[i] = 2 * i - 1;

  // La última coordenada arranca la cuenta: su signo ES el bit de más peso.
  let k = Math.abs(y[n - 1]!);
  let index = y[n - 1]! < 0 ? 1 : 0;

  for (let j = n - 2; j >= 0; j--) {
    if (j < n - 2) unext(u);
    index += u[k]!;
    k += Math.abs(y[j]!);
    if (y[j]! < 0) index += u[k + 1]!;
  }
  return index;
}

/**
 * Reconstruye el vector a partir de su número. Port de `cwrsi`.
 *
 * Va al revés que `pvqIndex`: rellena de la primera coordenada a la última,
 * bajando la fila de `U` con `uprev` a cada paso.
 */
export function pvqDeindex(n: number, k: number, index: number): number[] {
  const total = pvqSize(n, k);
  if (index < 0 || index >= total) {
    throw new Error(`el índice ${index} se sale de V(${n}, ${k}) = ${total}`);
  }
  const y = new Array<number>(n).fill(0);
  if (k === 0) return y;
  if (n === 1) {
    y[0] = index === 1 ? -k : k;
    return y;
  }

  const u = urow(n, k);
  let rest = k;
  let remaining = index;
  for (let j = 0; j < n; j++) {
    // El bloque alto es el de los negativos: si el índice cae ahí, se le resta
    // y se recuerda el signo.
    const block = u[rest + 1]!;
    const negative = remaining >= block;
    if (negative) remaining -= block;

    let value = rest;
    let p = u[rest]!;
    while (p > remaining) p = u[--rest]!;
    remaining -= p;
    value -= rest;

    y[j] = negative ? -value : value;
    uprev(u, rest + 2);
  }
  return y;
}

/**
 * Busca el mejor vector de `k` pulsos para representar la forma de `x`.
 *
 * El criterio no es minimizar la distancia: es **maximizar el coseno** entre `x`
 * e `y`, porque la magnitud la lleva la energía de la banda por su cuenta. Por
 * eso se maximiza `(x·y)² / (y·y)` y no `|x - y|`.
 *
 * Los pulsos se colocan de uno en uno, quedándose cada vez con el que más sube
 * ese coseno. Es voraz, no óptimo — pero es lo que hace CELT y lo que permite
 * que el coste sea predecible.
 */
export function pvqSearch(x: readonly number[], k: number): number[] {
  const n = x.length;
  const y = new Array<number>(n).fill(0);
  if (k <= 0 || n === 0) return y;

  const abs = x.map(Math.abs);
  const sign = x.map((v) => (v < 0 ? -1 : 1));
  let xy = 0;
  let yy = 0;
  let placed = 0;

  // Arranque por proyección: coloca de golpe casi todos los pulsos donde la
  // señal ya dice que van. Sin esto, colocar 200 pulsos de uno en uno cuesta
  // 200·N comparaciones y da lo mismo.
  const norm = abs.reduce((sum, v) => sum + v, 0);
  if (norm > 0 && k > 1) {
    // Se reparte un pulso menos de la cuenta: pasarse no se puede arreglar
    // después, y quedarse corto sí.
    const scale = (k - 1) / norm;
    for (let i = 0; i < n; i++) {
      const guess = Math.floor(abs[i]! * scale);
      if (guess > 0) {
        y[i] = guess;
        placed += guess;
        xy += guess * abs[i]!;
        yy += guess * guess;
      }
    }
  }

  for (; placed < k; placed++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      // Coseno al cuadrado si el pulso cayera aquí. El denominador crece
      // 2·|y[i]| + 1 porque (y+1)² = y² + 2y + 1.
      const num = xy + abs[i]!;
      const den = yy + 2 * Math.abs(y[i]!) + 1;
      const score = (num * num) / den;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    xy += abs[best]!;
    yy += 2 * Math.abs(y[best]!) + 1;
    y[best] = Math.abs(y[best]!) + 1;
  }

  // El signo sólo se aplica a lo que no es cero: `0 * -1` da -0, que NO es 0
  // para Object.is ni para una comparación estructural, y se cuela en cuanto
  // el vector viaja o se compara.
  for (let i = 0; i < n; i++) if (y[i] !== 0) y[i] = y[i]! * sign[i]!;
  return y;
}

/**
 * Devuelve el vector de pulsos normalizado a norma 1: la forma reconstruida.
 * Es lo que el decodificador multiplica por la energía de la banda.
 */
export function pvqNormalize(y: readonly number[]): number[] {
  const norm = Math.sqrt(y.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return y.map(() => 0);
  return y.map((v) => v / norm);
}
