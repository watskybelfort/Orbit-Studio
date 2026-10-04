/**
 * La FORMA de cada comando del bus, para la puerta que entra desde la RED (BUG 018).
 *
 * El guardia del servidor solo exigía que `type` fuera una cadena y casteaba a
 * `Command`: un tipo inexistente pasaba (`applyCommand` devolvía `undefined`, y el
 * que espera un inverso se comía un `undefined` sin saber de dónde), y un `batch`
 * con `commands: null` reventaba al reproducir. Y lo que se ve al entrar por el
 * socket es peor que eso: `channel: {}` insertaba un canal sin volumen,
 * `timeSig: {}` rompía la estructura y `clips: [null]` reventaba al aplicar.
 *
 * Aquí se describe QUÉ trae cada comando. La tabla es `Record<Command['type'],…>`,
 * así que el compilador obliga a que exista una fila para cada tipo de la unión y
 * avisa si aparece uno que no está: no puede quedarse vieja en silencio.
 *
 * El vocabulario (`?` opcional, `|null` obligatorio que admite null, `:` entidad) y
 * las tablas de entidades son los de `model/entity-schema.ts`, los mismos que usa
 * `parseProject` (BUG 017). Una entidad que se valida al abrir un archivo se valida
 * igual aquí.
 *
 * Se mira la FORMA, no el fondo: que un canal traiga `params` raras lo acota el
 * motor donde lo usa; lo que importa es que leer el comando no pueda romperse y que
 * lo que no exista se diga con su nombre.
 */

import type { Command } from '../commands';
import { checkForma, type Forma, type Problema } from './entity-schema';

/** Una fila por tipo de comando: los campos que hay que mirar y con qué forma. */
const FORMAS: Record<Command['type'], Record<string, Forma>> = {
  // Transporte / proyecto
  setTempo: { tempo: 'num' },
  setSwing: { swing: 'num' },
  setTimeSig: { timeSig: 'ent:timeSig' },
  setMeta: { patch: 'patch:meta' },
  // Canales
  addChannel: { channel: 'ent:channel', index: '?num' },
  removeChannel: { channelId: 'id' },
  restoreChannel: { channel: 'ent:channel', index: 'num', notesByPattern: 'mapa:notas' },
  patchChannel: { channelId: 'id', patch: 'patch:channel' },
  setChannelParam: { channelId: 'id', key: 'str', value: 'num', dropKey: '?bool' },
  moveChannel: { channelId: 'id', toIndex: 'num' },
  // Carpetas del rack
  addChannelGroup: { group: 'ent:channelGroup', index: '?num', members: '?id[]' },
  removeChannelGroup: { groupId: 'id' },
  patchChannelGroup: { groupId: 'id', patch: 'patch:channelGroup' },
  // Inserts del canal
  setChannelEffect: {
    channelId: 'id', slotIndex: 'num', slot: 'ent:slot|null', dropFx: '?bool',
  },
  patchChannelEffect: {
    channelId: 'id', slotIndex: 'num', patch: 'patch:slot',
  },
  setChannelEffectParam: {
    channelId: 'id', slotIndex: 'num', key: 'str', value: 'num', dropKey: '?bool',
  },
  // Patrones y notas
  addPattern: { pattern: 'ent:pattern', index: '?num' },
  removePattern: { patternId: 'id' },
  restorePattern: { pattern: 'ent:pattern', index: 'num', clips: 'lista:clip' },
  patchPattern: { patternId: 'id', patch: 'patch:pattern' },
  addNotes: { patternId: 'id', channelId: 'id', notes: 'lista:note' },
  removeNotes: { patternId: 'id', channelId: 'id', noteIds: 'id[]' },
  // El inverso de removeNotes: devuelve cada nota a SU posición, que es lo que
  // importa en una lista ordenada (desempate de eventos y serialización). `at` es
  // opcional para que un comando a mano pueda no saberlo: entonces se appendea.
  restoreNotes: { patternId: 'id', channelId: 'id', notes: 'lista:note', at: '?lista:num' },
  patchNotes: { patternId: 'id', channelId: 'id', patches: 'lista:patchid:note' },
  // Playlist
  addPlaylistTrack: { track: 'ent:playlistTrack' },
  removePlaylistTrack: { trackId: 'id' },
  restorePlaylistTrack: { track: 'ent:playlistTrack', clips: 'lista:clip' },
  patchPlaylistTrack: { trackId: 'id', patch: 'patch:playlistTrack' },
  addClips: { clips: 'lista:clip' },
  removeClips: { clipIds: 'id[]' },
  restoreClips: { clips: 'lista:clip' },
  patchClips: { patches: 'lista:patchid:clip' },
  // Arrangements
  addArrangement: { arrangement: 'ent:arrangement' },
  removeArrangement: { arrangementId: 'id' },
  restoreArrangement: {
    arrangement: 'ent:arrangement', index: 'num', tracks: 'lista:playlistTrack',
    clips: 'lista:clip', sections: 'lista:section', activeWas: 'id',
  },
  patchArrangement: { arrangementId: 'id', patch: 'patch:arrangement' },
  setActiveArrangement: { arrangementId: 'id' },
  setLayout: { name: 'str', windows: '?mapa|null', dropContainer: '?bool' },
  // LFOs, secciones y marcadores
  addLfos: { lfos: 'lista:lfo' },
  removeLfos: { lfoIds: 'id[]' },
  restoreLfos: { lfos: 'lista:lfo' },
  patchLfo: { lfoId: 'id', patch: 'patch:lfo' },
  addSections: { sections: 'lista:section' },
  removeSections: { sectionIds: 'id[]' },
  restoreSections: { sections: 'lista:section' },
  patchSections: { patches: 'lista:patchid:section' },
  addMarker: { marker: 'ent:marker' },
  removeMarker: { markerId: 'id' },
  patchMarker: { markerId: 'id', patch: 'patch:marker' },
  // Mixer
  patchMixerTrack: { trackIndex: 'num', patch: 'patch:mixerTrack' },
  setEffect: { trackIndex: 'num', slotIndex: 'num', slot: 'ent:slot|null' },
  patchEffect: { trackIndex: 'num', slotIndex: 'num', patch: 'patch:slot' },
  setEffectParam: { trackIndex: 'num', slotIndex: 'num', key: 'str', value: 'num', dropKey: '?bool' },
  setSend: { trackIndex: 'num', target: 'num', level: 'num|null', send: '?ent:send' },
  patchSend: { trackIndex: 'num', target: 'num', patch: 'patch:send' },
  setRoute: { trackIndex: 'num', routeTo: 'num|null' },
  // Enrutado de entrada
  addInputRoute: { route: 'ent:inputRoute', index: '?num' },
  removeInputRoute: { routeId: 'id' },
  patchInputRoute: { routeId: 'id', patch: 'patch:inputRoute' },
  // Samples
  registerSample: { sample: 'ent:sample' },
  unregisterSample: { sampleId: 'id' },
  // Lote (un solo paso de undo)
  batch: { label: '?str', commands: 'comandos' },
};

