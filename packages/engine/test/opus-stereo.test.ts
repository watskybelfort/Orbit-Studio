/**
 * El estéreo del reparto: intensidad y estéreo dual.
 *
 * Tres cosas, y la tercera es la que importa:
 *
 * 1. **Los escalones por bitrate** son los de la referencia. Un número mal
 *    copiado aquí no rompe nada: sólo hace que el encoder ahorre donde no debía.
 * 2. **La puerta que mira la señal** hace lo que dice: deja pasar la intensidad
 *    donde la diferencia entre canales no se oye y la frena donde sí. Se prueba
 *    con los dos extremos construidos a mano —canales pegados y canales
 *    independientes— porque en esos dos casos la respuesta correcta se sabe.
 * 3. **Que lo que se escribe en el paquete es lo que el codificador usa.** Se
 *    relee el paquete con el `RangeDecoder`, recorriendo la cabecera en el orden
 *    del formato hasta el asignador de bits, y se compara con el valor que se
 *    puede predecir. Si la decisión se tomara en un sitio y se escribiera otra,
 *    aquí saldría la diferencia — y en el archivo no saldría ningún error, sólo
 *    dos lados repartiendo bits de forma distinta.
 *
 * Lo tercero es la razón de ser de este archivo. El símbolo de intensidad no es
 * una bandera: es un número que el asignador puede RECORTAR a `codedBands` antes
 * de escribirlo, y el codificador tiene que quedarse con el recortado, no con el
 * que pidió. Por eso se lee del paquete y no de una variable del encoder.
 */

import { describe, expect, it } from 'vitest';
import { celtEncodeFrame, createCeltEncoder } from '../src/render/opus/celt-encoder';
import { OPUS_EBANDS } from '../src/render/opus/rate';
import {
  bitrateEfectivo,
  intensityBand,
  intensityBandForFrame,
  stereoAnalysis,
  UMBRAL_DIFERENCIA,
  type StereoMode,
} from '../src/render/opus/stereo';
import { NB_BANDS } from '../src/render/opus/tables';
import {
  crearEstadoLector,
  leerCabeceraCelt,
  type CabeceraCelt,
} from '../../../tools/qa/opus-celt-header';

const N = 960;
const LM = 3;

/** Ruido determinista. */
function ruido(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}

/**
 * Codifica `tramas` tramas estéreo y devuelve lo que el decodificador lee de
 * cada una.
 *
 * El estado del lector se arrastra igual que en un decodificador de verdad: la
 * energía gruesa se predice de la trama anterior, así que leer una trama suelta
 * del medio no daría lo mismo.
 */
function cabeceras(
  muestra: (i: number, canal: number) => number,
  tramas: number,
  bytes: number,
  modo: StereoMode,
): CabeceraCelt[] {
  const estado = createCeltEncoder(2);
  const lector = crearEstadoLector(2);
  const pcm = new Float64Array(N * 2);
  const salida: CabeceraCelt[] = [];
  for (let t = 0; t < tramas; t++) {
    for (let i = 0; i < N; i++) {
      pcm[i * 2] = muestra(t * N + i, 0);
      pcm[i * 2 + 1] = muestra(t * N + i, 1);
    }
    const trama = celtEncodeFrame(estado, pcm, { frameSize: N, bytes, stereo: modo });
    salida.push(leerCabeceraCelt(trama, lector, LM, 2));
  }
  return salida;
}

// ── Señales con la respuesta conocida ───────────────────────────────────────

/**
 * Canales pegados y nada por encima de 1 kHz.
 *
 * Las bandas agudas quedan vacías: ahí la intensidad no tira NADA, así que la
 * puerta tiene que dejar el corte donde lo puso el bitrate.
 */
function pegados(i: number, canal: number): number {
  const t = i / 48000;
  const v =
    0.3 * Math.sin(2 * Math.PI * 220 * t) +
    0.15 * Math.sin(2 * Math.PI * 440 * t) +
    0.08 * Math.sin(2 * Math.PI * 660 * t);
  return canal === 0 ? v : v * 0.8;
}

