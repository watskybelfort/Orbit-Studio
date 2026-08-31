/**
 * Recolección de samples: soltar el audio que ya no usa nadie, en los DOS
 * hilos — el de audio (el mapa del worklet) y el de la UI (las tres cachés de
 * audio decodificado del renderer, ver la sección de abajo).
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
 *
 * Ese último punto es también por qué las cachés del hilo de UI se barren desde
 * aquí y no cada una por su cuenta: «acaba de cambiar el mundo» es un solo
 * momento, y tenerlo escrito en un solo sitio es lo que impide que una de las
 * dos mitades se enganche donde la otra no (que es exactamente lo que pasó
 * entre la v3.7 y la v3.8).
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

// ── Las cachés de audio decodificado del hilo de UI ──────────────────────────

/**
 * Arriba se recolecta el audio del hilo de AUDIO. Abajo, el del hilo de la UI,
 * que es la otra mitad del mismo problema y hasta ahora no tenía dueño.
 *
 * Hay tres cachés de audio decodificado en el renderer y ninguna compartía
 * política: la del render (`export/render-inputs.ts`), la de picos
 * (`state/sample-peaks.ts`) y la PCM del editor de audio
 * (`editors/audio/AudioEditor.tsx`). Se atacan como una sola clase, con una
 * regla y tres instancias:
 *
 * **Cada caché se acota por su CONJUNTO VIVO, no por bytes; el conjunto vivo lo
 * define su consumidor, y se barre en el momento en que ese conjunto cambia.**
 *
 * De ahí salen las tres, sin margen para el gusto:
 *
 * - Render y picos sirven al PROYECTO ENTERO a la vez —un export necesita todos
 *   sus samples simultáneamente, y la playlist pinta todos los clips de audio
 *   del mismo frame—, así que su conjunto vivo es `project.samples` completo
 *   (`liveSampleKeys`, equivalente al `keepRegistered: true` del worklet: perder
 *   el registro solo cuesta una relectura de disco en el próximo undo/export, y
 *   reutilizar entre exports sucesivos es justo para lo que existen). Un tope de
 *   entradas ahí sería activamente dañino: desalojaría a mitad de un export lo
 *   que ese mismo export sigue necesitando.
 * - La PCM del editor sirve a UN sample: el que está abierto. Su conjunto vivo
 *   es O(1) y el barrido por proyecto **no la acota**, que es exactamente el
 *   fallo reportado — cinco Normalizar seguidos dejan cinco samples que SIGUEN
 *   registrados (cada operación hace `registerSample`), así que "lo que el
 *   proyecto registra" los conserva todos. Por eso, y solo ella, lleva además un
 *   tope de recencia (`AUDIO_EDITOR_PCM_ENTRIES`).
 *
 * **Sin tope en bytes, a propósito y otra vez.** Ya se decidió así en la v3.7 y
 * el reexamen no lo cambia: un máximo de bytes convierte al render en un LRU que
 * thrashea con el primer proyecto que no le quepa entero (y el síntoma sería un
 * export lento y una relectura de disco por sample, no un error), y en los picos
 * no se dispararía nunca —11,2 KB por entrada—. Donde el volumen sí manda, que
 * es el editor, el tope de ENTRADAS ya es un tope de bytes con otro nombre: dos
 * veces el sample más largo que quepa en el editor, y ni un byte más.
 */

/**
 * Clave de las tres cachés: identidad de CONTENIDO, no solo de id (un id
 * re-grabado con hash nuevo no puede servir el audio viejo desde caché).
 *
 * Vive aquí, una sola vez, por lo que pasa si dos copias divergen: el barrido
 * arma el conjunto vivo con esta función y las cachés guardan con esta función,
 * así que una diferencia de una coma haría que el GC desalojara en cada llamada
 * justo lo que se acaba de guardar. Y no daría error: daría una relectura de
 * disco por frame.
 */
export function sampleCacheKey(id: string, hash: string): string {
  return `${id}:${hash}`;
}

/**
 * Lo que el proyecto justifica tener decodificado, en claves de caché.
 *
 * Se recorre `project.samples` por sus VALORES y se usa `ref.id`, no la clave
 * del objeto: son el mismo string porque `applyCommand` escribe
 * `project.samples[cmd.sample.id] = cmd.sample` (`core/src/commands.ts`), y de
 * esa equivalencia depende que `sampleCacheKey(id, ref.hash)` del que guarda y
 * `sampleCacheKey(ref.id, ref.hash)` del que barre den lo mismo.
 */
