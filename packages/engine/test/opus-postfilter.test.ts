/**
 * El postfiltro: el predictor de tono.
 *
 * Hay tres cosas que probar aquí, y sólo la primera es sobre el filtro:
 *
 * 1. **Que el par análisis/síntesis es exacto.** El codificador RESTA con un
 *    FIR sobre la entrada y el decodificador SUMA con un IIR sobre su propia
 *    salida. Que eso se cancele es la razón por la que este encoder NO necesita
 *    un decodificador dentro, y se demuestra aquí de la única forma que vale:
 *    montando los dos lados y comprobando que vuelve la señal.
 * 2. **Que el análisis de tono acierta**, y en particular que no se queda con
 *    la octava de abajo — que es el fallo caro, porque un peine al doble del
 *    período mete un diente entre cada dos parciales.
 * 3. **Que lo que se escribe en el paquete es lo que el codificador usa.** Se
 *    relee el paquete con el `RangeDecoder`, copiando el arranque de un
 *    decodificador de verdad, y se compara con el estado que le queda al
 *    codificador. Si la decisión se tomara fuera de la rama que la escribe, o
 *    si el codificador guardara lo que MIDIÓ en vez de lo que TRANSMITIÓ, aquí
 *    saldría la diferencia — y en el archivo no saldría ningún error, saldría
 *    un peine desafinado que se arrastra trama a trama.
 */

import { describe, expect, it } from 'vitest';
import {
  celtEncodeFrame,
  createCeltEncoder,
  OVERLAP,
  PREEMPH,
  SIG_SCALE,
  type CeltEncoderState,
} from '../src/render/opus/celt-encoder';
import { celtWindow } from '../src/render/opus/mdct';
import {
  COMBFILTER_MAXPERIOD,
  COMBFILTER_MINPERIOD,
  POSTFILTER_GAIN_STEP,
  combFilter,
  pitchAnalysis,
} from '../src/render/opus/postfilter';
import { RangeDecoder } from '../src/render/opus/range-coder';
import { TAPSET_ICDF } from '../src/render/opus/tables';

const N = 960;
const MAX = COMBFILTER_MAXPERIOD;

/** Ruido determinista. */
function ruido(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}

/**
 * Diente de sierra de `periodo` muestras: ocho armónicos.
 *
 * Un seno puro no sirve para probar el análisis de tono: el blanqueado de orden
 * 4 lo modela entero y deja el residuo a cero, que es justamente lo que hace un
 * LPC bien hecho. El tono se busca en señales con estructura armónica.
 */
function sierra(periodo: number): (i: number) => number {
  return (i) => {
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin((2 * Math.PI * k * i) / periodo) / k;
    return v;
  };
}

// ── 1. El par análisis/síntesis ─────────────────────────────────────────────

