/**
 * El `CompiledProject` mínimo con el que renderizan los generadores de packs.
 *
 * Vive aparte porque `generate.ts` (pack de fábrica) y `warehouse.ts` (pack
 * Warehouse) lo construían igual, copiado: un máster plano, sin clips de audio
 * ni LFOs, con los eventos ordenados por compás. Dos copias del mismo
 * ensamblado es la clase de duplicado que se arregla en un sitio y no en el
 * otro, y entonces los dos packs dejan de sonar con el mismo criterio.
 *
 * Import relativo a la fuente del engine por lo mismo que los generadores: el
 * index del paquete arrastra el worklet de Vite, que Node no resuelve fuera
 * del bundler.
 */

import type {
  CompiledAutomationEvent,
  CompiledChannel,
  CompiledEffect,
  CompiledMixerTrack,
  CompiledNoteEvent,
  CompiledProject,
} from '../../engine/src/protocol';

export interface ProyectoOpts {
  tempo: number;
  lengthBeats: number;
  channels: CompiledChannel[];
  events: CompiledNoteEvent[];
  masterSlots?: CompiledEffect[];
  automation?: CompiledAutomationEvent[];
}

/** Proyecto de render: máster plano (el pack se genera sin tocar el máster). */
export function proyecto(o: ProyectoOpts): CompiledProject {
  const master: CompiledMixerTrack = {
    id: 'master',
    volume: 1,
    pan: 0,
    stereoWidth: 1,
    // EQ del strip plana: el pack se genera sin tocar nada del máster.
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    audible: true,
    slots: o.masterSlots ?? [],
    routeTo: null,
    sends: [],
  };
  return {
    tempo: o.tempo,
    lengthBeats: o.lengthBeats,
    channels: o.channels,
    events: [...o.events].sort((a, b) => a.start - b.start),
    audioClips: [],
    automation: o.automation ?? [],
    lfos: [],
    mixer: [master],
    mixerOrder: [0],
  };
}