export function liveSampleKeys(project: Project): ReadonlySet<string> {
  const live = new Set<string>();
  for (const ref of Object.values(project.samples)) {
    if (ref) live.add(sampleCacheKey(ref.id, ref.hash));
  }
  return live;
}

export interface UiAudioCacheStats {
  entries: number;
  bytes: number;
}

/** Lo que el barrido hizo con una caché concreta. */
export interface UiAudioCacheSweep {
  name: string;
  before: UiAudioCacheStats;
  after: UiAudioCacheStats;
}

/** La parte de una caché que le interesa al barrido común. */
interface SweepableCache {
  readonly name: string;
  stats(): UiAudioCacheStats;
  gc(project: Project): { before: UiAudioCacheStats; after: UiAudioCacheStats };
}

export interface UiAudioCache<T> extends SweepableCache {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
}

/**
 * El registro es de módulos, no de instancias vivas: cada caché se apunta al
 * cargarse. Que una caché no esté registrada porque su módulo todavía no se
 * importó no es un agujero — un módulo sin cargar no tiene nada decodificado
 * dentro, así que no barrerlo es la respuesta correcta.
 */
const uiCaches: SweepableCache[] = [];

/**
 * Caché de audio decodificado del hilo de UI, con la política común aplicada.
 *
 * `capacity` es la única perilla, y es la que separa las dos formas: sin ella,
 * la caché se acota solo contra el proyecto (conjunto vivo O(proyecto)); con
 * ella, además desaloja por recencia (conjunto vivo O(1)). Ver el bloque de
 * arriba para por qué cada una lleva lo que lleva.
 */