describe('el filtro de peine', () => {
  it('lo que quita el codificador lo devuelve el decodificador', () => {
    // Éste es EL test de la tarea. El codificador filtra sobre la señal de
    // entrada; el decodificador, sobre su propia salida. Son dos señales
    // distintas y aun así el lazo se cierra: si el residuo llega intacto, por
    // inducción la salida del decodificador es la entrada del codificador.
    // Por eso no hace falta meter un decodificador dentro del codificador —
    // basta con que los dos usen los MISMOS parámetros.
    const T = 240;
    const g = 0.46875;
    const onda = sierra(T);
    const x = new Float64Array(MAX + N);
    for (let i = 0; i < x.length; i++) x[i] = onda(i) * 8000;

    // Codificador: FIR sobre la entrada, ganancia negada.
    const residuo = new Float64Array(N);
    combFilter(residuo, 0, x, MAX, T, T, N, -g, -g, 1, 1, null, 0);

    // Decodificador: IIR sobre su propia salida, ganancia positiva. Su
    // historial es la señal RECONSTRUIDA de antes, que aquí es la original.
    const z = new Float64Array(MAX + N);
    z.set(x.subarray(0, MAX));
    z.set(residuo, MAX);
    combFilter(z, MAX, z, MAX, T, T, N, g, g, 1, 1, null, 0);

    for (let i = 0; i < N; i++) {
      expect(z[MAX + i]!, `muestra ${i}`).toBeCloseTo(x[MAX + i]!, 6);
    }
  });

  it('el error del residuo no se dispara al reinyectarlo', () => {
    // El IIR del decodificador realimenta, así que el ruido de cuantización
    // que le llega da vueltas por el lazo. Lo que hace que eso sea seguro es
    // que la ganancia está acotada muy por debajo de 1: el error crece por un
    // factor finito, no sin límite. Si el peine pudiera llegar a 1, un archivo
    // largo acabaría en oscilación.
    const T = 240;
    const g = POSTFILTER_GAIN_STEP * 8; // el tope del formato: qg = 7
    const onda = sierra(T);
    const x = new Float64Array(MAX + N);
    for (let i = 0; i < x.length; i++) x[i] = onda(i) * 8000;

    const residuo = new Float64Array(N);
    combFilter(residuo, 0, x, MAX, T, T, N, -g, -g, 1, 1, null, 0);

    const r = ruido(97);
    const sucio = new Float64Array(MAX + N);
    sucio.set(x.subarray(0, MAX));
    let energiaRuido = 0;
    for (let i = 0; i < N; i++) {
      const e = r() * 20;
      energiaRuido += e * e;
      sucio[MAX + i] = residuo[i]! + e;
    }
    combFilter(sucio, MAX, sucio, MAX, T, T, N, g, g, 1, 1, null, 0);

    let energiaError = 0;
    for (let i = 0; i < N; i++) {
      const d = sucio[MAX + i]! - x[MAX + i]!;
      energiaError += d * d;
    }
    // La cota teórica del lazo es `1/(1−g)²`, que con la ganancia máxima son
    // 8,9 dB. Se comprueba con margen: lo que importa es que sea FINITA.
    expect(energiaError / energiaRuido).toBeLessThan(1 / (1 - g) ** 2 + 1);
  });

  it('con las dos ganancias a cero es la identidad exacta', () => {
    const r = ruido(3);
    const x = new Float64Array(MAX + N);
    for (let i = 0; i < x.length; i++) x[i] = r() * 1000;
    const y = new Float64Array(N);
    combFilter(y, 0, x, MAX, 240, 300, N, 0, 0, 0, 2, celtWindow(OVERLAP), OVERLAP);
    for (let i = 0; i < N; i++) expect(y[i]).toBe(x[MAX + i]);
  });

  it('el cruce va de los parámetros viejos a los nuevos dentro del solape', () => {
    // Sin este cruce, cambiar de período entre dos tramas metería un salto.
    // Y el decodificador cruza IGUAL: hacerlo de otra forma sería separarse.
    const r = ruido(11);
    const x = new Float64Array(MAX + N);
    for (let i = 0; i < x.length; i++) x[i] = r() * 1000;
    const w = celtWindow(OVERLAP);
    const mezcla = new Float64Array(N);
    combFilter(mezcla, 0, x, MAX, 240, 300, N, 0.5, 0.5, 0, 0, w, OVERLAP);
    // Los dos extremos: sólo con los viejos y sólo con los nuevos.
    const viejo = new Float64Array(N);
    combFilter(viejo, 0, x, MAX, 240, 240, N, 0.5, 0.5, 0, 0, null, 0);
    const nuevo = new Float64Array(N);
    combFilter(nuevo, 0, x, MAX, 300, 300, N, 0.5, 0.5, 0, 0, null, 0);

    // Al principio del solape manda el viejo, al final el nuevo, y pasada la
    // zona de cruce sólo queda el nuevo.
    expect(Math.abs(mezcla[0]! - viejo[0]!)).toBeLessThan(Math.abs(mezcla[0]! - nuevo[0]!));
    const fin = OVERLAP - 1;
    expect(Math.abs(mezcla[fin]! - nuevo[fin]!)).toBeLessThan(Math.abs(mezcla[fin]! - viejo[fin]!));
    for (let i = OVERLAP; i < N; i++) expect(mezcla[i]!).toBeCloseTo(nuevo[i]!, 9);
  });
});

// ── 2. El análisis de tono ──────────────────────────────────────────────────

