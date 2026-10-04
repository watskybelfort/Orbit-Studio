/**
 * Vocabulario y tablas de la FORMA de una entidad, un patch o una lista.
 *
 * Es el módulo que comparten las dos capas de validación del repo, y hay que
 * explicar por qué son una sola:
 *
 * - **017 (`parseProject`)**: un `.orbit` puede traer `samples: 42`, un canal sin
 *   `volume`, un `mix` de tipo raro o unos `points` que no son lista. Lo que no se
 *   comprueba aquí llega al motor y sale un NaN o un reventón.
 * - **018 (comandos de la sala)**: un `addChannel` con `channel: {}` inserta un
 *   canal sin volumen, un `setTimeSig` con `timeSig: {}` rompe la estructura, y un
 *   `clips: [null]` revienta al aplicar.
 *
 * Son el mismo problema en dos puertas, así que la tabla de campos por entidad vive
 * aquí una sola vez: `Channel` no se describe dos veces, y una entidad que se
 * valida al abrir un archivo se valida igual cuando llega por el socket.
 *
 * Las tablas salen de `model/types.ts`: los campos SIN `?` son obligatorios (si
 * falta, el motor lee `undefined` y produce NaN o revienta) y los que lo tienen se
 * comprueban solo si están. Los mapas y listas que el motor RECORRE (`params`, `fx`,
 * `sends`, `notes`, `points`, `target`) se miran por dentro. Lo que el motor ACOTA
 * (keymap, cortes, rueda de tono, bus de carpeta) sigue saneándose donde se
 * saneaba: eso es dato del usuario, no una avería del archivo.
 *
 * Vocabulario de un token, con sus dos modificadores:
 *
 * - `?` delante = el campo es OPCIONAL (puede no estar).
 * - `|null` detrás = el campo es OBLIGATORIO y admite `null` (`slot: null` es cómo
 *   se vacía un insert; `routeTo: null` es el master). Nullable NO es opcional: son
 *   dos cosas distintas, y confundirlas dejaba pasar un `setEffect` sin `slot`.
 * - `:` = de qué entidad es el elemento, para validarla por dentro: `ent:channel`,
 *   `lista:clip`, `lista:ent:slot`, `patch:clip`, `mapa:notas`.
 */

import { UNSET } from './unset';

export type Forma = `${Clase}` | `?${Clase}` | `${Clase}|null` | `?${Clase}|null`;

type Clase =
  | 'num' | 'str' | 'bool' | 'id' | 'id[]'
  | 'mapa' | 'mapa:num' | 'mapa:notas'
  | 'obj'
  | `ent:${Entidad}`
  | `patch:${Entidad}` | `patchid:${Entidad}`
  | 'lista' | 'lista:num' | `lista:${Entidad}` | `lista:ent:${Entidad}`
  | `lista:patch:${Entidad}` | `lista:patchid:${Entidad}` | 'lista:comandos'
  | 'comandos';

/** Las entidades con tabla propia en `model/types.ts`. */
export type Entidad =
  | 'channel' | 'pattern' | 'arrangement' | 'playlistTrack' | 'clip' | 'marker'
  | 'section' | 'lfo' | 'inputRoute' | 'sample' | 'channelGroup' | 'note'
  | 'mixerTrack' | 'slot' | 'send' | 'timeSig' | 'paramRef' | 'automationPoint';

export interface Tabla {
  /** Campos sin `?` en `types.ts`: si faltan, el motor lee `undefined`. */
  obligatorio: Record<string, Forma>;
  /** Campos con `?`: se comprueban solo si vienen. */
  opcional?: Record<string, Forma>;
}

