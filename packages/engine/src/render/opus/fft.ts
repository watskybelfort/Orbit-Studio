/**
 * FFT compleja de radix mixto, para los tamaños que usa Opus.
 *
 * Existe por una razón muy concreta: los tamaños de trama de Opus son 120, 240,
 * 480 y 960, y **ninguno es potencia de dos** — todos son 2^k · 15. Una FFT
 * radix-2 de las de manual no sirve aquí, así que esta factoriza en primos
 * pequeños (2, 3, 5) y resuelve cada factor con su mariposa; lo que quede sin
 * factorizar cae a una DFT directa, que para un primo pequeño es más rápida que
 * cualquier cosa lista.
 *
 * La alternativa —MDCT directa O(N²)— no es viable: 960 puntos son 1,8 millones
 * de multiplicaciones POR TRAMA y por canal; un tema de tres minutos en estéreo
 * son 33.000 millones de operaciones. Con esto baja a algo del orden de N·log N.
 */

/** Descompone `n` en factores primos pequeños, de menor a mayor. */
export function factorize(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  for (const p of [4, 2, 3, 5]) {
    while (rest % p === 0) {
      out.push(p);
      rest /= p;
    }
  }
  if (rest > 1) out.push(rest);
  return out;
}

/**
 * FFT compleja in-place sobre `re`/`im` (misma longitud).
 *
 * `sign` es −1 para la transformada directa y +1 para la inversa (sin escalar:
 * quien la use decide si divide por n, que es lo que hace el convenio de cada
 * códec).
 */
export function fft(re: Float64Array, im: Float64Array, sign: -1 | 1 = -1): void {
  const n = re.length;
  if (n <= 1) return;
  transform(re, im, 0, 1, n, sign, new Float64Array(n), new Float64Array(n));
}

/**
 * Cooley-Tukey recursivo con zancada: en vez de reordenar el array (que con
 * radix mixto es un lío de índices), se recorre con `stride` y se escribe el
 * resultado en buffers de trabajo. Es la versión que menos se equivoca.
 */
function transform(
  re: Float64Array,
  im: Float64Array,
  offset: number,
  stride: number,
  n: number,
  sign: number,
  tmpRe: Float64Array,
  tmpIm: Float64Array,
): void {
  if (n === 1) return;

  // Factor más pequeño que divida a n (y el cociente).
  let radix = n;
  for (const p of [2, 3, 5]) {
    if (n % p === 0) {
      radix = p;
      break;
    }
  }
  const m = n / radix;

  if (m > 1) {
    // Sub-transformadas de cada "columna".
    for (let r = 0; r < radix; r++) {
      transform(re, im, offset + r * stride, stride * radix, m, sign, tmpRe, tmpIm);
    }
  }

  // Combinación con los factores de giro.
  for (let k = 0; k < m; k++) {
    for (let q = 0; q < radix; q++) {
      let sumRe = 0;
      let sumIm = 0;
      for (let r = 0; r < radix; r++) {
        const idx = offset + (k * radix + r) * stride;
        const xr = re[idx]!;
        const xi = im[idx]!;
        // Giro de la sub-transformada más el de la mariposa, en un solo ángulo.
        const angle = (sign * 2 * Math.PI * ((r * k) / n + (r * q) / radix));
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        sumRe += xr * c - xi * s;
        sumIm += xr * s + xi * c;
      }
      tmpRe[k + q * m] = sumRe;
      tmpIm[k + q * m] = sumIm;
    }
  }
  for (let i = 0; i < n; i++) {
    re[offset + i * stride] = tmpRe[i]!;
    im[offset + i * stride] = tmpIm[i]!;
  }
}

/** DFT directa: la referencia contra la que se comprueba la rápida. */
export function dftNaive(
  re: readonly number[] | Float64Array,
  im: readonly number[] | Float64Array,
  sign: -1 | 1 = -1,
): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const angle = (sign * 2 * Math.PI * k * t) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sr += re[t]! * c - im[t]! * s;
      si += re[t]! * s + im[t]! * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}
