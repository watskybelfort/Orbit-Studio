/**
 * Colocación del graph editor.
 *
 * Lo que se prueba es lo que hace legible el grafo: que la señal avance de
 * izquierda a derecha (una pista que desemboca en otra queda a su izquierda),
 * que las cajas de una misma columna no se solapen, que las fuentes salgan en
 * el mismo orden vertical que sus pistas y que un cable a una pista escondida
 * no se dibuje como una línea que sale de la nada.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, type Project } from '@orbit/core';
import { layoutGraph, type GraphNode } from '../src/editors/graph/layout';

function canal(project: Project, name: string, mixerTrack: number): string {
  const ch = createChannel('synth', project.channelOrder.length, name);
  ch.mixerTrack = mixerTrack;
  applyCommand(project, { type: 'addChannel', channel: ch });
  return ch.id;
}

const node = (nodes: GraphNode[], key: string): GraphNode => {
  const found = nodes.find((n) => n.key === key);
  if (!found) throw new Error(`Sin nodo ${key}`);
  return found;
};

describe('layoutGraph', () => {
  it('sin nada montado enseña solo el master', () => {
    const { nodes, links } = layoutGraph(createEmptyProject('Vacío'), { showAllTracks: false });
    expect(nodes.map((n) => n.key)).toEqual(['trk:0']);
    expect(links).toEqual([]);
  });

  it('el canal queda a la izquierda de su pista, y la pista del master', () => {
    const project = createEmptyProject('Cadena');
    const id = canal(project, 'Kick', 3);
    const { nodes, links } = layoutGraph(project, { showAllTracks: false });

    const canalNodo = node(nodes, `ch:${id}`);
    const pista = node(nodes, 'trk:3');
    const master = node(nodes, 'trk:0');
    expect(canalNodo.x).toBeLessThan(pista.x);
    expect(pista.x).toBeLessThan(master.x);
    expect(links.map((l) => l.kind)).toEqual(['channel', 'route']);
  });

  it('una cadena 6 → 4 → master ocupa tres columnas de izquierda a derecha', () => {
    const project = createEmptyProject('Buses');
    project.mixer[6]!.routeTo = 4;
    const { nodes } = layoutGraph(project, { showAllTracks: false });
    expect(node(nodes, 'trk:6').x).toBeLessThan(node(nodes, 'trk:4').x);
    expect(node(nodes, 'trk:4').x).toBeLessThan(node(nodes, 'trk:0').x);
  });

  it('las cajas de una columna no se solapan', () => {
    const project = createEmptyProject('Muchas');
    for (let i = 1; i <= 6; i++) canal(project, `C${i}`, i);
    const { nodes } = layoutGraph(project, { showAllTracks: false });
    const porColumna = new Map<number, GraphNode[]>();
    for (const n of nodes) {
      const list = porColumna.get(n.x);
      if (list) list.push(n);
      else porColumna.set(n.x, [n]);
    }
    for (const list of porColumna.values()) {
      const ordenadas = [...list].sort((a, b) => a.y - b.y);
      for (let i = 1; i < ordenadas.length; i++) {
        const antes = ordenadas[i - 1]!;
        expect(ordenadas[i]!.y).toBeGreaterThanOrEqual(antes.y + antes.h);
      }
    }
  });

  it('las fuentes van en el orden vertical de sus pistas', () => {
    const project = createEmptyProject('Orden');
    const enSeis = canal(project, 'Va a la 6', 6);
    const enDos = canal(project, 'Va a la 2', 2);
    const { nodes } = layoutGraph(project, { showAllTracks: false });
    // La pista 2 se pinta encima de la 6 (se apilan por índice), así que su
    // canal también.
    expect(node(nodes, 'trk:2').y).toBeLessThan(node(nodes, 'trk:6').y);
    expect(node(nodes, `ch:${enDos}`).y).toBeLessThan(node(nodes, `ch:${enSeis}`).y);
  });

  it('un envío sale como su propio cable, con nivel', () => {
    const project = createEmptyProject('Envío');
    canal(project, 'Voz', 2);
    project.mixer[2]!.sends = [{ target: 9, level: 0.4 }];
    const { links } = layoutGraph(project, { showAllTracks: false });
    const send = links.find((l) => l.kind === 'send');
    expect(send?.from.key).toBe('trk:2');
    expect(send?.to.key).toBe('trk:9');
    expect(send?.level).toBe(0.4);
  });

  it('con "ver todas" aparecen los 26 inserts', () => {
    const project = createEmptyProject('Todas');
    const { nodes } = layoutGraph(project, { showAllTracks: true });
    expect(nodes.filter((n) => n.kind === 'track')).toHaveLength(project.mixer.length);
  });

  it('un carril de la playlist solo sale si tiene audio', () => {
    const project = createEmptyProject('Carriles');
    const lane = Object.values(project.playlistTracks)[0]!;
    lane.mixerTrack = 4;
    const sinAudio = layoutGraph(project, { showAllTracks: false });
    expect(sinAudio.nodes.some((n) => n.kind === 'lane')).toBe(false);

    project.clips['c1'] = {
      id: 'c1',
      kind: 'audio',
      playlistTrackId: lane.id,
      start: 0,
      length: 4,
      muted: false,
      sampleId: 's1',
    };
    const conAudio = layoutGraph(project, { showAllTracks: false });
    expect(conAudio.nodes.some((n) => n.key === `lane:${lane.id}`)).toBe(true);
    expect(conAudio.links.some((l) => l.kind === 'lane')).toBe(true);
  });

  it('el lienzo mide lo que ocupan las cajas', () => {
    const project = createEmptyProject('Tamaño');
    canal(project, 'Uno', 1);
    const { nodes, width, height } = layoutGraph(project, { showAllTracks: false });
    for (const n of nodes) {
      expect(width).toBeGreaterThanOrEqual(n.x + n.w);
      expect(height).toBeGreaterThanOrEqual(n.y + n.h);
    }
  });
});
