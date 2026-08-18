/**
 * El Slicer trocea por donde diga el canal.
 *
 * Hasta ahora repartía SIEMPRE en partes iguales, que con un loop tocado a mano
 * parte los golpes por la mitad. Con `slicePoints` (los que saca el detector de
 * transientes) cada trozo empieza donde está el golpe.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';
import type { SampleData } from '../src/dsp/voices';

const SR = 44100;
const SAMPLE_ID = 'loop';

function note(key: number): Note {
  return { id: newId(), start: 0, duration: 4, key, velocity: 1, pan: 0, slide: false };
}

/** Un segundo de tono continuo: sirve para medir CUÁNTO dura un trozo. */
function toneSample(): Map<string, SampleData> {
  const n = SR;
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return new Map([[SAMPLE_ID, { left, right: left.slice(), rate: SR }]]);
}

/** Un segundo de silencio con UN golpe de 10 ms en el segundo 0.6. */
function hitSample(): Map<string, SampleData> {
  const n = SR;
  const left = new Float32Array(n);
  const from = Math.round(0.6 * SR);
  for (let i = from; i < from + Math.round(0.01 * SR); i++) {
    left[i] = 0.8 * Math.sin((2 * Math.PI * 440 * (i - from)) / SR);
  }
  return new Map([[SAMPLE_ID, { left, right: left.slice(), rate: SR }]]);
}

/** Proyecto de un canal slicer tocando UN trozo (la tecla elige cuál). */
function slicerProject(key: number, slicePoints?: number[]) {
  const p = createEmptyProject('Slicer');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('slicer', 0, 'Loop');
  ch.sampleId = SAMPLE_ID;
  ch.params['slices'] = 8;
  ch.params['attack'] = 0.0005;
  ch.params['release'] = 0.005;
  if (slicePoints) ch.slicePoints = slicePoints;
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(key)] });
  return compileProject(p, { mode: 'pattern', patternId });
}

function rms(xs: Float32Array, from: number, to: number): number {
  let s = 0;
  const end = Math.min(to, xs.length);
  for (let i = from; i < end; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, end - from));
}

describe('slicer: cortes propios del canal', () => {
  it('un trozo largo suena más rato que uno de los ocho iguales', () => {
    const samples = toneSample();
    // C3 = trozo 0. Con cortes propios va de 0 a 0.9 del sample (0.9 s);
    // sin ellos, un octavo (0.125 s).
    const conCortes = renderProject(slicerProject(36, [0, 0.9]), { samples, tailSeconds: 0 });
    const iguales = renderProject(slicerProject(36), { samples: toneSample(), tailSeconds: 0 });

    const ventana = Math.round(0.5 * SR);
    expect(rms(conCortes.left, 0, ventana)).toBeGreaterThan(rms(iguales.left, 0, ventana) * 2);
  });

  it('el trozo empieza EN el golpe, que es para lo que sirve', () => {
    // El golpe del sample está en 0.6: un corte ahí deja el segundo trozo
    // empezando justo en él.
    const conCortes = renderProject(slicerProject(37, [0, 0.6]), {
      samples: hitSample(),
      tailSeconds: 0,
    });
    const iguales = renderProject(slicerProject(37), { samples: hitSample(), tailSeconds: 0 });

    const primerosMs = Math.round(0.02 * SR);
    // Con el corte en el golpe, el trozo arranca sonando.
    expect(rms(conCortes.left, 0, primerosMs)).toBeGreaterThan(0.05);
    // Repartiendo en ocho, el segundo trozo (0.125–0.25) es silencio puro.
    expect(rms(iguales.left, 0, primerosMs)).toBeLessThan(0.001);
  });

  it('sin cortes propios el motor suena EXACTAMENTE igual que antes', () => {
    const a = renderProject(slicerProject(38), { samples: toneSample(), tailSeconds: 0 });
    const b = renderProject(slicerProject(38), { samples: toneSample(), tailSeconds: 0 });
    expect(a.left).toEqual(b.left);
    // Y el trozo 2 de ocho iguales empieza en 0.25 del sample: el tono está ahí.
    expect(rms(a.left, 0, Math.round(0.05 * SR))).toBeGreaterThan(0.1);
  });
});
