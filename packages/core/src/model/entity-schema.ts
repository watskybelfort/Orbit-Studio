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

import { esUnset } from './unset';

export type Forma = `${Clase}` | `?${Clase}` | `${Clase}|null` | `?${Clase}|null`;

type Clase =
  | 'num' | 'str' | 'bool' | 'id' | 'id[]' | 'num[]'
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
  | 'mixerTrack' | 'slot' | 'send' | 'timeSig' | 'meta' | 'paramRef' | 'automationPoint';

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
      novaPreset: 'str', prismaPreset: 'str', fx: 'lista:ent:slot|null',
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
      // Recorte de la AUTOMATIZACIÓN dentro de la muestra (BUG 041): con `start`
      // y `length` acortados, estos dos Guardan dónde se estaba muestreando la
      // curva, para no tener que recalcularla ni perder la fase al primer tramo.
      automationOffset: 'num', automationLength: 'num',
      // Y de lo mismo pero con el AUDIO estirado (BUG 042): segundos de fuente
      // asignados a la pieza y segundos ya consumidos antes de ella desde el
      // origen de grains, para que un corte no reinicie el grano (y con pitch).
      audioSourceLength: 'num', audioGrainOffset: 'num',
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
  /**
   * La ficha del proyecto. No vive en un pool (no tiene id) pero se valida igual: con
   * `setMeta` declarado como `patch: 'obj'` entraba cualquier cosa, y un `title` que
   * fuera un objeto reventaba al exportarlo —`suggestedExportName.title.trim()`— sin que
   * nada lo hubiera paradas antes (medido). Es texto, y ahora se dice que lo es.
   */
  meta: {
    obligatorio: { title: 'str', author: 'str', comments: 'str' },
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

/**
 * ¿Este campo es OBLIGATORIO en la entidad?
 *
 * Los patches son parciales, pero no pueden VACIAR lo obligatorio: quitarle el
 * volumen a un canal lo deja en NaN y el motor renderiza entero NaN. Ni con la
 * marca de borrado ni con un `undefined` puesto a mano, que es como el motor
 * deja un opcional vacío.
 */
function esObligatorio(tabla: Tabla, campo: string): boolean {
  return campo in (tabla.obligatorio as Record<string, Forma>);
}

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
      if (valor[campo] === undefined) {
        // En un campo OBLIGATORIO, en cambio, no se ignora: ignorarlo deja la
        // entidad sin él y el motor la lee como NaN (un `patchChannel` con
        // `volume: undefined` dejaba el volumen en NaN y el render entero NaN).
        if (esObligatorio(tabla, campo)) {
          return { field: `${ruta}.${campo}`, expected: 'está (un patch no puede vaciarlo)' };
        }
        continue;
      }
      // La marca de borrado es un valor legítimo de un patch: el inverso que quita
      // un campo opcional lleva este sobre, no un null.
      if (esUnset(valor[campo])) {
        // Pero solo de un campo que se pueda QUITAR. Borrar un obligatorio deja la
        // entidad incompleta y el motor la lee como NaN: se rechaza en la puerta,
        // no después.
        if (esObligatorio(tabla, campo)) {
          return {
            field: `${ruta}.${campo}`,
            expected: 'no se puede borrar: es obligatorio',
          };
        }
        continue;
      }
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
  // Una tabla dice los tipos de los campos, pero no que la entidad sea una unión
  // de formas: eso loMira la comprobación extra de la entidad, si la tiene.
  const extra = EXTRAS[entidad];
  if (extra !== undefined) return extra(valor, ruta);
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
    // En una lista, el `|null` es de los ELEMENTOS, no de la lista: el hueco de un
    // slot vacío es `null` dentro del array. La lista en sí tiene que existir —
    // `mixer[0].slots = null` pasaba la validación y reventaba al compilar con un
    // TypeError leyendo `.map` del compilador de audio.
    if (admiteNull && raiz !== 'lista') return null;
    return { field: ruta, expected: 'no es null' };
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
    case 'num[]':
      // Una lista de enteros, como el `at` de `restoreNotes` (dónde estaba cada nota
      // en la lista de origen). Un `indexOf` que devuelve -1 es un entero y pasa: lo
      // que no puede pasar es un `NaN` o un `null` colados en el hueco, que al
      // indexar la lista se comían una nota sin decírselo a nadie.
      return Array.isArray(valor) && valor.every(esNumero)
        ? null
        : { field: ruta, expected: 'una lista de números' };
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
      return checkLista(valor, resto, ruta, admiteNull);
    case 'comandos':
      // Los comandos validan su forma en `command-schema.ts`, que es quien tiene la
      // tabla de tipos; aquí solo se mira que sea una lista.
      return Array.isArray(valor) ? null : { field: ruta, expected: 'una lista' };
    default:
      return { field: ruta, expected: `una forma desconocida ("${forma}")` };
  }
}

