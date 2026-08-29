/**
 * Qué se compara en el golden, y por qué eso y no otra cosa.
 *
 * Un golden de audio puede compararse de dos maneras, y las dos tienen una
 * forma conocida de fallar:
 *
 * - **Hash bit a bit.** Muerde con todo: mueve un coeficiente en la última
 *   cifra y el hash cambia. Pero si el render no es reproducible entre
 *   plataformas, el hash rompe en la mitad de la CI, alguien le pone un
 *   `skip`, y a partir de ahí no protege nada mientras aparenta protegerlo.
 * - **Medidas agregadas con tolerancia.** No rompen por plataforma, pero si la
 *   tolerancia se elige a ojo pueden dejar pasar un cambio de sonido real.
 *
 * Aquí están LAS DOS, y ninguna es opcional, porque lo que las hace fiables no
 * es la elección sino la MEDIDA (ver `docs/GOLDEN.md` y `platform.ts`):
 *
 * 1. `hash` — sha256 de los bytes crudos de los dos Float32Array. Se compara
 *    siempre, en toda plataforma, sin condicional. Se pudo poner así porque se
 *    comprobó de verdad, no porque se supusiera: los 24 fixtures dan el MISMO
 *    hash en win32 y en linux, y además en tres versiones mayores de V8 (11,
 *    12 y 13). V8 no delega `Math.sin`/`cos`/`exp`/`pow`/`tanh` en la libm del
 *    sistema —usa su propio port de fdlibm, justamente para que el resultado
 *    no dependa del sistema operativo— y el resto del motor es aritmética
 *    IEEE-754 en un orden fijo. El experimento entero, con la única excepción
 *    que encontró (arm64), está en `platform.ts`. Si algún día aparece un
 *    runtime donde esto no se cumpla, la respuesta NO es saltar el test: es
 *    leer ese archivo, que explica qué hacer y qué no.
 * 2. `metrics` — una matriz de medidas perceptuales por ventana de tiempo,
 *    comparada con tolerancia. No está de adorno ni es un plan B: es lo que
 *    convierte un fallo de hash en un diagnóstico. Un hash que cambia solo
 *    dice «algo suena distinto»; las métricas dicen QUÉ y CUÁNTO —«el fixture
 *    del vinilo subió 0,4 dB en agudos a partir del segundo 2»—, y eso es lo
 *    que permite decidir en el momento si el diff de sonido se acepta o es un
 *    bug. Además cubre el caso en que el hash cambie por una razón que no es
 *    sonido (una versión de V8 que redondee distinto un `Math.pow`): si el
 *    hash cambia y las métricas no se mueven ni un ápice, el diff es numérico,
 *    no musical, y el mensaje del test lo dice.
 */

import { createHash } from 'node:crypto';
import { analyzeMix } from '../../src/render/analysis';

/** Ventanas de tiempo en las que se parte cada render para las métricas. */
export const WINDOWS = 8;

export interface WindowMetrics {
  lufs: number;
  peakDb: number;
  low: number;
  lowMid: number;
  highMid: number;
  high: number;
  corr: number;
}

export interface Fingerprint {
  /** sha256 de L‖R como bytes float32 little-endian. */
  hash: string;
  /** Muestras por canal. Un render que cambia de largo es un cambio de sonido. */
  samples: number;
  sampleRate: number;
  /** Medidas del render entero. */
  total: WindowMetrics;
  /** Las mismas medidas por ventana: es lo que ve el ENVOLVENTE en el tiempo. */
  windows: WindowMetrics[];
}

function metricsOf(left: Float32Array, right: Float32Array, sr: number): WindowMetrics {
  const m = analyzeMix(left, right, sr);
  return {
    lufs: m.lufsIntegrated,
    peakDb: m.peakDb,
    low: m.bands.low,
    lowMid: m.bands.lowMid,
    highMid: m.bands.highMid,
    high: m.bands.high,
    // `stereoCorrelation` divide por la energía: en una ventana de silencio
    // absoluto el numerador y el denominador son ambos ~0 y sale un valor sin
    // sentido (o NaN, que ni siquiera se puede comparar). El épsilon de
    // `analyzeMix` evita el NaN, pero no que el número baile; se ancla a 1
    // (mono perfecto, que es lo que es el silencio) por debajo del piso de 24
    // bits.
    corr: m.peakDb < -144 ? 1 : m.stereoCorrelation,
  };
}