/** Los tipos de comando que existen, para poder mirar el enum en runtime. */
export const COMMAND_TYPES: ReadonlySet<string> = new Set(Object.keys(FORMAS));

/** Cuánto se puede anidar un lote antes de darse por loco. Al llegar, RECHAZA. */
const MAX_ANIDADO = 16;

const esObjetoPlano = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fila de un tipo, o `undefined` — sin heredar de `Object.prototype`. */
function filaDe(tipo: string): Record<string, Forma> | undefined {
  // `FORMAS['toString']` devuelve la función heredada de `Object.prototype`, que es
  // truthy: por eso un comando con `type: 'toString'` pasaba como si tuviera fila.
  return Object.prototype.hasOwnProperty.call(FORMAS, tipo)
    ? FORMAS[tipo as Command['type']]
    : undefined;
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
  const fila = filaDe(tipo);
  if (fila === undefined) return `tipo de comando desconocido: "${tipo}"`;
  if (anidado > MAX_ANIDADO) return `lote anidado más de ${MAX_ANIDADO} niveles`;

  for (const [campo, forma] of Object.entries(fila)) {
    const problema = checkForma(value[campo], forma, `"${campo}"`);
    if (problema) return `${describe(problema)}`;
    // El lote se valida en cascada: un hijo malo es el problema del lote entero.
    if (forma === 'comandos') {
      const lista = value[campo];
      if (!Array.isArray(lista)) continue;
      for (const hijo of lista) {
        const problemaHijo = commandProblem(hijo, anidado + 1);
        if (problemaHijo !== null) return `en "${campo}": ${problemaHijo}`;
      }
    }
  }
  return null;
}

function describe(problema: Problema): string {
  return `${problema.field} ${problema.expected}`;
}

/** ¿Es un comando con la forma que el bus y el servidor pueden usar? */
export function isCommand(value: unknown): value is Command {
  return commandProblem(value) === null;
}