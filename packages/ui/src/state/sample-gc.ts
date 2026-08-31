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

/**
 * ── «Nadie avisa cuando el consumidor se va» ────────────────────────────────
 *
 * El pin de arriba es un caso de una clase que apareció tres veces alrededor
 * del editor de audio: **un recurso se da de alta y la baja queda a cargo de
 * nadie.** Los tres, y lo que resultó ser cada uno:
 *
 * 1. El sample que se sube al motor y todavía no está en el modelo (`runOp` y
 *    `runTune`): entre `loadSample` y `registerSample` no lo nombraba nada y un
 *    `collectSessionSamples` de otro origen —el Ctrl+Z de `useShortcuts`, que
 *    entra por los `await` de `decodeAudioData` y `crypto.subtle.digest`— se
 *    llevaba el audio recién subido y dejaba el clip mudo. Único de los tres
 *    que puede perder trabajo del usuario.
 * 2. La caché PCM del editor, que al cerrarse la ventana se quedaba esperando
 *    al próximo CAMBIO DE PROYECTO, que es el barrido de otra cosa.
 * 3. El `Set` de suscriptores de `sample-peaks.ts`, donde una baja perdida no
 *    tiene bytes que la delaten (retiene closures) y no la medía nada.
 *
 * **¿Se cierra de una vez, o son tres arreglos?** Tres arreglos en la baja, uno
 * solo en el diagnóstico. Y la razón no es pereza:
 *
 * - **La baja no se puede centralizar porque los tres ámbitos son distintos en
 *   naturaleza**: una operación asíncrona (vive lo que dura una promesa), un
 *   componente (vive lo que dura su montaje) y una suscripción (vive lo que
 *   quiera el que se suscribió). Cada uno tiene YA su construcción que la
 *   garantiza sin acordarse de nada: `finally` (aquí, `withPinnedSample`), el
 *   cleanup de `useEffect`, y la closure de baja que devuelve el alta. Un
 *   "gestor de recursos" común encima de los tres tendría que envolver tres
 *   mecanismos de ámbito ajenos, no daría ninguna garantía que esos tres no den
 *   ya, y sería una cuarta cosa de la que acordarse. El fallo, en los tres,
 *   nunca fue que faltara el mecanismo: `pinSample` existía con CERO llamantes,
 *   el cleanup de desmontaje sencillamente no se había escrito, y la baja de
 *   los picos ya era correcta.
 * - **Lo que sí generaliza es la regla**: toda alta nombra su baja en el mismo
 *   sitio y en el mismo commit, y la baja es ESTRUCTURAL —un `finally`, un
 *   cleanup, una closure devuelta—, nunca una llamada que haya que recordar en
 *   otro archivo. Un `pinSample` suelto es exactamente igual de peligroso que
 *   no sujetar: cambia la fuga de lado.
 * - **Y lo que sí se centraliza es el CONTADOR.** Las tres estructuras
 *   contestan hoy "cuánto hay vivo ahora mismo": `pinnedSamples()`,
 *   `stats()` / `uiAudioCacheStats()` y `peaksListenerCount()`. Eso es lo que
 *   convierte una fuga en un número en vez de una deducción, y es barato
 *   —tres funciones de una línea— porque el estado ya estaba ahí. La forma
 *   general (un `Set` de suscriptores con contador y aviso, que en el renderer
 *   se repite CUATRO veces: `sample-peaks`, `browser/pack-generator`,
 *   `state/param-touch` y `theme/useThemeVersion`) no cabe aquí: este archivo
 *   es sobre la vida de los SAMPLES, y los suscriptores de un tema no tienen
 *   nada que ver. Si se unifica, es en su propio módulo y con su propia
 *   tarjeta; lo que esta deja hecho es el precedente medible en uno de los
 *   cuatro.
 */

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
  /**
   * Suelta TODO: la baja del CONSUMIDOR, no la del proyecto.
   *
   * `gc()` contesta a «cambió el mundo» y conserva lo que el proyecto nuevo
   * sigue nombrando. Esto contesta a «el que la leía se fue» —se cierra la
   * ventana del editor de audio y con ella el único lector de su caché PCM—,
   * donde el conjunto vivo no es más chico: es VACÍO. No es otra política, es
   * la misma de arriba (cada caché se acota por su conjunto vivo, y se barre
   * cuando ese conjunto cambia) evaluada en el instante en que ese conjunto se
   * queda sin nadie que lo defina.
   *
   * Solo tiene sentido en una caché de consumidor único, que hoy es únicamente
   * la del editor: llamarlo en la del render o en la de picos tiraría lo que
   * otro panel sigue necesitando este mismo frame. Devuelve lo que soltó, para
   * que se pueda medir en vez de suponerse.
   */
  clear(): UiAudioCacheStats;
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
    clear() {
      const freed = stats();
      map.clear();
      return freed;
    },
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

