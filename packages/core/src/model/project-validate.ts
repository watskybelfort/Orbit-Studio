/**
 * Tipos y referencias de un proyecto recién parseado (BUG 017).
 *
 * `parseProject` comprobaba que el ESQUELETO estuviera y poco más: los campos
 * aditivos se rellenaban con `??=` sin mirar qué traían, y las entidades de los
 * pools no se comprobaban. De ahí lo que se veía al abrir un archivo tocado a
 * mano o escrito por una versión futura: `patternOrder: 42` pasaba y
 * `patterns: { x: null }` también —el compilaba ensuing en silencio o reventaba
 * con un TypeError que no nombraba el campo—.
 *
 * Aquí se decide QUÉ es estructura y qué es contenido musical, porque no todo
 * puede fallar:
 *
 * - **Estructura**: listas de orden y entidades de pool. Si su tipo no es el
 *   que el motor lee, se falla aquí y por su nombre. Un archivo que no se
 *   entiende no es un archivo: abrirlo a medias es peor que no abrirlo.
 * - **Contenido**: las notas de un clip, un corte de un canal, un slot de
 *   efecto. Eso se sanea y se acota donde ya se hacía (slices, keymap, bend,
 *   busTrack), porque un canal raro sigue siendo un canal: son datos del
 *   usuario, no una avería del archivo. Un clip que apunta a un patrón que no
 *   existe suena a silencio, y eso se deja como está —recuperable y sin ruido—.
 *
 * Módulo puro y sin dependencias de DOM para poder probarlo entero.
 */

import { PROJECT_POOLS } from './entity-id';

/** Listas de orden que el motor recorre por posición. */
const ORDER_FIELDS = [
  'channelOrder',
  'patternOrder',
  'arrangementOrder',
  'channelGroupOrder',
  'inputRouteOrder',
] as const;

export interface ParseProblem {
  /** Campo con el problema, con su ruta (`mixer[3]`). */
  field: string;
  /** Qué se esperaba. */
  expected: string;
}

/**
 * Comprueba el proyecto YA parseado (aún sin sanear) y devuelve los problemas
 * que lo hacen ilegible. Lo que devuelve no son excepciones: así el que llama
 * decide el mensaje y el test puede ver la lista entera.
 */
export function findProjectProblems(project: Record<string, unknown>): ParseProblem[] {
  const problems: ParseProblem[] = [];

  // 1. Las listas de orden: o son listas, o el motor las recorre esperando
  //    elementos. Un `42` aquí no es "un orden raro": es nada.
  for (const field of ORDER_FIELDS) {
    const value = project[field];
    if (value === undefined || value === null) continue; // aditivo: se rellena
    if (!Array.isArray(value)) {
      problems.push({ field, expected: 'una lista de ids' });
      continue;
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') {
        problems.push({ field: `${field}[${i}]`, expected: 'un id (string)' });
      }
    }
  }

  // 2. Cada entidad de un pool tiene que SER una entidad. Un `null` o un
  //    número ahí no es un patrón raro: revienta el compilador sin nombre.
  //    Solo los pools de entidad: `meta` o `timeSig` son mapas de datos, no
  //    colecciones de entidades.
  for (const poolName of PROJECT_POOLS) {
    const pool = project[poolName];
    if (typeof pool !== 'object' || pool === null || Array.isArray(pool)) continue;
    for (const [id, entity] of Object.entries(pool as Record<string, unknown>)) {
      if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
        problems.push({ field: `${poolName}.${id}`, expected: 'una entidad (objeto)' });
      }
    }
  }

  // 3. La mesa de mezcla es una lista de tamaño fijo que el motor indexa por
  //    posición: una entrada que no sea un objeto lo revienta al compilar.
  const mixer = project.mixer;
  if (Array.isArray(mixer)) {
    mixer.forEach((track, i) => {
      if (typeof track !== 'object' || track === null || Array.isArray(track)) {
        problems.push({ field: `mixer[${i}]`, expected: 'una pista (objeto)' });
      }
    });
  }

  return problems;
}

/** Los ids de una lista de orden que existen de verdad en su pool. */
export function keepExistingIds(order: readonly unknown[], pool: Record<string, unknown>): string[] {
  const kept: string[] = [];
  for (const id of order) {
    if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(pool, id)) kept.push(id);
  }
  return kept;
}