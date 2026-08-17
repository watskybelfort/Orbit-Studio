/**
 * "Último parámetro tocado".
 *
 * Toda perilla/fader que apunte a un destino automatizable (`ParamRef`) avisa
 * aquí al moverse. Con eso:
 * - el menú contextual de la perilla y la paleta pueden crear un clip de
 *   automatización o un LFO del parámetro que acabas de mover, sin obligar a
 *   buscarlo en un desplegable;
 * - la grabación de movimientos de perillas (ver `param-record`) sabe qué
 *   carril está escribiendo.
 *
 * El aviso llega DESPUÉS del dispatch, así que el valor ya está en el
 * proyecto: aquí no viaja ningún número, se lee del store cuando hace falta.
 */

import { paramRefKey, type ParamRef } from '@orbit/core';
import { create } from 'zustand';

interface ParamTouchState {
  /** Último destino movido por el usuario (null al arrancar). */
  last: ParamRef | null;
  /** Clave del destino (para comparar sin recorrer el objeto). */
  key: string | null;
}

export const useParamTouch = create<ParamTouchState>(() => ({ last: null, key: null }));

export function touchParam(ref: ParamRef): void {
  const key = paramRefKey(ref);
  // Solo re-renderiza al cambiar de destino: durante un arrastre son cientos
  // de avisos del MISMO parámetro y no deben mover la UI.
  if (useParamTouch.getState().key !== key) {
    useParamTouch.setState({ last: ref, key });
  }
  for (const listener of listeners) listener(ref);
}

export type ParamTouchListener = (ref: ParamRef) => void;

const listeners = new Set<ParamTouchListener>();

/** Escucha cada movimiento (la grabación de perillas se engancha aquí). */
export function onParamTouch(listener: ParamTouchListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