/**
 * Bytes crudos de los dos canales, en float32 little-endian.
 *
 * Se serializa a MANO en vez de pasar el buffer del Float32Array al hash: el
 * `.buffer` de un Float32Array hereda el endianness de la máquina, y aunque
 * hoy todo lo que corre esto es little-endian, un hash que depende
 * silenciosamente de eso es exactamente el tipo de trampa que este archivo
 * existe para no dejar puesta.
 */
function rawBytes(left: Float32Array, right: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe((left.length + right.length) * 4);
  let off = 0;
  for (let i = 0; i < left.length; i++) { buf.writeFloatLE(left[i]!, off); off += 4; }
  for (let i = 0; i < right.length; i++) { buf.writeFloatLE(right[i]!, off); off += 4; }
  return buf;
}

export function fingerprint(left: Float32Array, right: Float32Array, sr: number): Fingerprint {
  const n = Math.min(left.length, right.length);
  const windows: WindowMetrics[] = [];
  // Las ventanas cubren el render entero sin solaparse y sin dejar hueco: el
  // reparto se hace por índice redondeado, no por un tamaño fijo, para que la
  // última no se quede corta ni se salga.
  for (let w = 0; w < WINDOWS; w++) {
    const from = Math.round((w * n) / WINDOWS);
    const to = Math.round(((w + 1) * n) / WINDOWS);
    windows.push(metricsOf(left.subarray(from, to), right.subarray(from, to), sr));
  }
  return {
    hash: createHash('sha256').update(rawBytes(left, right)).digest('hex'),
    samples: n,
    sampleRate: sr,
    total: metricsOf(left.subarray(0, n), right.subarray(0, n), sr),
    windows,
  };
}

// ── Comparación ──────────────────────────────────────────────────────────────

/**
 * Tolerancia de las métricas, en dB (las siete son dB o adimensionales en el
 * mismo orden de magnitud).
 *
 * La cifra sale de medir por los dos lados, no de elegir un número redondo.
 *
 * **Por abajo — el ruido que NO debe hacerla saltar.** Dos ejecuciones en la
 * misma máquina dan exactamente los mismos dígitos: Δ = 0. Entre plataformas
 * distintas (win32/linux, x64, V8 11/12/13) también: Δ = 0, porque el render
 * es idéntico bit a bit (ver `platform.ts`). El único desvío real medido está
 * en arm64, donde dos fixtures difieren: Δ máximo **1.9e-13 dB**. La
 * tolerancia queda once órdenes de magnitud por encima de eso.
 *
 * **Por arriba — el cambio que SÍ debe hacerla saltar.** Se perturbaron
 * coeficientes reales del motor, uno a uno, y se midió (el detalle está en
 * `docs/GOLDEN.md`):
 *
 *   perturbación                          hash        peor métrica
 *   ------------------------------------- ----------  ------------------
 *   ANTI_DENORMAL 1e-20 → 1e-19            7 fixtures  0 dB (nada)
 *   COEF_SMOOTH 5 ms → 6 ms                7 fixtures  0.017 dB
 *   guarda 0,2 % → 1 %                     2 fixtures  0.906 dB (33 medidas)
 *
 * Eso deja claro el reparto de papeles, y conviene no confundirlo: **el hash
 * es la capa sensible y las métricas son la capa que explica.** La primera
 * fila lo enseña — multiplicar por diez una constante anti-denormal mueve el
 * hash de siete fixtures y no mueve ni una métrica, porque efectivamente no
 * cambia el sonido. Si el golden fuera solo métricas, ese cambio pasaría; si
 * fuera solo hash, no habría forma de saber que era inofensivo.
 *
 * Y sí, la segunda fila (0,017 dB) está a menos de dos veces la tolerancia:
 * un cambio de sonido pequeño de verdad la roza. Bajarla no ayudaría —el
 * margen contra el ruido de arm64 sobra tanto que se podría bajar mil veces—
 * pero tampoco hace falta: ese cambio ya lo caza el hash con siete fixtures.
 * La tolerancia no está para detectar, está para no mentir sobre lo que
 * detectó el hash.
 */
export const METRIC_TOLERANCE_DB = 0.01;

export interface MetricDiff {
  where: string;
  key: keyof WindowMetrics;
  expected: number;
  actual: number;
  delta: number;
}

