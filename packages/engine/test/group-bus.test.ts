/**
 * Carpetas del rack que suman a un bus, vistas desde el motor.
 *
 * La promesa es que la carpeta NO llega al kernel: el compilador la deja en
 * enrutado normal —el canal se compila en la pista del bus, y la pista propia de
 * un canal desemboca en el bus— y a partir de ahí es el motor de siempre. Así
 * que aquí no se comprueba una estructura bonita: se comprueba que bajar el
 * fader del bus apaga la sección, que el compresor del bus la toca entera, y que
 * el export de stems sigue aislando con el bus de por medio.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultEffectParams,
  newId,
  type ChannelGroup,
  type EffectSlot,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { audibleTracksForStem, renderProject, renderStems } from '../src/render/offline';

const SR = 44100;

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

function rms(xs: Float32Array): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, xs.length));
}

function group(name: string, patch: Partial<ChannelGroup> = {}): ChannelGroup {
  return { id: newId(), name, color: '#5aa9e6', collapsed: false, ...patch };
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

/** Un canal de sinte con una nota, en la pista pedida. */
function addVoice(project: Project, name: string, key: number, mixerTrack = 0): string {
  const ch = createChannel('synth', project.channelOrder.length, name);
  ch.mixerTrack = mixerTrack;
  ch.volume = 0.8;
  Object.assign(ch.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
  applyCommand(project, { type: 'addChannel', channel: ch });
  applyCommand(project, {
    type: 'addNotes',
    patternId: project.patternOrder[0]!,
    channelId: ch.id,
    notes: [note(0, 1, key)],
  });
  return ch.id;
}

function emptyProject(): Project {
  const project = createEmptyProject('Buses');
  project.tempo = 240;
  return project;
}

function compile(project: Project) {
  return compileProject(project, { mode: 'pattern', patternId: project.patternOrder[0]! });
}

function mixOf(project: Project): Float32Array {
  return renderProject(compile(project), { tailSeconds: 0.3, sampleRate: SR }).left;
}

function stemOf(project: Project, idx: number): Float32Array {
  return renderStems(compile(project), [idx], { tailSeconds: 0.3, sampleRate: SR }).get(idx)!.left;
}

/** Mete canales en una carpeta nueva con el bus pedido. */
function groupWithBus(project: Project, name: string, ids: string[], busTrack: number): ChannelGroup {
  const g = group(name, { busTrack });
  applyCommand(project, { type: 'addChannelGroup', group: g });
  for (const channelId of ids) {
    applyCommand(project, { type: 'patchChannel', channelId, patch: { groupId: g.id } });
  }
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('el compilador resuelve la carpeta a enrutado normal', () => {
  it('los canales del grupo se compilan EN la pista de bus', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36);
    const b = addVoice(project, 'Snare', 38);
    groupWithBus(project, 'Drums', [a, b], 5);

    const compiled = compile(project);
    expect(compiled.channels.map((c) => c.mixerTrack)).toEqual([5, 5]);
  });

  it('la pista propia de un canal del grupo desemboca en el bus', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36, 3);
    groupWithBus(project, 'Drums', [a], 5);

    const compiled = compile(project);
    expect(compiled.channels[0]!.mixerTrack).toBe(3); // conserva su strip
    expect(compiled.mixer[3]!.routeTo).toBe(5); // y sale por el bus
    expect(compiled.mixer[5]!.routeTo).toBe(0);
  });

  it('sin bus, el compilado es IDÉNTICO al del mismo proyecto sin carpeta', () => {
    const withGroup = emptyProject();
    const a = addVoice(withGroup, 'Kick', 36);
    const g = group('Drums');
    applyCommand(withGroup, { type: 'addChannelGroup', group: g });
    applyCommand(withGroup, { type: 'patchChannel', channelId: a, patch: { groupId: g.id } });

    const compiled = compile(withGroup);
    expect(compiled.channels[0]!.mixerTrack).toBe(0);
    expect(compiled.channels[0]!.audible).toBe(true);
    expect(compiled.mixer.map((t) => t.routeTo)).toEqual(
      compile(emptyProject()).mixer.map((t) => t.routeTo),
    );
  });

  it('el mute de la carpeta llega al kernel como canales no audibles', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36);
    const b = addVoice(project, 'Lead', 60);
    const g = groupWithBus(project, 'Drums', [a], 5);
    applyCommand(project, { type: 'patchChannelGroup', groupId: g.id, patch: { mute: true } });

    expect(compile(project).channels.map((c) => c.audible)).toEqual([false, true]);
    expect(b).toBeTruthy();
  });

  it('el solo de la carpeta enmudece lo de fuera', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36);
    addVoice(project, 'Lead', 60);
    const g = groupWithBus(project, 'Drums', [a], 5);
    applyCommand(project, { type: 'patchChannelGroup', groupId: g.id, patch: { solo: true } });

    expect(compile(project).channels.map((c) => c.audible)).toEqual([true, false]);
  });
});

