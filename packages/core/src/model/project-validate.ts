/**
 * Tipos y referencias de un proyecto recién parseado (BUG 017).
 *
 * `parseProject` comprobaba que el ESQUELETO estuviera y poco más: los campos
 * aditivos se rellenaban con `??=` sin mirar qué traían, las entidades de los
 * pools no se comprobaban, y los números que van a la línea de tiempo pasaban
 * como fueran. De ahí lo que se veía al abrir un archivo tocado a mano o escrito
 * por una versión futura: `samples: 42` pasaba, un patrón `null` compilaba en
 * silencio, y un `volume: 'loud'` en un canal salía como un NaN en el audio
 * renderizado.
 *
 * El QUÉ se espera de cada campo vive en `model/entity-schema.ts`, el mismo módulo
 * que usa la validación de comandos de la sala (BUG 018): son la misma pregunta en
 * dos puertas, y `Channel` no se describe dos veces. Aquí solo está lo que es del
 * PROYECTO y no de una entidad:
 *
 * - **Pools y entidades**: cada pool tiene que ser un mapa y cada entrada una
 *   entidad de las que el motor lee. Un pool que no es pool (`samples: 42`) se
 *   rechaza; una lista vacía vale como "sin nada".
 * - **Listas de orden**: tienen que ser listas de ids, y se podan las entradas que
 *   ya no existen (rehacer la lista si se queda vacía, para que el patrón no
 *   desaparezca en silencio).
 * - **Mesa de mezcla**: es una lista de tamaño fijo que el motor indexa por
 *   posición, así que cada pista se valida como entidad y no solo por sus números.
 *
 * Dos reglas gobiernan el resto:
 *
 * - **Un campo que el modelo declara obligatorio se exige.** Si falta, el motor lee
 *   `undefined`: un canal sin `volume` da NaN y un patrón sin `notes` revienta al
 *   recorrer. Un campo opcional ausente NO es un problema: es lo que hace que los
 *   `.orbit` de antes sigan abriéndose.
 * - **Esto corre ANTES de adoptar los pools.** Adoptar copia a pools sin prototipo
 *   y descarta claves reservadas, así que un `samples: 42` se convertiría en un
 *   pool vacío y el validador, al mirar después, ya no vería el tipo: el archivo
 *   inválido pasaría por limpio. Primero se juzga, luego se adopta.
 *
 * Módulo puro y sin DOM, para poder probarlo entero sin pasar por un archivo.
 */

import { checkForma, entityProblem, type Entidad, type Problema } from './entity-schema';
import { PROJECT_POOLS } from './entity-id';

/** Qué entidad hay en cada pool del proyecto (`mixer` no es un pool: es una lista). */
const POOL_A_ENTIDAD: Record<string, Entidad> = {
  channels: 'channel',
  channelGroups: 'channelGroup',
  patterns: 'pattern',
  arrangements: 'arrangement',
  playlistTracks: 'playlistTrack',
  clips: 'clip',
  markers: 'marker',
  sections: 'section',
  lfos: 'lfo',
  inputRoutes: 'inputRoute',
  samples: 'sample',
};

/** Listas de orden que el motor recorre por posición. */
const ORDER_FIELDS = [
  'channelOrder',
  'patternOrder',
  'arrangementOrder',
  'channelGroupOrder',
  'inputRouteOrder',
] as const;

/** Números sueltos del proyecto, fuera de cualquier entidad. */
const NUMERICOS_PROYECTO: readonly string[] = ['tempo', 'swing'];

/**
 * Campos que NO se rechazan por su tipo porque `parseProject` los SANEA después,
 * con el motivo escrito allí: los cortes del slicer se normalizan y se ordenan,
 * la rueda de tono se acota (y el 0 se borra) y el keymap se filtra contra las
 * muestras que existen de verdad. Un `bend: "loud"` se cae; no arruina el
 * archivo, porque es dato del usuario y el saneo ya existía.
 */
const SANEADOS = ['bend', 'keymap', 'slicePoints'] as const;

/** Copia la entidad sin esos campos, para validar lo que el saneo no toca. */
function sinSaneados(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const copia = { ...(value as Record<string, unknown>) };
  for (const campo of SANEADOS) delete copia[campo];
  return copia;
}

export type ParseProblem = Problema;

/**
 * Comprueba el proyecto YA parseado (aún sin sanear) y devuelve los problemas que
 * lo hacen ilegible. Lo que devuelve no son excepciones: así el que llama decide el
 * mensaje y el test puede ver la lista entera.
 */
export function findProjectProblems(project: Record<string, unknown>): ParseProblem[] {
  const problemas: ParseProblem[] = [];

  // 1. Listas de orden: o son listas de ids, o el motor las recorre esperando
  //    elementos. Un `42` aquí no es "un orden raro": es nada.
  for (const field of ORDER_FIELDS) {
    const value = project[field];
    if (value === undefined || value === null) continue; // aditivo: se rellena
    if (!Array.isArray(value)) {
      problemas.push({ field, expected: 'una lista de ids' });
      continue;
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') {
        problemas.push({ field: `${field}[${i}]`, expected: 'un id (string)' });
      }
    }
  }

  // 2. Cada pool tiene que SER un pool, y cada entrada tiene que ser la entidad que
  //    dice su nombre. Una lista VACÍA sí vale como "sin nada": no hay nada que
  //    perder y hay archivos que la traen así.
  for (const poolName of PROJECT_POOLS) {
    const pool = project[poolName];
    if (pool === undefined || pool === null) continue; // aditivo: se rellena
    if (typeof pool !== 'object' || (Array.isArray(pool) && pool.length > 0)) {
      problemas.push({ field: poolName, expected: 'un mapa de entidades' });
      continue;
    }
    const entidad = POOL_A_ENTIDAD[poolName];
    for (const [id, value] of Object.entries(pool as Record<string, unknown>)) {
      const problema =
        entidad === undefined
          ? { field: `${poolName}.${id}`, expected: 'una entidad (objeto)' }
          : entityProblem(sinSaneados(value), entidad, `${poolName}.${id}`);
      if (problema) problemas.push(problema);
    }
  }

  // 3. Números sueltos del proyecto. `swing: 'wrong'` llegaba a `swungStart` y
  //    volvía NaN en el tiempo de cada evento: el beat se rompía en silencio.
  for (const field of NUMERICOS_PROYECTO) {
    const problema = checkForma(project[field], 'num', field);
    if (problema && project[field] !== undefined) problemas.push(problema);
  }
  // `timeSig` es obligatorio y sus dos números van a la compilación.
  if (project.timeSig !== undefined) {
    const problema = entityProblem(project.timeSig, 'timeSig', 'timeSig');
    if (problema) problemas.push(problema);
  }

  // 4. La mesa de mezcla: lista de tamaño fijo que el motor indexa por posición, y
  //    cada pista se valida como ENTIDAD (sus slots, sus envíos, sus números), no
  //    solo por los números de la pista.
  const mixer = project.mixer;
  if (Array.isArray(mixer)) {
    mixer.forEach((track, i) => {
      const problema = entityProblem(track, 'mixerTrack', `mixer[${i}]`);
      if (problema) problemas.push(problema);
    });
  }

  return problemas;
}

/** Los ids de una lista de orden que existen de verdad en su pool. */
export function keepExistingIds(order: readonly unknown[], pool: Record<string, unknown>): string[] {
  const kept: string[] = [];
  for (const id of order) {
    if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(pool, id)) kept.push(id);
  }
  return kept;
}