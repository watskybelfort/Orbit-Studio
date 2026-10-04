/**
 * Forma de un comando del bus, para la puerta que entra desde la RED (BUG 018).
 *
 * El guardia del servidor solo exigía que `type` fuera una cadena y casteaba a
 * `Command`: un tipo inexistente pasaba (`applyCommand` devolvía `undefined`, y
 * el que espera un inverso se comía un `undefined` sin saber de dónde) y un
 * `batch` con `commands: null` reventaba al reproducir con un TypeError que no
 * nombraba el campo. Y nada de eso es hypothetical: la entrada llega del socket.
 *
 * Aquí se describe QUÉ trae cada comando. La tabla es `Record<Command['type'],…>`,
 * así que el compilador obliga a que exista una fila para cada tipo de la unión y
 * avisa si aparece uno que no está: no puede quedarse vieja en silencio. Los
 * nombres de campo, en cambio, los vigila un test que le pasa a todos los tipos su
 * comando MÍNIMO y comprueba que ninguno revienta leyendo un campo que no está.
 *
 * Lo que se valida es la FORMA, no el fondo: que un canal sea un objeto y que
 * `tempo` sea un número finito. Si el canal traeparams raras, lo acota el motor
 * donde lo usa; aquí lo que importa es que leer el comando no pueda romperse y que
 * lo que no existe se diga con su nombre en vez de reventar a mitad de un lote.
 */

import type { Command } from '../commands';

type FormaBase =
  | 'num' | 'str' | 'bool' | 'id' | 'id[]' | 'obj' | 'ent' | 'lista' | 'comandos'
  | 'mapa' | 'mapa-lista';

/**
 * Formas validables, con dos modificadores que se leen solos:
 * `?` delante = el campo es opcional; `|null` detrás = admite null (que es cómo
 * se vacía un insert, cómo se borra un envío y cómo se borra una ruta).
 */
export type Forma = FormaBase | `?${FormaBase}` | `${FormaBase}|null` | `?${FormaBase}|null`;

/** Una fila por tipo de comando: los campos que hay que mirar y con qué forma. */
const FORMAS: Record<Command['type'], Record<string, Forma>> = {
  // Transporte / proyecto
  setTempo: { tempo: 'num' },
  setSwing: { swing: 'num' },
  setTimeSig: { timeSig: 'obj' },
  setMeta: { patch: 'obj' },
  // Canales
  addChannel: { channel: 'ent', index: '?num' },
  removeChannel: { channelId: 'id' },
  restoreChannel: { channel: 'ent', index: 'num', notesByPattern: 'mapa-lista' },
  patchChannel: { channelId: 'id', patch: 'obj' },
  setChannelParam: { channelId: 'id', key: 'str', value: 'num', dropKey: '?bool' },
  moveChannel: { channelId: 'id', toIndex: 'num' },
  // Carpetas del rack
  addChannelGroup: { group: 'ent', index: '?num', members: '?id[]' },
  removeChannelGroup: { groupId: 'id' },
  patchChannelGroup: { groupId: 'id', patch: 'obj' },
  // Inserts del canal
  setChannelEffect: { channelId: 'id', slotIndex: 'num', slot: 'ent|null', dropFx: '?bool' },
  patchChannelEffect: { channelId: 'id', slotIndex: 'num', patch: 'obj' },
  setChannelEffectParam: { channelId: 'id', slotIndex: 'num', key: 'str', value: 'num', dropKey: '?bool' },
  // Patrones y notas
  addPattern: { pattern: 'ent', index: '?num' },
  removePattern: { patternId: 'id' },
  restorePattern: { pattern: 'ent', index: 'num', clips: 'lista' },
  patchPattern: { patternId: 'id', patch: 'obj' },
  addNotes: { patternId: 'id', channelId: 'id', notes: 'lista' },
  removeNotes: { patternId: 'id', channelId: 'id', noteIds: 'id[]' },
  patchNotes: { patternId: 'id', channelId: 'id', patches: 'lista' },
  // Playlist
  addPlaylistTrack: { track: 'ent' },
  removePlaylistTrack: { trackId: 'id' },
  restorePlaylistTrack: { track: 'ent', clips: 'lista' },
  patchPlaylistTrack: { trackId: 'id', patch: 'obj' },
  addClips: { clips: 'lista' },
  removeClips: { clipIds: 'id[]' },
  restoreClips: { clips: 'lista' },
  patchClips: { patches: 'lista' },
  // Arrangements
  addArrangement: { arrangement: 'ent' },
  removeArrangement: { arrangementId: 'id' },
  restoreArrangement: {
    arrangement: 'ent', index: 'num', tracks: 'lista', clips: 'lista', sections: 'lista', activeWas: 'id',
  },
  patchArrangement: { arrangementId: 'id', patch: 'obj' },
  setActiveArrangement: { arrangementId: 'id' },
  setLayout: { name: 'str', windows: 'mapa|null', dropContainer: '?bool' },
  // LFOs, secciones y marcadores
  addLfos: { lfos: 'lista' },
  removeLfos: { lfoIds: 'id[]' },
  restoreLfos: { lfos: 'lista' },
  patchLfo: { lfoId: 'id', patch: 'obj' },
  addSections: { sections: 'lista' },
  removeSections: { sectionIds: 'id[]' },
  restoreSections: { sections: 'lista' },
  patchSections: { patches: 'lista' },
  addMarker: { marker: 'ent' },
  removeMarker: { markerId: 'id' },
  patchMarker: { markerId: 'id', patch: 'obj' },
  // Mixer
  patchMixerTrack: { trackIndex: 'num', patch: 'obj' },
  setEffect: { trackIndex: 'num', slotIndex: 'num', slot: 'ent|null' },
  patchEffect: { trackIndex: 'num', slotIndex: 'num', patch: 'obj' },
  setEffectParam: { trackIndex: 'num', slotIndex: 'num', key: 'str', value: 'num', dropKey: '?bool' },
  setSend: { trackIndex: 'num', target: 'num', level: 'num|null', send: '?ent' },
  patchSend: { trackIndex: 'num', target: 'num', patch: 'obj' },
  setRoute: { trackIndex: 'num', routeTo: 'num|null' },
  // Enrutado de entrada
  addInputRoute: { route: 'ent', index: '?num' },
  removeInputRoute: { routeId: 'id' },
  patchInputRoute: { routeId: 'id', patch: 'obj' },
  // Samples
  registerSample: { sample: 'ent' },
  unregisterSample: { sampleId: 'id' },
  // Lote (un solo paso de undo)
  batch: { label: '?str', commands: 'comandos' },
};

