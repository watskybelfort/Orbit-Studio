/**
 * Presencia saliente: qué editor tocamos y dónde está el cursor. Los editores
 * llaman a reportActivity en sus pointermove/selecciones; aquí se deduplica y
 * se limita el ritmo antes de publicarlo por awareness. Sin sesión activa no
 * cuesta nada (return temprano).
 */

import type { PeerActivity } from '@orbit/collab';
import { useClaudeStore } from '../state/claude';
import { getCollabSession, useCollabStore } from './collab-state';
import { initFollow } from './follow';

const THROTTLE_MS = 120;

let lastSentAt = 0;
let lastJson = '';

/** Igual que en follow.ts: el dedupe es por contenido y no sabe de salas. */
export function resetActivityThrottle(): void {
  lastSentAt = 0;
  lastJson = '';
}

export function reportActivity(editor: string, pos?: Omit<PeerActivity, 'editor'>): void {
  const s = getCollabSession();
  if (!s) return;
  const activity: PeerActivity = {
    editor,
    ...pos,
    // Redondeo grueso: el cursor remoto no necesita precisión de sample y
    // así el throttle por-contenido deduplica de verdad.
    ...(pos?.beat !== undefined ? { beat: Math.round(pos.beat * 8) / 8 } : null),
  };
  const json = JSON.stringify(activity);
  if (json === lastJson) return;
  const now = performance.now();
  if (now - lastSentAt < THROTTLE_MS) return;
  lastSentAt = now;
  lastJson = json;
  s.setActivity(activity);
}

/** Publica si nuestro Claude está conectado trabajando (aparece como peer). */
export function reportClaudeActive(active: boolean): void {
  const s = getCollabSession();
  if (!s) return;
  s.awareness.setLocalStateField('claude', active);
}

let wired = false;

/**
 * Mantiene la bandera de Claude sincronizada con awareness: al conectarse o
 * caerse el bridge, y al entrar en una sala con el bridge ya conectado. Y
 * arranca el modo seguidor (publicar la vista lógica + seguir la de otro).
 * Idempotente; se llama una vez desde App.
 */
export function initPresence(): void {
  if (wired) return;
  wired = true;
  initFollow();
  const sync = () => reportClaudeActive(useClaudeStore.getState().connected);
  useClaudeStore.subscribe((s, prev) => {
    if (s.connected !== prev.connected) sync();
  });
  useCollabStore.subscribe((s, prev) => {
    if (s.phase === 'online' && prev.phase !== 'online') sync();
  });
}
