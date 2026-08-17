/**
 * Permisos por rol: primero la función pura `checkRole` (el contrato), y
 * después el filtro real donde vive el control — el LOG DE COMANDOS, con dos
 * clientes enlazados a mano (sin red, como en convergence.test.ts).
 *
 * Lo que se comprueba de punta a punta:
 * - un invitado edita, pero lo suyo NO entra al log si borra pistas o toca el
 *   master, y su store vuelve al estado de la sala (no se rompe la sesión);
 * - un oyente no mete NADA;
 * - una entrada remota con rol insuficiente se descarta igual en el receptor
 *   (mismo veredicto en todos los clientes = convergencia intacta).
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createChannel,
  createEmptyProject,
  newId,
  parseProject,
  ProjectStore,
  serializeProject,
  type Command,
  type Project,
} from '@orbit/core';
import { CommandLogBinding, type DeniedInfo, type LogEntry } from '../src/command-log';
import { checkRole, type CollabRole } from '../src/roles';

// ── Comandos de muestra ──────────────────────────────────────────────────────

const setTempo: Command = { type: 'setTempo', tempo: 96 };

function addNotesCmd(patternId: string, channelId: string): Command {
  return {
    type: 'addNotes',
    patternId,
    channelId,
    notes: [{ id: newId(), start: 0, duration: 1, key: 36, velocity: 0.9, pan: 0, slide: false }],
  };
}

const masterFader: Command = {
  type: 'patchMixerTrack',
  trackIndex: 0,
  patch: { volume: 0.5 },
};

const insertFader: Command = {
  type: 'patchMixerTrack',
  trackIndex: 1,
  patch: { volume: 0.5 },
};

const masterEffect: Command = {
  type: 'setEffect',
  trackIndex: 0,
  slotIndex: 0,
  slot: { id: newId(), kind: 'limiter', enabled: true, mix: 1, params: { ceiling: -0.3 } },
};

const insertEffect: Command = {
  type: 'setEffect',
  trackIndex: 2,
  slotIndex: 0,
  slot: { id: newId(), kind: 'reverb', enabled: true, mix: 0.3, params: { size: 0.6 } },
};

// ── Contrato: checkRole ──────────────────────────────────────────────────────

describe('checkRole: qué deja pasar cada rol', () => {
  it('el productor puede con todo', () => {
    const todo: Command[] = [
      setTempo,
      masterFader,
      masterEffect,
      { type: 'removeChannel', channelId: 'ch1' },
      { type: 'removePlaylistTrack', trackId: 't1' },
      { type: 'removeArrangement', arrangementId: 'a1' },
    ];
    for (const cmd of todo) {
      expect(checkRole('productor', cmd).allowed).toBe(true);
    }
  });

  it('el invitado edita: tempo, notas, faders de insert y efectos que no son del master', () => {
    const permitidos: Command[] = [
      setTempo,
      { type: 'setSwing', swing: 0.2 },
      addNotesCmd('pat', 'ch'),
      insertFader,
      insertEffect,
      { type: 'setEffectParam', trackIndex: 3, slotIndex: 0, key: 'size', value: 0.8 },
      { type: 'addChannel', channel: createChannel('drums', 0) },
      { type: 'addClips', clips: [] },
      { type: 'removeClips', clipIds: ['c1'] },
      { type: 'removePattern', patternId: 'p1' },
    ];
    for (const cmd of permitidos) {
      expect(checkRole('invitado', cmd), `debería permitir ${cmd.type}`).toEqual({ allowed: true });
    }
  });

  it('el invitado NO borra pistas', () => {
    const borrados: Command[] = [
      { type: 'removeChannel', channelId: 'ch1' },
      { type: 'removePlaylistTrack', trackId: 't1' },
      { type: 'removeArrangement', arrangementId: 'a1' },
    ];
    for (const cmd of borrados) {
      const verdict = checkRole('invitado', cmd);
      expect(verdict.allowed, `debería bloquear ${cmd.type}`).toBe(false);
      expect(verdict.reason).toMatch(/borrar pistas/i);
    }
  });

  it('el invitado sí puede deshacer la creación de una pista suya', () => {
    const cmd: Command = { type: 'removeChannel', channelId: 'ch1' };
    expect(checkRole('invitado', cmd, { ownCreation: true }).allowed).toBe(true);
  });

  it('el invitado NO toca el master del mixer (fader, efectos, sends, ruta)', () => {
    const master: Command[] = [
      masterFader,
      masterEffect,
      { type: 'patchEffect', trackIndex: 0, slotIndex: 0, patch: { enabled: false } },
      { type: 'setEffectParam', trackIndex: 0, slotIndex: 0, key: 'ceiling', value: -1 },
      { type: 'setSend', trackIndex: 0, target: 3, level: 0.4 },
      { type: 'setRoute', trackIndex: 0, routeTo: null },
    ];
    for (const cmd of master) {
      const verdict = checkRole('invitado', cmd);
      expect(verdict.allowed, `debería bloquear ${cmd.type} en el master`).toBe(false);
      expect(verdict.reason).toMatch(/master/i);
    }
  });

  it('un lote cae entero si un solo sub-comando está prohibido', () => {
    const lote: Command = {
      type: 'batch',
      label: 'Pasada de mezcla',
      commands: [insertFader, addNotesCmd('pat', 'ch'), masterFader],
    };
    expect(checkRole('invitado', lote).allowed).toBe(false);
    expect(checkRole('productor', lote).allowed).toBe(true);

    const loteLimpio: Command = { type: 'batch', commands: [insertFader, insertEffect] };
    expect(checkRole('invitado', loteLimpio).allowed).toBe(true);
  });

  it('el oyente no pasa ni un comando', () => {
    const cualquiera: Command[] = [setTempo, insertFader, addNotesCmd('pat', 'ch'), insertEffect];
    for (const cmd of cualquiera) {
      const verdict = checkRole('oyente', cmd);
      expect(verdict.allowed, `debería bloquear ${cmd.type}`).toBe(false);
      expect(verdict.reason).toMatch(/oyente/i);
    }
    // Ni siquiera lo que "solo añade".
    expect(checkRole('oyente', { type: 'addChannel', channel: createChannel('synth', 0) }).allowed).toBe(
      false,
    );
  });
});

// ── El filtro real: el log de comandos ───────────────────────────────────────

function cloneProject(p: Project): Project {
  return parseProject(serializeProject(p));
}

interface Room {
  storeA: ProjectStore;
  storeB: ProjectStore;
  docA: Y.Doc;
  docB: Y.Doc;
  logA: Y.Array<LogEntry>;
  denied: DeniedInfo[];
}

/**
 * Sala de dos: A es el productor host, B entra con el rol que se le pase.
 * Los docs se enlazan a mano (cada update de uno se aplica en el otro).
 */