export function createUiAudioCache<T>(opts: {
  name: string;
  /** Bytes REALES que retiene un valor — para medir, no para estimar. */
  bytesOf: (value: T) => number;
  /** Tope de entradas por recencia. Sin él, no hay desalojo por tamaño. */
  capacity?: number;
  /**
   * Estado paralelo con las mismas claves que hay que barrer a la vez (el
   * conjunto `failed` de los picos): si sobrevive al proyecto que lo generó,
   * es la misma fuga con otro tipo.
   */
  sweepExtra?: (live: ReadonlySet<string>) => void;
}): UiAudioCache<T> {
  const { name, bytesOf, capacity, sweepExtra } = opts;
  const map = new Map<string, T>();

  function stats(): UiAudioCacheStats {
    let bytes = 0;
    for (const value of map.values()) bytes += bytesOf(value);
    return { entries: map.size, bytes };
  }

  const cache: UiAudioCache<T> = {
    name,
    get(key) {
      const hit = map.get(key);
      // Reordenar el Map para refrescar la recencia solo tiene sentido si algo
      // desaloja por recencia; sin tope es trabajo que nadie mira.
      if (hit !== undefined && capacity !== undefined) {
        map.delete(key);
        map.set(key, hit);
      }
      return hit;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (capacity === undefined) return;
      while (map.size > capacity) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    has: (key) => map.has(key),
    stats,
    gc(project) {
      const before = stats();
      const live = liveSampleKeys(project);
      for (const key of map.keys()) {
        if (!live.has(key)) map.delete(key);
      }
      sweepExtra?.(live);
      return { before, after: stats() };
    },
  };
  uiCaches.push(cache);
  return cache;
}

/**
 * Tope de recencia de la caché PCM del editor de audio: el sample abierto y
 * aquel del que se viene.
 *
 * Dos y no uno porque el camino más frecuente después de una operación
 * destructiva es deshacerla: Normalizar deja el clip apuntando al sample nuevo
 * y un Ctrl+Z lo devuelve al viejo, que con tope 1 habría que releer del disco
 * y volver a decodificar. Dos y no cinco porque cada entrada es el buffer
 * entero —un pad estéreo de 30 s son ~11,5 MB— y el tercer paso de undo es
 * bastante más raro que el primero: no vale 11 MB residentes.
 *
 * Vive aquí y no en el `.tsx` porque es una decisión de la POLÍTICA, no del
 * componente; y porque así el test puede afirmar el número sin montar React.
 */
export const AUDIO_EDITOR_PCM_ENTRIES = 2;

/**
 * Barre las tres cachés contra el proyecto que ahora es verdad.
 *
 * Seguro con un export en marcha: esto solo hace `Map.delete` sobre las cachés
 * y nunca toca los buffers ya entregados — `collectSamples` devuelve su propio
 * `Map`, que los sigue sosteniendo pase lo que pase aquí (ver
 * `render-inputs.ts` y `render-inputs-cache.test.ts`).
 */
export function collectUiAudioCaches(project: Project): UiAudioCacheSweep[] {
  return uiCaches.map((cache) => ({ name: cache.name, ...cache.gc(project) }));
}

/**
 * Tamaño real de las cachés de audio de la UI ahora mismo — para medir, no para
 * estimar. Es lo que se teclea en la consola del renderer para comprobar que la
 * memoria de verdad volvió (`total` + el desglose por caché).
 */
export function uiAudioCacheStats(): UiAudioCacheStats & {
  caches: ({ name: string } & UiAudioCacheStats)[];
} {
  const caches = uiCaches.map((cache) => ({ name: cache.name, ...cache.stats() }));
  let entries = 0;
  let bytes = 0;
  for (const c of caches) {
    entries += c.entries;
    bytes += c.bytes;
  }
  return { entries, bytes, caches };
}

export interface CollectResult {
  /** Ids que se le pidió al kernel conservar. */
  keep: string[];
  /** false = no se mandó nada al KERNEL (y `reason` dice por qué). */
  sent: boolean;
  reason?: string;
  /** Lo que el mismo gesto liberó en el hilo de la UI. */
  ui: UiAudioCacheSweep[];
}

/**
 * Pide al worklet que suelte lo que no esté en la lista, **y barre las cachés
 * de audio del hilo de UI con el mismo gesto**.
 *
 * Las dos cosas van juntas por lo que son: los dos hilos guardan el mismo audio
 * del mismo proyecto y el momento en que sobra es idéntico —abrir un proyecto,
 * restaurar una versión, recuperar un autosave—, así que separarlas solo
 * habilita que una se enganche donde la otra no. Hasta la v3.8 el barrido de la
 * UI colgaba únicamente de `collectSamples()`, o sea de EXPORTAR: la cota real
 * no era «el proyecto abierto» sino «el último proyecto que se exportó», y
 * trabajar tres horas en otra canción sin exportar dejaba el audio decodificado
 * de la anterior entero en memoria. Enganchándolo aquí, los tres llamantes que
 * ya existían (`project-file.ts`, `rehydrateSamples`, `collectSessionSamples`)
 * lo heredan y ninguno futuro se puede olvidar.
 *
 * El barrido de la UI va ANTES del retorno temprano a propósito: la razón para
 * no tocar el kernel —soltar sin poder vaciar su caché deja samplers mudos— no
 * aplica al renderer, donde una entrada de menos solo cuesta releer del disco.
 *
 * `keepRegistered` (por defecto activo) conserva además todo lo registrado en
 * el proyecto aunque no lo use ningún canal ni clip: es lo que hace que
 * deshacer el borrado de un clip devuelva el audio y no un clip mudo. Ponerlo
 * en `false` recupera más memoria y paga ese precio. No afecta a las cachés de
 * la UI, que se acotan siempre contra lo registrado (ver `liveSampleKeys`).
 */
export function collectWorkletSamples(
  engine: SampleGcEngine,
  project: Project,
  opts: { keepRegistered?: boolean } = {},
): CollectResult {
  const ui = collectUiAudioCaches(project);
  const keep = sampleKeepSet(project, {
    pinned,
    ...(opts.keepRegistered === undefined ? null : { keepRegistered: opts.keepRegistered }),
  });
  if (typeof engine.keepOnlySamples !== 'function') {
    // Ver `SampleGcEngine`: soltar sin poder vaciar la caché del motor deja
    // samplers mudos. Mejor no recolectar que recolectar mal.
    return { keep, sent: false, reason: 'el motor no sabe olvidar su caché de samples', ui };
  }
  engine.keepOnlySamples(keep);
  engine.send({ type: 'collectSamples', keep });
  return { keep, sent: true, ui };
}
