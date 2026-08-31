/**
 * Rehidratación de samples en colaboración: que los sonidos del otro SUENEN.
 *
 * El proyecto replicado solo lleva referencias (`SampleRef`: id, ruta, hash).
 * El kernel, en cambio, resuelve las voces por id contra los bytes que le hayas
 * subido — si no los tiene, `ctx.samples.get(id)` es null y la voz sale muda.
 * Por eso al unirse a una sala, o al recibir un `registerSample` remoto, el
 * proyecto quedaba lleno de referencias y el motor local, vacío. Las
 * grabaciones y los bounces (`recording:<archivo>`) no sonaban NUNCA en la otra
 * máquina; los de fábrica sonaban "a veces", solo si el otro ya los había
 * pinchado en su Browser y su kernel los tenía cacheados bajo el mismo id.
 *
 * Una pasada de reconciliación arregla las dos direcciones a la vez:
 *
 * - HACIA FUERA: lo que podemos leer de disco y no es de fábrica se publica en
 *   la sala bajo su hash (una sola vez por hash, aunque dos personas arrastren
 *   el mismo archivo). Va por aquí y no por sound-actions.ts a propósito: así
 *   entran también las grabaciones, los bounces y los renders de pista, que se
 *   registran por otros caminos.
 * - HACIA DENTRO: lo que no podemos resolver en local se busca en la sala por
 *   hash y se sube a nuestro kernel bajo NUESTRO id.
 *
 * Lo de fábrica (`factory:…`) no viaja: las dos máquinas tienen el mismo pack y
 * lo resuelven por ruta. Mandarlo sería duplicar el pack por la red.
 *
 * La pasada es asíncrona y va de una en una (cada `await` suelta el hilo): un
 * proyecto con cincuenta samples no puede congelar la interfaz mientras carga.
 *
 * Reconciliar es LLENAR, y eso es solo la mitad cuando la sala no añade
 * samples sino que REEMPLAZA el proyecto entero (entrar en una sala,
 * re-derivar tras un merge cruzado). La otra mitad —soltar el audio del
 * proyecto anterior, que ya no nombra nadie— es
 * `syncSamplesAfterProjectReplaced`, aquí abajo.
 */

import type { CollabSession } from '@orbit/collab';
import type { Id } from '@orbit/core';
import { readSampleBytes } from '../browser/sound-actions';
import { engine, store } from '../state/app';
import { collectWorkletSamples } from '../state/sample-gc';

/** Resultado de una pasada, para que la UI cuente lo que falta. */
export interface SampleSyncReport {
  /** Samples que hemos subido al kernel local en esta pasada. */
  loaded: number;
  /** Samples cuyo contenido hemos publicado en la sala en esta pasada. */
  published: number;
  /** Nombres de los sonidos que siguen sin poder sonar aquí. */
  missing: string[];
}

const EMPTY_REPORT: SampleSyncReport = { loaded: 0, published: 0, missing: [] };

/** Ids cuyo contenido ya está en NUESTRO kernel. */
const loadedIds = new Set<Id>();
/** Ids cuya ruta no resuelve en ESTA máquina: no se reintenta el disco. */
const noLocalBytes = new Set<Id>();
/** Hashes que ya hemos intentado publicar (aunque los rechazara la sala). */
const publishAttempts = new Set<string>();

/** Firma del conjunto de samples del proyecto (para no reconciliar de más). */
let lastSignature = '';
/** Una pasada a la vez; lo que llegue mientras corre re-encola otra. */
let running = false;
let rerun = false;
let lastReport: SampleSyncReport = EMPTY_REPORT;

/** Yjs nos da una vista; el motor quiere un ArrayBuffer suyo que pueda mover. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * ¿Ha cambiado el conjunto de samples desde la última consulta? Se llama en
 * cada comando del store, así que compara una firma barata en vez de recorrer
 * el proyecto entero.
 */
export function sampleSetChanged(): boolean {
  const ids = Object.keys(store.project.samples);
  const signature = `${ids.length}:${ids.join(',')}`;
  if (signature === lastSignature) return false;
  lastSignature = signature;
  return true;
}

/**
 * Generación de la sala. Sube en cada reset y la pasada en vuelo la mira en
 * cada vuelta: sin esto, salir de una sala a mitad de sincronización (cada
 * sample es un `await` por IPC; con veinte sonidos son cientos de ms) dejaba
 * que la pasada VIEJA siguiera corriendo después del reset y volviera a llenar
 * `loadedIds` con lo de la sala muerta. En la sala siguiente esos samples se
 * saltaban enteros —no se publicaban nunca— y, como en local sí estaban
 * cargados, tampoco salían como ausentes: al otro le sonaban mudos y sin pista.
 */
