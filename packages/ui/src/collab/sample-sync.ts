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
 */

import type { CollabSession } from '@orbit/collab';
import type { Id } from '@orbit/core';
import { readSampleBytes } from '../browser/sound-actions';
import { engine, store } from '../state/app';

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

/** Olvida lo aprendido (al salir de la sala o cambiar de proyecto). */
export function resetSampleSync(): void {
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
  try {
    do {
      rerun = false;
      lastReport = await pass(session);
    } while (rerun);
  } finally {
    running = false;
  }
  return lastReport;
}

async function pass(session: CollabSession): Promise<SampleSyncReport> {
  const missing: string[] = [];
  let loaded = 0;
  let published = 0;

  for (const ref of Object.values(store.project.samples)) {
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