// ── La otra mitad, en disco: el .wav que no borra nadie ──────────────────────

/**
 * Arriba se recupera MEMORIA. Esto recupera DISCO, y no es la misma política
 * con otro sustantivo: es la misma pregunta con otro coste de equivocarse.
 *
 * El síntoma es el mismo bug un piso más abajo. Cada Normalizar / Reverse /
 * Fade / Afinar del editor de audio escribe un `.wav` nuevo en el almacén de
 * grabaciones (`recording:<archivo>`) y registra un sample nuevo; el sample
 * viejo se queda sin nadie que lo use, sale de las cachés — y su ARCHIVO se
 * queda en disco para siempre. No aparece en un heap snapshot: aparece cuando
 * al usuario se le llena el disco.
 *
 * **Por qué la respuesta de arriba no vale tal cual.** El barrido de memoria se
 * apoya en una premisa que en disco es FALSA: «lo que este proyecto no nombra,
 * no lo necesita nadie». El mapa del worklet y las tres cachés del renderer son
 * de ESTA ventana y de ESTE proyecto, así que ahí la premisa se cumple por
 * construcción. La carpeta de grabaciones no: es un almacén GLOBAL de la app,
 * compartido por todos los proyectos (un `.orbit` de hace tres meses puede
 * nombrar `recording:algo.wav`), por las versiones y autosaves guardados, y por
 * cualquier otra ventana abierta ahora mismo. Y el error no es simétrico: en
 * memoria, equivocarse cuesta una relectura de disco; en disco, equivocarse
 * cuesta el audio del usuario, y no hay Ctrl+Z que lo traiga.
 *
 * De ahí salen las cuatro decisiones, y ninguna es de gusto:
 *
 * **1. No se borra al recolectar. Se ANOTA al escribir y se BARRE aparte.**
 * `collectWorkletSamples` corre en mitad de la sesión, dentro de las mismas
 * ventanas asíncronas que `withPinnedSample` existe para tapar, y lo llama
 * cualquiera que crea que «cambió el mundo» —hasta un Ctrl+Z—. Un `Map.delete`
 * ahí dentro es gratis; una baja de archivo ahí dentro es una ruleta. Por eso
 * el barrido de disco NO cuelga de `collectWorkletSamples` (a propósito, y es
 * lo único de este archivo que se sale de «un solo momento, un solo sitio»): la
 * recolección de memoria contesta «¿sobra ahora?» y esta contesta «¿sobra, y
 * además ya no puede dejar de sobrar?», que no se responden en el mismo
 * instante.
 *
 * **2. Solo es candidato lo que ESTA sesión escribió, y solo el editor.** El
 * libro se llena en el `recording.save` del editor y muere con la ventana: no
 * se persiste. Una toma de micro, un consolidado, una pista capturada, un audio
 * arrastrado o cualquier archivo de una corrida anterior NO entran nunca — de
 * esos no sabemos quién más los nombra. Esta restricción a priori es la que
 * sostiene todo lo demás: un archivo que nació hace veinte segundos en esta
 * ventana no lo puede estar nombrando un `.orbit` que se guardó antes de que
 * existiera. Es «cuando duda, conserva» aplicado al conjunto candidato en vez
 * de a cada decisión: la duda que no se puede resolver se evita entrando.
 *
 * **3. Vivo es lo que ya calcula la recolección, incluidas las ramas
 * archivadas.** No hay una definición nueva de «vivo» aquí, y no debe haberla.
 * Un archivo es reclamable solo si se cumplen las TRES a la vez:
 *
 *  - ninguno de sus sample ids está sujeto (`pinnedSamples()`) — un sample
 *    sujeto está vivo por definición: es justo el que se está creando;
 *  - `project.samples` no nombra su ruta (la misma premisa de `liveSampleKeys`,
 *    evaluada sobre `path` en vez de sobre la clave de caché);
 *  - `ProjectStore.unreachableIds` devuelve TODOS sus nombres —la ruta y sus
 *    ids—, o sea que ningún undo, ningún redo y **ninguna rama archivada** del
 *    historial puede volver a nombrarlos. Esa es la parte difícil y ya estaba
 *    resuelta: `unreachableIds` recorre `undoStack`, `redoStack` y las
 *    `branches` del árbol de historial buscando el texto exacto entre comillas,
 *    así que una ruta metida dentro del `registerSample` de una rama abandonada
 *    mantiene vivo su archivo sin que este módulo sepa qué es una rama. Un id
 *    que aparece de casualidad en otro comando solo ALARGA la vida del archivo:
 *    el único error posible cae del lado seguro.
 *
 * En una cadena de cinco Normalizar la condición que manda es la tercera: los
 * cuatro intermedios siguen vivos mientras su paso de undo siga en el
 * historial, y solo dejan de estarlo cuando esa entrada se cae de verdad (tope
 * de 500 de `ProjectStore`, o su rama podada). Que es exactamente lo que se
 * quiere: mientras el usuario pueda volver ahí con Ctrl+Z, el archivo se queda.
 *
 * **4. Lo que se le pide al almacén es una BAJA REVERSIBLE, no un borrado.**
 * Por eso la capacidad se llama `discard` y su contrato dice «reversible
 * durante una ventana de retención»: papelera con caducidad, y `recording.read`
 * resolviendo también lo que está en ella. Un almacén que la implemente como un
 * borrado a secas incumple el contrato. La razón es la única duda que la
 * restricción (2) NO cubre: con nombres por contenido (ver `AudioEditor.tsx`),
 * dos ventanas que hagan la misma edición sobre el mismo audio escriben el
 * MISMO archivo, y ninguna ve el historial de la otra. Con papelera eso cuesta,
 * como mucho, un arranque; sin ella cuesta un clip mudo. Y de paso cubre la
 * duda de fondo que ningún cálculo del renderer puede cerrar —el `.orbit`
 * guardado, la versión restaurable, la ventana de al lado—: la retención es lo
 * que convierte «crecer para siempre» en «acotado», que era el problema, sin
 * convertir un error de cuenta en pérdida de audio.
 *
 * **Y por eso esto no se manda si el almacén no sabe hacerlo**, igual que
 * `collectWorkletSamples` no toca el kernel sin `keepOnlySamples`: mejor no
 * recuperar disco que recuperarlo mal.
 *
 * **Dónde va enganchado.** El momento seguro es aquel en el que el proyecto
 * deja de ser el sujeto de la pregunta, y JUSTO ANTES de que lo deje de ser:
 * las puertas que reemplazan el proyecto entero (`rehydrateSamples` y
 * compañía) y el cierre de la app. Después de reemplazarlo ya es tarde —el
 * historial que protegía a esos archivos se fue con el proyecto anterior—, así
 * que ahí lo que toca no es barrer sino `forgetRecordingLedger()`: sin sujeto
 * la pregunta no tiene respuesta, y sin respuesta se conserva.
 */

