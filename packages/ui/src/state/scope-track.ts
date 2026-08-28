/**
 * Qué pista está sirviendo AHORA el tap único del scope.
 *
 * `acquireScope` (scope-owner.ts) resuelve QUIÉN manda cuando dos vistas lo
 * piden a la vez (el último gana), pero no dice nada sobre CUÁL de las dos
 * pistas es la que de verdad está viajando en `scopeFrame` en este instante.
 * Un lector que asuma "el frame que me llega es el de la pista que pedí" se
 * equivoca en cuanto otra vista (el Orbit Scope, un EQ expandido, otro
 * analizador) pide una pista distinta y pasa a mandar ella.
 *
 * Este módulo es un envoltorio fino sobre `acquireScope` que además lleva la
 * cuenta de la pila de peticiones, para que cualquier consumidor pueda
 * preguntar "¿el tap de ahora mismo es el mío?" antes de confiar en los
 * datos — en vez de, por ejemplo, un LUFS de master calculado en silencio
 * sobre el audio de otra pista. TODOS los consumidores de `scopeFrame` deben
 * pedir el tap por acá (no por `acquireScope` directo) para que la cuenta sea
 * fiel.
 */

import { create } from 'zustand';
import { acquireScope } from './scope-owner';

/** Índice de pista del master en el mixer (siempre 0). */
export const MASTER_TRACK = 0;

interface ScopeTrackState {
  /** Pista que el kernel está tapeando ahora mismo, o null si nadie la pidió. */
  activeTrack: number | null;
}

export const useScopeTrack = create<ScopeTrackState>(() => ({ activeTrack: null }));

const stack: number[] = [];

function publish(): void {
  useScopeTrack.setState({ activeTrack: stack.length > 0 ? stack[stack.length - 1]! : null });
}

/**
 * Como `acquireScope`, pero además registra la petición en la pila propia de
 * este módulo. Devuelve la función de soltarlo (pensada para `useEffect`).
 */
export function acquireScopeTracked(track = 0): () => void {
  const release = acquireScope(track);
  stack.push(track);
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const idx = stack.lastIndexOf(track);
    if (idx >= 0) stack.splice(idx, 1);
    release();
    publish();
  };
}

/** ¿La pista dada es la que está viajando por `scopeFrame` ahora mismo? */
export function isScopeTrackActive(track: number): boolean {
  return useScopeTrack.getState().activeTrack === track;
}
