/**
 * Tipos y referencias de un proyecto recién parseado (BUG 017).
 *
 * `parseProject` comprobaba que el ESQUELETO estuviera y poco más: los campos
 * aditivos se rellenaban con `??=` sin mirar qué traían, las entidades de los
 * pools no se comprobaban, y los números que van a la línea de tiempo pasaban
 * como fueran. De ahí lo que se veía al abrir un archivo tocado a mano o escrito
 * por una versión futura: `samples: 42` pasaba, `patternOrder: 42` pasaba, un
 * patrón `null` pasaba y compilaba en silencio, y un `volume: 'loud'` en un canal
 * llegaba al motor y salía un NaN en el audio renderizado.
 *
 * Aquí se decide QUÉ es estructura y qué es contenido musical, porque no todo
 * puede fallar:
 *
 * - **Estructura**: pools, entidades, listas de orden y NÚMEROS. Si su tipo no
 *   es el que el motor lee, se falla aquí y por su nombre. Un archivo que no se
 *   entiende no es un archivo: abrirlo a medias es peor que no abrirlo, y la UI
 *   se queda con el proyecto anterior.
 * - **Contenido**: un nombre de canal raro, un preset desconocido, un corte. Eso
 *   se sanea y se acota donde ya se hacía (slices, keymap, bend, busTrack),
 *   porque es dato del usuario, no una avería del archivo.
 *
 * Dos reglas que gobiernan todo lo de aquí:
 *
 * - **Solo se mira lo que está**: un campo ausente no es un problema. Es lo que
 *   mantiene abriéndose los `.orbit` de antes de que existiera el campo.
 * - **Esto corre ANTES de adoptar los pools.** Adoptar copia a pools sin
 *   prototipo y descarta claves reservadas, así que un `samples: 42` se
 *   convertía en un pool vacío y el validador, al mirar después, ya no veía el
 *   tipo: el archivo inválido pasaba por limpio. Primero se juzga, luego se
 *   adopta.
 *
 * Módulo puro y sin DOM, para poder probarlo entero sin pasar por un archivo.
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

/**
 * Números que van DERECHO a la línea de tiempo o al motor. Un NaN aquí no es un
 * canal raro: es un evento que empieza en NaN, o un `render.left` con NaN dentro
 * —que es silencio, o un ruido entero, según dónde se mire—. Solo se comprueban
 * si están presentes, así que un canal sin `pan` (los `.orbit` antiguos) sigue
 * abriéndose.
 */
const NUMERICOS: Record<string, readonly string[]> = {
  channels: ['volume', 'pan'],
  clips: [
    'start', 'length', 'patternOffset', 'audioOffset', 'audioGain',
    'fadeIn', 'fadeOut', 'lane', 'audioPitch',
  ],
  playlistTracks: ['height', 'order', 'mixerTrack'],
  markers: ['time', 'tempo', 'timeSigNum'],
  sections: ['start', 'length'],
  lfos: ['rateBeats', 'amount', 'phase'],
  samples: ['duration'],
  inputRoutes: ['channel', 'channelRight', 'mixerTrack', 'gain'],
};

/**
 * Campos OBLIGATORIOS de cada entidad, tal como los declara `model/types.ts` (los
 * que no llevan `?`). Faltar aquí no es "un canal raro": es un NaN o un reventón,
 * porque el motor los lee sin mirar. Un canal sin `volume` compila y sale un
 * `render.left` con NaN dentro; un patrón sin `notes` revienta al recorrer.
 *
 * Lo que se puede migrar se migra con un default EXPLÍCITO en `parseProject` (los
 * `eq*` de las pistas, `routeTo` y `sends`): así un `.orbit` de antes se abre y
 * suena como antes, en vez de rechazarse por un campo que no le falta de verdad.
 */
const OBLIGATORIOS: Record<string, readonly string[]> = {
  channels: ['id', 'name', 'color', 'kind', 'params', 'volume', 'pan', 'mute', 'solo', 'mixerTrack'],
  channelGroups: ['id', 'name', 'color', 'collapsed'],
  patterns: ['id', 'name', 'color', 'length', 'notes'],
  arrangements: ['id', 'name'],
  playlistTracks: ['id', 'arrangementId', 'name', 'color', 'height', 'muted', 'order'],
  clips: ['id', 'kind', 'playlistTrackId', 'start', 'length', 'muted'],
  markers: ['id', 'time', 'name', 'color'],
  sections: ['id', 'arrangementId', 'name', 'start', 'length'],
  lfos: ['id', 'target', 'shape', 'rateBeats', 'amount', 'phase', 'enabled'],
  inputRoutes: ['id', 'name', 'channel', 'mixerTrack', 'armed', 'monitor', 'gain'],
  samples: ['id', 'name', 'path', 'hash', 'duration'],
};

/** Cada nota: los campos obligatorios de `Note` en `model/types.ts`. */
const OBLIGATORIOS_NOTA = ['id', 'start', 'duration', 'key', 'velocity', 'pan', 'slide'] as const;