function diffMetrics(
  where: string,
  expected: WindowMetrics,
  actual: WindowMetrics,
  out: MetricDiff[],
): number {
  let worst = 0;
  for (const key of Object.keys(expected) as (keyof WindowMetrics)[]) {
    const e = expected[key];
    const a = actual[key];
    const delta = Math.abs(a - e);
    if (delta > worst) worst = delta;
    if (!(delta <= METRIC_TOLERANCE_DB)) out.push({ where, key, expected: e, actual: a, delta });
  }
  return worst;
}

export interface Comparison {
  hashMatches: boolean;
  lengthMatches: boolean;
  /** Solo las medidas que SE PASAN de la tolerancia. */
  metricDiffs: MetricDiff[];
  /** La peor de esas, para encabezar el informe. */
  worst: MetricDiff | null;
  /**
   * El mayor desvío de CUALQUIER medida, se pase o no de la tolerancia.
   * `metricDiffs` filtra por definición, así que sin esto no hay forma de
   * decir «se movió 0,0087 dB, justo por debajo del umbral» — y esa frase es
   * la diferencia entre «no se movió nada» y «casi salta».
   */
  worstDelta: number;
}

export function compare(expected: Fingerprint, actual: Fingerprint): Comparison {
  const metricDiffs: MetricDiff[] = [];
  const lengthMatches = expected.samples === actual.samples;
  let worstDelta = 0;
  if (lengthMatches) {
    worstDelta = diffMetrics('total', expected.total, actual.total, metricDiffs);
    const windows = Math.min(expected.windows.length, actual.windows.length);
    for (let w = 0; w < windows; w++) {
      const w2 = diffMetrics(
        `ventana ${w + 1}/${windows}`,
        expected.windows[w]!,
        actual.windows[w]!,
        metricDiffs,
      );
      if (w2 > worstDelta) worstDelta = w2;
    }
  }
  metricDiffs.sort((a, b) => b.delta - a.delta);
  return {
    hashMatches: expected.hash === actual.hash,
    lengthMatches,
    metricDiffs,
    worst: metricDiffs[0] ?? null,
    worstDelta,
  };
}

/**
 * El texto que ve quien rompió el golden.
 *
 * Está escrito para que la reacción por defecto sea MIRAR el diff, no
 * regenerar la línea base: dice qué cambió, cuánto, y separa el caso «el
 * sonido se movió» del caso «el sonido es el mismo y lo que se movió es el
 * último bit» — que son dos decisiones distintas y merecen dos mensajes
 * distintos.
 */
export function explain(name: string, covers: string, cmp: Comparison): string {
  const lines = [`Golden "${name}" (${covers}):`];
  if (!cmp.lengthMatches) {
    lines.push('  · el render cambió de LARGO. Eso es siempre un cambio de sonido.');
  }
  if (cmp.metricDiffs.length > 0) {
    lines.push(
      `  · ${cmp.metricDiffs.length} medida(s) fuera de tolerancia (${METRIC_TOLERANCE_DB} dB).` +
        ' El sonido cambió de verdad, no es ruido numérico:',
    );
    for (const d of cmp.metricDiffs.slice(0, 8)) {
      lines.push(
        `      ${d.where} · ${d.key}: ${d.expected.toFixed(3)} → ${d.actual.toFixed(3)}` +
          `  (Δ ${d.delta.toFixed(3)} dB)`,
      );
    }
    if (cmp.metricDiffs.length > 8) lines.push(`      … y ${cmp.metricDiffs.length - 8} más.`);
  } else if (!cmp.hashMatches) {
    lines.push(
      '  · el hash cambió pero NINGUNA medida se movió más de ' +
        `${METRIC_TOLERANCE_DB} dB. El sonido es el mismo a efectos prácticos y` +
        ' lo que cambió vive en los últimos bits.',
      '    Dos causas posibles, y hay que distinguirlas antes de tocar la línea base:',
      '      a) un cambio de motor que redondea distinto sin cambiar el sonido' +
        ' (reordenar una suma, sustituir una división por una multiplicación).',
      '      b) el runtime: otra versión de Node/V8 que evalúa distinto un' +
        ' Math.pow. Comprobalo corriendo el mismo test en el Node de la CI' +
        ' (24) antes de regenerar nada — ver docs/GOLDEN.md.',
    );
  }
  lines.push(
    '  Si el cambio de sonido es el que buscabas: `npm run golden:update`,' +
      ' y el commit tiene que decir QUÉ diff de sonido se aceptó.',
  );
  return lines.join('\n');
}