let generation = 0;

/** Olvida lo aprendido (al salir de la sala o cambiar de proyecto). */
export function resetSampleSync(): void {
  generation++;
  loadedIds.clear();
  noLocalBytes.clear();
  publishAttempts.clear();
  lastSignature = '';
  lastReport = EMPTY_REPORT;
}

/**
 * Reconcilia una vez el proyecto con el kernel y con la sala. Es idempotente y
 * serializada: llamarla de más no cuesta más que una firma y un `Set.has`.
 */
export async function syncSamplesWithRoom(session: CollabSession): Promise<SampleSyncReport> {
  if (running) {
    // Ya hay una pasada dentro; que la termine y repita con lo nuevo.
    rerun = true;
    return lastReport;
  }
  running = true;
  const gen = generation;
  try {
    do {
      rerun = false;
      lastReport = await pass(session, gen);
    } while (rerun && gen === generation);
  } finally {
    running = false;
  }
  return lastReport;
}

/**
 * Reconcilia **y después barre**: lo que hay que llamar cuando la sala
 * REEMPLAZA el proyecto entero — `CommandLogBinding.join()` al entrar y
 * `.replay()` al re-derivar tras un merge cruzado (`collab/command-log.ts`),
 * las dos vías que hacen `store.replaceProject()` y avisan por
 * `onProjectReplaced`.
 *
 * `syncSamplesWithRoom` a secas es media respuesta: sube al kernel lo que el
 * proyecto NUEVO necesita y deja intacto el audio del ANTERIOR —el mapa del
 * worklet, la caché de decodificado del `AudioEngine` y las tres cachés del
 * renderer—, porque nadie le pidió nunca que soltara nada. Es exactamente la
 * fuga que la v3.9 cerró en las otras cinco puertas que reemplazan el proyecto
 * (`rehydrateSamples()` y `newProject()`), por la única que no miró: aquí el
 * audio del proyecto de antes se quedaba en memoria hasta cerrar la app, y en
 * una sesión de sala el `replay()` puede pasar varias veces.
 *
 * ── El orden: subir primero, barrer después ──────────────────────────────────
 *
 * Es la misma elección que el barrido al final de `rehydrateSamples()`
 * (`browser/sound-actions.ts`), y aquí tiene además una razón propia, porque
 * esta pasada es asíncrona y re-entrante.
 *
 * Barrer DESPUÉS da una garantía que barrer antes no da: `pass()` solo sube
 * ids que están en `store.project.samples`, y el `keep` del barrido —con
 * `keepRegistered`, que es el valor por defecto— contiene TODO lo registrado,
 * así que el barrido no puede deshacer lo que la sincronización acaba de
 * hacer. Al revés no existe ese invariante: entre el barrido y el final de la
 * pasada hay un `await` por sample (leer del disco o de la sala, IPC y
 * decodificar; con veinte sonidos son cientos de ms), y en una sala el
 * proyecto se sigue moviendo en esa ventana. Un `unregisterSample` remoto que
 * caiga ahí —los despacha el `collectSessionSamples()` de cualquier peer, con
 * origin `'gc'`, y se re-anexan al log— dejaría un sample recién subido que ya
 * no nombra nadie y que ningún barrido volvería a mirar hasta el próximo
 * `replaceProject`: la misma fuga con otro disparador.
 *
 * El precio de barrer después es conocido y es el correcto: mientras dura la
 * pasada conviven los dos juegos de audio (un pico de |A| + |B|). Es un
 * transitorio de esos mismos cientos de ms, no una fuga, y es el que
 * `rehydrateSamples()` ya acepta. Barrer antes lo ahorraría a cambio de una
 * ventana en la que el kernel no tiene ni lo viejo ni lo nuevo, y lo que se
 * oye en esa ventana es silencio.
 *
 * ── Lo que aquí ya no usa nadie pero otro colaborador sí ─────────────────────
 *
 * Es lo que hace distinto a este caso, y la respuesta es que el barrido **no
 * se lo puede quitar**. Lo que el otro necesita son los BYTES DE LA SALA: el
 * `Y.Map` 'assets' de `collab/assets.ts`, indexado por hash y replicado en
 * todos los clientes. `collectWorkletSamples` no toca eso ni puede —solo mira
 * el mapa del worklet, la caché del `AudioEngine` y las del renderer—, así que
 * lo publicado sigue publicado y quien lo pida lo saca con
 * `session.getSample(hash)` aunque aquí no quede ni un byte decodificado. Lo
 * dice también la cabecera de `state/sample-gc.ts`: esto no borra el asset.
 *
 * Y el barrido tampoco reduce lo que PODEMOS publicar: `pass()` publica desde
 * `readSampleBytes(ref.path)`, o sea desde el disco, nunca desde el kernel.
 *
 * De ahí qué se olvida y qué no al barrer:
 *
 * - `loadedIds` **sí** se poda, y es obligatorio. Es nuestra copia de "eso ya
 *   está arriba"; si el kernel suelta un id y aquí seguimos creyendo que lo
 *   tiene, la próxima pasada hace `continue` sobre él. Y eso no da error: da
 *   un sample MUDO que ni siquiera aparece en `missing`. Pasa de verdad en una
 *   sala —un `replay()` que re-deriva y devuelve un sample de antes, o el undo
 *   de un peer— y por eso se poda con el `keep` que recibió el kernel y no con
 *   una lista propia: olvidar de más solo cuesta releer y volver a subir;
 *   olvidar de menos deja mudo (ver `AudioEngine.keepOnlySamples`).
 * - `publishAttempts` **no**. Guarda los hashes que ya pusimos en la sala, y
 *   vaciarlo no sacaría nada de allí: solo nos haría reintentar publicar lo
 *   que `session.hasSample` ya rechaza por duplicado.
 * - `noLocalBytes` **tampoco**: es un hecho sobre el disco de ESTA máquina
 *   («esta ruta no resuelve aquí»), no sobre el proyecto que acaba de irse.
 */