function room(roleB: CollabRole): Room {
  const base = createEmptyProject('Roles');
  const storeA = new ProjectStore(cloneProject(base));
  const storeB = new ProjectStore(cloneProject(base));
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const origin = { link: true };
  docA.on('update', (u: Uint8Array, o: unknown) => {
    if (o !== origin) Y.applyUpdate(docB, u, origin);
  });
  docB.on('update', (u: Uint8Array, o: unknown) => {
    if (o !== origin) Y.applyUpdate(docA, u, origin);
  });
  const denied: DeniedInfo[] = [];
  new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }, {
    getRole: () => 'productor',
  }).start();
  new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' }, {
    isHost: () => false,
    getRole: () => roleB,
    onDenied: (info) => denied.push(info),
  }).start();
  return { storeA, storeB, docA, docB, logA: docA.getArray<LogEntry>('commands'), denied };
}

describe('CommandLogBinding: el rol se aplica en el log', () => {
  it('el invitado edita y su cambio llega al productor', () => {
    const { storeA, storeB, denied } = room('invitado');
    storeB.dispatch({ type: 'setTempo', tempo: 96 });
    expect(storeA.project.tempo).toBe(96);
    expect(denied).toHaveLength(0);
  });

  it('el invitado que borra una pista ajena no ensucia el log ni pierde la sesión', () => {
    const { storeA, storeB, logA, denied } = room('invitado');
    // La pista la crea el productor.
    const ch = createChannel('sub808', 0);
    storeA.dispatch({ type: 'addChannel', channel: ch });
    expect(storeB.project.channels[ch.id]).toBeDefined();

    const entriesBefore = logA.length;
    storeB.dispatch({ type: 'removeChannel', channelId: ch.id });

    // Ni en el log, ni en el store del que lo intentó, ni en el del productor.
    expect(logA.length).toBe(entriesBefore);
    expect(storeB.project.channels[ch.id]).toBeDefined();
    expect(storeA.project.channels[ch.id]).toBeDefined();
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toMatch(/borrar pistas/i);
    expect(denied[0]!.local).toBe(true);

    // Y la sesión sigue viva: el siguiente comando legal pasa con normalidad.
    storeB.dispatch({ type: 'setSwing', swing: 0.3 });
    expect(storeA.project.swing).toBe(0.3);
    expect(serializeProject(storeA.project)).toBe(serializeProject(storeB.project));
  });

  it('el invitado sí borra la pista que él mismo creó (undo de su propio alta)', () => {
    const { storeA, storeB, denied } = room('invitado');
    const ch = createChannel('drums', 0);
    storeB.dispatch({ type: 'addChannel', channel: ch });
    expect(storeA.project.channels[ch.id]).toBeDefined();

    storeB.dispatch({ type: 'removeChannel', channelId: ch.id });
    expect(storeB.project.channels[ch.id]).toBeUndefined();
    expect(storeA.project.channels[ch.id]).toBeUndefined();
    expect(denied).toHaveLength(0);
  });

  it('el invitado no mueve el master, pero sí un insert', () => {
    const { storeA, storeB, denied } = room('invitado');
    storeB.dispatch({ type: 'patchMixerTrack', trackIndex: 0, patch: { volume: 0.2 } });
    expect(storeA.project.mixer[0]!.volume).toBe(1);
    expect(storeB.project.mixer[0]!.volume).toBe(1);
    expect(denied[0]!.reason).toMatch(/master/i);

    storeB.dispatch({ type: 'patchMixerTrack', trackIndex: 1, patch: { volume: 0.7 } });
    expect(storeA.project.mixer[1]!.volume).toBeCloseTo(0.7);
  });

  it('el oyente no mete nada en el log', () => {
    const { storeA, storeB, logA, denied } = room('oyente');
    const entriesBefore = logA.length;
    storeB.dispatch({ type: 'setTempo', tempo: 111 });
    storeB.dispatch({ type: 'addChannel', channel: createChannel('synth', 0) });

    expect(logA.length).toBe(entriesBefore);
    expect(storeA.project.tempo).toBe(140);
    expect(storeB.project.tempo).toBe(140); // revertido en local
    expect(storeB.project.channelOrder).toHaveLength(0);
    expect(denied).toHaveLength(2);

    // Pero sigue recibiendo lo del productor: mira y escucha.
    storeA.dispatch({ type: 'setTempo', tempo: 76 });
    expect(storeB.project.tempo).toBe(76);
  });

  it('una entrada remota con rol insuficiente se descarta en el receptor', () => {
    // Cliente manipulado: escribe en el log a mano, saltándose su binding.
    const { storeA, docB } = room('oyente');
    const logB = docB.getArray<LogEntry>('commands');
    logB.push([
      {
        cmd: { type: 'setTempo', tempo: 200 },
        origin: 'local',
        user: 'Beto',
        client: docB.clientID,
        seq: 999,
        role: 'oyente',
      },
    ]);
    expect(storeA.project.tempo).toBe(140);

    // Con el rol correcto en la entrada, esa misma orden sí entra.
    logB.push([
      {
        cmd: { type: 'setTempo', tempo: 200 },
        origin: 'local',
        user: 'Beto',
        client: docB.clientID,
        seq: 1000,
        role: 'productor',
      },
    ]);
    expect(storeA.project.tempo).toBe(200);
  });
});
