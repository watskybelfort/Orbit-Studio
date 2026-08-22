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
 * ## Lo que falta para que esto sea compatible con Opus
 *
 * El orden concreto en que se numeran los vectores tiene que ser EL MISMO que el
 * del decodificador, y eso lo fija la RFC 6716 (§4.3.4). El de aquí está
 * documentado abajo y es consistente consigo mismo —los tests lo demuestran—
 * pero **no está contrastado contra la spec**. Hasta que lo esté, esto sirve como
 * cuantizador correcto, no como bitstream compatible. Se dice aquí para que nadie
 * lo dé por hecho leyendo los tests en verde.
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

/**
 * Numera un vector de pulsos. Devuelve un entero en `[0, V(n,k))`.
 *
 * El orden es: primero por el valor absoluto de la primera coordenada (0, 1, 2…),
 * y dentro de cada valor no nulo, primero el positivo y luego el negativo. El
 * resto del vector se numera igual, recursivamente. Es el orden que hace que
 * contar cuántos van por delante sea una suma de `V` y no una búsqueda.
 */
export function pvqIndex(y: readonly number[]): number {
  const k = y.reduce((sum, v) => sum + Math.abs(v), 0);
  let index = 0;
  let rest = k;
  for (let i = 0; i < y.length; i++) {
    const dims = y.length - i - 1;
    const value = y[i]!;
    const magnitude = Math.abs(value);
    // Todo lo que empieza con un valor absoluto MENOR va antes.
    for (let m = 0; m < magnitude; m++) {
      index += (m === 0 ? 1 : 2) * pvqSize(dims, rest - m);
    }
    // Dentro del mismo valor absoluto, el positivo va antes que el negativo.
    if (magnitude > 0 && value < 0) index += pvqSize(dims, rest - magnitude);
    rest -= magnitude;
  }
  return index;
}

/** Reconstruye el vector a partir de su número. La inversa exacta de `pvqIndex`. */
export function pvqDeindex(n: number, k: number, index: number): number[] {
  const total = pvqSize(n, k);
  if (index < 0 || index >= total) {
    throw new Error(`el índice ${index} se sale de V(${n}, ${k}) = ${total}`);
  }
  const y = new Array<number>(n).fill(0);
  let rest = k;
  let remaining = index;
  for (let i = 0; i < n; i++) {
    const dims = n - i - 1;
    let magnitude = 0;
    for (;;) {
      const block = (magnitude === 0 ? 1 : 2) * pvqSize(dims, rest - magnitude);
      if (remaining < block) break;
      remaining -= block;
      magnitude++;
    }
    if (magnitude === 0) {
      y[i] = 0;
    } else {
      const half = pvqSize(dims, rest - magnitude);
      const negative = remaining >= half;
      if (negative) remaining -= half;
      y[i] = negative ? -magnitude : magnitude;
      rest -= magnitude;
    }
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
