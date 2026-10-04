/**
 * BUG 003 — altas sin guardia de ID: sobrescriben la entidad previa y su undo la borra.
 *
 * Los canales, patrones, carpetas y arrangements ya estaban protegidos (el id
 * repetido se rechaza). Los demás pools no: un `add` con un id que ya vivía
 * escribía encima, el orden de ids quedaba duplicado y el INVERSO del alta —un
 * `remove*`, que borra por id— se llevaba por delante la entidad original. Al
 * deshacer, lo que desaparecía era lo que ya estaba, y el resto del proyecto se
 * quedaba con referencias rotas.
 *
 * Medido en la tarjeta con una entrada de audio: tras `addInputRoute` con el mismo
 * id dos veces y deshacer, `inputRoutes` quedaba vacío y `inputRouteOrder` con un
 * id huérfano. Ahora el id repetido se rechaza antes de mutar nada, y también
 * cuando el lote trae dos altas con el mismo id.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  serializeProject,
  type Clip,
  type Command,
  type Lfo,
  type Marker,
  type MixerTrack,
  type Project,
  type SampleRef,
  type Send,
} from '../src/index';

const clip = (id: string, trackId: string, start = 0): Clip => ({
  id,
  kind: 'audio',
  playlistTrackId: trackId,
  start,
  length: 4,
  muted: false,
  audioOffset: 0,
});

const lfo = (id: string): Lfo => ({
  id,
  target: { kind: 'transport', param: 'tempo' },
  shape: 'sine',
  rateBeats: 4,
  amount: 0.2,
  phase: 0,
  enabled: true,
});

const seccion = (id: string): {
  id: string;
  arrangementId: string;
  name: string;
  start: number;
  length: number;
} => ({ id, arrangementId: 'ar1', name: 'Intro', start: 0, length: 8 });

const marcador = (id: string): Marker => ({
  id,
  time: 4,
  name: 'corte',
  color: '#fff',
});

const sample = (id: string): SampleRef => ({
  id,
  name: 'a.wav',
  path: '/tmp/a.wav',
  hash: 'h1',
  duration: 1,
});

const ruta = (id: string): Parameters<typeof mkRuta>[0] => id;

function mkRuta(id: string): {
  id: string;
  name: string;
  channel: number;
  mixerTrack: number;
  armed: boolean;
  monitor: boolean;
  gain: number;
} {
  return { id, name: 'Micro', channel: 0, mixerTrack: 1, armed: false, monitor: false, gain: 1 };
}

/** Una entrada de audio en la sala, con su mixer. */
function mixerDePrueba(): MixerTrack {
  return {
    id: 'm1',
    name: 'Insert 1',
    color: '#3a3d45',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    slots: [],
    sends: [] as Send[],
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    routeTo: null,
  };
}

interface Caso {
  nombre: string;
  /** Deja el proyecto con UNA entidad viva de este pool, y devuelve su id. */
  sembrar: (p: Project) => string;
  /** El alta repetida, con el id que ya vive. */
  alta: (p: Project, id: string) => Command;
  /** Cómo se ve la entidad en el proyecto serializado. */
  entidad: (p: Project, id: string) => string;
}

