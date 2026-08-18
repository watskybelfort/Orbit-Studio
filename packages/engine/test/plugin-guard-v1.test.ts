/**
 * Aislamiento de plugins que emiten NaN/Inf.
 *
 * El sandbox capturaba EXCEPCIONES (bypass), pero no una señal envenenada: un
 * solo NaN de un plugin se propagaba a los estados IIR de los efectos de detrás
 * (biquads, delay, reverb) y los dejaba en NaN para siempre. Ahora la salida del
 * plugin se escanea y, si no es finita, el bloque va a cero y el slot a bypass.
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
import { renderProject } from '../src/render/offline';

const SR = 44100;

const NAN_FX = `
function createEffect() {
  return {
    process(l, r, n) {
      for (let i = 0; i < n; i++) { l[i] = NaN; r[i] = NaN; }
    },
  };
}`;

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

function hasNaN(xs: Float32Array): boolean {
  for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i]!)) return true;
  return false;
}

function projectWithSynthOnTrack1(): Project {
  const project = createEmptyProject('NaN guard');
  project.tempo = 240;
  const ch = createChannel('synth', 0, 'Lead');
  ch.mixerTrack = 1;
  ch.volume = 0.8;
  Object.assign(ch.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
  applyCommand(project, { type: 'addChannel', channel: ch });
  applyCommand(project, {
    type: 'addNotes',
    patternId: project.patternOrder[0]!,
    channelId: ch.id,
    notes: [note(0, 1, 60)],
  });
  return project;
}

describe('plugin de efecto que emite NaN', () => {
  it('no envenena la cadena: la salida sigue siendo finita', () => {
    const project = projectWithSynthOnTrack1();
    // Slot 0: el plugin que saca NaN. Slot 1: un delay (IIR) que, sin el scrub,
    // se quedaría en NaN para siempre por su realimentación.
    project.mixer[1]!.slots[0] = {
      id: newId(),
      kind: 'plugin',
      enabled: true,
      mix: 1,
      params: {},
      pluginId: 'nanfx',
    };
    project.mixer[1]!.slots[1] = {
      id: newId(),
      kind: 'delay',
      enabled: true,
      mix: 1,
      params: { ...defaultEffectParams('delay') },
    };

    const compiled = compileProject(project, {
      mode: 'pattern',
      patternId: project.patternOrder[0]!,
    });
    const res = renderProject(compiled, {
      tailSeconds: 0.2,
      sampleRate: SR,
      plugins: new Map([['nanfx', NAN_FX]]),
    });

    // Sin el scrub, res sería NaN por todas partes (el delay y el master
    // envenenados). Con el scrub, el plugin aporta silencio y todo es finito.
    expect(hasNaN(res.left)).toBe(false);
    expect(hasNaN(res.right)).toBe(false);
  });
});
