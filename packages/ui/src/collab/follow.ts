/**
 * Modo seguidor: tu vista va donde va la de otro.
 *
 * Dos mitades:
 * 1. SALIENTE — publicamos por awareness nuestra "vista lógica" (qué editor
 *    tenemos delante, patrón activo, canal del piano roll, pista de mixer
 *    abierta y posición en la playlist). Es distinta de `reportActivity`, que
 *    publica el cursor físico para pintarlo: esto es a dónde estás mirando.
 * 2. ENTRANTE — si sigues a alguien, cada cambio de SU vista se aplica a la
 *    tuya: se abre su editor, se cambia el patrón activo, se selecciona su
 *    canal del mixer y se mueve el caret (solo con el transporte parado, para
 *    no pelearse con el motor).
 *
 * Nada de esto pasa por el bus de comandos: es estado de UI, no del proyecto.
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PeerView } from '@orbit/collab';
import { setActivePattern, store } from '../state/app';
import { useUiStore, type UiState, type WindowId } from '../state/ui';
import { getCollabSession, useCollabStore } from './collab-state';
import { FollowBanner } from './FollowBanner';

/** Ventanas que cuentan como "editor" para la vista lógica. */
const EDITOR_WINDOWS: WindowId[] = [
  'playlist',
  'pianoRoll',
  'mixer',
  'channelRack',
  'nova',
  'automation',
  'audioEditor',
  'liveView',
  'scope',
  'graph',
];

/** Nombre visible de cada editor (para el aviso y la lista de conectados). */
export const EDITOR_LABELS: Record<string, string> = {
  playlist: 'la Playlist',
  pianoRoll: 'el Piano Roll',
  mixer: 'el Mixer',
  channelRack: 'el Channel Rack',
  nova: 'Orbit Nova',
  automation: 'la automatización',
  audioEditor: 'el editor de audio',
  liveView: 'la vista Live',
  scope: 'el Scope',
  graph: 'el enrutado',
};

/** Cada cuánto se publica la vista como mucho (los medidores van a ~20 fps). */
const PUBLISH_THROTTLE_MS = 200;

/** Editor con el foco: la ventana de editor abierta con la z más alta. */
function frontEditor(ui: UiState): WindowId | null {
  let best: WindowId | null = null;
  let bestZ = -1;
  for (const id of EDITOR_WINDOWS) {
    const w = ui.windows[id];
    if (w.open && w.z > bestZ) {
      best = id;
      bestZ = w.z;
    }
  }
  return best;
}

/** Vista lógica actual de esta ventana. */
function currentView(ui: UiState): PeerView | null {
  const editor = frontEditor(ui);
  if (!editor) return null;
  return {
    editor,
    ...(ui.activePatternId ? { patternId: ui.activePatternId } : null),
    ...(ui.pianoRollChannelId ? { channelId: ui.pianoRollChannelId } : null),
    mixerTrack: ui.selectedMixerTrack,
    // Redondeo a 1/4 de beat: el seguidor no necesita precisión de sample y
    // así el deduplicado por contenido corta el ruido de los medidores.
    playhead: Math.round(ui.positionBeats * 4) / 4,
  };
}

let lastPublished = '';
let lastPublishedAt = 0;

/** Publica nuestra vista (throttle + dedupe). Sin sesión no cuesta nada. */
function publishView(ui: UiState): void {
  const session = getCollabSession();
  if (!session) return;
  const view = currentView(ui);
  if (!view) return;
  const json = JSON.stringify(view);
  if (json === lastPublished) return;
  const now = performance.now();
  if (now - lastPublishedAt < PUBLISH_THROTTLE_MS) return;
  lastPublishedAt = now;
  lastPublished = json;
  session.setView(view);
}

let lastApplied = '';

/** Copia la vista de otro en la nuestra (solo UI: ni un comando). */
function applyView(view: PeerView): void {
  const json = JSON.stringify(view);
  if (json === lastApplied) return;
  lastApplied = json;

  const ui = useUiStore.getState();

  // Patrón activo: por setActivePattern, que además resincroniza el motor
  // cuando estamos en modo PAT.
  if (
    view.patternId &&
    view.patternId !== ui.activePatternId &&
    store.project.patterns[view.patternId]
  ) {
    setActivePattern(view.patternId);
  }

  const patch: Partial<UiState> = {};
  if (view.channelId && view.channelId !== ui.pianoRollChannelId) {
    patch.pianoRollChannelId = view.channelId;
  }
  if (view.mixerTrack !== undefined && view.mixerTrack !== ui.selectedMixerTrack) {
    patch.selectedMixerTrack = view.mixerTrack;
  }
  // El caret solo se mueve con el transporte parado: si suena, el motor manda.
  if (view.playhead !== undefined && !ui.playing && view.playhead !== ui.positionBeats) {
    patch.positionBeats = view.playhead;
  }
  if (Object.keys(patch).length > 0) useUiStore.setState(patch);

  // Su editor al frente (openWindow ya lo abre y lo sube de z).
  const editor = view.editor as WindowId;
  if (EDITOR_WINDOWS.includes(editor)) {
    const w = ui.windows[editor];
    if (!w.open || frontEditor(ui) !== editor) ui.openWindow(editor);
  }
}

// ── API pública ──────────────────────────────────────────────────────────────

/** Empieza a seguir a un peer (a uno mismo no). */
export function followPeer(clientId: number): void {
  const self = useCollabStore.getState().peers.find((p) => p.isSelf);
  if (self && self.clientId === clientId) return;
  lastApplied = '';
  useCollabStore.setState({ following: clientId });
  const peer = useCollabStore.getState().peers.find((p) => p.clientId === clientId);
  if (peer?.view) applyView(peer.view);
}

/** Deja de seguir: tu vista vuelve a ser tuya. */
export function unfollow(): void {
  lastApplied = '';
  useCollabStore.setState({ following: null });
}

/** ¿Estamos siguiendo a este peer? */
export function isFollowing(clientId: number): boolean {
  return useCollabStore.getState().following === clientId;
}

let wired = false;
let bannerRoot: Root | null = null;

/**
 * Cablea el modo seguidor. Idempotente; lo llama initPresence() (que a su vez
 * llama App una sola vez), así que no hace falta montar nada a mano.
 *
 * El aviso de "estás siguiendo a X" se monta como capa propia sobre el body
 * para que se vea con el panel de colaboración cerrado. Si prefieres pintarlo
 * dentro del árbol de App, exporta <FollowBanner/> y llama a initFollow(false).
 */
export function initFollow(mountBanner = true): void {
  if (wired) return;
  wired = true;

  // Saliente: cualquier cambio de UI puede mover nuestra vista.
  useUiStore.subscribe((ui) => publishView(ui));

  // Entrante: cambios de presencia del peer seguido.
  useCollabStore.subscribe((s, prev) => {
    if (s.following === null) return;
    if (s.peers === prev.peers && s.following === prev.following) return;
    const peer = s.peers.find((p) => p.clientId === s.following);
    if (peer?.view) applyView(peer.view);
  });

  if (mountBanner && typeof document !== 'undefined' && bannerRoot === null) {
    const host = document.createElement('div');
    host.id = 'orbit-follow-banner';
    document.body.appendChild(host);
    bannerRoot = createRoot(host);
    bannerRoot.render(createElement(FollowBanner));
  }
}
