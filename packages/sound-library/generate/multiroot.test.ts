/**
 * Cada instrumento del pack, a cada una de sus alturas, suena a la altura que
 * dice que suena.
 *
 * Es LA prueba de que el pack multisample vale para algo. El manifest promete
 * "esta grabación es tal nota" y el sampler transpone desde ahí: si la
 * grabación estuviera unos cents movida, el instrumento saldría desafinado
 * consigo mismo, y no de cualquier manera — desafinado A TROZOS, cambiando al
 * cruzar de una zona del teclado a la siguiente. Eso no se ve en ningún sitio
 * y no lo pilla ningún test que mire estado: hay que medir la señal.
 *
 * Se mide con la FFT del propio paquete, buscando la parcial dominante y
 * comparándola con la nota declarada. Y no con un detector de altura al uso:
 * uno de esos se pierde con un bajo de 32 Hz y con los drawbars de un órgano,
 * donde la parcial más fuerte no es la fundamental. Aquí no hace falta saber
 * cuál es la fundamental — basta con que la parcial que manda caiga EXACTA
 * sobre una parcial de la nota declarada.
 */

import { describe, expect, it } from 'vitest';
import { getFft, hannWindow } from '../src/fft';
import { DYNAMICS, INSTRUMENTS, midiDeHz, rootsFor, type InstrumentSpec } from './instruments';

const SR = 44100;
/** Ventana de análisis: 0,74 s. Larga para que el bin salga fino (1,3 Hz). */
const N = 32768;

/**
 * Frecuencia de la parcial dominante por debajo de 4 kHz, con interpolación
 * parabólica sobre el pico (el bin suelto no da la resolución que hace falta
 * para hablar de cents).
 */
function parcialDominante(xs: Float32Array): number {
  const desde = Math.min(Math.round(0.15 * SR), Math.max(0, xs.length - N - 1));
  const fft = getFft(N);
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (xs[desde + i] ?? 0) * win[i]!;
  fft.transform(re, im);
  const topeBin = Math.min(N / 2 - 2, Math.floor((4000 * N) / SR));
  let mejor = 0;
  let mejorMag = 0;
  for (let k = 2; k < topeBin; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    if (mag > mejorMag) {
      mejorMag = mag;
      mejor = k;
    }
  }
  const m0 = Math.hypot(re[mejor - 1]!, im[mejor - 1]!);
  const m1 = mejorMag;
  const m2 = Math.hypot(re[mejor + 1]!, im[mejor + 1]!);
  const d = (0.5 * (m0 - m2)) / (m0 - 2 * m1 + m2 || 1);
  return ((mejor + d) * SR) / N;
}

/**
 * Centro de gravedad del espectro, en Hz.
 *
 * Para un timbre que se repite a otra altura, el espectro entero es una copia
 * escalada y el centroide se mueve con él exactamente. Sirve donde la parcial
 * dominante no vale: una campana tiene dos parciales inarmónicas casi igual de
 * fuertes y cuál gana depende de dónde caiga la ventana de análisis, así que
 * seguir "la más fuerte" salta de una a otra y no mide nada.
 */
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

/** Diferencia en centésimas de semitono entre dos frecuencias. */
function cents(medida: number, esperada: number): number {
  return 1200 * Math.log2(medida / esperada);
}

function pico(xs: Float32Array): number {
  let p = 0;
  for (const v of xs) p = Math.max(p, Math.abs(v));
  return p;
}

/**
 * Las campanas son INARMÓNICAS a propósito: el modulador va a 3,53 veces la
 * fundamental, y eso es lo que hace que suenen a bronce y no a flauta. Su
 * parcial dominante no cae en un múltiplo entero de la nota, así que a ellas
 * se les mide el espectro entero (ver el centroide).
 */
const INARMONICOS = new Set(['campanas']);

/** Cuerdas pulsadas: se miden más fino (ver abajo). */
const CUERDAS = new Set(['cuerdas']);