/** `pre` de un canal: historial + trama, con una señal continua. */
function preDe(muestra: (i: number) => number, frameSize = N): Float64Array {
  const pre = new Float64Array(MAX + frameSize);
  for (let i = 0; i < pre.length; i++) pre[i] = muestra(i) * 8000;
  return pre;
}

describe('el análisis de tono', () => {
  const scratch = new Float64Array((MAX + N) >> 1);

  it('encuentra el período de una señal periódica', () => {
    const pre = preDe(sierra(240));
    const { period, gain } = pitchAnalysis(pre, MAX + N, N, 1, 0, 0, scratch);
    expect(period).toBeGreaterThanOrEqual(239);
    expect(period).toBeLessThanOrEqual(241);
    expect(gain).toBeGreaterThan(0.5);
  });

  it('no se queda con la octava de abajo', () => {
    // La correlación en `2T` es tan alta como en `T`, y elegir `2T` no da un
    // error pequeño: da un peine con un diente de más entre cada dos
    // parciales, que reinyecta energía donde no hay nada.
    for (const T of [180, 240, 320, 400]) {
      const { period } = pitchAnalysis(preDe(sierra(T)), MAX + N, N, 1, 0, 0, scratch);
      expect(Math.abs(period - T), `período ${T} -> ${period}`).toBeLessThanOrEqual(2);
    }
  });

  it('no encuentra tono en el ruido', () => {
    const r = ruido(5);
    const { gain } = pitchAnalysis(preDe(() => r()), MAX + N, N, 1, 0, 0, scratch);
    // 0,2 es el umbral con el que el codificador enciende el peine.
    expect(gain).toBeLessThan(0.2);
  });

  it('nunca devuelve un período fuera de los límites del formato', () => {
    // Por debajo del mínimo el peine no existe, y por encima del máximo menos
    // dos se saldría del historial: `x[i − T − 2]` tiene que caber.
    const r = ruido(13);
    for (const señal of [sierra(30), sierra(900), () => r(), () => 0]) {
      const { period } = pitchAnalysis(preDe(señal), MAX + N, N, 1, 0, 0, scratch);
      expect(period).toBeGreaterThanOrEqual(COMBFILTER_MINPERIOD);
      expect(period).toBeLessThanOrEqual(COMBFILTER_MAXPERIOD - 2);
    }
  });

  it('con silencio digital no devuelve un no-número', () => {
    // La autocorrelación de una trama muda es cero por todas partes, y sin el
    // suelo del Levinson eso sería una división por cero que acabaría en un
    // `enc.uint` con un símbolo que no existe — o sea, un archivo que no abre.
    const { period, gain } = pitchAnalysis(preDe(() => 0), MAX + N, N, 1, 0, 0, scratch);
    expect(Number.isFinite(period)).toBe(true);
    expect(Number.isFinite(gain)).toBe(true);
    expect(gain).toBeLessThan(0.2);
  });
});

// ── 3. Lo que de verdad se escribe ──────────────────────────────────────────

interface Postfiltro {
  on: number;
  period: number;
  gain: number;
  tapset: number;
}

/**
 * Lee del paquete la bandera de silencio y el bloque del postfiltro.
 *
 * Es a propósito una copia del arranque de `celt_decode_with_ec`, con su misma
 * condición de presupuesto: el bloque sólo se lee si caben 16 bits contados
 * ANTES de la bandera de silencio, y el `tapset` sólo si caben 2 más. Si el
 * codificador tomara la decisión fuera de la rama que la escribe, lo que
 * saliera de aquí no sería lo que él usó.
 */
function leerPostfiltro(paquete: Uint8Array): Postfiltro {
  const dec = new RangeDecoder(paquete);
  const totalBits = paquete.length * 8;
  const tell = dec.tell();
  const silence = tell === 1 ? dec.bitLogp(15) : 0;
  const salida: Postfiltro = { on: 0, period: 0, gain: 0, tapset: 0 };
  if (silence) return salida;
  if (tell + 16 <= totalBits && dec.bitLogp(1)) {
    const octave = dec.uint(6);
    salida.period = (16 << octave) + dec.bits(4 + octave) - 1;
    const qg = dec.bits(3);
    if (dec.tell() + 2 <= totalBits) salida.tapset = dec.icdf(TAPSET_ICDF, 2);
    salida.gain = POSTFILTER_GAIN_STEP * (qg + 1);
    salida.on = 1;
  }
  return salida;
}