/** Único esquema que este módulo sabe reclamar. */
const RECORDING_SCHEME = 'recording:';

/**
 * Tope del libro de archivos que la sesión lleva escritos.
 *
 * Al pasarse se olvida el más viejo, y olvidar es NO reclamar: el
 * desbordamiento empuja hacia la fuga, nunca hacia la baja. Es la dirección
 * correcta para un tope que nadie va a mirar. 200 ediciones destructivas en una
 * sola sesión ya es una sesión rarísima, y el libro entero son unos pocos
 * kilobytes.
 */
export const RECORDING_LEDGER_ENTRIES = 200;

/** Un archivo que esta sesión escribió en el almacén de grabaciones. */
export interface RecordingLedgerEntry {
  /** Nombre dentro de la carpeta de grabaciones (el que devolvió `recording.save`). */
  file: string;
  /** `recording:<file>`, tal cual aparece en `SampleRef.path`. */
  path: string;
  /** Bytes que ocupa en disco. Medidos al escribirlo, no estimados. */
  bytes: number;
  /**
   * Ids de sample que llegaron a nombrar este archivo. Son varios cuando el
   * nombre va por contenido y la misma edición se repite (Normalizar, Ctrl+Z,
   * Normalizar otra vez): mismo archivo, `newId()` distinto cada vez.
   */
  sampleIds: string[];
  /** Cuándo lo escribió esta sesión. */
  at: number;
}