const CASOS: Caso[] = [
  {
    nombre: 'entrada de audio',
    sembrar: (p) => {
      p.mixer.push(mixerDePrueba());
      applyCommand(p, { type: 'addInputRoute', route: mkRuta('r1') });
      return 'r1';
    },
    alta: () => ({ type: 'addInputRoute', route: mkRuta('r1') }),
    entidad: (p, id) => (p.inputRoutes[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'pista de playlist',
    sembrar: (p) => {
      applyCommand(p, {
        type: 'addPlaylistTrack',
        track: { id: 't1', arrangementId: p.activeArrangementId, name: 'Pista', color: '#fff', height: 56, muted: false, order: 0 },
      });
      return 't1';
    },
    alta: (p) => ({
      type: 'addPlaylistTrack',
      track: { id: 't1', arrangementId: p.activeArrangementId, name: 'Otra', color: '#fff', height: 56, muted: false, order: 0 },
    }),
    entidad: (p, id) => (p.playlistTracks[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'clip',
    sembrar: (p) => {
      applyCommand(p, {
        type: 'addPlaylistTrack',
        track: { id: 't1', arrangementId: p.activeArrangementId, name: 'Pista', color: '#fff', height: 56, muted: false, order: 0 },
      });
      applyCommand(p, { type: 'addClips', clips: [clip('c1', 't1')] });
      return 'c1';
    },
    alta: () => ({ type: 'addClips', clips: [clip('c1', 't1', 8)] }),
    entidad: (p, id) => (p.clips[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'LFO',
    sembrar: (p) => {
      applyCommand(p, { type: 'addLfos', lfos: [lfo('l1')] });
      return 'l1';
    },
    alta: () => ({ type: 'addLfos', lfos: [lfo('l1')] }),
    entidad: (p, id) => (p.lfos[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'sección',
    sembrar: (p) => {
      applyCommand(p, { type: 'addSections', sections: [seccion('s1')] });
      return 's1';
    },
    alta: () => ({ type: 'addSections', sections: [seccion('s1')] }),
    entidad: (p, id) => (p.sections[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'marcador',
    sembrar: (p) => {
      applyCommand(p, { type: 'addMarker', marker: marcador('k1') });
      return 'k1';
    },
    alta: () => ({ type: 'addMarker', marker: marcador('k1') }),
    entidad: (p, id) => (p.markers[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'sample',
    sembrar: (p) => {
      applyCommand(p, { type: 'registerSample', sample: sample('s1') });
      return 's1';
    },
    alta: () => ({ type: 'registerSample', sample: sample('s1') }),
    entidad: (p, id) => (p.samples[id] ? 'viva' : 'MUERTA'),
  },
  {
    nombre: 'nota',
    sembrar: (p) => {
      const canal = createChannel('synth', 0, 'C0');
      applyCommand(p, { type: 'addChannel', channel: canal });
      applyCommand(p, { type: 'addPattern', pattern: { id: 'pt1', name: 'P', color: '#fff', length: 4, notes: {} } });
      applyCommand(p, {
        type: 'addNotes',
        patternId: 'pt1',
        channelId: canal.id,
        notes: [{ id: 'n1', start: 0, duration: 1, key: 60, velocity: 1, pan: 0, slide: false }],
      });
      return 'n1';
    },
    alta: (p, id) => {
      const canal = Object.keys(p.channels)[0]!;
      return {
        type: 'addNotes',
        patternId: 'pt1',
        channelId: canal,
        notes: [{ id: 'n1', start: 2, duration: 1, key: 62, velocity: 1, pan: 0, slide: false }],
      };
    },
    entidad: (p) => {
      const notas = p.patterns.pt1?.notes ?? {};
      return Object.values(notas).flat().some((n) => n.id === 'n1') ? 'viva' : 'MUERTA';
    },
  },
];

describe('003 · un alta con un id que ya vive se rechaza antes de mutar nada', () => {
  for (const caso of CASOS) {
    it(`${caso.nombre}: el id repetido no pisa la entidad ni su undo la borra`, () => {
      const p = createEmptyProject();
      const id = caso.sembrar(p);
      const antes = serializeProject(p);

      // El alta repetida no vale: ni con una entidad nueva, ni pisando la que hay.
      expect(() => applyCommand(p, caso.alta(p, id))).toThrow(/Ya existe/);

      // El proyecto queda EXACTO como estaba: ni la entidad, ni su orden, ni su
      // contenido (un clip repetido con otro `start` no puede mover el original).
      expect(serializeProject(p)).toBe(antes);
      expect(caso.entidad(p, id)).toBe('viva');
    });

    it(`${caso.nombre}: el inverso de un alta repetida no se lleva lo anterior`, () => {
      // El recorrido completo de la tarjeta: alta, alta repetida, y deshacer. Sin
      // el guard, el deshacer se lleva la ORIGINAL (por eso se mide al final).
      const p = createEmptyProject();
      const id = caso.sembrar(p);
      const antes = serializeProject(p);
      const repetida = caso.alta(p, id);
      let inversa: Command | null = null;
      try {
        inversa = applyCommand(p, repetida);
      } catch {
        inversa = null;
      }
      if (inversa !== null) applyCommand(p, inversa);
      expect(serializeProject(p)).toBe(antes);
      expect(caso.entidad(p, id)).toBe('viva');
    });
  }

  it('los pools que ya estaban protegidos siguen rechazando (y se nota cuál es cuál)', () => {
    const p = createEmptyProject();
    const canal = createChannel('synth', 0, 'C0');
    applyCommand(p, { type: 'addChannel', channel: canal });
    expect(() => applyCommand(p, { type: 'addChannel', channel: { ...canal } })).toThrow(
      /Ya existe: canal/,
    );
    applyCommand(p, { type: 'addPattern', pattern: { id: 'pt1', name: 'P', color: '#fff', length: 4, notes: {} } });
    expect(() =>
      applyCommand(p, { type: 'addPattern', pattern: { id: 'pt1', name: 'P', color: '#fff', length: 4, notes: {} } }),
    ).toThrow(/Ya existe: patrón/);
  });

  it('un lote con dos altas del MISMO id no deja el proyecto a medias', () => {
    const p = createEmptyProject();
    const antes = serializeProject(p);
    expect(() =>
      applyCommand(p, {
        type: 'batch',
        label: 'dos clips con el mismo id',
        commands: [
          { type: 'addClips', clips: [clip('c1', 't1')] },
          { type: 'addClips', clips: [clip('c1', 't1')] },
        ],
      }),
    ).toThrow(/Ya existe: clip/);
    // Todo-o-nada: el primer clip tampoco se queda.
    expect(serializeProject(p)).toBe(antes);
    expect(Object.keys(p.clips)).toEqual([]);
  });

  it('dentro de una sola lista de altas, el id repetido también se rechaza', () => {
    const p = createEmptyProject();
    const antes = serializeProject(p);
    // Los dos clips llevan el MISMO id, en la misma lista.
    expect(() =>
      applyCommand(p, { type: 'addClips', clips: [clip('c9', 't1'), clip('c9', 't1', 8)] }),
    ).toThrow(/Ya existe: clip/);
    expect(serializeProject(p)).toBe(antes);
  });

  it('un id que sí es nuevo en un lote con varios entra todos', () => {
    const p = createEmptyProject();
    applyCommand(p, {
      type: 'addClips',
      clips: [clip('c1', 't1'), clip('c2', 't1'), clip('c3', 't1')],
    });
    expect(Object.keys(p.clips).sort()).toEqual(['c1', 'c2', 'c3']);
    // Y deshacerlos deja el proyecto como estaba.
    const antes = serializeProject(p);
    const inversa = applyCommand(p, { type: 'removeClips', clipIds: ['c1', 'c2', 'c3'] });
    applyCommand(p, inversa);
    expect(serializeProject(p)).toBe(antes);
  });

  it('el id huérfano en el orden era el síntoma: ahora el orden tampoco se duplica', () => {
    const p = createEmptyProject();
    p.mixer.push(mixerDePrueba());
    applyCommand(p, { type: 'addInputRoute', route: mkRuta('r1') });
    expect(() => applyCommand(p, { type: 'addInputRoute', route: mkRuta('r1') })).toThrow();
    // Un solo id en el orden, y la entrada sigue ahí.
    expect(p.inputRouteOrder).toEqual(['r1']);
    expect(Object.keys(p.inputRoutes)).toEqual(['r1']);
  });
});