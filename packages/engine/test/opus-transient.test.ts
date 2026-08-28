/**
 * Los transitorios: detectar el golpe, repartir la resolución y —lo más
 * delicado— escribir la decisión en el sitio exacto del bitstream.
 *
 * Aquí se comprueban tres cosas distintas y conviene no mezclarlas:
 *
 * 1. **La decisión** (`transientAnalysis`, `tfAnalysis`): pura, sin bitstream.
 *    Que dispare donde tiene que disparar y no donde no.
 * 2. **Lo que se escribe**: se vuelve a LEER el paquete con el decodificador de
 *    rango, siguiendo el mismo orden que sigue un decodificador de verdad, y se
 *    comprueba que el bit que sale es el que el codificador usó. Ésta es la
 *    comprobación que cazaría la trampa del formato —decidir fuera de la rama
 *    que escribe—, porque ahí el bit dice una cosa y el encoder hizo otra.
 * 3. **El silencio**: que una trama a cero deje el estado de energía en el
 *    MISMO sitio donde lo deja el decodificador.
 *
 * Que el archivo lo abra alguien que no seamos nosotros lo comprueba
 * `tools/qa/opus-verify.ts`, y cuánto se gana, `tools/qa/opus-transient-ab.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  celtEncodeFrame,
  createCeltEncoder,
  OVERLAP,
  PREEMPH,
  SIG_SCALE,
  SILENT_ENERGY,
} from '../src/render/opus/celt-encoder';
import { RangeDecoder } from '../src/render/opus/range-coder';
import { OPUS_EBANDS } from '../src/render/opus/rate';
import { NB_BANDS, TF_SELECT_TABLE } from '../src/render/opus/tables';
import { tfAnalysis, transientAnalysis } from '../src/render/opus/transient';

const N = 960;
const LEN = N + OVERLAP;

/** El buffer que ve el detector: solape de la trama anterior + la trama. */
function buffer(muestra: (i: number) => number, channels = 1): Float64Array {
  const out = new Float64Array(LEN * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < LEN; i++) out[c * LEN + i] = muestra(i);
  }
  return out;
}

