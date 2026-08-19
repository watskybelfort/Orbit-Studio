/**
 * Quién tiene cogido el tap del scope.
 *
 * El kernel tiene UN solo par (`scopeEnabled` + `scopeTrack`), pero hay dos
 * consumidores independientes: la ventana del Orbit Scope y el analizador que
 * se dibuja dentro de cada EQ del mixer. Los dos pedían `setScope(true, …)` al
 * montar y `setScope(false)` al desmontar, sin llevar la cuenta de nadie, así
 * que plegar un EQ apagaba el tap del Scope, que se quedaba en blanco PARA
 * SIEMPRE (su efecto tiene deps `[]` y nunca vuelve a pedirlo) hasta cerrar y
 * reabrir la ventana.
 *
 * Con esto el tap va por préstamo: el último que lo pide manda —que es lo que
 * ya estaba documentado— y al soltarlo vuelve al anterior que siga vivo. Solo
 * se apaga cuando no queda nadie mirando.
 */

import { engine } from './app';

interface ScopeOwner {
  token: object;
  track: number;
}

let owners: ScopeOwner[] = [];

/** Aplica lo que toca ahora mismo: el último que sigue vivo, o apagado. */
function apply(): void {
  const last = owners[owners.length - 1];
  if (last) engine.setScope(true, last.track);
  else engine.setScope(false);
}

/**
 * Pide el tap para una pista. Devuelve la función de soltarlo, pensada para
 * devolverla tal cual desde un `useEffect` (`return acquireScope(i)`).
 */
export function acquireScope(track = 0): () => void {
  const owner: ScopeOwner = { token: {}, track };
  owners.push(owner);
  apply();
  let released = false;
  return () => {
    if (released) return; // soltar dos veces no puede apagar el de otro
    released = true;
    owners = owners.filter((o) => o !== owner);
    apply();
  };
}

/** Cuántos lo tienen cogido ahora mismo (para tests). */
export function scopeOwnerCount(): number {
  return owners.length;
}