describe('cada altura suena donde dice, y a las dos pulsaciones', () => {
  // Las capas de fuerza se miden por separado, y no por completismo: una
  // síntesis que al bajar la pulsación se lleve por delante la altura deja el
  // instrumento desafinado CONSIGO MISMO según lo fuerte que toques, que es el
  // peor de los dos mundos — se oye, y no se ve en ningún sitio. Y hay dos
  // sitios por donde eso pasaría de verdad: el índice de FM de una campana
  // mueve cuál es su parcial dominante, y el filtro de un bajo puede acabar
  // por debajo de su propio fundamental.
  for (const spec of INSTRUMENTS) {
    it(`${spec.slug}`, () => {
      for (const dyn of DYNAMICS) {
        const raices = rootsFor(spec);
        const razones = raices.map(
          (hz) => parcialDominante(spec.render(SR, hz, dyn).left) / hz,
        );

        if (INARMONICOS.has(spec.subcategory)) {
          // En una campana el espectro entero tiene que subir la octava, que es
          // la promesa: la misma campana, más aguda. Se mide con el centroide,
          // no con la parcial que manda — hay dos casi iguales de fuertes y cuál
          // gana depende de la ventana.
          const centros = raices.map((hz) => centroide(spec.render(SR, hz, dyn).left));
          for (let i = 1; i < centros.length; i++) {
            expect(
              Math.abs(cents(centros[i]!, centros[i - 1]!) - 1200),
              `${spec.slug} (dyn ${dyn}): el espectro no sube la octava entre tomas`,
            ).toBeLessThan(35);
          }
          continue;
        }

        raices.forEach((hz, i) => {
          const razon = razones[i]!;
          const armonica = Math.max(1, Math.round(razon));
          // 15 cents. No se puede apretar más por el ensemble de cuerdas, que son
          // seis sierras repartidas entre -12 y +13 cents a propósito: cuál manda
          // depende de la deriva, y eso mueve la medida unos cents. Para lo que
          // se busca sobra — un fallo de afinación entre zonas empieza en medio
          // semitono, y uno de "esta síntesis no hace caso a la altura" es una
          // octava entera.
          expect(
            Math.abs(cents(razon, armonica)),
            `${spec.slug} @ ${hz.toFixed(1)} Hz, dyn ${dyn} (parcial x${armonica})`,
          ).toBeLessThan(15);
        });
      }
    });
  }
});

describe('las cuerdas pulsadas quedan afinadas entre ellas', () => {
  // Aquí se aprieta a 10 cents, y es donde se ve el retardo fraccionario del
  // Karplus-Strong: con el retardo redondeado a muestras enteras, media
  // muestra son 0,7 cents en el registro grave y 2,6 en el agudo, así que la
  // guitarra salía desafinada CONSIGO MISMA y el escalón caía justo al cruzar
  // de zona. Una cuerda pulsada tiene el espectro limpio, así que se puede
  // medir fino y exigir en consecuencia.
  //
  // Y es también donde se prueba que la pulsación NO toca la amortiguación del
  // lazo: la amortiguación entra en el largo del retardo, así que moverla con
  // la fuerza dejaría la capa floja desafinada respecto de la fuerte — en la
  // misma nota, cambiando según cómo la pulses.
  for (const spec of INSTRUMENTS.filter((s) => CUERDAS.has(s.subcategory))) {
    it(`${spec.slug}`, () => {
      for (const dyn of DYNAMICS) {
        for (const hz of rootsFor(spec)) {
          const razon = parcialDominante(spec.render(SR, hz, dyn).left) / hz;
          const armonica = Math.max(1, Math.round(razon));
          expect(
            Math.abs(cents(razon, armonica)),
            `${spec.slug} @ ${hz.toFixed(1)} Hz, dyn ${dyn} (parcial x${armonica})`,
          ).toBeLessThan(10);
        }
      }
    });
  }
});

describe('ninguna altura ni pulsación rompe la síntesis', () => {
  for (const spec of INSTRUMENTS) {
    it(`${spec.slug}`, () => {
      for (const dyn of DYNAMICS) {
        for (const hz of rootsFor(spec)) {
          const { left, right } = spec.render(SR, hz, dyn);
          const donde = `${spec.slug} @ ${hz.toFixed(1)} Hz, dyn ${dyn}`;
          expect(left.length, donde).toBe(right.length);
          expect(left.some((v) => !Number.isFinite(v)), donde).toBe(false);
          expect(right.some((v) => !Number.isFinite(v)), donde).toBe(false);
          // Ni mudo ni saturado: el post normaliza a 0.9, así que cualquier cosa
          // fuera de ahí es que la síntesis se fue.
          expect(pico(left), donde).toBeGreaterThan(0.2);
          expect(pico(left), donde).toBeLessThanOrEqual(1);
          // Bordes a cero: un click al empezar o al acabar se oye en CADA nota.
          expect(Math.abs(left[0]!), donde).toBeLessThan(0.02);
          expect(Math.abs(left[left.length - 1]!), donde).toBeLessThan(0.02);
        }
      }
    });
  }
});