/** Todas las entidades del modelo, con sus campos y sus tipos. */
export const ENTIDADES: Record<Entidad, Tabla> = {
  channel: {
    obligatorio: {
      id: 'id', name: 'str', color: 'str', kind: 'str', params: 'mapa:num',
      volume: 'num', pan: 'num', mute: 'bool', solo: 'bool', mixerTrack: 'num',
    },
    opcional: {
      groupId: 'id', sampleId: 'id', keymap: 'lista', slicePoints: 'lista:num',
      novaPreset: 'str', prismaPreset: 'str', fx: 'lista:ent:slot',
      instrumentPluginId: 'str', bend: 'num',
    },
  },
  pattern: {
    obligatorio: { id: 'id', name: 'str', color: 'str', length: 'num', notes: 'mapa:notas' },
  },
  arrangement: {
    obligatorio: { id: 'id', name: 'str' },
  },
  playlistTrack: {
    obligatorio: {
      id: 'id', arrangementId: 'id', name: 'str', color: 'str', height: 'num',
      muted: 'bool', order: 'num',
    },
    opcional: { icon: 'str', mixerTrack: 'num' },
  },
  clip: {
    obligatorio: {
      id: 'id', kind: 'str', playlistTrackId: 'id', start: 'num', length: 'num', muted: 'bool',
    },
    opcional: {
      color: 'str', patternId: 'id', patternOffset: 'num', sampleId: 'id',
      audioOffset: 'num', audioGain: 'num', audioStretch: 'bool', audioPitch: 'num',
      fadeIn: 'num', fadeOut: 'num', lane: 'num', frozenFrom: 'id[]',
      target: 'ent:paramRef', points: 'lista:automationPoint',
    },
  },
  marker: {
    obligatorio: { id: 'id', time: 'num', name: 'str', color: 'str' },
    opcional: { tempo: 'num', timeSigNum: 'num' },
  },
  section: {
    obligatorio: {
      id: 'id', arrangementId: 'id', name: 'str', start: 'num', length: 'num',
    },
    opcional: { color: 'str', kind: 'str' },
  },
  lfo: {
    obligatorio: {
      id: 'id', target: 'ent:paramRef', shape: 'str', rateBeats: 'num', amount: 'num',
      phase: 'num', enabled: 'bool',
    },
  },
  inputRoute: {
    obligatorio: {
      id: 'id', name: 'str', channel: 'num', mixerTrack: 'num', armed: 'bool',
      monitor: 'bool', gain: 'num',
    },
    opcional: { channelRight: 'num', playlistTrackId: 'id' },
  },
  sample: {
    obligatorio: { id: 'id', name: 'str', path: 'str', hash: 'str', duration: 'num' },
  },
  channelGroup: {
    obligatorio: { id: 'id', name: 'str', color: 'str', collapsed: 'bool' },
    opcional: { busTrack: 'num', mute: 'bool', solo: 'bool' },
  },
  note: {
    obligatorio: {
      id: 'id', start: 'num', duration: 'num', key: 'num', velocity: 'num',
      pan: 'num', slide: 'bool',
    },
    opcional: { bend: 'num' },
  },
  mixerTrack: {
    obligatorio: {
      id: 'id', name: 'str', color: 'str', volume: 'num', pan: 'num', mute: 'bool',
      solo: 'bool', stereoWidth: 'num', slots: 'lista:ent:slot|null',
    },
    // Estos cuatro llegaron despues del archivo y `parseProject` los RELLENA con un
    // default explicito (eq a 0 dB, sin envios y el master sin ruta), asi que no se
    // exigen: un `.orbit` de antes de que existieran se abre y suena igual. El
    // default de `routeTo` distingue master (null) de insert (0) a proposito: con
    // null en un insert, el audio se pierde entero.
    opcional: {
      eqLow: 'num', eqMid: 'num', eqHigh: 'num', routeTo: 'num|null', sends: 'lista:send',
    },
  },
  slot: {
    obligatorio: { id: 'id', kind: 'str', enabled: 'bool', mix: 'num', params: 'mapa:num' },
    opcional: { sidechainSource: 'num', pluginId: 'str' },
  },
  send: {
    obligatorio: { target: 'num', level: 'num' },
    opcional: { tap: 'str', part: 'str', invert: 'bool', pan: 'num', mute: 'bool' },
  },
  timeSig: {
    obligatorio: { num: 'num', den: 'num' },
  },
  automationPoint: {
    obligatorio: { id: 'id', time: 'num', value: 'num', tension: 'num' },
  },
  // `ParamRef` es una unión de seis formas: todas llevan `kind` y `param` (cadenas);
  // las que apuntan a algo llevan además su id o su índice.
  paramRef: {
    obligatorio: { kind: 'str', param: 'str' },
    opcional: { channelId: 'id', trackIndex: 'num', slotIndex: 'num' },
  },
};

