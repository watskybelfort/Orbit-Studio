/**
 * Las dos capas de fuerza de cada instrumento suenan DISTINTO, no más bajo.
 *
 * Es LA prueba de que las capas de velocidad valen para algo. Que el pack pese
 * el doble en instrumentos no lo justifica que haya dos archivos: lo justifica
 * que el de la capa floja tenga otro timbre. Una síntesis a la que se le baje
 * un parámetro que no era el que mandaba —o a la que se le escape una `dyn`
 * sin conectar— produce dos archivos casi idénticos, el manifest queda
 * perfecto, el keymap reparte bien, todo pasa en verde... y en el teclado no
 * se nota nada. Eso solo lo ve una medida de la señal.
 *
 * Se mide con el centroide espectral: el centro de gravedad del espectro, en
 * Hz. Tocar flojo excita menos los parciales de arriba, así que el centro de
 * gravedad BAJA. Se compara entre capas del mismo instrumento a la misma
 * altura, y las dos vienen normalizadas al mismo pico por el post de la
 * síntesis, así que la diferencia no puede venir del nivel.
 */

import { describe, expect, it } from 'vitest';
import { getFft, hannWindow } from '../src/fft';
import { DYNAMICS, INSTRUMENTS, rootsFor, type StereoRender } from './instruments';

const SR = 44100;
/** Ventana de análisis: 0,74 s, la misma que usa el test de alturas. */
const N = 32768;
const SUAVE = DYNAMICS[0]!;
const FUERTE = DYNAMICS[DYNAMICS.length - 1]!;

/**
 * Renders memorizados. Este archivo mira las mismas tomas desde varios
 * ángulos y sintetizar un instrumento no es barato: sin la caché, las pruebas
 * de abajo renderizarían el catálogo entero una vez cada una.
 */
const cache = new Map<string, StereoRender>();
function toma(slug: string, hz: number, dyn: number): StereoRender {
  const clave = slug + '@' + hz.toFixed(4) + '@' + dyn;
  let r = cache.get(clave);
  if (r === undefined) {
    r = INSTRUMENTS.find((s) => s.slug === slug)!.render(SR, hz, dyn);
    cache.set(clave, r);
  }
  return r;
}

/** Centro de gravedad del espectro, en Hz. */
function centroide(xs: Float32Array): number {
  const desde = Math.min(Math.round(0.15 * SR), Math.max(0, xs.length - N - 1));
  const fft = getFft(N);
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (xs[desde + i] ?? 0) * win[i]!;
  fft.transform(re, im);
  let suma = 0;
  let peso = 0;
  for (let k = 1; k < N / 2; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    suma += mag * ((k * SR) / N);
    peso += mag;
  }
  return peso > 0 ? suma / peso : 0;
}

/** Fracción de la energía de la toma que cae en los primeros 20 ms. */
function pesoDelAtaque(xs: Float32Array): number {
  const n20 = Math.round(0.02 * SR);
  let ataque = 0;
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
    const e = xs[i]! * xs[i]!;
    total += e;
    if (i < n20) ataque += e;
  }
  return total > 0 ? ataque / total : 0;
}

/** Correlación normalizada del primer segundo, saltándose el ataque. */
function correlacion(a: Float32Array, b: Float32Array): number {
  const hasta = Math.min(a.length, b.length, SR);
  let sa = 0;
  let sb = 0;
  let sab = 0;
  for (let i = Math.round(0.05 * SR); i < hasta; i++) {
    sa += a[i]! * a[i]!;
    sb += b[i]! * b[i]!;
    sab += a[i]! * b[i]!;
  }
  return sab / (Math.sqrt(sa * sb) || 1);
}

describe('el catálogo de pulsaciones', () => {
  it('va de menos a más y acaba EXACTAMENTE en 1', () => {
    // El 1 no es una pulsación cualquiera: es el contrato de que la capa
    // fuerte de este pack es la grabación única del pack anterior. Si el
    // último valor dejara de ser 1, los setenta y dos WAV de siempre
    // cambiarían al regenerar, y con ellos el sonido de todo proyecto ya
    // guardado.
    expect(FUERTE).toBe(1);
    for (let i = 1; i < DYNAMICS.length; i++) {
      expect(DYNAMICS[i]!).toBeGreaterThan(DYNAMICS[i - 1]!);
    }
    for (const dyn of DYNAMICS) {
      expect(dyn).toBeGreaterThan(0);
      expect(dyn).toBeLessThanOrEqual(1);
    }
  });

  it('sin pedir pulsación sale el golpe entero', () => {
    // `render(sr, hz)` tiene que seguir dando lo de siempre: por ahí entran el
    // test de alturas, los packs a medida y cualquier sitio que no sepa que
    // existen las capas.
    for (const spec of INSTRUMENTS) {
      const porDefecto = spec.render(SR, spec.rootHz).left;
      const explicita = toma(spec.slug, spec.rootHz, FUERTE).left;
      expect(porDefecto.length, spec.slug).toBe(explicita.length);
      for (let i = 0; i < porDefecto.length; i += 97) {
        expect(porDefecto[i], spec.slug + ' @ ' + i).toBe(explicita[i]);
      }
    }
  });
});