describe('el bus suena de verdad', () => {
  it('bajar el fader del bus apaga la sección entera', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36);
    const b = addVoice(project, 'Snare', 43);
    groupWithBus(project, 'Drums', [a, b], 5);

    const before = rms(mixOf(project));
    expect(before).toBeGreaterThan(1e-3);

    project.mixer[5]!.volume = 0;
    // Si los canales siguieran yendo al Master, esto no cambiaría nada.
    expect(rms(mixOf(project))).toBeLessThan(before * 0.01);
  });

  it('el mute del bus apaga los canales que van por él y solo esos', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36);
    addVoice(project, 'Lead', 67); // fuera de la carpeta, directo al Master
    groupWithBus(project, 'Drums', [a], 5);

    const full = rms(mixOf(project));
    project.mixer[5]!.mute = true;
    const rest = rms(mixOf(project));
    expect(rest).toBeGreaterThan(1e-3); // el lead sigue sonando
    expect(rest).toBeLessThan(full);
  });

  it('un efecto en el bus toca a los canales del grupo, con pista propia o sin ella', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36); // sin pista propia
    const b = addVoice(project, 'Snare', 43, 3); // con la suya
    groupWithBus(project, 'Drums', [a, b], 5);

    const dry = mixOf(project);
    project.mixer[5]!.slots[0] = reverbSlot();
    const wet = mixOf(project);
    // La reverb del bus alarga la cola: hay energía donde antes ya no había.
    const tailFrom = Math.floor(SR * 0.4);
    const tail = (xs: Float32Array) => rms(xs.subarray(Math.min(tailFrom, xs.length)));
    expect(tail(wet)).toBeGreaterThan(tail(dry) * 2);
  });
});

describe('stems con un bus de carpeta de por medio', () => {
  it('el stem de un canal del grupo no sale mudo: el bus sigue audible', () => {
    const project = emptyProject();
    const a = addVoice(project, 'Kick', 36, 3);
    addVoice(project, 'Lead', 67, 7);
    groupWithBus(project, 'Drums', [a], 5);

    expect(audibleTracksForStem(compile(project), 3)).toEqual(new Set([0, 3, 5]));
    expect(rms(stemOf(project, 3))).toBeGreaterThan(1e-3);
  });

  it('el stem de una pista NO trae el audio de la otra carpeta', () => {
    const project = emptyProject();
    const kick = addVoice(project, 'Kick', 36, 3);
    const bass = addVoice(project, 'Bass', 31, 4);
    groupWithBus(project, 'Drums', [kick], 5);
    groupWithBus(project, 'Bajos', [bass], 6);

    // Cada uno por su bus, y ni el bus ni la pista del otro se cuelan.
    expect(audibleTracksForStem(compile(project), 3)).toEqual(new Set([0, 3, 5]));
    expect(audibleTracksForStem(compile(project), 4)).toEqual(new Set([0, 4, 6]));

    const only = stemOf(project, 3);
    const both = mixOf(project);
    expect(rms(only)).toBeGreaterThan(1e-3);
    expect(rms(only)).toBeLessThan(rms(both));
  });

  it('el stem de la PISTA DE BUS trae el grupo entero, no silencio', () => {
    const project = emptyProject();
    const kick = addVoice(project, 'Kick', 36, 3);
    const snare = addVoice(project, 'Snare', 43, 4);
    addVoice(project, 'Lead', 67, 7); // ajeno al grupo
    groupWithBus(project, 'Drums', [kick, snare], 5);

    // Aguas arriba del bus están las dos pistas del grupo; la 7 no.
    expect(audibleTracksForStem(compile(project), 5)).toEqual(new Set([0, 3, 4, 5]));

    const busStem = stemOf(project, 5);
    expect(rms(busStem)).toBeGreaterThan(1e-3);
    // Y trae MÁS que el stem de una sola de sus pistas.
    expect(rms(busStem)).toBeGreaterThan(rms(stemOf(project, 3)));
  });

  it('el stem del bus de una carpeta no trae el de la otra', () => {
    const project = emptyProject();
    const kick = addVoice(project, 'Kick', 36, 3);
    const bass = addVoice(project, 'Bass', 31, 4);
    groupWithBus(project, 'Drums', [kick], 5);
    groupWithBus(project, 'Bajos', [bass], 6);

    const drums = stemOf(project, 5);
    const bajos = stemOf(project, 6);
    expect(rms(drums)).toBeGreaterThan(1e-3);
    expect(rms(bajos)).toBeGreaterThan(1e-3);
    // El stem de la batería es EXACTAMENTE el de su pista: nada del bajo entró.
    const soloKick = stemOf(project, 3);
    expect([...drums].every((v, i) => Math.abs(v - soloKick[i]!) < 1e-6)).toBe(true);
  });

  it('el mute de la carpeta también apaga su stem', () => {
    const project = emptyProject();
    const kick = addVoice(project, 'Kick', 36, 3);
    const g = groupWithBus(project, 'Drums', [kick], 5);
    expect(rms(stemOf(project, 5))).toBeGreaterThan(1e-3);

    applyCommand(project, { type: 'patchChannelGroup', groupId: g.id, patch: { mute: true } });
    expect(rms(stemOf(project, 5))).toBeLessThan(1e-6);
  });

  it('una hoja del grafo saca el mismo stem que antes de que existiera aguas arriba', () => {
    // Red de seguridad del cambio en audibleTracksForStem: de una pista de
    // instrumento no cuelga nada, así que su conjunto audible no se movió.
    const project = emptyProject();
    addVoice(project, 'Lead', 67, 2);
    expect(audibleTracksForStem(compile(project), 2)).toEqual(new Set([0, 2]));
  });
});
