// Los canvas leen los tokens del tema con getComputedStyle al dibujar, así que
// necesitan redibujarse cuando cambia el tema (data-theme o las perillas del
// customizador, que son variables inline en <html>). Este hook expone un
// contador que se incrementa con cada cambio; basta con meterlo en las deps
// del callback de dibujo.

import { useSyncExternalStore } from 'react';

let version = 0;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

/**
 * Alta al cambio de tema; devuelve la baja. Es exactamente la firma que
 * `useSyncExternalStore` pide, y se exporta para poder comprobar su ciclo de
 * vida sin montar React.
 *
 * El `MutationObserver` es posesión de ESTE subscribe, no del `Set` de
 * suscriptores: se crea en la primera alta y —este era el bug— hay que
 * desconectarlo en la baja del ÚLTIMO suscriptor. Sin eso, cada montaje deja
 * un observador colgado mirando `<html>` para siempre: la clase «un alta cuya
 * baja no es de nadie», y la particularidad de este caso es que un módulo de
 * suscriptores compartido no lo habría evitado, porque lo que se fuga no es
 * el `Set` sino el observador que este subscribe posee. Al volver a haber un
 * suscriptor se crea de nuevo (y `version` sigue contando desde donde estaba:
 * los canvas ya redibujados no necesitan enterarse de cambios perdidos).
 */
export function onThemeVersionChange(listener: () => void): () => void {
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      version += 1;
      // Sobre una copia: si un listener se da de baja dentro de su propio
      // callback, el resto recibe igualmente ESTE aviso en vez de depender de
      // cómo itere el `Set`.
      for (const l of [...listeners]) l();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

/** Cuántos suscriptores vivos hay (diagnóstico: una fuga es un número). */
export function themeListenerCount(): number {
  return listeners.size;
}

export function useThemeVersion(): number {
  return useSyncExternalStore(onThemeVersionChange, () => version);
}