export interface Problema {
  /** Ruta del problema: `clips[2].start`, `channel.volume`, `mix[0].slots[1].mix`. */
  field: string;
  /** Qué se esperaba. */
  expected: string;
}

const esObjetoPlano = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Una tabla de entidad contra un objeto. `clase` es `ent` o `patch`. */
export function entityProblem(
  valor: unknown,
  entidad: Entidad,
  ruta: string,
  clase: 'ent' | 'patch' | 'patchid' = 'ent',
): Problema | null {
  if (!esObjetoPlano(valor)) return { field: ruta, expected: 'una entidad (objeto)' };
  const tabla = ENTIDADES[entidad];

  if (clase === 'patch' || clase === 'patchid') {
    // Un patch es PARCIAL: no se exigen los obligatorios (el bus rellena lo que no
    // viene), pero sí que cada campo presente sea del tipo que dice la tabla y
    // que no haya campos de más: eso último llegaba al `Object.assign` del bus y se
    // escribía en la entidad sin saber qué era.
    // En un patch SUELTO la id no se admite (va en `channelId`): si viniera, el
    // assign le cambiaría la id a la entidad. En un parche de LISTA es obligatoria:
    // es lo que dice a cuál de los muchos se aplica.
    if (clase === 'patchid') {
      if (typeof valor.id !== 'string') {
        return { field: `${ruta}.id`, expected: 'un id (cadena)' };
      }
    } else if ('id' in valor) {
      return { field: `${ruta}.id`, expected: 'no se admite aquí: la id va en el comando' };
    }
    const todos = { ...tabla.obligatorio, ...(tabla.opcional ?? {}) };
    for (const campo of Object.keys(valor)) {
      if (clase === 'patchid' && campo === 'id') continue;
      const forma = todos[campo] as Forma | undefined;
      if (forma === undefined) {
        return { field: `${ruta}.${campo}`, expected: 'no es un campo de la entidad' };
      }
      // Una clave presente con valor `undefined` es lo mismo que no venir: el
      // `Object.assign` del bus la escribiría como `undefined`, que no es un campo
      // del modelo. Se ignora en vez de fiarse del `undefined` que llega de otro
      // sitio.
      if (valor[campo] === undefined) continue;
      // La marca de borrado es un valor legitimo de un patch: el inverso que
      // quita un campo opcional lleva esta cadena, no un null.
      if (valor[campo] === UNSET) continue;
      const problema = checkForma(valor[campo], forma, `${ruta}.${campo}`);
      if (problema) return problema;
    }
    return null;
  }

  for (const [campo, forma] of Object.entries(tabla.obligatorio)) {
    const problema = checkForma(valor[campo], forma, `${ruta}.${campo}`);
    if (problema) return problema;
  }
  for (const [campo, forma] of Object.entries(tabla.opcional ?? {})) {
    if (valor[campo] === undefined) continue;
    const problema = checkForma(valor[campo], forma, `${ruta}.${campo}`);
    if (problema) return problema;
  }
  return null;
}