const recordingLedger = new Map<string, RecordingLedgerEntry>();

/** El nombre de archivo de una ruta `recording:<archivo>`, o null si es de otro esquema. */
export function recordingFileOf(path: string): string | null {
  return path.startsWith(RECORDING_SCHEME) ? path.slice(RECORDING_SCHEME.length) : null;
}

/**
 * El alta: «esta sesión acaba de escribir este archivo para este sample».
 *
 * Va pegada al `recording.save` que lo escribe, no al `registerSample` que lo
 * nombra, y la diferencia es deliberada: una operación que revienta entre las
 * dos deja el archivo en disco sin que nada lo nombre jamás, que es justo el
 * caso que hay que poder reclamar. Anotar es barato y no autoriza nada — quien
 * decide es `reclaimableRecordings`.
 */
export function noteRecordingWritten(entry: {
  sampleId: string;
  path: string;
  bytes: number;
}): void {
  const file = recordingFileOf(entry.path);
  if (!file || !entry.sampleId) return;
  const known = recordingLedger.get(file);
  if (known) {
    if (!known.sampleIds.includes(entry.sampleId)) known.sampleIds.push(entry.sampleId);
    return;
  }
  recordingLedger.set(file, {
    file,
    path: entry.path,
    bytes: entry.bytes,
    sampleIds: [entry.sampleId],
    at: Date.now(),
  });
  while (recordingLedger.size > RECORDING_LEDGER_ENTRIES) {
    const oldest = recordingLedger.keys().next();
    if (oldest.done) break;
    recordingLedger.delete(oldest.value);
  }
}

/**
 * Olvida el libro entero: la baja del SUJETO de la pregunta.
 *
 * Se llama cuando el proyecto se reemplaza (abrir otro, restaurar una versión,
 * entrar en una sala). A partir de ahí el historial que protegía esos archivos
 * ya no está, así que no se puede contestar si siguen vivos — y sin respuesta
 * se conserva. Olvidar es la opción conservadora, no la perezosa.
 */
export function forgetRecordingLedger(): void {
  recordingLedger.clear();
}

/** Lo que esta sesión lleva escrito en disco. Para medir, no para estimar. */
export function recordingLedgerStats(): { files: number; bytes: number } {
  let bytes = 0;
  for (const entry of recordingLedger.values()) bytes += entry.bytes;
  return { files: recordingLedger.size, bytes };
}

/** El libro tal cual, para inspeccionarlo desde un test o desde la consola. */
export function recordingLedgerEntries(): RecordingLedgerEntry[] {
  return [...recordingLedger.values()];
}

/**
 * Lo que la decisión necesita saber del mundo, inyectado en vez de importado.
 *
 * `unreachableIds` es `ProjectStore.unreachableIds` (`core/src/store.ts`): la
 * respuesta ya calculada de «de estos nombres, ¿cuáles no puede volver a
 * nombrar ningún undo, redo ni rama archivada?». Entra por parámetro para que
 * este archivo siga sin depender de `state/app` — y para que un test pueda
 * afirmar la política contra un store de verdad sin montar la app.
 */
export interface RecordingGcDeps {
  project: Project;
  unreachableIds(ids: Iterable<string>): string[];
}

/** Un archivo que se conserva, y por qué. */
export interface RecordingKept {
  entry: RecordingLedgerEntry;
  reason: string;
}

export interface RecordingReclaimPlan {
  /** Archivos que cumplen las tres condiciones. */
  reclaim: RecordingLedgerEntry[];
  /** Los demás, cada uno con el motivo que lo salvó. */
  keep: RecordingKept[];
  /** Bytes que se recuperarían. */
  bytes: number;
}

/**
 * Qué archivos del libro se pueden dar de baja, y por qué NO los demás.
 *
 * Pura: no toca el disco ni el store, solo decide. El motivo de cada conservado
 * se devuelve porque es lo que convierte «no liberó nada» en un diagnóstico en
 * vez de en una sospecha.
 */
