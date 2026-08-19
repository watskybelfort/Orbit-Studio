/**
 * Tres formas de que un render salga mal sin que nada avise.
 *
 * 1. **NaN del sampler.** Con la perilla `start` a tope, la interpolación leía
 *    una muestra más allá del final del sample. Un NaN suelto no se queda
 *    quieto: el limiter del master —o cualquier filtro con memoria— se queda
 *    con la ganancia en NaN para siempre y el archivo entero sale a basura.
 * 2. **La fase desbocada.** Una nota por encima del sample rate (tecla alta
 *    con la octava subida) hacía crecer la fase sin freno, y con ella la saw y
 *    la cuadrada: picos de +142 dB.
 * 3. **El compilado mutado.** El kernel escribe params dentro del proyecto
 *    compilado; renderizar la mezcla y luego los stems con el mismo compilado
 *    daba stems que no cuadraban, y dos renders seguidos no coincidían.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';
import type { SampleData } from '../src/dsp/voices';

const SR = 44100;
const SAMPLE_ID = 'golpe';

function note(key: number, duration = 2): Note {
  return { id: newId(), start: 0, duration, key, velocity: 1, pan: 0, slide: false };
}

function anyNaN(xs: Float32Array): boolean {
  for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i]!)) return true;
  return false;
}

function peak(xs: Float32Array): number {
  let p = 0;
  for (let i = 0; i < xs.length; i++) p = Math.max(p, Math.abs(xs[i]!));
  return p;
}

function samples(length = SR): Map<string, SampleData> {
  const left = new Float32Array(length);
  for (let i = 0; i < length; i++) left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return new Map([[SAMPLE_ID, { left, right: left.slice(), rate: SR }]]);
}

/** Un canal sampler con los recortes que se le pidan, y un limiter en el master. */
function samplerProject(params: Record<string, number>) {
  const p = createEmptyProject('Sampler');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('sampler', 0, 'Golpe');
  ch.sampleId = SAMPLE_ID;
  for (const [key, value] of Object.entries(params)) ch.params[key] = value;
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(60)] });
  // El limiter es lo que convierte un NaN suelto en un archivo entero perdido.
  applyCommand(p, {
    type: 'setEffect',
    trackIndex: 0,
    slotIndex: 0,
    slot: { id: newId(), kind: 'limiter', enabled: true, mix: 1, params: {} },
  });
  return compileProject(p, { mode: 'pattern', patternId });
}

describe('el sampler no puede meter NaN en la mezcla', () => {
  it('con start a tope (su valor legal máximo) el render sigue siendo audio', () => {
    const out = renderProject(samplerProject({ start: 1 }), {
      samples: samples(),
      tailSeconds: 0,
    });
    expect(anyNaN(out.left)).toBe(false);
    expect(anyNaN(out.right)).toBe(false);
  });

  it('start a tope + loop + reverse tampoco', () => {
    const out = renderProject(samplerProject({ start: 1, loop: 1, reverse: 1 }), {
      samples: samples(),
      tailSeconds: 0,
    });
    expect(anyNaN(out.left)).toBe(false);
  });

  it('un sample de menos de dos muestras no suena, pero no envenena nada', () => {
    const out = renderProject(samplerProject({}), { samples: samples(1), tailSeconds: 0 });
    expect(anyNaN(out.left)).toBe(false);
    expect(peak(out.left)).toBe(0);
  });

  it('el recorte normal sigue sonando igual de fuerte', () => {
    const out = renderProject(samplerProject({}), { samples: samples(), tailSeconds: 0 });
    expect(peak(out.left)).toBeGreaterThan(0.1);
  });
});