export async function syncSamplesAfterProjectReplaced(
  session: CollabSession,
): Promise<SampleSyncReport> {
  const gen = generation;
  const report = await syncSamplesWithRoom(session);
  // Salimos de la sala mientras la pasada corría (`resetSampleSync` subió la
  // generación): barrer ahora sería calcular el `keep` contra un proyecto que
  // ya no tiene nada que ver con la sesión que pidió esto.
  if (gen !== generation) return report;

  const collected = collectWorkletSamples(engine, store.project);
  if (collected.sent) {
    const keep = new Set<Id>(collected.keep);
    for (const id of loadedIds) if (!keep.has(id)) loadedIds.delete(id);
  }
  return report;
}

async function pass(session: CollabSession, gen: number): Promise<SampleSyncReport> {
  const missing: string[] = [];
  let loaded = 0;
  let published = 0;

  for (const ref of Object.values(store.project.samples)) {
    // La sala ya no es esta: se corta en seco en vez de seguir apuntando cosas
    // de la anterior sobre el estado recién reseteado.
    if (gen !== generation) return { loaded, published, missing };
    if (loadedIds.has(ref.id)) continue;

    // 1) Bytes de esta máquina: pack de fábrica, carpeta del usuario o
    //    grabación propia. Es el camino rápido y el único para lo de fábrica.
    let bytes: ArrayBuffer | null = null;
    let fromDisk = false;
    if (!noLocalBytes.has(ref.id)) {
      try {
        bytes = await readSampleBytes(ref.path);
      } catch {
        bytes = null; // el archivo no está en esta máquina: seguimos por la sala
      }
      if (bytes) fromDisk = true;
      else noLocalBytes.add(ref.id);
    }

    // 2) Si aquí no hay nada, lo que publicó el otro en la sala (por hash: su
    //    id y el nuestro pueden diferir, el sha1 del archivo no).
    if (!bytes) {
      const blob = session.getSample(ref.hash);
      if (blob) bytes = toArrayBuffer(blob);
    }

    if (!bytes) {
      missing.push(ref.name);
      continue;
    }

    try {
      await engine.loadSample(ref.id, bytes);
      loadedIds.add(ref.id);
      loaded++;
    } catch {
      // Formato que este navegador no decodifica: ese sonido no sonará, pero
      // el resto del proyecto sí. Cuenta como ausente para que la UI lo diga.
      missing.push(ref.name);
      continue;
    }

    // 3) Solo publica quien TIENE el archivo. Lo de fábrica no viaja.
    if (
      fromDisk &&
      !ref.path.startsWith('factory:') &&
      !publishAttempts.has(ref.hash) &&
      !session.hasSample(ref.hash)
    ) {
      publishAttempts.add(ref.hash);
      if (session.publishSample(new Uint8Array(bytes), { hash: ref.hash, name: ref.name }) === 'published') {
        published++;
      }
    }
  }

  return { loaded, published, missing };
}
