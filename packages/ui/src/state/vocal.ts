/**
 * «Preparar pista de voz»: el atajo que convierte el flujo de grabar un micro
 * en el flujo de grabar VOZ sobre el beat.
 *
 * Lo que hace, y por qué cada paso:
 *
 * 1. **Una pista de playlist llamada «Voz»**, creada si no existe. Es donde
 *    caen las tomas, y el nombre es el que el usuario va a buscar mañana.
 * 2. **Una ruta de entrada armada y enlazada a esa pista** (`playlistTrackId`).
 *    `placeTake` del grabador ya respeta ese enlace: cada toma cae ahí, no en
 *    la primera pista libre. Sin enrutado declarado se crea una ruta mono por
 *    el canal 1 —el micro de siempre— en vez de dejar el flujo vocal a medias.
 * 3. **Una pista de mixer libre**, para que la voz no acabe sumada al master
 *    sin canal propio donde poner compresor, EQ o reverb. Si ya hay un canal
 *    llamado «Voz», se reutiliza.
 *
 * Es idempotente: pulsarlo dos veces no crea una segunda pista ni una segunda
 * ruta. Y todo va en UN `batch`, así que también es un solo Ctrl+Z — preparar
 * la sesión de voz no puede dejar media pista creada.
 *
 * La decisión vive en `planVocalSetup`, pura sobre el proyecto; la acción solo
 * despacha. Así el test puede aplicar los comandos de verdad y comprobar el
 * resultado sin montar React.
 */

import {
  createInputRoute,
  createPlaylistTrack,
  pickColor,
  projectInputRoutes,
  type Command,
  type Id,
  type InputRoute,
  type Project,
} from '@orbit/core';
import { store } from './app';

export const VOCAL_TRACK_NAME = 'Voz';

const norm = (value: string): string => value.trim().toLocaleLowerCase();

export interface VocalSetupPlan {
  trackId: Id;
  routeId: Id;
  trackCreated: boolean;
  routeCreated: boolean;
  commands: Command[];
}

/**
 * Primer canal de mixer libre (sin contar el master). Si no queda ninguno,
 * cae al 1: mejor compartir canal que apuntar a un índice que no existe.
 */
function freeMixerTrack(project: Project, trackId: Id | null, routeId: Id | null): number {
  const named = project.mixer.findIndex((track, index) => index > 0 && norm(track.name) === 'voz');
  if (named > 0) return named;
  // Lo que la pista ya eligió (o la ruta que ya entra por ahí) manda: preparar
  // dos veces no puede mudar la voz de canal.
  const current = trackId !== null ? project.playlistTracks[trackId] : undefined;
  if (current?.mixerTrack !== undefined && current.mixerTrack > 0) return current.mixerTrack;
  const currentRoute = routeId !== null ? project.inputRoutes[routeId] : undefined;
  if (currentRoute && currentRoute.mixerTrack > 0) return currentRoute.mixerTrack;

  const used = new Set<number>();
  for (const track of Object.values(project.playlistTracks)) {
    if (track.id !== trackId && track.mixerTrack !== undefined) used.add(track.mixerTrack);
  }
  for (const route of projectInputRoutes(project)) {
    if (route.id !== routeId) used.add(route.mixerTrack);
  }
  for (let i = 1; i < project.mixer.length; i++) if (!used.has(i)) return i;
  return 1;
}

/**
 * La ruta que va a recibir la voz.
 *
 * No vale «la primera armada»: con una guitarra armada, el botón Voz enlazaba
 * la pista Voz a la GUITARRA y las tomas acababan en la pista equivocada. Se
 * reutiliza la que se llama Voz (o mic/vocal), la entrada genérica del aparato
 * (canal 0, «Entrada 1») o se crea una propia.
 */
function vocalRoute(project: Project): { route: InputRoute; created: boolean } {
  const routes = projectInputRoutes(project);
  const named = routes.find((route) => norm(route.name) === 'voz');
  if (named) return { route: named, created: false };
  const mic = routes.find((route) => /voz|mic|vocal/.test(norm(route.name)));
  if (mic) return { route: mic, created: false };
  const generic = routes.find(
    (route) => route.channel === 0 && /^(entrada|input)\s*\d*$/.test(norm(route.name)),
  );
  if (generic) return { route: generic, created: false };
  return { route: createInputRoute(0, undefined, VOCAL_TRACK_NAME), created: true };
}

export function planVocalSetup(project: Project): VocalSetupPlan {
  const arrangementId = project.activeArrangementId;
  const tracks = Object.values(project.playlistTracks)
    .filter((track) => track.arrangementId === arrangementId)
    .sort((a, b) => a.order - b.order);
  const commands: Command[] = [];

  let track = tracks.find((item) => norm(item.name) === norm(VOCAL_TRACK_NAME));
  const trackCreated = track === undefined;
  if (!track) {
    track = createPlaylistTrack(arrangementId, tracks.length, VOCAL_TRACK_NAME);
    track.color = pickColor(tracks.length);
    // Dos carriles de fábrica: la segunda toma ya nace legible sin que el
    // usuario tenga que arrastrar la altura de la pista.
    track.height = 56;
    commands.push({ type: 'addPlaylistTrack', track });
  }

  const { route, created: routeCreated } = vocalRoute(project);
  const mixerTrack = freeMixerTrack(project, track.id, route.id);

  if (track.mixerTrack !== mixerTrack) {
    commands.push({
      type: 'patchPlaylistTrack',
      trackId: track.id,
      patch: { mixerTrack },
    });
  }

  const needsRoutePatch =
    route.playlistTrackId !== track.id ||
    route.mixerTrack !== mixerTrack ||
    !route.armed;
  if (needsRoutePatch) {
    commands.push({
      type: 'patchInputRoute',
      routeId: route.id,
      patch: { playlistTrackId: track.id, mixerTrack, armed: true },
    });
  }

  if (routeCreated) {
    // `patchInputRoute` iría antes que el alta y el bus lo rechazaría por no
    // existir: el alta va PRIMERO, y el patch después.
    commands.unshift({ type: 'addInputRoute', route });
  }

  return {
    trackId: track.id,
    routeId: route.id,
    trackCreated,
    routeCreated,
    commands,
  };
}

/**
 * Prepara el flujo vocal en el proyecto abierto. Devuelve los ids para que la
 * UI pueda abrir la cabina sobre esa pista; `null` si no hay proyecto.
 */
export function prepareVocalSetup(): VocalSetupPlan | null {
  const project = store.project;
  if (!project) return null;
  const plan = planVocalSetup(project);
  if (plan.commands.length > 0) {
    const label = plan.trackCreated ? 'Preparar pista de voz' : 'Enlazar entrada de voz';
    store.dispatch({ type: 'batch', label, commands: plan.commands }, { label });
  }
  return plan;
}