/** Los tipos de comando que existen, para poder mirar el enum en runtime. */
export const COMMAND_TYPES: ReadonlySet<string> = new Set(Object.keys(FORMAS));

/** Cuánto se puede anidar un lote antes de darse por loco. Al llegar, RECHAZA. */
const MAX_ANIDADO = 16;

function esObjetoPlano(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * El problema del comando, o `null` si su forma sirve. `null` y no excepción
 * porque quien decide (el servidor, el bus) necesita poder REPORTAR el motivo y
 * seguir con lo siguiente: una entrada mala no puede tirar la sala.
 */
export function commandProblem(value: unknown, anidado = 0): string | null {
  if (!esObjetoPlano(value)) return 'no es un objeto';
  const tipo = value.type;
  if (typeof tipo !== 'string') return 'no tiene "type"';
  const fila = FORMAS[tipo as Command['type']];
  if (fila === undefined) return `tipo de comando desconocido: "${tipo}"`;
  if (anidado > MAX_ANIDADO) return `lote anidado más de ${MAX_ANIDADO} niveles`;

  for (const [campo, forma] of Object.entries(fila)) {
    const bruto = value[campo];
    const admiteNull = forma.includes('|null');
    const opcional = forma.startsWith('?');
    // Ausente o `undefined`: si el campo es opcional, se pasa; si no, es un
    // problema y se dice cuál. Un `null` explícito solo vale donde la forma lo
    // admite: `slot: null` es cómo se vacía un insert, `level: null` un envío.
    if (bruto === undefined) {
      if (opcional || admiteNull) continue;
      return `falta "${campo}"`;
    }
    if (bruto === null) {
      if (admiteNull) continue;
      return `"${campo}" es null`;
    }
    const base = (opcional ? forma.slice(1) : forma).replace('|null', '') as FormaBase;
    const problema = checkForma(bruto, base, campo, anidado);
    if (problema) return problema;
  }
  return null;
}

function checkForma(
  valor: unknown,
  forma: FormaBase,
  campo: string,
  anidado: number,
): string | null {
  switch (forma) {
    case 'num':
      return typeof valor === 'number' && Number.isFinite(valor) ? null : `"${campo}" no es un número`;
    case 'str':
      return typeof valor === 'string' ? null : `"${campo}" no es una cadena`;
    case 'bool':
      return typeof valor === 'boolean' ? null : `"${campo}" no es verdadero o falso`;
    case 'id':
      return typeof valor === 'string' ? null : `"${campo}" no es un id`;
    case 'id[]':
      if (!Array.isArray(valor)) return `"${campo}" no es una lista de ids`;
      return valor.every((id) => typeof id === 'string') ? null : `"${campo}" tiene un id que no es cadena`;
    case 'obj':
      return esObjetoPlano(valor) ? null : `"${campo}" no es un objeto`;
    case 'ent': {
      if (!esObjetoPlano(valor)) return `"${campo}" no es una entidad`;
      // Una entidad con `id` debe traerlo de cadena: es su dirección en el pool.
      const id = valor.id;
      if (id !== undefined && typeof id !== 'string') return `"${campo}.id" no es un id`;
      return null;
    }
    case 'lista':
      return Array.isArray(valor) ? null : `"${campo}" no es una lista`;
    case 'mapa':
      return esObjetoPlano(valor) ? null : `"${campo}" no es un mapa`;
    case 'mapa-lista':
      if (!esObjetoPlano(valor)) return `"${campo}" no es un mapa`;
      return Object.values(valor).every(Array.isArray)
        ? null
        : `"${campo}" tiene una entrada que no es una lista`;
    case 'comandos': {
      if (!Array.isArray(valor)) return `"${campo}" no es una lista de comandos`;
      for (const hijo of valor) {
        const problema = commandProblem(hijo, anidado + 1);
        if (problema) return `en "${campo}": ${problema}`;
      }
      return null;
    }
  }
}

/** ¿Es un comando con la forma que el bus y el servidor pueden usar? */
export function isCommand(value: unknown): value is Command {
  return commandProblem(value) === null;
}