/** Pistas de mixer: `routeTo`, `sends` y `eq*` se migran con defaults explícitos. */
const OBLIGATORIOS_PISTA = [
  'id', 'name', 'color', 'volume', 'pan', 'mute', 'solo', 'stereoWidth', 'slots',
] as const;

/** Números sueltos del proyecto, fuera de cualquier entidad. */
const NUMERICOS_PROYECTO: readonly string[] = ['tempo', 'swing'];

export interface ParseProblem {
  /** Campo con el problema, con su ruta (`mixer[3].volume`, `patterns.p.notes`). */
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

  // 2. Cada pool tiene que SER un pool, y cada entidad tiene que ser una entidad.
  //    `samples: 42` antes se convertía en un pool vacío al adoptar y pasaba
  //    limpio; aquí se juzga ANTES de adoptar. Una lista VACÍA sí vale como "sin
  //    nada": no hay nada que perder y hay archivos que la traen así.
  for (const poolName of PROJECT_POOLS) {
    const pool = project[poolName];
    if (pool === undefined || pool === null) continue; // aditivo: se rellena
    if (typeof pool !== 'object' || (Array.isArray(pool) && pool.length > 0)) {
      problems.push({ field: poolName, expected: 'un mapa de entidades' });
      continue;
    }
    for (const [id, entity] of Object.entries(pool as Record<string, unknown>)) {
      if (typeof entity !== 'object' || entity === null || Array.isArray(entity)) {
        problems.push({ field: `${poolName}.${id}`, expected: 'una entidad (objeto)' });
        continue;
      }
      problems.push(...entityProblems(poolName, id, entity as Record<string, unknown>));
    }
  }

  // 3. Números sueltos del proyecto. `swing: 'wrong'` llegaba a `swungStart` y
  //    volvía NaN en el tiempo de cada evento: el beat se rompía en silencio.
  for (const field of NUMERICOS_PROYECTO) {
    const value = project[field];
    if (value !== undefined && !esNumero(value)) {
      problems.push({ field, expected: 'un número' });
    }
  }
  // `timeSig` es obligatorio y sus dos números van a la compilación: un num de
  // tipo raro llegaba como compiled.timeSigNum = NaN.
  const timeSig = project.timeSig;
  if (typeof timeSig === 'object' && timeSig !== null && !Array.isArray(timeSig)) {
    for (const campo of ['num', 'den']) {
      if (!esNumero((timeSig as Record<string, unknown>)[campo])) {
        problems.push({ field: `timeSig.${campo}`, expected: 'un número' });
      }
    }
  }

  // 4. La mesa de mezcla es una lista de tamaño fijo que el motor indexa por
  //    posición: una entrada que no sea un objeto lo revienta al compilar, y sus
  //    números van derechos al bus de la pista.
  const mixer = project.mixer;
  if (Array.isArray(mixer)) {
    mixer.forEach((track, i) => {
      if (typeof track !== 'object' || track === null || Array.isArray(track)) {
        problems.push({ field: `mixer[${i}]`, expected: 'una pista (objeto)' });
        return;
      }
      const propio = track as Record<string, unknown>;
      problems.push(...numericProblems(`mixer[${i}]`, propio,
        ['volume', 'pan', 'eqLow', 'eqMid', 'eqHigh', 'stereoWidth', 'routeTo'], ['routeTo']));
      for (const campo of OBLIGATORIOS_PISTA) {
        if (propio[campo] === undefined) {
          problems.push({ field: `mixer[${i}].${campo}`, expected: 'está' });
        }
      }
      // Las pistas llevan las MISMAS tablas internas que un canal: slots con su
      // mix y sus params, y envíos con target/level/pan. Antes solo se miraban los
      // números de la pista, así que un `slots[0].mix` de tipo raro pasaba.
      if (propio.slots !== undefined) problems.push(...slotsProblems(`mixer[${i}].slots`, propio.slots));
      problems.push(...sendsProblems(`mixer[${i}]`, propio));
    });
  }

  return problems;
}

