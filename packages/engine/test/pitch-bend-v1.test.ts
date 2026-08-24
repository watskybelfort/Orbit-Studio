/**
 * La rueda de tono dobla el tono de una voz VIVA.
 *
 * Aquí no se mira ningún campo del kernel: se mide la frecuencia de la salida
 * con el mismo detector de altura que usa el afinador. Es la única forma de
 * probar lo que este trabajo prometía — no que exista un `setBend`, sino que
 * los diez instrumentos se muevan cuando la rueda se mueve. Un motor donde la
 * rueda dobla unos sonidos y otros no es peor que uno donde no dobla ninguno:
 * el que no dobla se aprende en un minuto, el que dobla a medias se descubre
 * en mitad de una toma.
 *
 * Las dos cosas se prueban por separado porque fallan por separado:
 *  - doblar lo que YA suena (la rueda se mueve con la nota sonando), y
 *  - nacer doblado (la rueda sujeta y se toca una nota nueva).
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  type Channel,
  type InstrumentKind,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import { detectPitchTrack } from '../src/render/pitch';

const SR = 44100;

/**
 * Muestra de prueba: tono con armónicos, sin clicks y LARGA.
 *
 * Larga a propósito: doblar un sampler una octava arriba es leerlo al doble de
 * velocidad, así que la muestra se gasta en la mitad de tiempo. Con medio
 * segundo, la ventana en la que se mide el doblez caía ya en el silencio de
 * después y el detector no leía nada.
 */
function tono(hz: number): { left: Float32Array; right: Float32Array; rate: number } {
  const n = Math.round(4 * SR);
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 300) * Math.min(1, (n - i) / 300);
    const ph = (2 * Math.PI * hz * i) / SR;
    left[i] = (Math.sin(ph) * 0.7 + Math.sin(2 * ph) * 0.2) * 0.8 * env;
  }
  return { left, right: left.slice(), rate: SR };
}

const MUESTRA = tono(220);

/**
 * Bloques que se miden en cada ventana (~0,44 s). Suficiente para que el
 * detector de altura tenga tramas de sobra, y corto para que un sampler
 * doblado no se coma la muestra entera antes de la segunda medida.
 */
const VENTANA = 150;

interface RigOptions {
  params?: Record<string, number>;
  /** Sube la muestra de prueba y la ata al canal (sampler y slicer). */
  sample?: boolean;
  /** Canales extra del mismo tipo (para probar que la rueda no se derrama). */
  channels?: number;
}

/** Kernel con uno o varios canales del instrumento pedido, listo para tocar. */
function rig(kind: InstrumentKind, opts: RigOptions = {}): KernelCore {
  const project = createEmptyProject();
  const total = opts.channels ?? 1;
  const created: Channel[] = [];
  for (let i = 0; i < total; i++) {
    const channel = createChannel(kind, i, `Test ${i}`);
    if (opts.sample) channel.sampleId = 'tono';
    applyCommand(project, { type: 'addChannel', channel });
    created.push(channel);
  }
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    for (const channel of created) {
      applyCommand(project, { type: 'setChannelParam', channelId: channel.id, key, value });
    }
  }
  if (opts.sample) {
    applyCommand(project, {
      type: 'registerSample',
      sample: { id: 'tono', name: 'tono', path: 'pack:tono', hash: 'tono', duration: 4 },
    });
  }

  const core = new KernelCore(SR);
  if (opts.sample) {
    core.handleMessage({
      type: 'loadSample',
      sampleId: 'tono',
      left: MUESTRA.left,
      right: MUESTRA.right,
      sampleRate: MUESTRA.rate,
    });
  }
  const patternId = project.patternOrder[0]!;
  core.handleMessage({
    type: 'snapshot',
    project: compileProject(project, { mode: 'pattern', patternId }),
  });
  return core;
}

/** Renderiza `blocks` bloques y devuelve el canal izquierdo entero. */
function render(core: KernelCore, blocks: number): Float32Array {
  const out = new Float32Array(blocks * MAX_BLOCK);
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < blocks; b++) {
    core.process(l, r, MAX_BLOCK);
    out.set(l, b * MAX_BLOCK);
  }
  return out;
}

