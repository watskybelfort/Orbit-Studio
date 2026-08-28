/**
 * La medida perceptual del banco de calidad Opus, puesta a prueba.
 *
 * Estos tests no codifican nada ni llaman a ffmpeg: construyen a mano los casos
 * en los que la SNR es DEMOSTRABLEMENTE ciega y comprueban que la medida nueva
 * no lo es. Ése es el criterio con el que se aceptó: no «da un número bonito»,
 * sino «separa dos cosas que la SNR da por idénticas y el oído no».
 *
 * Los dos puntos ciegos que se prueban aquí son exactamente los dos por los que
 * la dispersión adaptativa se quedó sin decidir en la v3.4:
 *
 * 1. **Reparto del error DENTRO de la banda.** Mismo error total, repartido
 *    denso o concentrado en cuatro pulsos. Es lo que hace la rotación de
 *    dispersión del PVQ, que es ortogonal y por tanto no cambia la norma.
 * 2. **Dónde cae el error respecto al enmascarador.** Mismo error total, una
 *    vez pegado al tono que lo tapa y otra lejos, donde no hay nada que lo tape.
 */

import { describe, expect, it } from 'vitest';
import { patronDb, snrDb } from '../../../tools/qa/opus-metrics';

const SR = 48000;

/** PRNG determinista: el test tiene que dar lo mismo en cada máquina. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}

/** Gaussiana por suma de uniformes: sobra para lo que hace falta aquí. */
function gaussiana(r: () => number): number {
  return (r() + r() + r() + r()) * 0.5;
}

function normalizar(v: Float64Array): Float64Array {
  let e = 0;
  for (const x of v) e += x * x;
  const g = 1 / Math.sqrt(e);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * g;
  return v;
}