/** El problema de un valor contra una forma, o `null` si la cumple. */
export function checkForma(valor: unknown, forma: Forma, ruta: string): Problema | null {
  const admiteNull = forma.endsWith('|null');
  const base = admiteNull ? (forma.slice(0, -'|null'.length) as Forma) : forma;
  const opcional = base.startsWith('?');
  const clase = (opcional ? base.slice(1) : base) as Clase;
  const partes = clase.split(':');
  const raiz = partes[0]!;
  const resto = partes.slice(1);

  if (valor === undefined) {
    return opcional ? null : { field: ruta, expected: 'está' };
  }
  if (valor === null) {
    return admiteNull ? null : { field: ruta, expected: 'no es null' };
  }

  switch (raiz) {
    case 'num':
      return esNumero(valor) ? null : { field: ruta, expected: 'un número' };
    case 'str':
      return typeof valor === 'string' ? null : { field: ruta, expected: 'una cadena' };
    case 'bool':
      return typeof valor === 'boolean' ? null : { field: ruta, expected: 'un booleano' };
    case 'id':
      return typeof valor === 'string' ? null : { field: ruta, expected: 'un id (cadena)' };
    case 'id[]':
      return Array.isArray(valor) && valor.every((id) => typeof id === 'string')
        ? null
        : { field: ruta, expected: 'una lista de ids' };
    case 'obj':
      return esObjetoPlano(valor) ? null : { field: ruta, expected: 'un objeto' };
    case 'mapa':
      if (resto[0] === 'num') return mapaNumerico(valor, ruta);
      if (resto[0] === 'notas') return mapaDeNotas(valor, ruta);
      return esObjetoPlano(valor) ? null : { field: ruta, expected: 'un mapa' };
    case 'ent':
      return entityProblem(valor, resto[0] as Entidad, ruta);
    case 'patch':
      return entityProblem(valor, resto[0] as Entidad, ruta, 'patch');
    case 'patchid':
      return entityProblem(valor, resto[0] as Entidad, ruta, 'patchid');
    case 'lista':
      return checkLista(valor, resto, ruta);
    case 'comandos':
      // Los comandos validan su forma en `command-schema.ts`, que es quien tiene la
      // tabla de tipos; aquí solo se mira que sea una lista.
      return Array.isArray(valor) ? null : { field: ruta, expected: 'una lista' };
    default:
      return { field: ruta, expected: `una forma desconocida ("${forma}")` };
  }
}

/** `lista`, `lista:num`, `lista:ent:<entidad>`, `lista:<entidad>`, `lista:patch:<x>`… */
function checkLista(valor: unknown, resto: string[], ruta: string): Problema | null {
  if (!Array.isArray(valor)) return { field: ruta, expected: 'una lista' };
  const [primero, segundo] = resto;
  if (primero === undefined) return null; // `lista` a secas: solo que sea lista
  if (primero === 'num') {
    for (let i = 0; i < valor.length; i++) {
      if (!esNumero(valor[i])) return { field: `${ruta}[${i}]`, expected: 'un número' };
    }
    return null;
  }
  if (primero === 'comandos') return null; // los valida command-schema
  const clase = (segundo === undefined ? 'ent' : primero) as 'ent' | 'patch' | 'patchid';
  const entidad = (segundo ?? primero) as Entidad;
  for (let i = 0; i < valor.length; i++) {
    const item = valor[i];
    // Un hueco (null) es legal solo donde la lista lo admite: los slots de efecto.
    if (item === null && clase === 'ent' && entidad === 'slot') continue;
    const problema = entityProblem(item, entidad, `${ruta}[${i}]`, clase);
    if (problema) return problema;
  }
  return null;
}

function mapaNumerico(valor: unknown, ruta: string): Problema | null {
  if (!esObjetoPlano(valor)) return { field: ruta, expected: 'un mapa de números' };
  for (const [clave, numero] of Object.entries(valor)) {
    if (!esNumero(numero)) return { field: `${ruta}.${clave}`, expected: 'un número' };
  }
  return null;
}

/** `notes` de un patrón: mapa de id de canal → lista de notas. */
function mapaDeNotas(valor: unknown, ruta: string): Problema | null {
  if (!esObjetoPlano(valor)) return { field: ruta, expected: 'un mapa de notas por canal' };
  for (const [canal, lista] of Object.entries(valor)) {
    const problema = checkLista(lista, ['note'], `${ruta}.${canal}`);
    if (problema) return problema;
  }
  return null;
}