/** Altura mediana de la parte con señal (0 si no hay tono que leer). */
function f0(xs: Float32Array): number {
  const track = detectPitchTrack(xs, SR);
  const values = Array.from(track.f0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  return values.length > 0 ? values[values.length >> 1]! : 0;
}

/** Cruces por cero por segundo: para el ruido filtrado, que no tiene altura. */
function zcr(xs: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i - 1]! <= 0 && xs[i]! > 0) crossings++;
  return crossings / (xs.length / SR);
}

function rms(xs: Float32Array): number {
  let s = 0;
  for (const v of xs) s += v * v;
  return Math.sqrt(s / Math.max(1, xs.length));
}

/** Razón de altura de un doblez, en semitonos. */
const ratio = (semitones: number) => Math.pow(2, semitones / 12);

/**
 * Los detectores de altura tienen su error y las envolventes de filtro mueven
 * el timbre mientras se mide, así que se compara la RAZÓN con un 3 % — de
 * sobra para separar un doblez de una octava (x2) de no doblar (x1).
 */
function expectRatio(despues: number, antes: number, semitones: number): void {
  expect(antes).toBeGreaterThan(0);
  expect(despues).toBeGreaterThan(0);
  const esperada = ratio(semitones);
  expect(Math.abs(despues / antes - esperada) / esperada).toBeLessThan(0.03);
}

/**
 * Los instrumentos con altura, cada uno con lo que necesita para sonar
 * sostenido y limpio mientras se mide (nada de esto cambia lo que se prueba:
 * un filtro cerrándose durante la medida solo añade ruido al detector).
 */
const MELODICOS: { kind: InstrumentKind; opts: RigOptions & { key?: number } }[] = [
  { kind: 'sub808', opts: { params: { decay: 4, glide: 0.005 }, key: 48 } },
  { kind: 'synth', opts: { params: { sustain: 1, decay: 2, cutoff: 9000, envAmount: 0 } } },
  { kind: 'supersaw', opts: { params: { detune: 0.05 } } },
  { kind: 'fm', opts: { params: { sustain: 1, decay: 3, index: 1, indexDecay: 0.05 } } },
  { kind: 'vox', opts: { params: { vibrato: 0, breath: 0 } } },
  { kind: 'nova', opts: {} },
  { kind: 'prisma', opts: {} },
  { kind: 'sampler', opts: { sample: true, params: { release: 2 } } },
  { kind: 'slicer', opts: { sample: true, params: { slices: 1 }, key: 36 } },
];

/**
 * Toca una nota, deja que se asiente, mueve la rueda y devuelve la altura de
 * antes y la de después.
 */
function bendWhileSounding(
  kind: InstrumentKind,
  semitones: number,
  opts: RigOptions & { key?: number } = {},
): { antes: number; despues: number } {
  const core = rig(kind, opts);
  const key = opts.key ?? 60;
  core.handleMessage({ type: 'previewNote', channelIndex: 0, key, on: true });
  const antes = render(core, VENTANA);
  core.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones });
  const despues = render(core, VENTANA);
  return { antes: f0(antes), despues: f0(despues) };
}

describe('la rueda dobla lo que YA está sonando', () => {
  for (const { kind, opts } of MELODICOS) {
    it(`${kind}: una octava arriba dobla la frecuencia`, () => {
      const { antes, despues } = bendWhileSounding(kind, 12, opts);
      expectRatio(despues, antes, 12);
    });
  }

  it('y también hacia abajo', () => {
    const { antes, despues } = bendWhileSounding('synth', -12, {
      params: { sustain: 1, decay: 2, cutoff: 9000, envAmount: 0 },
    });
    expectRatio(despues, antes, -12);
  });

  it('un doblez pequeño mueve poco: 2 semitonos son 2, no 12', () => {
    const { antes, despues } = bendWhileSounding('synth', 2, {
      params: { sustain: 1, decay: 2, cutoff: 9000, envAmount: 0 },
    });
    expectRatio(despues, antes, 2);
  });
});