/** Codifica `tramas` tramas de una señal continua y devuelve los paquetes. */
function codificar(
  muestra: (i: number) => number,
  tramas: number,
  opciones: { channels?: number; bytes?: number; postfilter?: 'adaptive' | 'off' } = {},
): { estado: CeltEncoderState; paquetes: Uint8Array[] } {
  const channels = opciones.channels ?? 1;
  const estado = createCeltEncoder(channels);
  const paquetes: Uint8Array[] = [];
  const pcm = new Float64Array(N * channels);
  for (let t = 0; t < tramas; t++) {
    for (let i = 0; i < N; i++) {
      const v = muestra(t * N + i);
      for (let c = 0; c < channels; c++) pcm[i * channels + c] = v;
    }
    paquetes.push(
      celtEncodeFrame(estado, pcm, {
        frameSize: N,
        bytes: opciones.bytes ?? 159,
        postfilter: opciones.postfilter,
      }),
    );
  }
  return { estado, paquetes };
}

describe('la decisión llega al bitstream tal cual', () => {
  it('el peine se enciende con una señal tonal y no con ruido', () => {
    const tonal = codificar(sierra(240), 6);
    // La primera trama no puede: el historial del peine está a cero, así que no
    // hay de qué predecir. Se mira a partir de la tercera.
    expect(leerPostfiltro(tonal.paquetes[4]!).on).toBe(1);

    const r = ruido(21);
    const blanco = codificar(() => r() * 0.5, 6);
    for (const p of blanco.paquetes) expect(leerPostfiltro(p).on).toBe(0);
  });

  it('el período que se lee del paquete es el de la señal', () => {
    for (const T of [180, 240, 320]) {
      const { paquetes } = codificar(sierra(T), 6);
      const leido = leerPostfiltro(paquetes[4]!);
      expect(leido.on, `período ${T}`).toBe(1);
      expect(Math.abs(leido.period - T), `período ${T} -> ${leido.period}`).toBeLessThanOrEqual(2);
    }
  });

  it("con postfilter='off' no se enciende nunca", () => {
    const { paquetes } = codificar(sierra(240), 6, { postfilter: 'off' });
    for (const p of paquetes) expect(leerPostfiltro(p).on).toBe(0);
  });

  it('las dos rutas dan paquetes distintos: el peine se usa de verdad', () => {
    const con = codificar(sierra(240), 6);
    const sin = codificar(sierra(240), 6, { postfilter: 'off' });
    const iguales = con.paquetes.every(
      (p, i) => p.length === sin.paquetes[i]!.length && p.every((b, j) => b === sin.paquetes[i]![j]),
    );
    expect(iguales).toBe(false);
  });

  it('el estado que le queda al codificador es el que va a tener el decodificador', () => {
    // Ésta es la sincronía, escrita como invariante. Trama a trama:
    //
    // - la GANANCIA que guarda el codificador es exactamente la que sale del
    //   paquete — la reconstruida, no la medida;
    // - cuando el peine está encendido, también el período y el `tapset`.
    //
    // Cuando está apagado el codificador se queda con el período que midió y
    // el decodificador con cero, y eso NO es una divergencia: los dos entran
    // en la trama siguiente multiplicados por una ganancia de cero, así que el
    // filtro de los dos lados sale idéntico. Es lo mismo que hace la
    // referencia.
    const estado = createCeltEncoder(1);
    const onda = sierra(240);
    const pcm = new Float64Array(N);
    for (let t = 0; t < 10; t++) {
      // A mitad se cambia de nota, para que el período TENGA que moverse y el
      // cruce de parámetros se ejercite de verdad.
      const periodo = t < 5 ? 240 : 300;
      const w = sierra(periodo);
      for (let i = 0; i < N; i++) pcm[i] = (t < 5 ? onda : w)(t * N + i);
      const paquete = celtEncodeFrame(estado, pcm, { frameSize: N, bytes: 159 });
      const leido = leerPostfiltro(paquete);
      expect(estado.prefilterGain, `trama ${t}: ganancia`).toBeCloseTo(leido.gain, 12);
      if (leido.on) {
        expect(estado.prefilterPeriod, `trama ${t}: período`).toBe(leido.period);
        expect(estado.prefilterTapset, `trama ${t}: tapset`).toBe(leido.tapset);
      }
    }
  });

  it('una trama de silencio deja el peine apagado y el historial sincronizado', () => {
    // El decodificador, en una trama de silencio, no lee parámetros nuevos pero
    // SIGUE aplicando el peine con los de la anterior cruzándolo a cero. Si el
    // codificador se saltara ese paso, los dos historiales se separarían justo
    // en la trama siguiente — la misma forma del bug del silencio, por el otro
    // extremo.
    const estado = createCeltEncoder(1);
    const onda = sierra(240);
    const pcm = new Float64Array(N);
    for (let t = 0; t < 5; t++) {
      for (let i = 0; i < N; i++) pcm[i] = onda(t * N + i);
      celtEncodeFrame(estado, pcm, { frameSize: N, bytes: 159 });
    }
    expect(estado.prefilterGain).toBeGreaterThan(0);
    const anterior = Float64Array.from(estado.prefilterMem);

    pcm.fill(0);
    const paquete = celtEncodeFrame(estado, pcm, { frameSize: N, bytes: 159 });
    expect(leerPostfiltro(paquete).on).toBe(0);
    expect(estado.prefilterGain).toBe(0);
    expect(estado.prefilterPeriod).toBe(COMBFILTER_MINPERIOD);
    // Y el historial del peine ha AVANZADO: la trama muda entra en él como
    // cualquier otra. Si se hubiera saltado, el peine de la trama siguiente
    // predeciría desde muestras que el decodificador ya ha dejado atrás.
    let mismo = true;
    for (let i = 0; i < anterior.length; i++) {
      if (anterior[i] !== estado.prefilterMem[i]) mismo = false;
    }
    expect(mismo).toBe(false);
    // Cero a partir de la segunda muestra: la primera lleva la memoria del
    // pre-énfasis de la trama anterior, que no es silencio.
    for (let i = MAX - N + 1; i < MAX; i++) expect(estado.prefilterMem[i]).toBe(0);
  });

  it('el historial del peine guarda la señal SIN filtrar', () => {
    // Son dos memorias distintas y confundirlas sería predecir desde una señal
    // que el decodificador no tiene: la MDCT ve la señal filtrada, el peine
    // predice de la de entrada.
    const estado = createCeltEncoder(1);
    const onda = sierra(240);
    const pcm = new Float64Array(N);
    for (let t = 0; t < 4; t++) {
      for (let i = 0; i < N; i++) pcm[i] = onda(t * N + i);
      celtEncodeFrame(estado, pcm, { frameSize: N, bytes: 159 });
    }
    // Las últimas `N` muestras del historial son la última trama con
    // pre-énfasis y nada más. Se reconstruye aquí el pre-énfasis a mano.
    let mem = 0;
    const esperado = new Float64Array(N);
    for (let t = 0; t < 4; t++) {
      for (let i = 0; i < N; i++) {
        const x = onda(t * N + i) * SIG_SCALE;
        esperado[i] = x + mem;
        mem = -PREEMPH * x;
      }
    }
    for (let i = 0; i < N; i++) {
      expect(estado.prefilterMem[MAX - N + i]!, `muestra ${i}`).toBeCloseTo(esperado[i]!, 6);
    }
  });

  it('en tramas donde el bloque no cabe no se escribe nada', () => {
    // Con dos bytes no caben los 16 bits del bloque, y el decodificador da por
    // hecho que no hay postfiltro. Escribir el bit ahí descolocaría el paquete
    // entero; no escribirlo cuando el otro lo espera, también.
    const { paquetes } = codificar(sierra(240), 4, { bytes: 2 });
    for (const p of paquetes) expect(leerPostfiltro(p).on).toBe(0);
  });
});
