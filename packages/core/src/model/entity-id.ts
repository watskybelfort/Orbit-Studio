/**
 * Los ids de entidad son CLAVES de pools que son objetos planos
 * (`project.clips`, `project.channels`, …). Por eso una clave HEREDADA no es un
 * id: `project.clips['__proto__']` devuelve el prototipo, no `undefined`, y un
 * `Object.assign(clip, patch)` encima MUTA `Object.prototype` para todo el
 * proceso —renderer, servidor o test— desde un comando remoto, incluso de un
 * invitado (BUG 016). Lo que se veía era `({}).start === 9` en objetos ajenos al
 * proyecto.
 *
 * Dos capas, porque una sola deja un agujero:
 *
 * 1. **Los pools no tienen prototipo** (`nullPool`): aunque una clave heredada
 *    llegara colada, la lectura devuelve `undefined` y no hay a qué asignar.
 *    Esto cubre también lo que entra por `parseProject` y por el log de
 *    colaboración, sin tocar los cuarenta lugares que leen de un pool.
 * 2. **Los ids reservados se RECHAZAN antes de mutar** (`assertNoReservedIds`):
 *    que no se contamine el prototipo no significa que '__proto__' sea un canal
 *    legítimo —sería una entidad invisible en todas partes— así que el comando
 *    falla con su nombre y el proyecto y el historial quedan intactos.
 */

/**
 * Claves que un objeto plano hereda y que, escritas como dato, cambian el
 * prototipo en vez de añadir una propiedad. `toString` y compañía no mutan nada
 * por sí solas, pero se rechazan igual: son las que hacen que una lectura
 * devuelva un valor heredado en vez de `undefined` (y por tanto que un `patch`
 * escriba sobre el objeto equivocado sin querer).
 */
const RESERVED_IDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
]);

/** Campos cuyo valor ES un id (o una lista de ids): `id`, `channelId`, `clipIds`… */
const ID_FIELD = /([a-z]|^)(id|ids)$/i;

/**
 * ¿Es un id que puede ser clave de un pool? Solo se miran las claves
 * RESERVADAS: la cadena vacía es legítima en campos de id (`groupId: ''` es
 * "canal suelto" en el modelo), y lo que rompe es que la clave se resuelva por
 * la cadena de prototipos, no que no tenga caracteres.
 */
export function isEntityId(id: unknown): id is string {
  return typeof id === 'string' && !RESERVED_IDS.has(id);
}

/** Falla, con nombre, si el id no puede ser clave de un pool. */
export function assertEntityId(id: unknown, what = 'entidad'): string {
  if (!isEntityId(id)) {
    throw new Error(`Id de ${what} inválido: ${JSON.stringify(id)} (clave reservada)`);
  }
  return id;
}

/** Pool nuevo SIN prototipo: la barrera que hace que una lectura nunca herede. */
export function nullPool<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Lectura PROPIA de un pool (nunca la heredada). Para pools que vengan de fuera. */
export function ownOf<T>(pool: Record<string, T>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(pool, id) ? pool[id] : undefined;
}

/**
 * Copia las entradas PROPIAS de un pool a uno nuevo sin prototipo, descartando
 * los ids reservados. Hace falta para lo que llega parseado: `JSON.parse` crea
 * los pools con `Object.prototype`, así que `json.clips['__proto__']` devuelve el
 * prototipo —y eso pasa con los `.orbit` del disco y con el log de colaboración
 *—, y una clave propia `'__proto__'` en el JSON es un dato que ninguna
 * direccionamiento legítimo puede alcanzar.
 */
export function adoptPool<T>(source: unknown): Record<string, T> {
  const out = nullPool<T>();
  if (typeof source !== 'object' || source === null) return out;
  const entradas = source as Record<string, T>;
  for (const id of Object.keys(source)) {
    if (!RESERVED_IDS.has(id)) out[id] = entradas[id] as T;
  }
  return out;
}

/**
 * Rechaza, ANTES de tocar nada, cualquier comando que lleve un id reservado en
 * un campo de id. Recorre el payload con un tope de profundidad (un comando es un
 * objeto pequeño; el tope es una red de seguridad, no una política) y solo mira
 * los campos que son ids: un TÍTULO o un nombre de archivo que valga '__proto__'
 * son datos y se dejan en paz.
 */
export function assertNoReservedIds(command: unknown, what = 'comando'): void {
  walk(command, 0, what);
}

function checkIdValue(value: unknown, what: string): void {
  if (typeof value === 'string') {
    assertEntityId(value, what);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') assertEntityId(item, what);
    }
  }
}

function walk(value: unknown, depth: number, what: string): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, what);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (ID_FIELD.test(key)) checkIdValue(item, what);
    walk(item, depth + 1, what);
  }
}

/** Los pools del proyecto: mapas id→entidad, los únicos donde el id es clave. */
export const PROJECT_POOLS = [
  'channels',
  'channelGroups',
  'patterns',
  'arrangements',
  'playlistTracks',
  'clips',
  'markers',
  'sections',
  'lfos',
  'inputRoutes',
  'samples',
] as const;

/** Los pools de un proyecto ya construido, sin prototipo y sin ids reservados. */
export function adoptProjectPools<T extends object>(project: T): T {
  const holder = project as Record<string, unknown>;
  for (const name of PROJECT_POOLS) {
    if (holder[name] !== undefined) holder[name] = adoptPool(holder[name]);
  }
  return project;
}