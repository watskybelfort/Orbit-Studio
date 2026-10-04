/**
 * Follow-up de 017/018/002 tras la revisión de #8 sobre el esquema compartido.
 *
 * Los cuatro huecos que encontró, y que aquí quedan con su forma exacta:
 *
 *  1. `mixer[0].slots = null` pasaba `parseProject` y reventaba al compilar con un
 *     TypeError leyendo `.map`. El `|null` de una lista era del ARRAY, no de sus
 *     elementos: el hueco de un slot vacío es `null` DENTRO del array.
 *  2. `patchChannel` con `patch: { volume: <marca de borrado> }` pasaba y dejaba el
 *     canal sin volumen → NaN en el render entero. La marca solo puede quitar lo
 *     que se puede quitar, y un `undefined` tampoco vale para vaciar un
 *     obligatorio.
 *  3. La marca era la CADENA `'\u0000unset'`, que colisionaba con texto legítimo: un
 *     canal cuyo nombre fuese exactamente ese texto se quedaba `undefined` al
 *     deshacer. Ahora es un sobre, que no se puede confundir con un valor de campo.
 *  4. `ParamRef` es una unión de seis ramas y la tabla solo miraba tipos: un
 *     `{ kind: 'mixer', param: 'volume' }` sin `trackIndex` pasaba.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  commandProblem,
  createChannel,
  createEmptyProject,
  esUnset,
  findProjectProblems,
  serializeProject,
  UNSET,
  type Lfo,
  type Send,
} from '../src/index';

/** Los campos que `findProjectProblems` señala, para poder mirarlos con `toMatch`. */
function campos(p: unknown): string {
  return findProjectProblems(p as Record<string, unknown>)
    .map((x) => `${x.field}: ${x.expected}`)
    .join(' | ');
}

/** El id del primer canal del proyecto. */
function unCanal(p: ReturnType<typeof createEmptyProject>): string {
  return p.channels[Object.keys(p.channels)[0]!]!.id;
}

/** El proyecto vacío no trae canales, y casi todo lo que se prueba aquí es un canal. */
function proyecto(): ReturnType<typeof createEmptyProject> {
  const p = createEmptyProject();
  applyCommand(p, { type: 'addChannel', channel: createChannel('synth', 0, 'C0') });
  return p;
}

describe('follow-up · una lista nula se rechaza, sus huecos no', () => {
  it('mixer[0].slots = null: el proyecto entero se rechaza', () => {
    const p = proyecto() as unknown as { mixer: { slots: unknown }[] };
    p.mixer[0]!.slots = null;
    expect(campos(p)).toMatch(/slots/);
  });

  it('la lista de efectos de un canal tampoco puede ser null', () => {
    const p = proyecto();
    (p.channels[unCanal(p)] as unknown as { fx: unknown }).fx = null;
    expect(campos(p)).toMatch(/fx/);
  });

  it('pero un HUECO dentro de la lista sigue valiendo (slot vacío)', () => {
    const p = proyecto();
    p.mixer[0]!.slots = [
      null,
      { id: 'fx1', kind: 'compressor', enabled: true, mix: 1, params: {} },
    ];
    expect(campos(p)).toEqual('');
  });

  it('y un null en una lista que no admite huecos se rechaza', () => {
    const p = proyecto();
    p.mixer[1]!.sends = [{ target: 2, level: 0.5 }, null as unknown as Send];
    expect(campos(p)).toMatch(/sends\[1\]/);
  });
});

describe('follow-up · la marca de borrado solo borra lo que se puede borrar', () => {
  it('borrar un campo OBLIGATORIO con la marca se rechaza en la puerta', () => {
    const problema = commandProblem({
      type: 'patchChannel',
      channelId: 'c1',
      patch: { volume: UNSET },
    });
    expect(problema).toMatch(/volume/);
    expect(problema).toMatch(/no se puede borrar/);
  });

  it('y con `undefined` tampoco: un patch no puede vaciar un obligatorio', () => {
    const problema = commandProblem({
      type: 'patchChannel',
      channelId: 'c1',
      patch: { volume: undefined },
    });
    expect(problema).toMatch(/volume/);
  });

  it('un opcional sí se puede quitar con la marca (sigue siendo el caso de 002)', () => {
    expect(
      commandProblem({ type: 'patchChannel', channelId: 'c1', patch: { groupId: UNSET } }),
    ).toBeNull();
  });

  it('un opcional con `undefined` se queda vacío (así lo usa el motor)', () => {
    // El motor vacía opcionales mandando `undefined` (`patchChannel` con
    // `sampleId: undefined` saca la muestra del canal), así que aquí no se escribe
    // un `undefined` en la entidad: se quita la clave. Lo que no puede pasar es
    // vaciar un obligatorio, y eso lo rechaza la puerta (test de arriba).
    const p = proyecto();
    const id = unCanal(p);
    applyCommand(p, {
      type: 'addChannelGroup',
      group: { id: 'g1', name: 'G', color: '#fff', collapsed: false },
    });
    applyCommand(p, { type: 'patchChannel', channelId: id, patch: { groupId: 'g1' } });
    expect(p.channels[id]!.groupId).toBe('g1');

    applyCommand(p, { type: 'patchChannel', channelId: id, patch: { groupId: undefined } });
    expect('groupId' in p.channels[id]!).toBe(false);
    expect(campos(p)).toEqual('');
  });

  it('la marca se reconoce por su forma y no se confunde con un objeto cualquiera', () => {
    expect(esUnset(UNSET)).toBe(true);
    expect(esUnset(JSON.parse(JSON.stringify(UNSET)))).toBe(true);
    expect(esUnset({ $orbitUnset: true, valor: 3 })).toBe(false);
    expect(esUnset({ $orbitUnset: false })).toBe(false);
    expect(esUnset({ $orbitUnset: 'sí' })).toBe(false);
    expect(esUnset({ otro: 1 })).toBe(false);
    expect(esUnset([UNSET])).toBe(false);
    expect(esUnset(null)).toBe(false);
    expect(esUnset('\u0000unset')).toBe(false);
  });

  it('y un texto legítimo que se pareciera a la marca antigua NO se toca', () => {
    const p = proyecto();
    const id = unCanal(p);
    const canal = p.channels[id]!;
    applyCommand(p, { type: 'patchChannel', channelId: id, patch: { name: '\u0000unset' } });
    // El texto se conserva tal cual: no se confunde con una orden de borrar.
    expect(canal.name).toBe('\u0000unset');

    // Su inverso lleva el texto ANTERIOR (no la marca) y deshacer lo repone.
    const inverse = applyCommand(p, {
      type: 'patchChannel',
      channelId: id,
      patch: { name: ' otro ' },
    });
    const inversePatch = (inverse as { patch: Record<string, unknown> }).patch;
    expect(inversePatch.name).toBe('\u0000unset');
    expect(esUnset(inversePatch.name)).toBe(false);
    applyCommand(p, inverse);
    expect(canal.name).toBe('\u0000unset');
    expect(typeof canal.name).toBe('string');
  });
});