function producto(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Sintetiza una banda a partir de sus coeficientes: un seno por bin, con la
 * misma fase en todas las versiones.
 *
 * Que las fases se compartan es lo que hace justo el experimento: los senos son
 * ortogonales en el intervalo, así que la energía del error en el tiempo es la
 * misma que la del error en los coeficientes. Dos reconstrucciones con la misma
 * distancia al original en coeficientes tienen, exactamente, la misma SNR.
 */
function sintetizar(
  coef: Float64Array,
  fases: Float64Array,
  f0: number,
  df: number,
  muestras: number,
  amplitud: number,
): Float64Array {
  const out = new Float64Array(muestras);
  for (let i = 0; i < coef.length; i++) {
    const c = coef[i]! * amplitud;
    if (c === 0) continue;
    const w = (2 * Math.PI * (f0 + i * df)) / SR;
    const p = fases[i]!;
    for (let n = 0; n < muestras; n++) out[n] = out[n]! + c * Math.sin(w * n + p);
  }
  return out;
}

function seno(f: number, amplitud: number, muestras: number, fase = 0): Float64Array {
  const out = new Float64Array(muestras);
  const w = (2 * Math.PI * f) / SR;
  for (let n = 0; n < muestras; n++) out[n] = amplitud * Math.sin(w * n + fase);
  return out;
}

function sumar(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + b[i]!;
  return out;
}

describe('la medida perceptual del banco Opus', () => {
  it('da infinito cuando la copia es el original', () => {
    const x = seno(1000, 0.4, SR / 2);
    expect(patronDb(x, x, SR, 0)).toBe(Infinity);
  });

  it('empeora cuanto más ruido se añade', () => {
    const muestras = SR / 2;
    const limpio = sintetizarMezcla(muestras);
    const r = rng(4242);
    const conPoco = new Float64Array(muestras);
    const conMucho = new Float64Array(muestras);
    for (let i = 0; i < muestras; i++) {
      const ruido = r();
      conPoco[i] = limpio[i]! + ruido * 0.002;
      conMucho[i] = limpio[i]! + ruido * 0.02;
    }
    const poco = patronDb(limpio, conPoco, SR, 0);
    const mucho = patronDb(limpio, conMucho, SR, 0);
    expect(poco).toBeGreaterThan(mucho);
    expect(mucho).toBeGreaterThan(0);
  });

  /**
   * El punto ciego número uno, y el que desbloquea la dispersión.
   *
   * `esparcida` es lo que sale de un PVQ sin rotación de dispersión: se quedan
   * los K bins más grandes y el resto va a cero. `densa` tiene EXACTAMENTE la
   * misma distancia al original —se construye para que su producto escalar con
   * la referencia sea el mismo—, pero repartida por toda la banda.
   *
   * Para la SNR son el mismo archivo. Para el oído, uno es ruido de banda ancha
   * (que es lo que era) y el otro son doce silbidos sueltos.
   */
  it('separa el mismo error repartido de forma distinta dentro de la banda', () => {
    const N = 96; // los 96 bins de la banda 18 de CELT en una trama de 20 ms
    const F0 = 9600;
    const DF = 25;
    const K = 12;
    const muestras = SR / 2;
    const r = rng(20260828);

    const referencia = normalizar(Float64Array.from({ length: N }, () => gaussiana(r)));
    const fases = Float64Array.from({ length: N }, () => r() * Math.PI);

    // Esparcida: los K bins de mayor magnitud, el resto a cero, renormalizada.
    const orden = [...referencia.keys()].sort(
      (a, b) => Math.abs(referencia[b]!) - Math.abs(referencia[a]!),
    );
    const esparcida = new Float64Array(N);
    for (let i = 0; i < K; i++) esparcida[orden[i]!] = referencia[orden[i]!]!;
    normalizar(esparcida);
    const c = producto(referencia, esparcida);

    // Densa: la misma correlación con la referencia (⇒ el mismo error) pero
    // con la parte de error extendida por toda la banda.
    const ortogonal = Float64Array.from({ length: N }, () => gaussiana(r));
    const proyeccion = producto(ortogonal, referencia);
    for (let i = 0; i < N; i++) ortogonal[i] = ortogonal[i]! - proyeccion * referencia[i]!;
    normalizar(ortogonal);
    const densa = new Float64Array(N);
    const beta = Math.sqrt(Math.max(0, 1 - c * c));
    for (let i = 0; i < N; i++) densa[i] = c * referencia[i]! + beta * ortogonal[i]!;

    const A = 0.15;
    const orig = sintetizar(referencia, fases, F0, DF, muestras, A);
    const sinDispersion = sintetizar(esparcida, fases, F0, DF, muestras, A);
    const conDispersion = sintetizar(densa, fases, F0, DF, muestras, A);

    const snrEsparcida = snrDb(orig, sinDispersion, 0);
    const snrDensa = snrDb(orig, conDispersion, 0);
    // La construcción garantiza el mismo error: si esto se separa, el
    // experimento está mal montado y lo que venga detrás no vale.
    expect(Math.abs(snrEsparcida - snrDensa)).toBeLessThan(0.1);

    const percepEsparcida = patronDb(orig, sinDispersion, SR, 0);
    const percepDensa = patronDb(orig, conDispersion, SR, 0);
    // Y aquí es donde la medida nueva se gana el sitio. Medido: la SNR las
    // separa 0,03 dB y la de patrón 8,05 dB (8,82 contra 16,88). El listón se
    // deja en 4 para que no se rompa por un cambio de redondeo.
    expect(percepDensa - percepEsparcida).toBeGreaterThan(4);
  });

  /**
   * El punto ciego número dos: la SNR no sabe qué hay tapando el error.
   *
   * Mismo error, mismo tamaño. Una vez a 50 Hz del tono que lo enmascara y otra
   * a 8 kHz, donde no hay absolutamente nada. Al oído no se parecen en nada.
   */
  it('separa el error enmascarado del que no lo está', () => {
    const muestras = SR / 2;
    const tono = seno(1000, 0.5, muestras);
    const error = 0.5 * 10 ** (-30 / 20); // 30 dB por debajo del tono
    const cerca = sumar(tono, seno(1050, error, muestras, 0.7));
    const lejos = sumar(tono, seno(8000, error, muestras, 0.7));

    const snrCerca = snrDb(tono, cerca, 0);
    const snrLejos = snrDb(tono, lejos, 0);
    expect(Math.abs(snrCerca - snrLejos)).toBeLessThan(0.5);

    const percepCerca = patronDb(tono, cerca, SR, 0);
    const percepLejos = patronDb(tono, lejos, SR, 0);
    // Medido: la SNR da 30,0043 dB por los dos lados —idéntica hasta el
    // decimotercer decimal— y la de patrón 56,22 contra 15,79.
    expect(percepCerca - percepLejos).toBeGreaterThan(20);
  });
});

/** Algo con contenido en todo el espectro, para el test de monotonía. */
function sintetizarMezcla(muestras: number): Float64Array {
  const out = new Float64Array(muestras);
  const parciales = [110, 220, 330, 440, 880, 1760, 3520, 7040, 11000];
  for (let k = 0; k < parciales.length; k++) {
    const w = (2 * Math.PI * parciales[k]!) / SR;
    const a = 0.25 / (k + 1);
    for (let n = 0; n < muestras; n++) out[n] = out[n]! + a * Math.sin(w * n + k);
  }
  return out;
}