/**
 * `lista`, `lista:num`, `lista:ent:<entidad>`, `lista:<entidad>`, `lista:patch:<x>`…
 *
 * `admiteHuecos` es el `|null` de la forma, que se refiere a los ELEMENTOS: los
 * slots de efecto llevan `lista:ent:slot|null` porque un slot vacío es un hueco
 * (`null`) dentro del array. La lista, en cambio, siempre tiene que estar.
 */
function checkLista(
  valor: unknown,
  resto: string[],
  ruta: string,
  admiteHuecos = false,
): Problema | null {
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
    if (item === null && admiteHuecos && clase === 'ent') continue;
    const problema = entityProblem(item, entidad, `${ruta}[${i}]`, clase);
    if (problema) return problema;
  }
  return null;
}

/**
 * Lo que una tabla NO puede decir: que una entidad sea una UNIÓN de formas.
 *
 * `ParamRef` es la unión de seis ramas y todas llevan `kind` y `param`; lo que las
 * distingue es qué campo las apunta y qué `param` admiten. Con solo la tabla, un
 * `{ kind: 'mixer', param: 'volume' }` —sin `trackIndex`— pasaba y el motor lo
 * leía como `undefined`: una automatización apunta al sitio equivocado en vez de
 * avisar. Aquí cada rama declara sus campos obligatorios, sus prohibidos y, si es
 * cerrado, los `param` que accepts.
 */
const EXTRAS: Record<string, (valor: Record<string, unknown>, ruta: string) => Problema | null> = {
  paramRef: paramRefProblem,
};

/** Las seis ramas de `ParamRef` (ver `ParamRef` en `types.ts`). */
const RAMAS_PARAM_REF: Record<string, { apunta: string[]; params?: string[] }> = {
  channel: { apunta: ['channelId'] },
  channelMix: { apunta: ['channelId'], params: ['volume', 'pan', 'bend'] },
  mixer: {
    apunta: ['trackIndex'],
    params: ['volume', 'pan', 'stereoWidth', 'eqLow', 'eqMid', 'eqHigh'],
  },
  effect: { apunta: ['trackIndex', 'slotIndex'] },
  channelFx: { apunta: ['channelId', 'slotIndex'] },
  transport: { apunta: [], params: ['tempo', 'swing'] },
};

/**
 * ¿Está el `kind` entre las ramas? Consulta de PROPIEDAD PROPIA, no `in`.
 *
 * `in` hereda de `Object.prototype`, así que `{kind: 'toString'}` pasaba el filtro,
 * `RAMAS_PARAM_REF['toString']` devolvía la función heredada y `rama.apunta` reventaba
 * con un TypeError EN EL VALIDADOR: en el bus y en `parseProject` eso era una excepción
 * en vez de un problema nombrado, y en el servidor la excepción se cazaba pero la
 * entrada inválida se quedaba en el documento y se repartía (medido: log 4→7 y
 * `denied` vacío). Es el mismo motivo por el que `model/entity-id.ts` saca su lista de
 * reservas de `Object.getOwnPropertyNames(Object.prototype)`.
 */
function esRamaParamRef(kind: string): boolean {
  return Object.hasOwn(RAMAS_PARAM_REF, kind);
}

function paramRefProblem(valor: Record<string, unknown>, ruta: string): Problema | null {
  const kind = valor.kind;
  if (typeof kind !== 'string' || !esRamaParamRef(kind)) {
    return { field: `${ruta}.kind`, expected: 'una de las ramas de ParamRef' };
  }
  const rama = RAMAS_PARAM_REF[kind]!;
  for (const campo of rama.apunta) {
    if (valor[campo] === undefined) {
      return { field: `${ruta}.${campo}`, expected: `está (lo exige la rama «${kind}»)` };
    }
  }
  if (rama.params !== undefined && !rama.params.includes(valor.param as string)) {
    return { field: `${ruta}.param`, expected: `uno de: ${rama.params.join(', ')}` };
  }
  // Los campos de las OTRAS ramas no se admiten: `{kind:'channel', trackIndex: 3}`
  // no apunta a ningún sitio (el motor leería el canal y el índice por separado).
  // Solo se miran las ramas de verdad, nunca las heredadas.
  const ajenos = Object.getOwnPropertyNames(RAMAS_PARAM_REF)
    .filter((otra) => otra !== kind)
    .flatMap((otra) => RAMAS_PARAM_REF[otra]!.apunta)
    .filter((campo) => !rama.apunta.includes(campo));
  for (const campo of new Set(ajenos)) {
    if (valor[campo] !== undefined) {
      return { field: `${ruta}.${campo}`, expected: `no lleva este campo la rama «${kind}»` };
    }
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