describe('una nota que NACE con la rueda sujeta nace doblada', () => {
  // Este es el caso que separa "la rueda mueve voces" de "hay una rueda". Sin
  // el estado por canal, tocar con la rueda sujeta daba unas notas dobladas y
  // otras no según hubieran nacido antes o después de moverla.
  for (const { kind, opts } of MELODICOS) {
    it(`${kind}: se toca con la rueda arriba y sale arriba`, () => {
      const key = opts.key ?? 60;
      const recto = rig(kind, opts);
      recto.handleMessage({ type: 'previewNote', channelIndex: 0, key, on: true });
      const sinDoblar = f0(render(recto, VENTANA));

      const doblado = rig(kind, opts);
      doblado.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones: 12 });
      doblado.handleMessage({ type: 'previewNote', channelIndex: 0, key, on: true });
      const conRueda = f0(render(doblado, VENTANA));

      expectRatio(conRueda, sinDoblar, 12);
    });
  }

  it('nace doblada YA, sin trepar durante el ataque', () => {
    // Con el 808 se ve mejor que con nadie: tiene portamento, así que si el
    // doblez entrara como un cambio normal la nota arrancaría en su sitio y
    // treparía durante los primeros milisegundos. Se mide justo el arranque.
    const params = { decay: 4, glide: 0.25 };
    const core = rig('sub808', { params });
    core.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones: 12 });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 48, on: true });
    const arranque = f0(render(core, 60));

    const recto = rig('sub808', { params });
    recto.handleMessage({ type: 'previewNote', channelIndex: 0, key: 48, on: true });
    const rectoArranque = f0(render(recto, 60));

    expectRatio(arranque, rectoArranque, 12);
  });
});

describe('la rueda no se derrama', () => {
  it('doblar un canal no toca al de al lado', () => {
    const core = rig('synth', {
      channels: 2,
      params: { sustain: 1, decay: 2, cutoff: 9000, envAmount: 0 },
    });
    core.handleMessage({ type: 'previewNote', channelIndex: 1, key: 60, on: true });
    const antes = f0(render(core, VENTANA));
    core.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones: 12 });
    const despues = f0(render(core, VENTANA));
    expect(antes).toBeGreaterThan(0);
    expect(Math.abs(despues - antes) / antes).toBeLessThan(0.01);
  });

  it('un canal que no existe no revienta el kernel', () => {
    const core = rig('synth');
    expect(() =>
      core.handleMessage({ type: 'pitchBend', channelIndex: 9, semitones: 5 }),
    ).not.toThrow();
    expect(() =>
      core.handleMessage({ type: 'pitchBend', channelIndex: -1, semitones: 5 }),
    ).not.toThrow();
  });
});

describe('soltar la rueda devuelve la nota EXACTAMENTE a su sitio', () => {
  // Se compara muestra a muestra, no la altura estimada: la trampa aquí es
  // acumular el doblez sobre el valor anterior en vez de recalcularlo desde la
  // nota, y eso deja la afinación unos cents corrida tras cada meneo — un
  // error que ningún detector de altura ve y el oído sí, tocando a dúo.
  const meneo = [7, -3, 11, 0];

  for (const kind of ['synth', 'sampler'] as InstrumentKind[]) {
    it(`${kind}: tras menearla y soltarla suena idéntico`, () => {
      const opts: RigOptions =
        kind === 'sampler'
          ? { sample: true, params: { release: 2 } }
          : { params: { sustain: 1, decay: 2, cutoff: 9000, envAmount: 0 } };

      const quieto = rig(kind, opts);
      quieto.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
      render(quieto, 30);
      const referencia = render(quieto, 60);

      const meneado = rig(kind, opts);
      meneado.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
      render(meneado, 30);
      for (const s of meneo) {
        meneado.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones: s });
      }
      const vuelta = render(meneado, 60);

      expect(rms(referencia)).toBeGreaterThan(1e-4);
      for (let i = 0; i < referencia.length; i++) {
        expect(vuelta[i]).toBe(referencia[i]);
      }
    });
  }
});