describe('una nota imposible no revienta la salida', () => {
  /** Synth (saw) con la octava arriba del todo y la tecla más alta que hay. */
  function synthProject(key: number, octave: number) {
    const p = createEmptyProject('Synth');
    p.tempo = 120;
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('synth', 0, 'Lead');
    ch.params['wave'] = 0; // saw
    ch.params['octave'] = octave;
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(key, 1)] });
    return compileProject(p, { mode: 'pattern', patternId });
  }

  it('la tecla 127 con la octava en +2 no se va a +142 dB', () => {
    const out = renderProject(synthProject(127, 2), { tailSeconds: 0 });
    expect(anyNaN(out.left)).toBe(false);
    // Sin envolver bien la fase esto medía 9e+6.
    expect(peak(out.left)).toBeLessThan(4);
  });

  it('una nota normal suena exactamente igual que siempre', () => {
    const out = renderProject(synthProject(60, 0), { tailSeconds: 0 });
    expect(peak(out.left)).toBeGreaterThan(0.05);
    expect(peak(out.left)).toBeLessThan(2);
  });
});

describe('el render no se corta cuando el tempo baja a mitad de canción', () => {
  /** 32 compases con un marcador que deja el tempo en la cuarta parte. */
  function quarterTime() {
    const p = createEmptyProject('Quarter');
    p.tempo = 120;
    p.timeSig = { num: 4, den: 4 };
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('synth', 0, 'Lead');
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(60, 1)] });
    applyCommand(p, {
      type: 'addMarker',
      marker: { id: newId(), time: 4, name: 'lento', color: '#fff', tempo: 30 },
    });
    const compiled = compileProject(p, { mode: 'song' });
    return { ...compiled, lengthBeats: 128 };
  }

  it('el tope de duración lo pone el tempo MÁS LENTO, no el del beat 0', () => {
    const compiled = quarterTime();
    const out = renderProject(compiled, { tailSeconds: 0 });
    // 4 beats a 120 (2 s) + 124 beats a 30 (248 s) = 250 s de música. Con el
    // tope calculado sobre 120 BPM el render se cortaba en 208 s.
    expect(out.left.length / out.sampleRate).toBeGreaterThan(240);
  });

  it('sin marcadores de tempo el tope sale exactamente igual que antes', () => {
    const p = createEmptyProject('Normal');
    p.tempo = 120;
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('synth', 0, 'Lead');
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(60, 1)] });
    const compiled = { ...compileProject(p, { mode: 'song' }), lengthBeats: 16 };
    const out = renderProject(compiled, { tailSeconds: 0 });
    expect(out.left.length / out.sampleRate).toBeGreaterThan(7);
    expect(out.left.length / out.sampleRate).toBeLessThan(9);
  });
});

describe('renderizar no ensucia el proyecto compilado', () => {
  /** Un canal con un LFO sobre su volumen: eso es lo que el kernel escribe. */
  function lfoProject() {
    const p = createEmptyProject('LFO');
    p.tempo = 120;
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('synth', 0, 'Lead');
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(60, 4)] });
    applyCommand(p, {
      type: 'addLfos',
      lfos: [
        {
          id: newId(),
          target: { kind: 'channel', channelId: ch.id, param: 'cutoff' },
          shape: 'sine',
          rateBeats: 1,
          amount: 0.5,
          phase: 0,
          enabled: true,
        },
      ],
    });
    return compileProject(p, { mode: 'pattern', patternId });
  }

  it('dos renders del MISMO compilado dan exactamente los mismos bytes', () => {
    const compiled = lfoProject();
    const a = renderProject(compiled, { tailSeconds: 0 });
    const b = renderProject(compiled, { tailSeconds: 0 });
    expect(a.left.length).toBe(b.left.length);
    let distintas = 0;
    for (let i = 0; i < a.left.length; i++) if (a.left[i] !== b.left[i]) distintas++;
    expect(distintas).toBe(0);
  });

  it('el parámetro que mueve el LFO sigue en su sitio tras renderizar', () => {
    const compiled = lfoProject();
    const antes = compiled.channels[0]!.params['cutoff'];
    expect(antes).toBe(4000);
    renderProject(compiled, { tailSeconds: 0 });
    renderProject(compiled, { tailSeconds: 0 });
    // Sin aislar, esto quedaba en 3971.44 y seguía derivando en cada render.
    expect(compiled.channels[0]!.params['cutoff']).toBe(antes);
  });
});
