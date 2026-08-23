/**
 * Qué samples se lleva el render offline.
 *
 * Esto se prueba aparte porque olvidarse de una fuente no da error: da
 * SILENCIO en el export. Y el silencio de un instrumento concreto dentro de
 * una mezcla es de lo último que se mira — se descubre al escuchar el máster
 * terminado, que es el peor momento posible.
 */

import { describe, expect, it } from 'vitest';
import { createKeymapZone } from '@orbit/core';
import type { CompiledChannel, CompiledProject } from '@orbit/engine';
import { neededSampleIds } from '../src/export/render-inputs';

function channel(patch: Partial<CompiledChannel> = {}): CompiledChannel {
  return {
    id: 'ch1',
    kind: 'sampler',
    params: {},
    volume: 1,
    pan: 0,
    audible: true,
    mixerTrack: 1,
    ...patch,
  };
}

function compiled(patch: Partial<CompiledProject> = {}): CompiledProject {
  return {
    tempo: 120,
    swing: 0,
    timeSigNum: 4,
    lengthBeats: 16,
    channels: [],
    events: [],
    audioClips: [],
    automation: [],
    lfos: [],
    mixer: [],
    mixerOrder: [],
    ...patch,
  } as CompiledProject;
}

describe('samples que necesita el render', () => {
  it('coge el sample del canal', () => {
    const p = compiled({ channels: [channel({ sampleId: 'uno' })] });
    expect([...neededSampleIds(p)]).toEqual(['uno']);
  });

  it('coge TAMBIÉN las muestras del keymap', () => {
    // El multisample tiene sus muestras en las zonas, no en `sampleId`.
    // Olvidarlas exportaba el instrumento entero en silencio.
    const p = compiled({
      channels: [
        channel({
          keymap: [
            createKeymapZone('grave', { keyRoot: 40 }),
            createKeymapZone('agudo', { keyRoot: 70 }),
          ],
        }),
      ],
    });
    expect([...neededSampleIds(p)].sort()).toEqual(['agudo', 'grave']);
  });

  it('con keymap Y sample suelto se lleva los dos', () => {
    // `sampleId` sigue viajando aunque mande el keymap (quitar el keymap
    // devuelve el canal a su sample), así que el render lo quiere igual.
    const p = compiled({
      channels: [
        channel({ sampleId: 'viejo', keymap: [createKeymapZone('nuevo', { keyRoot: 60 })] }),
      ],
    });
    expect([...neededSampleIds(p)].sort()).toEqual(['nuevo', 'viejo']);
  });

  it('coge los samples de los clips de audio', () => {
    const p = compiled({
      audioClips: [
        { sampleId: 'toma', start: 0, length: 4, offset: 0, gain: 1, trackIndex: 1 },
      ] as unknown as CompiledProject['audioClips'],
    });
    expect([...neededSampleIds(p)]).toEqual(['toma']);
  });

  it('no repite un sample que usan varios sitios', () => {
    const p = compiled({
      channels: [
        channel({ id: 'a', sampleId: 'comun' }),
        channel({ id: 'b', keymap: [createKeymapZone('comun', { keyRoot: 60 })] }),
      ],
    });
    expect([...neededSampleIds(p)]).toEqual(['comun']);
  });

  it('un proyecto sin audio no pide nada', () => {
    expect(neededSampleIds(compiled()).size).toBe(0);
  });
});