describe('el kit se dobla ENTERO, no tres piezas de nueve', () => {
  /** Golpea una pieza del kit con la rueda donde se le diga. */
  function golpe(key: number, semitones: number): Float32Array {
    const core = rig('drums');
    if (semitones !== 0) core.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key, on: true });
    return render(core, 40);
  }

  it('el tom, que tiene altura, sube de altura', () => {
    expectRatio(f0(golpe(45, 12)), f0(golpe(45, 0)), 12);
  });

  it('el hat es ruido filtrado y no tiene altura: lo que se mueve es su banda', () => {
    // Doblar un hat no puede mover una fundamental que no existe: lo honesto
    // es mover su filtro, y eso se ve en los cruces por cero.
    //
    // Los márgenes son de un dígito a propósito. El hat es un pasa-altos sobre
    // ruido BLANCO: por encima del corte sigue habiendo banda hasta Nyquist
    // llueva o truene, así que mover el corte cambia el peso del grave, no el
    // techo. Lo que se prueba es la DIRECCIÓN, en dos medidas que se mueven al
    // revés la una de la otra — sube el corte y hay más cruces y menos energía;
    // bájalo y al contrario. Las dos a la vez no se explican por casualidad, y
    // las dos se quedarían quietas si el filtro no se moviera.
    const sinDoblar = golpe(42, 0);
    const arriba = golpe(42, 12);
    const abajo = golpe(42, -12);
    expect(zcr(sinDoblar)).toBeGreaterThan(0);
    expect(zcr(arriba)).toBeGreaterThan(zcr(sinDoblar) * 1.12);
    expect(zcr(abajo)).toBeLessThan(zcr(sinDoblar) * 0.93);
    expect(rms(arriba)).toBeLessThan(rms(sinDoblar));
    expect(rms(abajo)).toBeGreaterThan(rms(sinDoblar));
  });

  it('doblar el kit no lo enmudece ni lo revienta', () => {
    for (const key of [36, 38, 39, 42, 45, 46, 48, 49, 70]) {
      for (const semis of [-24, -7, 0, 7, 24]) {
        const out = golpe(key, semis);
        expect(out.some((v) => !Number.isFinite(v))).toBe(false);
        expect(rms(out)).toBeGreaterThan(1e-5);
      }
    }
  });
});

describe('los bordes', () => {
  it('doblezos absurdos no producen NaN en ningún instrumento', () => {
    for (const { kind, opts } of MELODICOS) {
      for (const semis of [-96, -48, 48, 96]) {
        const core = rig(kind, opts);
        core.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones: semis });
        core.handleMessage({ type: 'previewNote', channelIndex: 0, key: opts.key ?? 60, on: true });
        const out = render(core, 60);
        expect(out.some((v) => !Number.isFinite(v)), `${kind} @ ${semis}st`).toBe(false);
      }
    }
  });

  it('la rueda sobrevive a recompilar el proyecto', () => {
    // Mover una perilla recompila y manda un snapshot nuevo. Si eso soltara la
    // rueda, tocar una perilla con la rueda sujeta daría un salto de tono.
    const project = createEmptyProject();
    const channel = createChannel('synth', 0, 'Test');
    applyCommand(project, { type: 'addChannel', channel });
    const params = { sustain: 1, decay: 2, cutoff: 9000, envAmount: 0 };
    for (const [key, value] of Object.entries(params)) {
      applyCommand(project, { type: 'setChannelParam', channelId: channel.id, key, value });
    }
    const patternId = project.patternOrder[0]!;
    const snap = () => compileProject(project, { mode: 'pattern', patternId });

    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: snap() });
    core.handleMessage({ type: 'pitchBend', channelIndex: 0, semitones: 12 });
    core.handleMessage({ type: 'snapshot', project: snap() });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
    const conRueda = f0(render(core, VENTANA));

    const recto = new KernelCore(SR);
    recto.handleMessage({ type: 'snapshot', project: snap() });
    recto.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
    const sinRueda = f0(render(recto, VENTANA));

    expectRatio(conRueda, sinRueda, 12);
  });
});