export function reclaimableRecordings(deps: RecordingGcDeps): RecordingReclaimPlan {
  const entries = [...recordingLedger.values()];
  const reclaim: RecordingLedgerEntry[] = [];
  const keep: RecordingKept[] = [];
  if (entries.length === 0) return { reclaim, keep, bytes: 0 };

  const namedByProject = new Set<string>();
  for (const ref of Object.values(deps.project.samples)) {
    if (ref?.path) namedByProject.add(ref.path);
  }

  // Una sola pasada de `unreachableIds` para todos los candidatos: recorre el
  // historial entero con un `JSON.stringify` por comando, así que preguntar
  // archivo por archivo sería el mismo trabajo repetido N veces.
  const pending: RecordingLedgerEntry[] = [];
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.sampleIds.some((id) => pinned.has(id))) {
      keep.push({ entry, reason: 'sujeto: la operación que lo escribe sigue en vuelo' });
    } else if (namedByProject.has(entry.path)) {
      keep.push({ entry, reason: 'el proyecto lo nombra' });
    } else {
      pending.push(entry);
      names.push(entry.path, ...entry.sampleIds);
    }
  }

  const unreachable = new Set(deps.unreachableIds(names));
  let bytes = 0;
  for (const entry of pending) {
    const dead = unreachable.has(entry.path) && entry.sampleIds.every((id) => unreachable.has(id));
    if (dead) {
      reclaim.push(entry);
      bytes += entry.bytes;
    } else {
      keep.push({
        entry,
        reason: 'un undo, un redo o una rama archivada puede volver a nombrarlo',
      });
    }
  }
  return { reclaim, keep, bytes };
}

/**
 * Lo que el barrido de disco necesita del almacén de grabaciones.
 *
 * **`discard` no es borrar.** El contrato es una baja REVERSIBLE durante una
 * ventana de retención —papelera con caducidad, y `recording.read` resolviendo
 * también lo que está en ella—, no un `unlink`. Ver la decisión (4) del bloque
 * de arriba: es lo que cubre la única duda que el renderer no puede cerrar por
 * cálculo (el `.orbit` guardado, la versión restaurable, la ventana de al
 * lado). Devuelve los archivos que de verdad dio de baja.
 *
 * Opcional por el mismo motivo que `keepOnlySamples` en `SampleGcEngine`: si el
 * almacén no lo sabe hacer, esto no se manda. Mejor no recuperar disco que
 * recuperarlo mal.
 */
export interface RecordingStore {
  discard?(files: readonly string[]): Promise<readonly string[]>;
}

export interface RecordingSweep {
  before: { files: number; bytes: number };
  after: { files: number; bytes: number };
  /** Archivos que el almacén confirmó haber dado de baja. */
  discarded: string[];
  /** Los que se conservaron, con su motivo. */
  kept: { file: string; reason: string }[];
  /** false = no se le pidió nada al almacén (y `reason` dice por qué). */
  sent: boolean;
  reason?: string;
}

/**
 * Pide al almacén que dé de baja los archivos que ya no puede nombrar nadie.
 *
 * Se llama en el momento seguro, no en cada recolección (ver la decisión 1). El
 * libro solo se poda con lo que el almacén CONFIRMÓ: si una baja falla, el
 * archivo sigue anotado y se reintenta en el próximo barrido, que es preferible
 * a darlo por ido y no volver a mirarlo nunca.
 */
export async function sweepRecordingFiles(
  deps: RecordingGcDeps,
  store: RecordingStore,
): Promise<RecordingSweep> {
  const before = recordingLedgerStats();
  const plan = reclaimableRecordings(deps);
  const kept = plan.keep.map((k) => ({ file: k.entry.file, reason: k.reason }));
  if (typeof store.discard !== 'function') {
    return {
      before,
      after: before,
      discarded: [],
      kept,
      sent: false,
      reason: 'el almacén de grabaciones no sabe dar de baja un archivo',
    };
  }
  if (plan.reclaim.length === 0) {
    return { before, after: before, discarded: [], kept, sent: true };
  }
  const discarded = await store.discard(plan.reclaim.map((e) => e.file));
  for (const file of discarded) recordingLedger.delete(file);
  return { before, after: recordingLedgerStats(), discarded: [...discarded], kept, sent: true };
}
