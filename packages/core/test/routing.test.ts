/**
 * El enrutado como grafo (lo que pinta y valida el graph editor).
 *
 * Lo que importa: que las tres clases de cable salgan todas (canal, carril de
 * audio, salida y envío), que un cable que cerraría un bucle se vea venir
 * ANTES de guardarlo —el compilador tolera los ciclos, pero lo que suena
 * entonces no es lo que nadie quería— y que un proyecto que YA trae un ciclo
 * (o índices fuera de rango) no cuelgue el cálculo de columnas.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands';
import { createChannel, createEmptyProject } from '../src/model/defaults';
import {
  channelsByTrack,
  outputsOf,
  routingEdges,
  trackColumns,
  trackOfChannel,
  usedTracks,
  wouldLoop,
} from '../src/model/routing';
import type { Project } from '../src/model/types';

function base(): Project {
  return createEmptyProject('Enrutado');
}

/** Añade un canal en la pista dada y devuelve su id. */
function canal(project: Project, name: string, mixerTrack: number): string {
  const ch = createChannel('synth', project.channelOrder.length, name);
  ch.mixerTrack = mixerTrack;
  applyCommand(project, { type: 'addChannel', channel: ch });
  return ch.id;
}

describe('aristas del enrutado', () => {
  it('un canal enseña su cable a la pista', () => {
    const project = base();
    const id = canal(project, 'Kick', 3);
    const edges = routingEdges(project).filter((e) => e.kind === 'channel');
    expect(edges).toEqual([{ kind: 'channel', from: id, to: 3 }]);
  });

  it('un canal con pista fuera de rango cuenta como master', () => {
    const project = base();
    const id = canal(project, 'Raro', 999);
    expect(trackOfChannel(project, id)).toBe(0);
    expect(routingEdges(project).find((e) => e.from === id)?.to).toBe(0);
  });

  it('salidas y envíos salen como aristas distintas', () => {
    const project = base();
    project.mixer[4]!.routeTo = 2;
    project.mixer[4]!.sends = [{ target: 6, level: 0.4 }];
    const edges = routingEdges(project).filter((e) => e.from === 4);
    expect(edges).toEqual([
      { kind: 'route', from: 4, to: 2 },
      { kind: 'send', from: 4, to: 6, level: 0.4 },
    ]);
  });

  it('el master no tiene salida (routeTo null) y no inventa arista', () => {
    const project = base();
    expect(routingEdges(project).some((e) => e.kind === 'route' && e.from === 0)).toBe(false);
  });

  it('un cable a sí misma no es una salida', () => {
    const project = base();
    project.mixer[5]!.routeTo = 5;
    expect(outputsOf(project.mixer, 5)).toEqual([]);
    expect(routingEdges(project).some((e) => e.from === 5)).toBe(false);
  });

  it('los carriles de audio de la playlist también entran al grafo', () => {
    const project = base();
    const lane = Object.values(project.playlistTracks)[0];
    expect(lane).toBeDefined();
    lane!.mixerTrack = 7;
    const edges = routingEdges(project).filter((e) => e.kind === 'lane');
    expect(edges).toContainEqual({ kind: 'lane', from: lane!.id, to: 7 });
  });
});

describe('bucles', () => {
  it('enchufar una pista a sí misma es un bucle', () => {
    const project = base();
    expect(wouldLoop(project.mixer, 3, 3)).toBe(true);
  });

  it('lo normal (a una pista que va al master) no lo es', () => {
    const project = base();
    expect(wouldLoop(project.mixer, 3, 5)).toBe(false);
  });

  it('se ve venir el bucle indirecto: 5 → 3 con 3 → 5 puesto', () => {
    const project = base();
    project.mixer[3]!.routeTo = 5;
    expect(wouldLoop(project.mixer, 5, 3)).toBe(true);
  });

  it('y el que se cerraría por un envío, no solo por la salida', () => {
    const project = base();
    project.mixer[3]!.routeTo = 0;
    project.mixer[3]!.sends = [{ target: 8, level: 0.5 }];
    expect(wouldLoop(project.mixer, 8, 3)).toBe(true);
  });

  it('el master es destino seguro para cualquiera', () => {
    const project = base();
    project.mixer[4]!.routeTo = 2;
    expect(wouldLoop(project.mixer, 4, 0)).toBe(false);
  });

  it('un índice inexistente no es un bucle (lo rechaza quien enchufa)', () => {
    const project = base();
    expect(wouldLoop(project.mixer, 3, 999)).toBe(false);
  });
});

describe('columnas', () => {
  it('con todo al master, el master queda a la derecha', () => {
    const project = base();
    const cols = trackColumns(project.mixer);
    expect(cols[1]).toBe(0);
    expect(cols[0]).toBe(1);
  });

  it('una cadena 6 → 4 → master ocupa tres columnas', () => {
    const project = base();
    project.mixer[6]!.routeTo = 4;
    const cols = trackColumns(project.mixer);
    expect(cols[6]).toBe(0);
    expect(cols[4]).toBe(1);
    expect(cols[0]).toBe(2);
  });

  it('un proyecto que ya trae un ciclo no cuelga el cálculo', () => {
    const project = base();
    project.mixer[3]!.routeTo = 4;
    project.mixer[4]!.routeTo = 3;
    const cols = trackColumns(project.mixer);
    expect(cols).toHaveLength(project.mixer.length);
    expect(cols.every((c) => Number.isFinite(c))).toBe(true);
  });
});

describe('qué se enseña', () => {
  it('sin nada montado, solo el master', () => {
    const project = base();
    expect(usedTracks(project)).toEqual([0]);
  });

  it('las pistas con canales, con envíos y las que reciben de ellas', () => {
    const project = base();
    canal(project, 'Voz', 2);
    project.mixer[2]!.sends = [{ target: 9, level: 0.3 }];
    project.mixer[9]!.routeTo = 0;
    expect(usedTracks(project)).toEqual([0, 2, 9]);
  });

  it('una pista que no va al master se enseña con su destino', () => {
    const project = base();
    project.mixer[6]!.routeTo = 4;
    expect(usedTracks(project)).toEqual([0, 4, 6]);
  });

  it('los canales se agrupan por pista en el orden del rack', () => {
    const project = base();
    const a = canal(project, 'A', 2);
    const b = canal(project, 'B', 2);
    const c = canal(project, 'C', 5);
    const map = channelsByTrack(project);
    expect(map.get(2)).toEqual([a, b]);
    expect(map.get(5)).toEqual([c]);
  });
});
