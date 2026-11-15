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
  it('en un proyecto vacío crea pista, ruta armada y les da un canal de mixer libre', () => {
    const project = createEmptyProject('Voz');
    const plan = planVocalSetup(project);
    expect(plan.trackCreated).toBe(true);
    expect(plan.routeCreated).toBe(true);
    expect(plan.commands[0]?.type).toBe('addInputRoute');

    apply(project, plan);
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

  it('reutiliza la entrada armada y no renombra una guitarra a Voz', () => {
    const project = createEmptyProject('Voz');
    const route = createInputRoute(4, undefined, 'Guitarra DI');
    applyCommand(project, { type: 'addInputRoute', route });

    const plan = planVocalSetup(project);
    expect(plan.routeId).toBe(route.id);
    expect(plan.routeCreated).toBe(false);
    expect(route.name).toBe('Guitarra DI');
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