describe('la altura es un parámetro de verdad', () => {
  const uno: InstrumentSpec = INSTRUMENTS[0]!;

  it('sin pedir altura sale la del registro natural', () => {
    const porDefecto = uno.render(SR).left;
    const explicita = uno.render(SR, uno.rootHz).left;
    expect(porDefecto.length).toBe(explicita.length);
    for (let i = 0; i < porDefecto.length; i += 97) {
      expect(porDefecto[i]).toBe(explicita[i]);
    }
  });

  it('dos alturas dan audio DISTINTO (no es la misma toma reetiquetada)', () => {
    const grave = uno.render(SR, uno.rootHz / 2).left;
    const agudo = uno.render(SR, uno.rootHz * 2).left;
    let iguales = 0;
    let mirados = 0;
    for (let i = 0; i < grave.length; i += 13) {
      mirados++;
      if (grave[i] === agudo[i]) iguales++;
    }
    expect(iguales / mirados).toBeLessThan(0.1);
  });

  it('la misma altura dos veces es idéntica bit a bit', () => {
    // El pack se regenera de cero cada vez: si esto no se cumpliera, cada
    // build produciría setenta y dos archivos distintos y el repo no pararía
    // de crecer.
    const a = uno.render(SR, uno.rootHz * 2);
    const b = uno.render(SR, uno.rootHz * 2);
    expect(a.left).toEqual(b.left);
    expect(a.right).toEqual(b.right);
  });

  it('cada altura estrena ruido: dos tomas del mismo pad no respiran a la vez', () => {
    // Con la semilla vieja —solo el slug— las tres tomas de un pad compartían
    // desafinaciones, fases de arranque y frecuencias de deriva. Sonando juntas
    // en el teclado no sonaban a sección: sonaban a una sola fuente doblada,
    // porque su "respiración" iba enganchada. La altura entra en la semilla.
    const pad = INSTRUMENTS.find((s) => s.subcategory === 'pads')!;
    const grave = pad.render(SR, pad.rootHz / 2).left;
    const agudo = pad.render(SR, pad.rootHz * 2).left;
    // Las envolventes de las dos tomas son distintas de verdad, no la misma
    // curva a otra altura: se compara la energía por tramos.
    const tramos = 24;
    const paso = Math.floor(grave.length / tramos);
    let distintos = 0;
    for (let t = 0; t < tramos; t++) {
      let ea = 0;
      let eb = 0;
      for (let i = t * paso; i < (t + 1) * paso; i++) {
        ea += grave[i]! * grave[i]!;
        eb += agudo[i]! * agudo[i]!;
      }
      if (Math.abs(Math.sqrt(ea) - Math.sqrt(eb)) > 0.02 * Math.sqrt(ea)) distintos++;
    }
    expect(distintos).toBeGreaterThan(tramos / 2);
  });
});

describe('las notas MIDI del manifest', () => {
  it('el registro natural de cada instrumento cae en una nota redonda', () => {
    for (const spec of INSTRUMENTS) {
      const midi = midiDeHz(spec.rootHz);
      // Todas las raíces del catálogo son un do: en la convención de la casa
      // (C5 = 60) eso son múltiplos de 12.
      expect(midi % 12, spec.slug).toBe(0);
    }
  });

  it('las tres alturas caben en el teclado', () => {
    for (const spec of INSTRUMENTS) {
      for (const hz of rootsFor(spec)) {
        const midi = midiDeHz(hz);
        const donde = `${spec.slug} @ ${hz.toFixed(1)}`;
        expect(midi, donde).toBeGreaterThanOrEqual(0);
        expect(midi, donde).toBeLessThanOrEqual(127);
      }
    }
  });

  it('las tres alturas son octavas exactas, sin repetir', () => {
    for (const spec of INSTRUMENTS) {
      const midis = rootsFor(spec).map(midiDeHz);
      expect(new Set(midis).size, spec.slug).toBe(midis.length);
      for (let i = 1; i < midis.length; i++) {
        expect(midis[i]! - midis[i - 1]!, spec.slug).toBe(12);
      }
    }
  });

  it('midiDeHz clava las referencias', () => {
    expect(midiDeHz(440)).toBe(69);
    expect(midiDeHz(261.63)).toBe(60);
    expect(midiDeHz(65.41)).toBe(36);
  });
});
