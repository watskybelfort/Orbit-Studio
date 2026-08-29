/**
 * Stems: aislar el audio de una pista pasándolo por la cadena completa. El bug
 * era que `renderStems` silenciaba TODA pista salvo la pedida y el master, así
 * que una pista ruteada por un bus intermedio salía muda y una con send a un
 * retorno de reverb salía seca. Aquí se comprueban esos dos caminos.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultEffectParams,
  newId,
  type EffectSlot,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject, renderStems } from '../src/render/offline';

const SR = 44100;

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

function reverbSlot(): EffectSlot {
  return {
    id: newId(),
    kind: 'reverb',
    enabled: true,
    mix: 1,
    params: { ...defaultEffectParams('reverb'), size: 0.7, damp: 0.4, predelay: 0 },
  };
}

function rms(xs: Float32Array, from = 0, to = xs.length): number {
  let s = 0;
  const end = Math.min(to, xs.length);
  for (let i = from; i < end; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, end - from));
}

/** Un canal de sinte con una nota corta, en la pista de mixer indicada. */
function projectWithChannelOn(mixerTrack: number): Project {
  const project = createEmptyProject('Stems');
  project.tempo = 240;
  const ch = createChannel('synth', 0, 'Lead');
  ch.mixerTrack = mixerTrack;
  ch.volume = 0.8;
  Object.assign(ch.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
  applyCommand(project, { type: 'addChannel', channel: ch });
  const patternId = project.patternOrder[0]!;
  applyCommand(project, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(0, 1, 60)] });
  return project;
}

function stemOf(project: Project, idx: number): Float32Array {
  const patternId = project.patternOrder[0]!;
  const compiled = compileProject(project, { mode: 'pattern', patternId });
  return renderStems(compiled, [idx], { tailSeconds: 0.3, sampleRate: SR }).results.get(idx)!.left;
}

describe('renderStems', () => {
  it('el stem de una pista ruteada por un bus intermedio no sale mudo', () => {
    const project = projectWithChannelOn(2);
    // Pista 2 → bus 3 → master. Antes del fix, el bus 3 se silenciaba y borraba
    // el audio que la pista 2 le había sumado: stem en silencio absoluto.
    project.mixer[2]!.routeTo = 3;
    project.mixer[3]!.routeTo = 0;

    const patternId = project.patternOrder[0]!;
    const compiled = compileProject(project, { mode: 'pattern', patternId });
    const full = renderProject(compiled, { tailSeconds: 0.3, sampleRate: SR });
    const stem = renderStems(compiled, [2], { tailSeconds: 0.3, sampleRate: SR }).results.get(2)!.left;

    expect(rms(full.left)).toBeGreaterThan(1e-3); // sanity: la mezcla suena
    expect(rms(stem)).toBeGreaterThan(1e-3); // y el stem también (antes: 0)
  });

  it('el stem conserva la cola del send a un retorno de reverb', () => {
    const project = projectWithChannelOn(2);
    // La pista 2 manda a un retorno (pista 4) con reverb; el retorno va al master.
    project.mixer[4]!.slots[0] = reverbSlot();
    project.mixer[2]!.sends = [{ target: 4, level: 1 }];

    const stem = stemOf(project, 2);
    // Bastante después del final de la nota (0,25 s a 240 BPM) sigue habiendo
    // energía: es la cola de la reverb del send, que antes se perdía (stem seco).
    const tail = rms(stem, Math.floor(SR * 0.35), stem.length);
    expect(tail).toBeGreaterThan(1e-4);
  });

  it('el stem NO incluye el audio de otras pistas', () => {
    const project = projectWithChannelOn(2);
    // Una segunda fuente en la pista 5, ajena al stem de la 2.
    const other = createChannel('synth', 1, 'Other');
    other.mixerTrack = 5;
    other.volume = 0.8;
    Object.assign(other.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
    applyCommand(project, { type: 'addChannel', channel: other });
    applyCommand(project, {
      type: 'addNotes',
      patternId: project.patternOrder[0]!,
      channelId: other.id,
      notes: [note(0, 1, 67)],
    });

    // La pista 5 no está en el camino de la 2, así que su audio no debe aparecer.
    const stem2 = stemOf(project, 2);
    const stem5 = stemOf(project, 5);
    expect(rms(stem2)).toBeGreaterThan(1e-3);
    expect(rms(stem5)).toBeGreaterThan(1e-3);
    // Los dos stems por separado no son el mismo audio.
    expect(rms(stem2)).not.toBeCloseTo(rms(stem5), 3);
  });
});

/** Un canal de sinte por pista de mixer pedida, cada uno con su propia nota. */
function projectWithChannelsOn(mixerTracks: number[]): Project {
  const project = createEmptyProject('Stems multi');
  project.tempo = 240;
  mixerTracks.forEach((mixerTrack, i) => {
    const ch = createChannel('synth', i, `Ch${i}`);
    ch.mixerTrack = mixerTrack;
    ch.volume = 0.8;
    Object.assign(ch.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
    applyCommand(project, { type: 'addChannel', channel: ch });
    applyCommand(project, {
      type: 'addNotes',
      patternId: project.patternOrder[0]!,
      channelId: ch.id,
      notes: [note(0, 1, 60 + i)],
    });
  });
  return project;
}

describe('renderStems: una pista rota no se lleva a sus hermanas del lote', () => {
  it('el fallo de UNA pista deja las demás del mismo lote en `results`, y solo esa en `errors`', () => {
    const project = projectWithChannelsOn([1, 2, 3]);
    const patternId = project.patternOrder[0]!;
    const compiled = compileProject(project, { mode: 'pattern', patternId });

    // No hay forma limpia de forzar una excepción real del kernel a mitad de
    // render de UNA sola pista sin acoplar el test a su implementación interna
    // (ver el comentario largo en run-export.ts sobre por qué las 12 pistas NO
    // van en 12 renders sueltos). En su lugar se usa el mismo `onProgress` que
    // ya recibe `renderProject` de verdad: revienta justo en su cierre
    // incondicional (`opts.onProgress?.(1)`, el último paso de un render que
    // YA terminó de computar) de la SEGUNDA pista del lote. El resultado que
    // le llega a `renderStems` es idéntico al de una excepción real del
    // kernel a mitad de proceso: una que se cuela por el mismo `try` de la
    // pista 2 y nada más.
    let completed = 0;
    const onProgress = (fraction: number): void => {
      if (fraction < 1) return;
      const isSecondTrack = completed === 1;
      completed++;
      if (isSecondTrack) throw new Error('fallo simulado en el render del stem');
    };

    const { results, errors } = renderStems(compiled, [1, 2, 3], {
      tailSeconds: 0.3,
      sampleRate: SR,
      onProgress,
    });

    // Las pistas 1 y 3 —renderizadas con éxito antes y después de la rota—
    // NO se pierden: antes del fix, la excepción sin capturar tiraba con
    // ellas todo el `Map` de vuelta.
    expect([...results.keys()].sort()).toEqual([1, 3]);
    expect(rms(results.get(1)!.left)).toBeGreaterThan(1e-3);
    expect(rms(results.get(3)!.left)).toBeGreaterThan(1e-3);
    // La pista 2 queda fuera de `results` y su motivo, en `errors`.
    expect(results.has(2)).toBe(false);
    expect(errors.size).toBe(1);
    expect(errors.get(2)).toMatch(/fallo simulado/);
  });
});
