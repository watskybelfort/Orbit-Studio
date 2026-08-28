/**
 * Recolección de samples del worklet: soltar del hilo de audio el audio que ya
 * no usa nadie.
 *
 * El kernel guardaba cada sample que había pasado por delante y no soltaba
 * ninguno: escuchar cuarenta sonidos en el Explorador, abrir otro proyecto o
 * congelar y descongelar dejaba todos esos megas dentro del hilo de audio
 * hasta cerrar la app. Aquí se decide qué sobra —FUERA del hilo de audio,
 * contando referencias contra el proyecto editable— y el kernel hace la resta,
 * que es el único que sabe qué tiene cargado.
 *
 * Tres cosas que esto NO es:
 *
 * - **No borra el asset.** El sample sigue en `project.samples`, en el disco y
 *   en la sala de colaboración: en una sala, lo que aquí ya no usa nadie puede
 *   seguir vivo para otro cliente (`collab/assets.ts`). Volver a usarlo es
 *   volver a subirlo, no recuperarlo.
 * - **No decide sola.** El kernel protege por su cuenta lo que su proyecto
 *   compilado referencia, el preview que suena y lo que esté leyendo una voz
 *   viva — eso último lo APLAZA hasta que la voz muere, que borrar el buffer
 *   bajo los pies de una voz es un clic.
 * - **No es automática.** La llama quien sabe que acaba de cambiar el mundo:
 *   abrir un proyecto, restaurar una versión, recuperar un autosave.
 */

import type { Project } from '@orbit/core';
import { sampleKeepSet, type ToKernel } from '@orbit/engine';

/**
 * Lo que la recolección necesita del motor.
 *
 * `keepOnlySamples` NO es opcional por comodidad: sin él, esto no se manda. El
 * `AudioEngine` lleva su propia caché de lo que ya subió (`loadedSamples` /
 * `sampleDurations`) y `loadSample` se sale por ella sin re-subir nada. Soltar
 * en el kernel sin vaciar esa caché deja las dos versiones de la verdad
 * peleadas, y el resultado es el peor fallo posible aquí: el próximo
 * `loadSample` de ese id devuelve la duración cacheada, no manda el audio, y
 * el sampler o el clip se quedan MUDOS sin decir nada.
 */
export interface SampleGcEngine {
  send(msg: ToKernel): void;
  /**
   * Olvida la caché de decodificado de todo lo que no esté en `keep`, para que
   * el próximo `loadSample` de esos ids vuelva a subir el audio de verdad.
   */
  keepOnlySamples?(keep: readonly string[]): void;
}

/**
 * Ids que hay que conservar aunque el proyecto todavía no los nombre.
 *
 * Es la ventana entre `engine.loadSample(...)` y el `registerSample` que lo
 * mete en el modelo: un bounce a medio renderizar, una toma que se está
 * escribiendo a disco, un sonido recién arrastrado. Recolectar ahí en medio se
 * llevaría por delante justo lo que se acaba de cargar.
 */
const pinned = new Set<string>();

export function pinSample(id: string): void {
  if (id) pinned.add(id);
}

export function unpinSample(id: string): void {
  pinned.delete(id);
}

export function pinnedSamples(): string[] {
  return [...pinned];
}

/**
 * Sujeta un sample mientras dura la operación que lo está creando. El `finally`
 * es el motivo de que exista: un bounce que revienta a mitad no puede dejar el
 * id sujeto para siempre — sería una fuga con otro nombre.
 */
export async function withPinnedSample<T>(id: string, run: () => Promise<T>): Promise<T> {
  pinSample(id);
  try {
    return await run();
  } finally {
    unpinSample(id);
  }
}

export interface CollectResult {
  /** Ids que se le pidió al kernel conservar. */
  keep: string[];
  /** false = no se mandó nada (y `reason` dice por qué). */
  sent: boolean;
  reason?: string;
}

/**
 * Pide al worklet que suelte lo que no esté en la lista.
 *
 * `keepRegistered` (por defecto activo) conserva además todo lo registrado en
 * el proyecto aunque no lo use ningún canal ni clip: es lo que hace que
 * deshacer el borrado de un clip devuelva el audio y no un clip mudo. Ponerlo
 * en `false` recupera más memoria y paga ese precio.
 */
export function collectWorkletSamples(
  engine: SampleGcEngine,
  project: Project,
  opts: { keepRegistered?: boolean } = {},
): CollectResult {
  const keep = sampleKeepSet(project, {
    pinned,
    ...(opts.keepRegistered === undefined ? null : { keepRegistered: opts.keepRegistered }),
  });
  if (typeof engine.keepOnlySamples !== 'function') {
    // Ver `SampleGcEngine`: soltar sin poder vaciar la caché del motor deja
    // samplers mudos. Mejor no recolectar que recolectar mal.
    return { keep, sent: false, reason: 'el motor no sabe olvidar su caché de samples' };
  }
  engine.keepOnlySamples(keep);
  engine.send({ type: 'collectSamples', keep });
  return { keep, sent: true };
}
