/**
 * BUG 008 — el kernel alocaba decenas de vistas por bloque de audio.
 *
 * `dst.set(src.subarray(0, n))` es la forma corta de copiar un bloque, pero cada
 * `subarray` es un objeto NUEVO aunque no reserve memoria. En una mesa con inserts y
 * envíos pre salían 52 vistas por bloque de 128 muestras, que a 48 kHz son unos
 * 19 500 objetos por segundo de basura en el hilo de audio (medido en la auditoría).
 * Una alocación aquí no rompe un test: hace que el GC pare el hilo en el peor momento
 * y el usuario oiga un chasquido cada tantos minutos. Es la regla dura 2 del repo.
 *
 * Aquí se cuenta lo que se crea DENTRO de `process` —vistas y cortes— sobre un
 * proyecto que pasa por todos los caminos que copiaban: insert de canal con mezcla
 * seca, insert de strip, toma pre-fader, captura de la salida de una pista y el tap
 * del osciloscopio. El recuento tiene que ser CERO, y el segundo test comprueba que el
 * contador cuenta (si no, el de arriba pasaría siempre).
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultEffectParams,
  newId,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 48000;

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

function slotStereo(mix: number): {
  id: string;
  kind: 'stereo';
  enabled: boolean;
  mix: number;
  params: Record<string, number>;
} {
  return {
    id: newId(),
    kind: 'stereo',
    enabled: true,
    mix,
    params: { ...defaultEffectParams('stereo'), width: 1, monoBelow: 0 },
  };
}

/**
 * Proyecto con lo justo para que TODOS los caminos que copiaban un bloque se
 * ejecuten: un canal con insert y `mix` < 1 (que es el que guarda el seco del
 * bloque), y otra pista con insert de strip y con envío pre-fader.
 */
function proyectoQueCopia(): Project {
  const project = createEmptyProject('Alocaciones');
  project.tempo = 240;
  const patternId = project.patternOrder[0]!;

  const canal = createChannel('synth', 0, 'Con cadena');
  canal.mixerTrack = 1;
  Object.assign(canal.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
  applyCommand(project, { type: 'addChannel', channel: canal });
  applyCommand(project, {
    type: 'setChannelEffect',
    channelId: canal.id,
    slotIndex: 0,
    slot: slotStereo(0.6), // < 1: obliga a guardar el seco del bloque
  });
  applyCommand(project, {
    type: 'addNotes',
    patternId,
    channelId: canal.id,
    notes: [note(0, 2, 60)],
  });

  const canal2 = createChannel('synth', 0, 'A strip');
  canal2.mixerTrack = 2;
  applyCommand(project, { type: 'addChannel', channel: canal2 });
  applyCommand(project, {
    type: 'addNotes',
    patternId,
    channelId: canal2.id,
    notes: [note(0, 2, 67)],
  });
  applyCommand(project, {
    type: 'setEffect',
    trackIndex: 2,
    slotIndex: 0,
    slot: slotStereo(0.5), // también por debajo de 1: guarda el seco
  });
  applyCommand(project, {
    type: 'setSend',
    trackIndex: 2,
    target: 3,
    level: null,
    // La toma pre-fader también es una copia del bloque.
    send: { target: 3, level: 0.4, tap: 'pre' },
  });
  return project;
}

interface Recuento {
  vistas: number;
  cortes: number;
}

type Subarray = typeof Float32Array.prototype.subarray;
type Slice = typeof Float32Array.prototype.slice;

/**
 * Cuenta las vistas y cortes que se crean dentro de `process`, parcheando los
 * prototypes de `Float32Array` (los dos caminos de copiar un bloque: vista o copia).
 */
function contandoVistasEnProcess(core: KernelCore, bloques: number): Recuento {
  const rec: Recuento = { vistas: 0, cortes: 0 };
  const subarrayOriginal: Subarray = Float32Array.prototype.subarray;
  const sliceOriginal: Slice = Float32Array.prototype.slice;
  let dentro = false;

  const vista: Subarray = function (this: Float32Array, start?: number, end?: number) {
    if (dentro) rec.vistas++;
    if (start === undefined) return subarrayOriginal.call(this);
    if (end === undefined) return subarrayOriginal.call(this, start);
    return subarrayOriginal.call(this, start, end);
  } as Subarray;
  const corte: Slice = function (this: Float32Array, start?: number, end?: number) {
    if (dentro) rec.cortes++;
    if (start === undefined) return sliceOriginal.call(this);
    if (end === undefined) return sliceOriginal.call(this, start);
    return sliceOriginal.call(this, start, end);
  } as Slice;

  Float32Array.prototype.subarray = vista;
  Float32Array.prototype.slice = corte;
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  try {
    for (let b = 0; b < bloques; b++) {
      dentro = true;
      core.process(l, r, MAX_BLOCK);
      dentro = false;
    }
  } finally {
    Float32Array.prototype.subarray = subarrayOriginal;
    Float32Array.prototype.slice = sliceOriginal;
  }
  return rec;
}

describe('008 · el hilo de audio no aloca', () => {
  it('process() no crea ni una vista con una mesa llena', () => {
    const core = new KernelCore(SR);
    core.handleMessage({
      type: 'snapshot',
      project: compileProject(proyectoQueCopia(), { mode: 'song' }),
    });
    core.handleMessage({ type: 'setScope', enabled: true, trackIndex: 2 });
    core.handleMessage({ type: 'setTrackCapture', trackIndex: 2, enabled: true });
    core.handleMessage({ type: 'play', fromBeat: 0 });

    const rec = contandoVistasEnProcess(core, 200);
    expect(rec.vistas + rec.cortes).toBe(0);
  });

  it('y el contador cuenta (si no, el de arriba pasaría siempre)', () => {
    let dentro = false;
    let vistas = 0;
    const original: Subarray = Float32Array.prototype.subarray;
    const contador: Subarray = function (this: Float32Array, start?: number, end?: number) {
      if (dentro) vistas++;
      if (start === undefined) return original.call(this);
      if (end === undefined) return original.call(this, start);
      return original.call(this, start, end);
    } as Subarray;
    Float32Array.prototype.subarray = contador;
    try {
      dentro = true;
      new Float32Array(8).subarray(0, 4);
      dentro = false;
    } finally {
      Float32Array.prototype.subarray = original;
    }
    expect(vistas).toBe(1);
  });
});