describe('follow-up · ParamRef se valida por rama, no solo por tipo', () => {
  const patchLfo = (target: unknown) =>
    commandProblem({ type: 'patchLfo', lfoId: 'l1', patch: { target } });

  it('cada rama exige el campo con el que se apunta', () => {
    expect(patchLfo({ kind: 'mixer', param: 'volume' })).toMatch(/trackIndex/);
    expect(patchLfo({ kind: 'channel', param: 'volume' })).toMatch(/channelId/);
    expect(patchLfo({ kind: 'effect', param: 'cutoff' })).toMatch(/trackIndex|slotIndex/);
    expect(patchLfo({ kind: 'channelFx', param: 'cutoff' })).toMatch(/channelId/);
    expect(patchLfo({ kind: 'transport' })).toMatch(/param/);
  });

  it('y las ramas cerradas no admiten un param de otra', () => {
    expect(patchLfo({ kind: 'mixer', trackIndex: 1, param: 'cutoff' })).toMatch(/param/);
    expect(patchLfo({ kind: 'channelMix', channelId: 'c1', param: 'cutoff' })).toMatch(/param/);
    expect(patchLfo({ kind: 'transport', param: 'volume' })).toMatch(/param/);
    // Las ramas abiertas sí: `channel` y `effect` admiten cualquier parámetro.
    expect(patchLfo({ kind: 'channel', channelId: 'c1', param: 'cutoff' })).toBeNull();
    expect(patchLfo({ kind: 'effect', trackIndex: 1, slotIndex: 0, param: 'cutoff' })).toBeNull();
  });

  it('un kind que no existe, o campos de otra rama, tampoco', () => {
    expect(patchLfo({ kind: 'master', param: 'volume' })).toMatch(/kind/);
    expect(patchLfo({ kind: 'channel', channelId: 'c1', trackIndex: 1, param: 'volume' })).toMatch(
      /trackIndex/,
    );
  });

  it('las seis ramas bien formadas pasan', () => {
    expect(patchLfo({ kind: 'channel', channelId: 'c1', param: 'volume' })).toBeNull();
    expect(patchLfo({ kind: 'channelMix', channelId: 'c1', param: 'bend' })).toBeNull();
    expect(patchLfo({ kind: 'mixer', trackIndex: 1, param: 'eqMid' })).toBeNull();
    expect(patchLfo({ kind: 'effect', trackIndex: 1, slotIndex: 2, param: 'cutoff' })).toBeNull();
    expect(patchLfo({ kind: 'channelFx', channelId: 'c1', slotIndex: 0, param: 'cutoff' })).toBeNull();
    expect(patchLfo({ kind: 'transport', param: 'swing' })).toBeNull();
  });

  it('y lo mismo dentro de un proyecto: un LFO sin destino no entra', () => {
    const p = proyecto();
    const lfo: Lfo = {
      id: 'l1',
      // Sin `trackIndex`: la rama 'mixer' no puede resolver a dónde apunta.
      target: { kind: 'mixer', param: 'volume' } as Lfo['target'],
      shape: 'sine',
      rateBeats: 4,
      amount: 0.5,
      phase: 0,
      enabled: true,
    };
    p.lfos = { l1: lfo };
    expect(campos(p)).toMatch(/trackIndex/);

    // Y el mismo LFO bien formado entra sin quejarse.
    p.lfos.l1!.target = { kind: 'mixer', trackIndex: 0, param: 'volume' };
    expect(campos(p)).toEqual('');
  });
});