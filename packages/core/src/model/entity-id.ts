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
 * prototipo en vez de añadir una propiedad. La lista se toma de lo que
 * `Object.prototype` TIENE hoy en vez de ir a mano: si el entorno trae otra
 * propiedad heredada —o alguien ya contaminó el prototipo antes de que llegara
 * aquí—, esa también queda reservada, que es justo lo que importa. `prototype`
 * no está ahí (es propiedad de las funciones, no del prototipo) pero se reserva
 * igual: es el otro nombre con el que se llama a un id en la práctica.
 */
const RESERVED_IDS: ReadonlySet<string> = new Set([
  'prototype',
  ...Object.getOwnPropertyNames(Object.prototype),
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
 * Rechaza, ANTES de tocar nada, un comando que lleve un id reservado.
 *
 * Se miran los VALORES de los campos de id (`id`, `channelId`, `clipIds`…) y
 * también las CLAVES de cualquier objeto del payload: hay mapas cuyas claves son
 * ids y cuyo nombre no lo dice —`notesByPattern` va de id de patrón a sus
 * notas—, y con una clave heredada el consumidor `pool[clave]` leería el
 * prototipo. Un TÍTULO o un nombre que valgan `'__proto__'` sí se dejan: son
 * datos, no claves.
 *
 * El bus recibe objetos vivos del renderer: detecta ciclos sin imponer un
 * límite de notas que impida deshacer un patrón grande cargado desde disco.
 */
export function assertNoReservedIds(command: unknown, what = 'comando'): void {
  walk(command, what);
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

/**
 * Recorrido iterativo completo. Los ancestros detectan ciclos; `visited` evita
 * revisar dos veces un objeto compartido entre ramas, que sí es legítimo.
 * No se omite el fondo de batches ni se rechaza un inverso grande por tamaño.
 */
function walk(root: unknown, what: string): void {
  const pendientes: { value: unknown; leaving: boolean }[] = [{ value: root, leaving: false }];
  const ancestors = new WeakSet<object>();
  const visited = new WeakSet<object>();
  while (pendientes.length > 0) {
    const { value, leaving } = pendientes.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (leaving) {
      ancestors.delete(value);
      visited.add(value);
      continue;
    }
    if (ancestors.has(value)) throw new Error(`Comando ${what} contiene una referencia circular`);
    if (visited.has(value)) continue;
    ancestors.add(value);
    pendientes.push({ value, leaving: true });
    if (Array.isArray(value)) {
      for (const item of value) pendientes.push({ value: item, leaving: false });
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      // Una clave heredada en CUALQUIER objeto del payload, no solo en los campos
      // de id: hay mapas cuyas claves son ids y cuyo nombre no lo dice
      // (`notesByPattern` va de id de patrón a sus notas, `notes` de id de canal a
      // las suyas). Con una clave así, el consumidor `pool[clave]` leería el
      // prototipo.
      assertEntityId(key, `${what} (clave)`);
      if (ID_FIELD.test(key)) checkIdValue(item, what);
      pendientes.push({ value: item, leaving: false });
    }
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
