import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createEmptyProject,
  createInputRoute,
  createPlaylistTrack,
  type Project,
} from '@orbit/core';
import { planVocalSetup, VOCAL_TRACK_NAME } from '../src/state/vocal';

function apply(project: Project, plan: ReturnType<typeof planVocalSetup>): void {
  for (const command of plan.commands) applyCommand(project, command);
}

describe('preparar pista de voz', () => {
  it('en un proyecto vacío usa la primera pista (a la vista), con ruta armada y canal de mixer libre', () => {
    const project = createEmptyProject('Voz');
    const first = Object.values(project.playlistTracks).sort((a, b) => a.order - b.order)[0]!;
    const tracksBefore = Object.keys(project.playlistTracks).length;
    const plan = planVocalSetup(project);
    // Antes creaba una pista nueva AL FINAL (la novena, fuera de la vista) y se
    // grababa sin ver dónde caía la toma. Ahora es la «Pista 1» vacía.
    expect(plan.trackCreated).toBe(false);
    expect(plan.trackRenamed).toBe(true);
    expect(plan.trackId).toBe(first.id);
    expect(plan.routeCreated).toBe(true);
    expect(plan.commands[0]?.type).toBe('addInputRoute');

    apply(project, plan);
    expect(Object.keys(project.playlistTracks)).toHaveLength(tracksBefore);
    const track = project.playlistTracks[plan.trackId]!;
    const route = project.inputRoutes[plan.routeId]!;
    expect(track.name).toBe(VOCAL_TRACK_NAME);
    expect(track.arrangementId).toBe(project.activeArrangementId);
    expect(route.name).toBe(VOCAL_TRACK_NAME);
    expect(route.armed).toBe(true);
    expect(route.playlistTrackId).toBe(track.id);
    expect(route.mixerTrack).toBe(track.mixerTrack);
    expect(track.mixerTrack).toBeGreaterThan(0);
    expect(project.mixer[track.mixerTrack!]).toBeDefined();
  });

  it('es idempotente: la segunda vez no despacha nada', () => {
    const project = createEmptyProject('Voz');
    apply(project, planVocalSetup(project));

    const again = planVocalSetup(project);
    expect(again.commands).toEqual([]);
    expect(again.trackCreated).toBe(false);
    expect(again.routeCreated).toBe(false);
  });

  it('salta las pistas con algo o con nombre propio, y si no queda ninguna de fábrica vacía crea una al final', () => {
    const project = createEmptyProject('Voz');
    const ordered = Object.values(project.playlistTracks).sort((a, b) => a.order - b.order);
    // La 1 tiene un clip, la 2 la nombró el usuario: la voz va a la 3.
    project.clips['c1'] = { id: 'c1', kind: 'pattern', playlistTrackId: ordered[0]!.id, start: 0, length: 4, muted: false };
    ordered[1]!.name = 'Beat';
    expect(planVocalSetup(project).trackId).toBe(ordered[2]!.id);

    // Todas ocupadas o con nombre propio: se crea al final, como antes.
    for (const t of ordered) t.name = `Mía ${t.order}`;
    const plan = planVocalSetup(project);
    expect(plan.trackCreated).toBe(true);
    expect(plan.trackRenamed).toBe(false);
  });

  it('reutiliza una pista «Voz» que ya existe y no crea otra', () => {
    const project = createEmptyProject('Voz');
    const track = createPlaylistTrack(project.activeArrangementId, 8, '  voz  ');
    track.mixerTrack = 7;
    applyCommand(project, { type: 'addPlaylistTrack', track });

    const plan = planVocalSetup(project);
    expect(plan.trackId).toBe(track.id);
    expect(plan.trackCreated).toBe(false);
    expect(plan.commands.some((c) => c.type === 'addPlaylistTrack')).toBe(false);
  });

  it('con una guitarra armada crea su propia entrada de voz, no secuestra la guitarra', () => {
    const project = createEmptyProject('Voz');
    const route = createInputRoute(4, undefined, 'Guitarra DI');
    applyCommand(project, { type: 'addInputRoute', route });

    const plan = planVocalSetup(project);
    expect(plan.routeCreated).toBe(true);
    expect(plan.routeId).not.toBe(route.id);
    apply(project, plan);
    expect(route.name).toBe('Guitarra DI');
    expect(route.playlistTrackId).toBeUndefined();
    expect(project.inputRoutes[plan.routeId]!.name).toBe(VOCAL_TRACK_NAME);
    expect(project.inputRoutes[plan.routeId]!.playlistTrackId).toBe(plan.trackId);
  });

  it('reutiliza la entrada genérica del aparato (canal 0, «Entrada 1»)', () => {
    const project = createEmptyProject('Voz');
    const route = createInputRoute(0, undefined, 'Entrada 1');
    applyCommand(project, { type: 'addInputRoute', route });

    const plan = planVocalSetup(project);
    expect(plan.routeId).toBe(route.id);
    expect(plan.routeCreated).toBe(false);
    expect(plan.commands.some((c) => c.type === 'addInputRoute')).toBe(false);
  });

  it('prefiere el canal de mixer llamado Voz si ya hay uno', () => {
    const project = createEmptyProject('Voz');
    project.mixer[4]!.name = 'Voz';
    const plan = planVocalSetup(project);
    apply(project, plan);
    expect(project.playlistTracks[plan.trackId]!.mixerTrack).toBe(4);
    expect(project.inputRoutes[plan.routeId]!.mixerTrack).toBe(4);
  });

  it('enlaza la ruta a la pista vocal aunque estuviera apuntando a otra', () => {
    const project = createEmptyProject('Voz');
    const other = createPlaylistTrack(project.activeArrangementId, 8, 'Beats');
    applyCommand(project, { type: 'addPlaylistTrack', track: other });
    const route = createInputRoute(0, undefined, 'Entrada 1');
    route.playlistTrackId = other.id;
    applyCommand(project, { type: 'addInputRoute', route });

    const plan = planVocalSetup(project);
    apply(project, plan);
    expect(project.inputRoutes[route.id]!.playlistTrackId).toBe(plan.trackId);
    expect(project.inputRoutes[route.id]!.playlistTrackId).not.toBe(other.id);
  });
});