describe('tocar flojo cambia el TIMBRE, no el volumen', () => {
  for (const spec of INSTRUMENTS) {
    it(spec.slug, () => {
      for (const hz of rootsFor(spec)) {
        const fuerte = centroide(toma(spec.slug, hz, FUERTE).left);
        const suave = centroide(toma(spec.slug, hz, SUAVE).left);
        // El margen es flojo a propósito: no se pide que cada instrumento baje
        // tanto como el de al lado —un órgano casi no responde a la pulsación
        // y un piano eléctrico responde con todo—, se pide que NINGUNO se haya
        // quedado sin conectar. El peor del catálogo baja al 0,96.
        expect(
          suave / fuerte,
          spec.slug + ' @ ' + hz.toFixed(1) + ' Hz: la capa floja no es más oscura (' +
            suave.toFixed(0) + ' Hz vs ' + fuerte.toFixed(0) + ' Hz)',
        ).toBeLessThan(0.98);
      }
    });
  }
});

describe('y el golpe se encoge con la pulsación', () => {
  // Solo donde hay un golpe que encoger: martillo de piano y púa de guitarra.
  // El centroide dice que el sonido se oscurece; esto dice que además ENTRA
  // distinto, que es la otra mitad de lo que hace reconocible a un
  // instrumento muestreado.
  //
  // No se les pide a todos, y el piano eléctrico explica por qué: ahí el
  // "tine" que se apaga ES casi todo el ataque, así que al normalizar el pico
  // la fracción del ataque SUBE en vez de bajar. No es un fallo — es que en un
  // FM el transitorio no es ruido añadido encima, es el propio tono.
  const DE_GOLPE = new Set(['piano-suave', 'piano-brillante']);
  for (const spec of INSTRUMENTS.filter(
    (s) => DE_GOLPE.has(s.slug) || s.subcategory === 'cuerdas',
  )) {
    it(spec.slug, () => {
      for (const hz of rootsFor(spec)) {
        const fuerte = pesoDelAtaque(toma(spec.slug, hz, FUERTE).left);
        const suave = pesoDelAtaque(toma(spec.slug, hz, SUAVE).left);
        expect(
          suave,
          spec.slug + ' @ ' + hz.toFixed(1) + ' Hz: el ataque no se encoge al tocar flojo',
        ).toBeLessThan(fuerte * 0.98);
      }
    });
  }
});

describe('las dos capas son la MISMA cuerda', () => {
  // La pulsación no entra en la semilla del PRNG, y esto es lo que se juega:
  // con semillas distintas las dos capas serían dos tomas independientes —otra
  // desafinación, otras fases, otra deriva— y cruzar el borde de velocidad
  // sonaría a cambiar de instrumento en vez de a pegar más fuerte.
  //
  // Se mide donde la aleatoriedad ES el sonido: los pads (deriva y detune por
  // voz) y las cuerdas pulsadas (la excitación entera es ruido). Ahí, con la
  // semilla compartida, la correlación entre capas va de 0,93 a 0,98. El
  // contrafactual se midió estrenando semilla a la misma altura —sumarle una
  // centésima de Hz basta, porque `semillaDe` redondea ahí— y cae a 0,25 o por
  // debajo, con dos pads en negativo. En el resto del catálogo esta medida no
  // dice nada (un órgano es aditivo puro y correlaciona consigo mismo pase lo
  // que pase), y por eso no se les pide.
  for (const spec of INSTRUMENTS.filter(
    (s) => s.subcategory === 'pads' || s.subcategory === 'cuerdas',
  )) {
    it(spec.slug, () => {
      const c = correlacion(
        toma(spec.slug, spec.rootHz, SUAVE).left,
        toma(spec.slug, spec.rootHz, FUERTE).left,
      );
      expect(c, spec.slug + ': las capas no comparten ruido').toBeGreaterThan(0.85);
    });
  }
});

describe('cada capa se regenera igual', () => {
  it('la misma altura y la misma pulsación, dos veces, es idéntica bit a bit', () => {
    // El pack se regenera de cero: sin esto, cada build escribiría ciento
    // cuarenta y cuatro archivos distintos y el repo no pararía de crecer.
    const uno = INSTRUMENTS[0]!;
    const a = uno.render(SR, uno.rootHz, SUAVE);
    const b = uno.render(SR, uno.rootHz, SUAVE);
    expect(a.left).toEqual(b.left);
    expect(a.right).toEqual(b.right);
  });

  it('las dos capas no son el mismo audio reetiquetado', () => {
    const uno = INSTRUMENTS[0]!;
    const suave = toma(uno.slug, uno.rootHz, SUAVE).left;
    const fuerte = toma(uno.slug, uno.rootHz, FUERTE).left;
    let iguales = 0;
    let mirados = 0;
    for (let i = 0; i < suave.length; i += 13) {
      mirados++;
      if (suave[i] === fuerte[i]) iguales++;
    }
    expect(iguales / mirados).toBeLessThan(0.1);
  });
});