describe('el detector de ataque', () => {
  it('dispara con un click en mitad del silencio', () => {
    const golpe = LEN >> 1;
    const r = ruido(1);
    const x = buffer((i) => (i < golpe ? 0 : r() * Math.exp(-(i - golpe) / 72)));
    expect(transientAnalysis(x, LEN, 1).isTransient).toBe(true);
  });

  it('no dispara con un tono sostenido', () => {
    const x = buffer((i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    expect(transientAnalysis(x, LEN, 1).isTransient).toBe(false);
  });

  it('no dispara con ruido estacionario, que es el falso positivo fácil', () => {
    // Un detector que mirase «cuánto sube la energía» se dispararía aquí en
    // cuanto el ruido diera un pico. Éste mira si el golpe se tapa a sí mismo,
    // y el ruido continuo se tapa entero.
    const r = ruido(7);
    const x = buffer(() => r() * 0.4);
    expect(transientAnalysis(x, LEN, 1).isTransient).toBe(false);
  });

  it('no dispara con silencio absoluto', () => {
    expect(transientAnalysis(buffer(() => 0), LEN, 1).isTransient).toBe(false);
  });

  it('decide lo mismo a cualquier volumen', () => {
    // No es cosmético: la métrica es un COCIENTE entre la energía de la trama y
    // su propio umbral de enmascaramiento, así que si dependiera del volumen
    // sería que uno de los dos lados está mal calculado.
    const golpe = LEN >> 1;
    const r = ruido(3);
    const patron = (i: number) => (i < golpe ? 0 : r() * Math.exp(-(i - golpe) / 72));
    const flojo = transientAnalysis(buffer((i) => 1e-3 * patron(i)), LEN, 1);
    const r2 = ruido(3);
    const patron2 = (i: number) => (i < golpe ? 0 : r2() * Math.exp(-(i - golpe) / 72));
    const fuerte = transientAnalysis(buffer((i) => 1e4 * patron2(i)), LEN, 1);
    expect(flojo.isTransient).toBe(true);
    expect(fuerte.isTransient).toBe(true);
    expect(fuerte.metric).toBeCloseTo(flojo.metric, 6);
  });

  it('se queda con el canal que más golpea', () => {
    const golpe = LEN >> 1;
    const r = ruido(11);
    const x = new Float64Array(LEN * 2);
    for (let i = 0; i < LEN; i++) {
      x[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 48000);
      x[LEN + i] = i < golpe ? 0 : r() * Math.exp(-(i - golpe) / 72);
    }
    expect(transientAnalysis(x, LEN, 2).tfChan).toBe(1);
  });
});

describe('el reparto de resolución por banda', () => {
  const M = 8;
  const LM = 3;

  /** Bandas normalizadas de una trama de bloques cortos, ya intercaladas. */
  function bandas(valor: (banda: number, bin: number, sub: number) => number): Float64Array {
    const x = new Float64Array(N);
    for (let i = 0; i < NB_BANDS; i++) {
      for (let k = OPUS_EBANDS[i]!; k < OPUS_EBANDS[i + 1]!; k++) {
        for (let b = 0; b < M; b++) x[k * M + b] = valor(i, k, b);
      }
    }
    return x;
  }

  it('un golpe metido en un solo sub-bloque conserva la resolución temporal', () => {
    // Toda la energía en el sub-bloque 3: recombinar hacia frecuencia
    // repartiría ese golpe por los ocho, que es justo el pre-eco.
    const x = bandas((_i, _k, b) => (b === 3 ? 1 : 0));
    const { tfRes, tfSelect } = tfAnalysis(x, OPUS_EBANDS, NB_BANDS, 1, LM, N, 0, 0.5);
    const fila = TF_SELECT_TABLE[LM]!;
    for (let i = 1; i < NB_BANDS; i++) {
      expect(fila[4 + 2 * tfSelect + tfRes[i]!]).toBeLessThanOrEqual(0);
    }
  });

  it('un tono estable manda recombinar los sub-bloques hacia frecuencia', () => {
    // El mismo bin en los ocho sub-bloques es un seno que no se mueve: ahí la
    // resolución temporal no describe nada y la de frecuencia sí.
    const x = bandas((i, k) => (k === OPUS_EBANDS[i]! ? 1 : 0));
    const { tfRes, tfSelect } = tfAnalysis(x, OPUS_EBANDS, NB_BANDS, 1, LM, N, 0, 0);
    const fila = TF_SELECT_TABLE[LM]!;
    let recombinan = 0;
    for (let i = 0; i < NB_BANDS; i++) {
      if (fila[4 + 2 * tfSelect + tfRes[i]!]! > 0) recombinan++;
    }
    expect(recombinan).toBeGreaterThan(NB_BANDS / 2);
  });

  it('en tramas de bloque largo nunca pide recombinar (no hay qué recombinar)', () => {
    // Con `isTransient=0` la tabla sólo da 0 o negativos: pedir un valor
    // positivo dejaría `blocks` en cero dentro del PVQ y eso no es un error,
    // es un bucle infinito.
    const r = ruido(5);
    const x = bandas(() => r());
    const { tfRes, tfSelect } = tfAnalysis(x, OPUS_EBANDS, NB_BANDS, 0, LM, N, 0, 0);
    const fila = TF_SELECT_TABLE[LM]!;
    expect(tfSelect).toBe(0);
    for (let i = 0; i < NB_BANDS; i++) {
      expect(fila[0 + 2 * tfSelect + tfRes[i]!]).toBeLessThanOrEqual(0);
    }
  });
});

// ── Lo que de verdad se escribe ─────────────────────────────────────────────

/**
 * Lee del paquete los tres primeros elementos, en el orden del formato.
 *
 * Es a propósito una copia del arranque de un decodificador: si el codificador
 * decidiera el transitorio FUERA de la rama que lo escribe, aquí saldría un bit
 * que no corresponde con lo que hizo, y todo lo que viene detrás se leería
 * corrido sin dar ningún error.
 */
function leerBanderas(paquete: Uint8Array): { silence: number; isTransient: number } {
  const dec = new RangeDecoder(paquete);
  const totalBits = paquete.length * 8;
  const silence = dec.tell() === 1 ? dec.bitLogp(15) : 0;
  if (silence) return { silence, isTransient: 0 };
  if (dec.tell() + 16 <= totalBits) dec.bitLogp(1);
  const isTransient = dec.tell() + 3 <= totalBits ? dec.bitLogp(3) : 0;
  return { silence, isTransient };
}

/** PCM de una trama: silencio y luego un golpe seco. */
function golpeSeco(): Float64Array {
  const pcm = new Float64Array(N);
  const r = ruido(23);
  for (let i = N >> 1; i < N; i++) pcm[i] = r() * 0.8 * Math.exp(-(i - (N >> 1)) / 72);
  return pcm;
}

describe('la decisión llega al bitstream tal cual', () => {
  it('el bit que se lee del paquete es el que el codificador usó', () => {
    const pcm = golpeSeco();

    // El mismo troceado y el mismo pre-énfasis que hace el codificador, para
    // preguntarle al detector exactamente lo que el codificador le preguntó.
    const analisis = new Float64Array(LEN);
    let mem = 0;
    for (let i = 0; i < N; i++) {
      const x = pcm[i]! * SIG_SCALE;
      analisis[OVERLAP + i] = x + mem;
      mem = -PREEMPH * x;
    }
    expect(transientAnalysis(analisis, LEN, 1).isTransient).toBe(true);

    const conDeteccion = celtEncodeFrame(createCeltEncoder(1), pcm, { frameSize: N, bytes: 159 });
    expect(leerBanderas(conDeteccion).isTransient).toBe(1);

    const sinDeteccion = celtEncodeFrame(createCeltEncoder(1), pcm, {
      frameSize: N,
      bytes: 159,
      transient: 'off',
    });
    expect(leerBanderas(sinDeteccion).isTransient).toBe(0);
  });

  it('un tono sostenido no gasta el camino de bloque corto', () => {
    // El tono se genera CONTINUO entre las dos tramas. Repetir el mismo bloque
    // no valdría: 960 muestras no son un número entero de periodos de 440 Hz,
    // así que en la costura habría un salto de fase —y un salto de fase es un
    // click de verdad, que el detector hace bien en cazar.
    const estado = createCeltEncoder(1);
    const trama = (n: number): Float64Array => {
      const pcm = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        pcm[i] = 0.4 * Math.sin((2 * Math.PI * 440 * (n * N + i)) / 48000);
      }
      return pcm;
    };
    // La primera arranca desde silencio y sí es un ataque; se mira la tercera,
    // que ya viene de tono por los dos lados.
    celtEncodeFrame(estado, trama(0), { frameSize: N, bytes: 159 });
    celtEncodeFrame(estado, trama(1), { frameSize: N, bytes: 159 });
    const tercera = celtEncodeFrame(estado, trama(2), { frameSize: N, bytes: 159 });
    expect(leerBanderas(tercera).isTransient).toBe(0);
  });

  it('las dos rutas dan paquetes distintos: el bloque corto se usa de verdad', () => {
    const pcm = golpeSeco();
    const corto = celtEncodeFrame(createCeltEncoder(1), pcm, { frameSize: N, bytes: 159 });
    const largo = celtEncodeFrame(createCeltEncoder(1), pcm, {
      frameSize: N,
      bytes: 159,
      transient: 'off',
    });
    expect(Buffer.from(corto).equals(Buffer.from(largo))).toBe(false);
  });

  it('a 2,5 ms no hay transitorio posible y no se escribe el bit', () => {
    // Con LM=0 la trama YA es un sub-bloque: no hay nada que partir, y el
    // formato ni siquiera transmite el campo.
    const pcm = new Float64Array(120);
    const r = ruido(29);
    for (let i = 60; i < 120; i++) pcm[i] = r() * 0.8;
    const paquete = celtEncodeFrame(createCeltEncoder(1), pcm, { frameSize: 120, bytes: 39 });
    expect(paquete.length).toBe(39);
  });
});

describe('la trama de silencio deja el estado donde lo deja el decodificador', () => {
  it('marca silencio y no escribe nada más', () => {
    const estado = createCeltEncoder(1);
    const paquete = celtEncodeFrame(estado, new Float64Array(N), { frameSize: N, bytes: 159 });
    expect(leerBanderas(paquete).silence).toBe(1);
  });

  it('todas las bandas quedan en el suelo que pone el decodificador', () => {
    // El decodificador (libopus y ffmpeg) pone −28 en TODAS las bandas al leer
    // la bandera. Si el codificador se quedara con las energías de verdad, la
    // predicción de las tramas siguientes partiría de dos sitios distintos y el
    // golpe que viene después del silencio volvería con el nivel cambiado.
    const estado = createCeltEncoder(1);
    // Primero algo con contenido, para que `oldBandE` no esté ya a cero.
    const tono = new Float64Array(N);
    for (let i = 0; i < N; i++) tono[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    celtEncodeFrame(estado, tono, { frameSize: N, bytes: 159 });
    expect(estado.oldBandE.some((v) => v !== SILENT_ENERGY)).toBe(true);

    celtEncodeFrame(estado, new Float64Array(N), { frameSize: N, bytes: 159 });
    for (const v of estado.oldBandE) expect(v).toBe(SILENT_ENERGY);
  });

  it('el historial de solape sigue avanzando aunque la trama sea silencio', () => {
    // La trama de silencio no escribe, pero el análisis de la SIGUIENTE sí
    // necesita saber que lo de antes era silencio.
    const estado = createCeltEncoder(1);
    const tono = new Float64Array(N);
    for (let i = 0; i < N; i++) tono[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    celtEncodeFrame(estado, tono, { frameSize: N, bytes: 159 });
    celtEncodeFrame(estado, new Float64Array(N), { frameSize: N, bytes: 159 });
    for (const v of estado.history) expect(v).toBe(0);
  });
});

/** PRNG determinista: el mismo test tiene que dar el mismo número siempre. */
function ruido(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}