/**
 * Dos canales de ruido INDEPENDIENTE, con la misma energía.
 *
 * Es el caso contrario: toda la energía de la trama está en la diferencia entre
 * canales. La intensidad tiraría media señal y el mid/side no ahorra nada.
 */
function independientes(): (i: number, canal: number) => number {
  // Generadores nuevos en cada llamada: si se compartieran entre pruebas, cada
  // una vería un trozo distinto del ruido y los números dejarían de repetirse.
  const izq = ruido(11);
  const der = ruido(97);
  return (_i, canal) => (canal === 0 ? izq() : der()) * 0.4;
}

describe('los escalones por bitrate', () => {
  it('el bitrate efectivo sale en kb/s', () => {
    // 160 bytes por trama de 20 ms son 64 kb/s brutos; menos los 80 bits de la
    // energía gruesa, 60.
    expect(bitrateEfectivo(160, 3)).toBe(60);
    expect(bitrateEfectivo(320, 3)).toBe(124);
    expect(bitrateEfectivo(80, 3)).toBe(28);
  });

  it('los cortes son los de la referencia', () => {
    const corte = (bytes: number) => intensityBand(bytes, 3, 0, 21);
    expect(corte(80)).toBe(8); // 28 kb/s
    expect(corte(120)).toBe(12); // 44
    expect(corte(160)).toBe(16); // 60
    expect(corte(200)).toBe(18); // 78
    expect(corte(240)).toBe(19); // 92
    expect(corte(320)).toBe(20); // 124
    expect(corte(400)).toBe(21); // 158: apagada
  });

  it('nunca se sale del rango de bandas pedido', () => {
    expect(intensityBand(80, 3, 0, 5)).toBe(5);
    expect(intensityBand(400, 3, 0, 21)).toBe(21);
  });
});

