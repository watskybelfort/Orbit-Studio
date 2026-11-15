/**
 * Cierre de los hallazgos de la auditoría de noviembre: las puertas del bus
 * dejan de aceptar transporte imposible, arrangement fantasma, altas repetidas,
 * layouts corruptos y cadenas de inserts truncadas. Cada caso se comprobaba a
 * mano con un script fuera del repo; aquí queda fijado.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  commandProblem,
  createChannel,
  createEmptyProject,
  createInputRoute,
  parseProject,
  ProjectStore,
  serializeProject,
  type Command,
} from '../src/index';

function roundTrip(project: ReturnType<typeof createEmptyProject>): string {
  return serializeProject(project);
}

describe('transporte: rangos en la puerta y en el archivo', () => {
  it('rechaza tempo, swing y compás imposibles antes de mutar', () => {
    const p = createEmptyProject();
    const before = roundTrip(p);
    for (const cmd of [
      { type: 'setTempo', tempo: -40 },
      { type: 'setTempo', tempo: 1200 },
      { type: 'setSwing', swing: 9 },
      { type: 'setSwing', swing: -0.1 },
      { type: 'setTimeSig', timeSig: { num: 0, den: 4 } },
      { type: 'setTimeSig', timeSig: { num: 4, den: 0 } },
      { type: 'setTimeSig', timeSig: { num: 4.5, den: 4 } },
    ] as Command[]) {
      expect(() => applyCommand(p, cmd)).toThrow(/fuera de rango/);
    }
    expect(roundTrip(p)).toBe(before);
  });

  it('parseProject rechaza un .orbit con tempo o compás fuera de rango', () => {
    const p = createEmptyProject();
    const json = JSON.parse(roundTrip(p)) as Record<string, unknown>;
    json['tempo'] = -40;
    expect(() => parseProject(JSON.stringify(json))).toThrow(/tempo/);

    const otro = JSON.parse(roundTrip(p)) as Record<string, unknown>;
    otro['timeSig'] = { num: 0, den: 4 };
    expect(() => parseProject(JSON.stringify(otro))).toThrow(/timeSig/);
  });
});

describe('arrangement activo', () => {
  it('no se puede activar un arrangement que no existe', () => {
    const p = createEmptyProject();
    expect(() => applyCommand(p, { type: 'setActiveArrangement', arrangementId: 'ghost' }))
      .toThrow(/No existe/);
    expect(p.activeArrangementId).not.toBe('ghost');
  });
});

describe('altas repetidas en restore*', () => {
  it('restoreChannel se rechaza si el canal ya está', () => {
    const p = createEmptyProject();
    const channel = createChannel('sub808', 0);
    applyCommand(p, { type: 'addChannel', channel });
    expect(() => applyCommand(p, {
      type: 'restoreChannel', channel, index: 0, notesByPattern: {},
    })).toThrow(/Ya existe/);
    expect(p.channelOrder.filter((id) => id === channel.id)).toHaveLength(1);
  });

  it('restoreClips se rechaza si el clip ya está', () => {
    const p = createEmptyProject();
    const trackId = Object.values(p.playlistTracks)[0]!.id;
    const clip = {
      id: 'clip-x', kind: 'audio' as const, playlistTrackId: trackId,
      start: 0, length: 1, muted: false,
    };
    applyCommand(p, { type: 'addClips', clips: [clip] });
    expect(() => applyCommand(p, { type: 'restoreClips', clips: [clip] }))
      .toThrow(/Ya existe/);
  });
});

describe('inversos con el índice perdido', () => {
  it('una entrada fuera del orden vuelve al final, no al principio', () => {
    const p = createEmptyProject();
    const a = createInputRoute(0);
    const b = createInputRoute(2);
    applyCommand(p, { type: 'addInputRoute', route: a });
    applyCommand(p, { type: 'addInputRoute', route: b });
    // Simula un merge: la ruta existe en el pool pero no en el orden.
    p.inputRouteOrder = [b.id];
    const inverse = applyCommand(p, { type: 'removeInputRoute', routeId: a.id });
    applyCommand(p, inverse);
    expect(p.inputRouteOrder).toEqual([b.id, a.id]);
  });
});

describe('layouts', () => {
  it('un layouts que no es mapa no entra al proyecto', () => {
    const p = createEmptyProject();
    const json = JSON.parse(roundTrip(p)) as Record<string, unknown>;
    json['layouts'] = 42;
    expect(() => parseProject(JSON.stringify(json))).toThrow(/layouts/);
  });

  it('guardar un layout con nombre reservado no toca el prototipo', () => {
    const p = createEmptyProject();
    expect(() => applyCommand(p, {
      type: 'setLayout',
      name: '__proto__',
      windows: { playlist: { open: true, x: 0, y: 0, w: 100, h: 100 } },
    })).toThrow(/reservada/);
    expect(Object.keys(p.layouts ?? {})).toEqual([]);
  });

  it('un layout guardado por la app vuelve a abrirse (dos niveles)', () => {
    const p = createEmptyProject();
    applyCommand(p, {
      type: 'setLayout',
      name: 'Mezcla',
      windows: {
        playlist: { open: true, x: 12, y: 12, w: 700, h: 400 },
        mixer: { open: true, x: 12, y: 424, w: 700, h: 300 },
        browser: { open: true, x: 0, y: 0, w: 0, h: 0 },
      },
    });
    const json = serializeProject(p);
    const reopened = parseProject(json);
    expect(reopened.layouts?.['Mezcla']).toEqual(p.layouts?.['Mezcla']);
  });

  it('un layout con una ventana rota se rechaza con la ruta completa', () => {
    const p = createEmptyProject();
    const json = JSON.parse(roundTrip(p)) as Record<string, unknown>;
    json['layouts'] = { Mezcla: { playlist: { open: 'sí', x: 0, y: 0, w: 10, h: 10 } } };
    expect(() => parseProject(JSON.stringify(json))).toThrow(/layouts\.Mezcla\.playlist\.open/);
  });
});

describe('cadena de inserts', () => {
  it('un patchChannel no puede truncar fx', () => {
    const p = createEmptyProject();
    const channel = createChannel('synth', 0);
    applyCommand(p, { type: 'addChannel', channel });
    expect(() => applyCommand(p, {
      type: 'patchChannel',
      channelId: channel.id,
      patch: { fx: [null] },
    })).toThrow(/huecos/);
    expect(p.channels[channel.id]!.fx).toHaveLength(4);
  });
});

describe('restore* con id ocupado', () => {
  it('restoreLfos rechaza pisar un LFO que ya existe', () => {
    const p = createEmptyProject();
    const lfo = {
      id: 'L1', target: { kind: 'channel', channelId: 'c', param: 'cutoff' },
      shape: 'sine', rateBeats: 4, amount: 0.5, phase: 0, enabled: true,
    } as never;
    applyCommand(p, { type: 'addLfos', lfos: [lfo] });
    expect(p.lfos['L1']).toBeTruthy();
    expect(() => applyCommand(p, { type: 'restoreLfos', lfos: [lfo] })).toThrow(/LFO/);
    // El que ya estaba sigue exactamente donde estaba.
    expect(p.lfos['L1']).toBeTruthy();
  });

  it('restoreSections rechaza pisar una sección que ya existe', () => {
    const p = createEmptyProject();
    const section = {
      id: 'S1', arrangementId: p.activeArrangementId, name: 'Estribillo', start: 8, length: 4,
    } as never;
    applyCommand(p, { type: 'addSections', sections: [section] });
    expect(() => applyCommand(p, { type: 'restoreSections', sections: [section] })).toThrow(/sección/);
    expect(p.sections['S1']).toBeTruthy();
  });
});

describe('campos que un patch no puede tocar', () => {
  it('patchMixerTrack no puede reemplazar la lista de inserts ni los envíos', () => {
    expect(commandProblem({
      type: 'patchMixerTrack', trackIndex: 0, patch: { slots: null },
    } as never)).toBeTruthy();
    expect(commandProblem({
      type: 'patchMixerTrack', trackIndex: 0, patch: { sends: null },
    } as never)).toBeTruthy();
    // Los campos normales siguen pasando.
    expect(commandProblem({
      type: 'patchMixerTrack', trackIndex: 0, patch: { volume: 0.8 },
    } as never)).toBeNull();
  });

  it('patchPattern no puede reemplazar el mapa de notas', () => {
    const p = createEmptyProject();
    expect(commandProblem({
      type: 'patchPattern', patternId: p.patternOrder[0]!, patch: { notes: {} },
    } as never)).toBeTruthy();
    expect(commandProblem({
      type: 'patchPattern', patternId: p.patternOrder[0]!, patch: { name: 'Otro' },
    } as never)).toBeNull();
  });
});

describe('keymap y slicePoints rotos no revientan con un TypeError', () => {
  it('un keymap que no es lista se descarta al parsear', () => {
    const p = createEmptyProject();
    const channel = createChannel('sampler', 0);
    applyCommand(p, { type: 'addChannel', channel });
    const json = JSON.parse(roundTrip(p)) as Record<string, Record<string, unknown>>;
    const channels = json['channels'] as Record<string, Record<string, unknown>>;
    channels[channel.id]!['keymap'] = 42;
    const parsed = parseProject(JSON.stringify(json));
    expect(parsed.channels[channel.id]?.keymap).toBeUndefined();
  });

  it('un slicePoints que no es lista se descarta al parsear', () => {
    const p = createEmptyProject();
    const channel = createChannel('sampler', 0);
    applyCommand(p, { type: 'addChannel', channel });
    const json = JSON.parse(roundTrip(p)) as Record<string, Record<string, unknown>>;
    const channels = json['channels'] as Record<string, Record<string, unknown>>;
    channels[channel.id]!['slicePoints'] = 'hola';
    const parsed = parseProject(JSON.stringify(json));
    expect(parsed.channels[channel.id]?.slicePoints).toBeUndefined();
  });
});

describe('renombrar una toma', () => {
  it('patchSample cambia el nombre y su inverso lo repone', () => {
    const p = createEmptyProject();
    applyCommand(p, {
      type: 'registerSample',
      sample: { id: 's1', name: 'Toma', path: 'recording:a.wav', hash: 'h', duration: 1 },
    });
    const inverse = applyCommand(p, {
      type: 'patchSample',
      sampleId: 's1',
      patch: { name: 'Toma 2 · doblaje' },
    });
    expect(p.samples['s1']!.name).toBe('Toma 2 · doblaje');
    applyCommand(p, inverse);
    expect(p.samples['s1']!.name).toBe('Toma');
  });
});

describe('campos fantasma de una nota', () => {  it('patchNotes rechaza un campo que Note no tiene', () => {
    const p = createEmptyProject();
    const patternId = p.patternOrder[0]!;
    const channel = createChannel('synth', 0);
    applyCommand(p, { type: 'addChannel', channel });
    const channelId = channel.id;
    applyCommand(p, {
      type: 'addNotes',
      patternId,
      channelId,
      notes: [{
        id: 'n1', start: 0, duration: 1, key: 60, velocity: 0.8, pan: 0, slide: false,
      }],
    });
    expect(() => applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [{ id: 'n1', bend: 7 } as never],
    })).toThrow(/bend no es un campo|Nota sin campo "bend"/);
    expect('bend' in p.patterns[patternId]!.notes[channelId]![0]!).toBe(false);
  });
});

describe('undo bloqueado', () => {
  it('el primer intento no miente y el segundo salta el paso muerto', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'local' });
    const ch = createChannel('sub808', 0);
    store.dispatch({ type: 'addChannel', channel: ch }, { origin: 'local' });
    // Otro origen borra el canal: el inverso de addChannel ya no puede aplicarse.
    store.dispatch({ type: 'removeChannel', channelId: ch.id }, { origin: 'claude' });

    const bloqueado = store.historyView();
    expect(store.undo('local')).toBe(false);
    expect(store.historyView()).toEqual(bloqueado);

    // El segundo Ctrl+Z salta el paso muerto y deshace el tempo, que sí puede.
    expect(store.undo('local')).toBe(true);
    expect(store.project.tempo).toBe(140);
    // La entrada muerta sigue ahí para cuando el mundo la permita.
    expect(store.historyView().entries.length).toBeGreaterThan(0);
  });
});