function esNumero(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numericProblems(
  prefijo: string,
  entidad: Record<string, unknown>,
  campos: readonly string[],
  admitenNull: readonly string[] = [],
): ParseProblem[] {
  const problems: ParseProblem[] = [];
  for (const campo of campos) {
    const value = entidad[campo];
    // `null` solo donde el modelo lo admite: el `routeTo` del master es
    // `number | null` porque ahí no hay a dónde enrutar.
    if (value === null && admitenNull.includes(campo)) continue;
    if (value !== undefined && !esNumero(value)) {
      problems.push({ field: `${prefijo}.${campo}`, expected: 'un número' });
    }
  }
  return problems;
}

/**
 * Lo mínimo de dentro de una entidad que, si está mal, no es "un canal raro" sino
 * un NaN en el audio o un reventón al recorrer: los números de la entidad, sus
 * mapas de parámetros, sus slots de efecto y —en un patrón— el mapa de notas.
 */
function entityProblems(
  poolName: string,
  id: string,
  entidad: Record<string, unknown>,
): ParseProblem[] {
  const ruta = `${poolName}.${id}`;
  const problems = numericProblems(ruta, entidad, NUMERICOS[poolName] ?? []);
  // Obligatorios del modelo: si faltan, el motor lee `undefined` y sale NaN o
  // revienta al recorrer. No es un dato raro del usuario: es un archivo roto.
  for (const campo of OBLIGATORIOS[poolName] ?? []) {
    if (entidad[campo] === undefined) problems.push({ field: `${ruta}.${campo}`, expected: 'está' });
  }

  // Mapas de números: `params` de canal y de slot de efecto.
  for (const campo of ['params', 'pointers']) {
    if (entidad[campo] === undefined) continue;
    problems.push(...mapProblems(`${ruta}.${campo}`, entidad[campo]));
  }

  // Slots de efecto: lista de tamaño fijo con huecos, cada uno con su `mix` y sus
  // `params`. Un `mix: null` es un NaN esperando a multiplicative.
  if (entidad.fx !== undefined) problems.push(...slotsProblems(`${ruta}.fx`, entidad.fx));
  if (entidad.slots !== undefined) problems.push(...slotsProblems(`${ruta}.slots`, entidad.slots));

  // Envíos: `target`, `level` y `pan` van al bus de mixer.
  problems.push(...sendsProblems(ruta, entidad));

  // Las notas de un patrón: mapa id de canal -> lista. `notes: null` pasaba el
  // esqueleto y reventaba al recorrer con "Cannot convert undefined or null to
  // object", en el compilador, sin nombres.
  if (poolName === 'patterns' && entidad.notes !== undefined) {
    const notas = entidad.notes;
    if (typeof notas !== 'object' || notas === null || Array.isArray(notas)) {
      problems.push({ field: `${ruta}.notes`, expected: 'un mapa de notas por canal' });
    } else {
      for (const [canal, lista] of Object.entries(notas as Record<string, unknown>)) {
        if (!Array.isArray(lista)) {
          problems.push({ field: `${ruta}.notes.${canal}`, expected: 'una lista de notas' });
          continue;
        }
        lista.forEach((nota, i) => {
          if (typeof nota !== 'object' || nota === null || Array.isArray(nota)) {
            problems.push({ field: `${ruta}.notes.${canal}[${i}]`, expected: 'una nota (objeto)' });
            return;
          }
          const propio = nota as Record<string, unknown>;
          problems.push(...numericProblems(`${ruta}.notes.${canal}[${i}]`, propio,
            ['start', 'duration', 'key', 'velocity', 'pan']));
          for (const campo of OBLIGATORIOS_NOTA) {
            if (propio[campo] === undefined) {
              problems.push({
                field: `${ruta}.notes.${canal}[${i}].${campo}`, expected: 'está',
              });
            }
          }
        });
      }
    }
  }

  return problems;
}

/**
 * Envíos de una entidad que los tenga (las pistas del mixer). `target` y `level`
 * van al bus: un string ahí es un NaN en la ganancia de la salida.
 */
function sendsProblems(ruta: string, entidad: Record<string, unknown>): ParseProblem[] {
  if (entidad.sends === undefined) return [];
  if (!Array.isArray(entidad.sends)) {
    return [{ field: `${ruta}.sends`, expected: 'una lista de envíos' }];
  }
  const problems: ParseProblem[] = [];
  entidad.sends.forEach((send, i) => {
    if (typeof send !== 'object' || send === null || Array.isArray(send)) {
      problems.push({ field: `${ruta}.sends[${i}]`, expected: 'un envío (objeto)' });
      return;
    }
    problems.push(...numericProblems(`${ruta}.sends[${i}]`, send as Record<string, unknown>,
      ['target', 'level', 'pan']));
  });
  return problems;
}

function mapProblems(ruta: string, value: unknown): ParseProblem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: ruta, expected: 'un mapa de números' }];
  }
  const problems: ParseProblem[] = [];
  for (const [clave, numero] of Object.entries(value as Record<string, unknown>)) {
    if (!esNumero(numero)) {
      problems.push({ field: `${ruta}.${clave}`, expected: 'un número' });
    }
  }
  return problems;
}

function slotsProblems(ruta: string, value: unknown): ParseProblem[] {
  if (!Array.isArray(value)) return [{ field: ruta, expected: 'una lista de slots' }];
  const problems: ParseProblem[] = [];
  value.forEach((slot, i) => {
    // Hueco = null, que es como está un slot vacío.
    if (slot === null) return;
    if (typeof slot !== 'object' || Array.isArray(slot)) {
      problems.push({ field: `${ruta}[${i}]`, expected: 'un slot (objeto o null)' });
      return;
    }
    const propio = slot as Record<string, unknown>;
    problems.push(...numericProblems(`${ruta}[${i}]`, propio, ['mix', 'sidechainSource']));
    if (propio.params !== undefined) problems.push(...mapProblems(`${ruta}[${i}].params`, propio.params));
  });
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