describe('la puerta que mira la señal', () => {
  const ebands = OPUS_EBANDS;

  /** Monta unas bandas normalizadas con la correlación que se pida por banda. */
  function montar(rhoPorBanda: (b: number) => number, energia: (b: number) => number): {
    shape: Float64Array;
    bandE: Float64Array;
  } {
    const m = 1 << LM;
    const shape = new Float64Array(N * 2);
    const bandE = new Float64Array(NB_BANDS * 2);
    const r = ruido(5);
    for (let b = 0; b < NB_BANDS; b++) {
      const desde = m * ebands[b]!;
      const hasta = m * ebands[b + 1]!;
      const rho = rhoPorBanda(b);
      // Se construye el derecho como `ρ·izquierdo + √(1−ρ²)·independiente`, que
      // da exactamente la correlación pedida, y se normaliza cada canal a 1.
      const izq = new Float64Array(hasta - desde);
      const ind = new Float64Array(hasta - desde);
      for (let k = 0; k < izq.length; k++) {
        izq[k] = r();
        ind[k] = r();
      }
      const norma = (v: Float64Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      const nIzq = norma(izq);
      const nInd = norma(ind);
      for (let k = 0; k < izq.length; k++) {
        izq[k] = izq[k]! / nIzq;
        ind[k] = ind[k]! / nInd;
      }
      const der = new Float64Array(izq.length);
      for (let k = 0; k < izq.length; k++) {
        der[k] = rho * izq[k]! + Math.sqrt(Math.max(0, 1 - rho * rho)) * ind[k]!;
      }
      const nDer = norma(der);
      for (let k = 0; k < izq.length; k++) {
        shape[desde + k] = izq[k]!;
        shape[N + desde + k] = der[k]! / nDer;
      }
      bandE[b] = energia(b);
      bandE[b + NB_BANDS] = energia(b);
    }
    return { shape, bandE };
  }

  it('con los canales pegados, el corte se queda donde lo puso el bitrate', () => {
    const { shape, bandE } = montar(() => 1, () => 1);
    expect(
      intensityBandForFrame(shape, bandE, ebands, NB_BANDS, NB_BANDS, LM, N, 16),
    ).toBe(16);
  });

  it('con las bandas agudas vacías, también: no hay nada que tirar', () => {
    const { shape, bandE } = montar(
      (b) => (b >= 16 ? 0 : 1),
      (b) => (b >= 16 ? 1e-6 : 1),
    );
    expect(
      intensityBandForFrame(shape, bandE, ebands, NB_BANDS, NB_BANDS, LM, N, 16),
    ).toBe(16);
  });

  it('con los canales independientes y sonando, la puerta la apaga entera', () => {
    const { shape, bandE } = montar(() => 0, () => 1);
    expect(
      intensityBandForFrame(shape, bandE, ebands, NB_BANDS, NB_BANDS, LM, N, 16),
    ).toBe(NB_BANDS);
  });

  it('para en la primera banda que pida más de lo que hay', () => {
    // Sólo la banda 18 lleva diferencia entre canales; las 19 y 20, no. El corte
    // tiene que quedarse en 19: por encima es gratis, en la 18 no.
    const { shape, bandE } = montar((b) => (b === 18 ? -1 : 1), () => 1);
    expect(
      intensityBandForFrame(shape, bandE, ebands, NB_BANDS, NB_BANDS, LM, N, 16),
    ).toBe(19);
  });

  it('el umbral por defecto está en la meseta que salió del banco', () => {
    expect(UMBRAL_DIFERENCIA).toBeGreaterThan(0);
    expect(UMBRAL_DIFERENCIA).toBeLessThan(0.02);
  });
});

describe('el estéreo dual', () => {
  // La comparación es de normas L1, y el giro a mid/side conserva la L2, no la
  // L1: para un par `(l, r)` la L1 girada vale `√2·max(|l|,|r|)` y la sin girar
  // `|l|+|r|`. Así que el giro sale caro justo cuando en cada coeficiente manda
  // un canal y el otro calla — que es lo que pasa con dos fuentes distintas.
  it('con los canales pegados no se enciende: el mid/side sale más barato', () => {
    const shape = new Float64Array(N * 2);
    const r = ruido(3);
    for (let i = 0; i < N; i++) {
      const v = r();
      shape[i] = v;
      shape[N + i] = v;
    }
    expect(stereoAnalysis(shape, OPUS_EBANDS, LM, N)).toBe(false);
  });

  it('con el contenido repartido entre los dos canales, sí', () => {
    // Cada coeficiente suena en un canal y calla en el otro: el mid y el side
    // salen los dos llenos y hay que pagarlos dos veces.
    const shape = new Float64Array(N * 2);
    const r = ruido(3);
    for (let i = 0; i < N; i++) {
      const v = r();
      if (i % 2 === 0) shape[i] = v;
      else shape[N + i] = v;
    }
    expect(stereoAnalysis(shape, OPUS_EBANDS, LM, N)).toBe(true);
  });

  it('el margen es estrecho, y por eso depende de la señal y no del ruido', () => {
    // Con dos canales independientes la decisión se juega en el 4 % —333 contra
    // 320—, así que el resultado depende de cómo se reparta la amplitud. Con
    // muestras uniformes el cociente sale 0,94 y no se enciende; con
    // coeficientes de MDCT, que salen gaussianos, sale 1,00 y sí. No es una
    // ambigüedad del código: es lo que mide la referencia.
    const shape = new Float64Array(N * 2);
    const a = ruido(3);
    const b = ruido(1234);
    for (let i = 0; i < N; i++) {
      shape[i] = a();
      shape[N + i] = b();
    }
    expect(stereoAnalysis(shape, OPUS_EBANDS, LM, N)).toBe(false);

    // Los mismos dos canales independientes, pero gaussianos.
    const gauss = new Float64Array(N * 2);
    const suma = (r: () => number) => {
      let v = 0;
      for (let k = 0; k < 12; k++) v += r();
      return v;
    };
    for (let i = 0; i < N; i++) {
      gauss[i] = suma(a);
      gauss[N + i] = suma(b);
    }
    expect(stereoAnalysis(gauss, OPUS_EBANDS, LM, N)).toBe(true);
  });
});

describe('la decisión llega al bitstream tal cual', () => {
  // 239 bytes de trama CELT son 96 kb/s: el escalón de la referencia da 19.
  const BYTES = 239;

  it("con stereo='off' el paquete dice que no hay ni intensidad ni dual", () => {
    for (const senal of [pegados, independientes()]) {
      for (const cab of cabeceras(senal, 8, BYTES, 'off')) {
        // `NB_BANDS` recortado a `codedBands` por el asignador: eso es apagada.
        expect(cab.intensity).toBe(cab.codedBands);
        expect(cab.dualStereo).toBe(0);
      }
    }
  });

  it('con los canales pegados se lee EXACTAMENTE el corte por bitrate', () => {
    const esperado = intensityBand(BYTES, LM, 0, NB_BANDS);
    expect(esperado).toBe(19);
    const leidas = cabeceras(pegados, 8, BYTES, 'intensity');
    for (const cab of leidas) {
      expect(cab.intensity).toBe(Math.min(esperado, cab.codedBands));
    }
    // Y que de verdad esté haciendo algo: si `codedBands` bajara hasta 19 sola,
    // la comprobación de arriba se cumpliría sin que la intensidad existiera.
    expect(leidas.some((c) => c.codedBands > esperado)).toBe(true);
  });

  it('con los canales independientes la puerta la apaga, y se lee apagada', () => {
    for (const cab of cabeceras(independientes(), 8, BYTES, 'intensity')) {
      expect(cab.intensity).toBe(cab.codedBands);
    }
  });

  it('el estéreo dual se lee del paquete justo donde el análisis lo enciende', () => {
    // Con dos fuentes independientes el giro a mid/side no ahorra nada y el
    // análisis lo apaga; con los canales pegados, al revés.
    // La decisión se juega en un 4 % de margen, así que en ruido puro alguna
    // trama cae del otro lado; lo que se comprueba es que la mayoría se
    // encienden, no que se encienda un contador interno.
    const sueltas = cabeceras(independientes(), 12, BYTES, 'dual');
    expect(sueltas.filter((c) => c.dualStereo === 1).length).toBeGreaterThanOrEqual(9);
    for (const cab of cabeceras(pegados, 12, BYTES, 'dual')) {
      expect(cab.dualStereo).toBe(0);
    }
  });

  it('el lector sigue en sitio trama tras trama, y en los cuatro modos', () => {
    // Una cabecera leída fuera de sitio no da error: da números. Lo que no da es
    // números COHERENTES veinte tramas seguidas — `codedBands` se saldría de
    // rango o la intensidad se pasaría de las bandas codificadas al primer bit
    // corrido.
    for (const modo of ['off', 'intensity', 'dual', 'adaptive'] as const) {
      for (const cab of cabeceras(pegados, 20, BYTES, modo)) {
        expect(cab.codedBands).toBeGreaterThan(0);
        expect(cab.codedBands).toBeLessThanOrEqual(NB_BANDS);
        expect(cab.intensity).toBeGreaterThanOrEqual(0);
        expect(cab.intensity).toBeLessThanOrEqual(cab.codedBands);
        expect(cab.inclinacion).toBeGreaterThanOrEqual(0);
        expect(cab.inclinacion).toBeLessThanOrEqual(10);
      }
    }
  });

  it('cambiar la decisión cambia el paquete: no es un adorno', () => {
    const conIntensidad = cabeceras(pegados, 6, BYTES, 'intensity');
    const sin = cabeceras(pegados, 6, BYTES, 'off');
    expect(conIntensidad.some((c, i) => c.intensity !== sin[i]!.intensity)).toBe(true);
  });
});
