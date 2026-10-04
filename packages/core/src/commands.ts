/**
 * Bus de comandos: TODA mutación del proyecto es un Command serializable.
 * `applyCommand` muta el proyecto y devuelve el comando inverso (capturado
 * ANTES de mutar), lo que da undo/redo, replay colaborativo y acceso MCP
 * por el mismo camino.
 */

import type {
  Arrangement,
  ArrangementSection,
  Channel,
  ChannelGroup,
  Clip,
  EffectSlot,
  Id,
  LayoutWindow,
  Lfo,
  Marker,
  MixerTrack,
  Note,
  Pattern,
  PlaylistTrack,
  Project,
  ProjectMeta,
  SampleRef,
  Send,
  TimeSig,
} from './model/types';
import { CHANNEL_SLOTS, MIXER_SLOTS } from './model/types';
import type { InputRoute } from './model/input-routing';
import { MAX_INPUT_ROUTES } from './model/input-routing';
import { wouldLoop } from './model/routing';
import { assertNoReservedIds } from './model/entity-id';

// ── Tipos de comando ─────────────────────────────────────────────────────────

export type NotePatch = Partial<Omit<Note, 'id'>> & { id: Id };
export type ClipPatch = Partial<Omit<Clip, 'id'>> & { id: Id };
export type SectionPatch = Partial<Omit<ArrangementSection, 'id'>> & { id: Id };

export type Command =
  // Transport / proyecto
  | { type: 'setTempo'; tempo: number }
  | { type: 'setSwing'; swing: number }
  | { type: 'setTimeSig'; timeSig: TimeSig }
  | { type: 'setMeta'; patch: Partial<ProjectMeta> }
  // Canales
  | { type: 'addChannel'; channel: Channel; index?: number }
  | { type: 'removeChannel'; channelId: Id }
  | {
      type: 'restoreChannel';
      channel: Channel;
      index: number;
      notesByPattern: Record<Id, Note[]>;
    }
  | { type: 'patchChannel'; channelId: Id; patch: Partial<Omit<Channel, 'id'>> }
  | {
      type: 'setChannelParam';
      channelId: Id;
      key: string;
      value: number;
      /**
       * Solo lo usa el INVERSO: la clave NO existía en `params` y hay que
       * borrarla en vez de escribir un valor. Con `?? 0` el inverso
       * materializaba el default y apply+invert dejaba de ser identidad.
       */
      dropKey?: boolean;
    }
  | { type: 'moveChannel'; channelId: Id; toIndex: number }
  // Carpetas del rack: organización pura, no tocan el audio. `members` solo lo
  // usa el inverso de borrar una carpeta, para devolver a sus canales dentro.
  | { type: 'addChannelGroup'; group: ChannelGroup; index?: number; members?: Id[] }
  | { type: 'removeChannelGroup'; groupId: Id }
  | { type: 'patchChannelGroup'; groupId: Id; patch: Partial<Omit<ChannelGroup, 'id'>> }
  // Inserts propios del canal (Channel.fx)
  | {
      type: 'setChannelEffect';
      channelId: Id;
      slotIndex: number;
      slot: EffectSlot | null;
      /**
       * Solo lo usa el INVERSO: el canal no traía `fx` y, si al deshacer la
       * cadena queda entera a nulls, hay que quitarle el campo materializado
       * para devolverlo al estado legado.
       */
      dropFx?: boolean;
    }
  | {
      type: 'patchChannelEffect';
      channelId: Id;
      slotIndex: number;
      patch: Partial<Pick<EffectSlot, 'enabled' | 'mix' | 'sidechainSource'>>;
    }
  | {
      type: 'setChannelEffectParam';
      channelId: Id;
      slotIndex: number;
      key: string;
      value: number;
      /** Igual que en `setChannelParam`: el inverso borra si la clave no estaba. */
      dropKey?: boolean;
    }
  // Patrones
  | { type: 'addPattern'; pattern: Pattern; index?: number }
  | { type: 'removePattern'; patternId: Id }
  | { type: 'restorePattern'; pattern: Pattern; index: number; clips: Clip[] }
  | { type: 'patchPattern'; patternId: Id; patch: Partial<Omit<Pattern, 'id' | 'notes'>> }
  // Notas
  | { type: 'addNotes'; patternId: Id; channelId: Id; notes: Note[] }
  | { type: 'removeNotes'; patternId: Id; channelId: Id; noteIds: Id[] }
  /**
   * Devuelve notas a la posición que tenían. A diferencia de los `restore*` de
   * pools (donde el orden de las claves no importa), el orden de las notas SÍ: es lo
   * que desempata los eventos que comparten inicio al compilar y lo que sale al
   * serializar. Por eso el inverso de `removeNotes` no es un `addNotes` (que
   * empuja al final) sino esto, con el índice de cada nota.
   */
  | { type: 'restoreNotes'; patternId: Id; channelId: Id; notes: Note[]; at?: number[] }
  | { type: 'patchNotes'; patternId: Id; channelId: Id; patches: NotePatch[] }
  // Playlist
  | { type: 'addPlaylistTrack'; track: PlaylistTrack }
  | { type: 'removePlaylistTrack'; trackId: Id }
  | { type: 'restorePlaylistTrack'; track: PlaylistTrack; clips: Clip[] }
  | { type: 'patchPlaylistTrack'; trackId: Id; patch: Partial<Omit<PlaylistTrack, 'id'>> }
  | { type: 'addClips'; clips: Clip[] }
  | { type: 'removeClips'; clipIds: Id[] }
  | { type: 'restoreClips'; clips: Clip[] }
  | { type: 'patchClips'; patches: ClipPatch[] }
  // Arrangements
  | { type: 'addArrangement'; arrangement: Arrangement }
  | { type: 'removeArrangement'; arrangementId: Id }
  | {
      type: 'restoreArrangement';
      arrangement: Arrangement;
      index: number;
      tracks: PlaylistTrack[];
      clips: Clip[];
      /** Secciones que pertenecían al arrangement (si no, quedaban huérfanas). */
      sections: ArrangementSection[];
      /** Arrangement activo ANTES de borrar (si no, el undo no lo restauraba). */
      activeWas: Id;
    }
  | { type: 'patchArrangement'; arrangementId: Id; patch: Partial<Omit<Arrangement, 'id'>> }
  | { type: 'setActiveArrangement'; arrangementId: Id }
  // Layouts de ventanas guardados en el proyecto
  | {
      type: 'setLayout';
      name: string;
      windows: Record<string, LayoutWindow> | null;
      /**
       * Solo lo usa el INVERSO: el proyecto no traía `layouts` y, si al
       * deshacer el contenedor queda vacío, hay que quitarlo para que el
       * .orbit vuelva a ser el de antes (el campo es opcional).
       */
      dropContainer?: boolean;
    }
  // LFOs
  | { type: 'addLfos'; lfos: Lfo[] }
  | { type: 'removeLfos'; lfoIds: Id[] }
  | { type: 'restoreLfos'; lfos: Lfo[] }
  | { type: 'patchLfo'; lfoId: Id; patch: Partial<Omit<Lfo, 'id'>> }
  // Marcadores
  // Secciones del arreglo. Van en lote como los clips (no de una en una como
  // los marcadores): duplicar un drop toca la sección, sus clips y todo lo que
  // venía detrás, y eso tiene que ser UN paso de undo.
  | { type: 'addSections'; sections: ArrangementSection[] }
  | { type: 'removeSections'; sectionIds: Id[] }
  | { type: 'restoreSections'; sections: ArrangementSection[] }
  | { type: 'patchSections'; patches: SectionPatch[] }
  | { type: 'addMarker'; marker: Marker }
  | { type: 'removeMarker'; markerId: Id }
  | { type: 'patchMarker'; markerId: Id; patch: Partial<Omit<Marker, 'id'>> }
  // Mixer
  | {
      type: 'patchMixerTrack';
      trackIndex: number;
      patch: Partial<Omit<MixerTrack, 'id' | 'slots' | 'sends'>>;
    }
  | { type: 'setEffect'; trackIndex: number; slotIndex: number; slot: EffectSlot | null }
  | {
      type: 'patchEffect';
      trackIndex: number;
      slotIndex: number;
      patch: Partial<Pick<EffectSlot, 'enabled' | 'mix' | 'sidechainSource'>>;
    }
  | {
      type: 'setEffectParam';
      trackIndex: number;
      slotIndex: number;
      key: string;
      value: number;
      /** Igual que en `setChannelParam`: el inverso borra si la clave no estaba. */
      dropKey?: boolean;
    }
  | {
      type: 'setSend';
      trackIndex: number;
      target: number;
      level: number | null;
      /**
       * Solo lo usa el INVERSO: restaura el envío entero (tap/part/invert/pan/
       * mute incluidos). Sin esto, deshacer un borrado recreaba el envío con
       * solo {target, level} y se perdía toda su forma.
       */
      send?: Send;
    }
  /**
   * Cambia CÓMO es un envío (de dónde toma, qué parte lleva, polaridad, pan,
   * mute) sin tocar su nivel. Aparte de `setSend` porque ese usa `level: null`
   * para borrar el envío, y "quitarle el mute" no puede compartir camino con
   * "quítalo entero".
   */
  | {
      type: 'patchSend';
      trackIndex: number;
      target: number;
      patch: Partial<Omit<Send, 'target'>>;
    }
  | { type: 'setRoute'; trackIndex: number; routeTo: number | null }
  /*
   * Enrutado de entrada (v3.5): qué canal físico de la interfaz entra en qué
   * pista. Van de una en una y no en lote (como los marcadores, no como los
   * clips): una ruta se crea, se cambia o se quita a mano, nunca por barrido.
   */
  | { type: 'addInputRoute'; route: InputRoute; index?: number }
  | { type: 'removeInputRoute'; routeId: Id }
  | { type: 'patchInputRoute'; routeId: Id; patch: Partial<Omit<InputRoute, 'id'>> }
  // Samples
  | { type: 'registerSample'; sample: SampleRef }
  | { type: 'unregisterSample'; sampleId: Id }
  // Lote (un solo paso de undo)
  | { type: 'batch'; label?: string; commands: Command[] };

// ── Helpers ──────────────────────────────────────────────────────────────────

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No existe: ${what}`);
  return value;
}

/**
 * Valida un índice de slot de efecto. Sin esto, un slotIndex fuera de rango o
 * fraccionario (p. ej. vía MCP) rompía la invariante de longitud fija del array
 * de slots (huecos, claves no-índice) y se PERSISTÍA en el .orbit.
 */
function slotIn(index: number, count: number, what: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`Slot de ${what} fuera de rango: ${index} (0..${count - 1})`);
  }
  return index;
}

/** Misma guarda para rutas, envíos e inversos, antes de cualquier mutación. */
function assertMixerConnection(project: Project, from: number, to: number): void {
  if (!Number.isInteger(to) || to < 0 || to >= project.mixer.length) {
    throw new Error(`Ruta fuera de rango: ${String(to)} (0..${project.mixer.length - 1})`);
  }
  // También cuentan los envíos silenciados o a nivel cero: el compilador los
  // incluye en la topología, y reactivarlos no debe descubrir un ciclo oculto.
  if (wouldLoop(project.mixer, from, to)) {
    throw new Error(
      `Enrutar la pista ${from} a la ${to} cerraría un ciclo ` +
        `(la señal de ${to} ya vuelve a ${from}): dejaría la mezcla ` +
        'en silencio. Se mantiene la conexión anterior.',
    );
  }
}

/**
 * El inverso de un lote de parches se guarda por ENTIDAD y POR CLAVE.
 *
 * Un lote puede traer el mismo id dos veces (arrastrar dos notas superpuestas, un
 * comando armado a mano, un parche que se fusiona con otro). La última mutación gana,
 * que es lo correcto, pero el inverso tiene que devolver los valores de ANTES de la
 * primera vez que se vio cada uno: si se apila, queda el valor que había entre medias y
 * al deshacer sigue habiendo un cambio musical puesto después de Ctrl+Z (medido en la
 * tarjeta 004: nota en key 60, parches [{key 61}, {key 62}], y al deshacer se quedaba en
 * key 61).
 *
 * Y por CLAVE, no solo por id: si el segundo parche del mismo id toca OTRO campo, ese
 * campo también necesita su valor viejo (nota key 60/velocity 1, parches [{key 61},
 * {velocity 0.2}]: guardando solo las claves del primero, el undo dejaba velocity 0.2).
 *
 * Se podría rechazar los ids repetidos, pero eso rompe los lotes legítimos que tocan
 * dos veces la misma entidad. Aquí se mantiene la última escritura y el inverso conserva
 * el PRIMER valor viejo de cada clave, que es el único que devuelve al estado anterior.
 *
 * @param vistos qué claves se han guardado ya, por id (el `Map` se crea si no existe).
 */
function anotarInverso<T extends { id: string }>(
  inverses: T[],
  vistos: Map<string, Set<string>>,
  id: string,
  patch: object,
  target: object,
): void {
  const viejo = pickOld(target, patch as Partial<Record<string, unknown>>);
  let claves = vistos.get(id);
  if (claves === undefined) {
    claves = new Set<string>();
    vistos.set(id, claves);
  }
  const nuevo: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(viejo)) {
    if (claves.has(clave)) continue;
    claves.add(clave);
    nuevo[clave] = valor;
  }
  if (Object.keys(nuevo).length === 0) return;
  inverses.push({ id, ...nuevo } as T);
}

/**
 * Un alta con un id que ya vive en el pool se RECHAZA, antes de mutar nada.
 *
 * Por qué rechazar y no "reemplazar": el alta repetida no perdía solo su propia
 * entidad, sino la que ya estaba. El orden de ids se duplicaba y el inverso del
 * alta (un `remove*`) se llevaba por delante a la ORIGINAL: al deshacer, la entidad
 * preexistente desaparecía y el resto del proyecto se quedaba con referencias
 * rotas. Medido en la tarjeta 003 con una entrada de audio: `inputRoutes` vacío y
 * `inputRouteOrder` con un id huérfano.
 *
 * Se comprueba ANTES de escribir (los `add*` que traen una lista recorren dos
 * veces: primero se juzga que no hay ningún id repetido —ni contra el pool ni
 * dentro de la propia lista— y después se escribe), de modo que un lote con ids
 * repetidos tampoco deja el proyecto a medias.
 */
function assertIdNuevo(yaExiste: boolean, que: string, id: string): void {
  if (yaExiste) throw new Error(`Ya existe: ${que} ${id}`);
}

/** Todos los ids de un alta en lista deben ser nuevos: ni del pool, ni entre ellos. */
function assertIdsNuevos<T extends { id: string }>(
  pool: Record<string, unknown>,
  items: readonly T[],
  que: string,
): void {
  const vistos = new Set<string>();
  for (const item of items) {
    assertIdNuevo(pool[item.id] !== undefined || vistos.has(item.id), que, item.id);
    vistos.add(item.id);
  }
}

function pickOld<T extends object>(target: T, patch: Partial<T>): Partial<T> {
  const old: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    old[k] = (target as Record<string, unknown>)[k];
  }
  return old as Partial<T>;
}

/**
 * Los tres campos opcionales de una carpeta (`busTrack`, `mute`, `solo`) tienen
 * un valor NEUTRO explícito, y el inverso de un patch lo usa en vez del
 * `undefined` que devuelve `pickOld` cuando la carpeta no traía el campo.
 *
 * No es cosmética: el inverso viaja a la sala serializado, y `JSON.stringify`
 * borra las claves que valen `undefined`. Sin esto, deshacer "dale un bus a la
 * batería" quitaba el bus aquí y no lo quitaba en el resto de clientes — el
 * comando llegaba con el patch vacío.
 */
function neutralizeGroupPatch(
  patch: Partial<Omit<ChannelGroup, 'id'>>,
): Partial<Omit<ChannelGroup, 'id'>> {
  const out = { ...patch };
  if ('busTrack' in out && out.busTrack === undefined) out.busTrack = 0;
  if ('mute' in out && out.mute === undefined) out.mute = false;
  if ('solo' in out && out.solo === undefined) out.solo = false;
  return out;
}

/**
 * Array de inserts del canal, creándolo si el proyecto viene de antes de la
 * v1.1. Se materializa solo cuando alguien va a escribir en él: un canal sin
 * efectos sigue guardándose sin el campo.
 */
function channelFx(channel: Channel): (EffectSlot | null)[] {
  if (!channel.fx || channel.fx.length !== CHANNEL_SLOTS) {
    const slots: (EffectSlot | null)[] = Array.from({ length: CHANNEL_SLOTS }, () => null);
    if (channel.fx) {
      for (let i = 0; i < Math.min(channel.fx.length, CHANNEL_SLOTS); i++) {
        slots[i] = channel.fx[i] ?? null;
      }
    }
    channel.fx = slots;
  }
  return channel.fx;
}

// ── applyCommand ─────────────────────────────────────────────────────────────

export function applyCommand(project: Project, cmd: Command): Command {
  // Antes de mutar NADA: un id reservado (una clave heredada) en cualquier
  // campo de id se rechaza con su nombre, así que el proyecto y el historial
  // quedan intactos y el prototipo global no se toca (ver `model/entity-id.ts`:
  // el pool sin prototipo es la segunda barrera, esta es la que lo dice).
  assertNoReservedIds(cmd, cmd.type);
  switch (cmd.type) {
    // Transport / proyecto
    case 'setTempo': {
      const inverse: Command = { type: 'setTempo', tempo: project.tempo };
      project.tempo = cmd.tempo;
      return inverse;
    }
    case 'setSwing': {
      const inverse: Command = { type: 'setSwing', swing: project.swing };
      project.swing = cmd.swing;
      return inverse;
    }
    case 'setTimeSig': {
      const inverse: Command = { type: 'setTimeSig', timeSig: { ...project.timeSig } };
      project.timeSig = { ...cmd.timeSig };
      return inverse;
    }
    case 'setMeta': {
      const inverse: Command = { type: 'setMeta', patch: pickOld(project.meta, cmd.patch) };
      Object.assign(project.meta, cmd.patch);
      return inverse;
    }

    // Canales
    case 'addChannel': {
      // Un add con un id que ya vive en el pool duplicaba el id en el orden y su
      // inverso (removeChannel) se llevaba por delante a la entidad original.
      // Se rechaza, como setRoute con los ciclos: el comando es inválido y el
      // estado anterior queda intacto.
      if (project.channels[cmd.channel.id]) {
        throw new Error(`Ya existe: canal ${cmd.channel.id}`);
      }
      project.channels[cmd.channel.id] = cmd.channel;
      const index = cmd.index ?? project.channelOrder.length;
      project.channelOrder.splice(index, 0, cmd.channel.id);
      return { type: 'removeChannel', channelId: cmd.channel.id };
    }
    case 'removeChannel': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      const index = project.channelOrder.indexOf(cmd.channelId);
      const notesByPattern: Record<Id, Note[]> = {};
      for (const pid of project.patternOrder) {
        const pat = project.patterns[pid];
        const notes = pat?.notes[cmd.channelId];
        if (pat && notes && notes.length > 0) {
          notesByPattern[pid] = notes;
          delete pat.notes[cmd.channelId];
        }
      }
      delete project.channels[cmd.channelId];
      // Guardia: si el canal está en el pool pero NO en channelOrder (estado
      // inconsistente por un merge de colaboración), indexOf da -1 y splice(-1,1)
      // expulsaría al ÚLTIMO canal del orden.
      if (index >= 0) project.channelOrder.splice(index, 1);
      return { type: 'restoreChannel', channel, index, notesByPattern };
    }
    case 'restoreChannel': {
      project.channels[cmd.channel.id] = cmd.channel;
      // index < 0 = el canal no estaba en el orden al borrarlo: se reengancha al
      // final en vez de en una posición negativa (que insertaría antes del último).
      if (cmd.index >= 0) project.channelOrder.splice(cmd.index, 0, cmd.channel.id);
      else project.channelOrder.push(cmd.channel.id);
      for (const [pid, notes] of Object.entries(cmd.notesByPattern)) {
        const pat = project.patterns[pid];
        if (pat) pat.notes[cmd.channel.id] = notes;
      }
      return { type: 'removeChannel', channelId: cmd.channel.id };
    }
    case 'addChannelGroup': {
      // Mismo caso que addChannel: con el id repetido, el orden se duplicaba y
      // el inverso borraba la carpeta preexistente.
      if (project.channelGroups[cmd.group.id]) {
        throw new Error(`Ya existe: carpeta ${cmd.group.id}`);
      }
      const at = cmd.index ?? project.channelGroupOrder.length;
      project.channelGroups[cmd.group.id] = { ...cmd.group };
      project.channelGroupOrder.splice(at, 0, cmd.group.id);
      // Al deshacer un borrado, los canales vuelven a su carpeta.
      for (const id of cmd.members ?? []) {
        const ch = project.channels[id];
        if (ch) ch.groupId = cmd.group.id;
      }
      return { type: 'removeChannelGroup', groupId: cmd.group.id };
    }
    case 'removeChannelGroup': {
      const group = must(project.channelGroups[cmd.groupId], `carpeta ${cmd.groupId}`);
      const index = project.channelGroupOrder.indexOf(cmd.groupId);
      // Borrar la carpeta NO borra sus canales: se quedan sueltos.
      const members = project.channelOrder.filter(
        (id) => project.channels[id]?.groupId === cmd.groupId,
      );
      for (const id of members) delete project.channels[id]!.groupId;
      delete project.channelGroups[cmd.groupId];
      if (index >= 0) project.channelGroupOrder.splice(index, 1);
      return { type: 'addChannelGroup', group, index: Math.max(0, index), members };
    }
    case 'patchChannelGroup': {
      const group = must(project.channelGroups[cmd.groupId], `carpeta ${cmd.groupId}`);
      const inverse: Command = {
        type: 'patchChannelGroup',
        groupId: cmd.groupId,
        patch: neutralizeGroupPatch(pickOld(group, cmd.patch)),
      };
      Object.assign(group, cmd.patch);
      return inverse;
    }
    case 'patchChannel': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      const inverse: Command = {
        type: 'patchChannel',
        channelId: cmd.channelId,
        patch: pickOld(channel, cmd.patch),
      };
      Object.assign(channel, cmd.patch);
      return inverse;
    }
    case 'setChannelParam': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      const params = channel.params;
      const had = Object.hasOwn(params, cmd.key);
      const inverse: Command = {
        type: 'setChannelParam',
        channelId: cmd.channelId,
        key: cmd.key,
        value: had ? params[cmd.key]! : 0,
        // Sin clave, el inverso deja de escribir un 0 fantasma: la borra.
        ...(had ? null : { dropKey: true }),
      };
      if (cmd.dropKey) delete params[cmd.key];
      else params[cmd.key] = cmd.value;
      return inverse;
    }
    case 'moveChannel': {
      const from = project.channelOrder.indexOf(cmd.channelId);
      if (from < 0) throw new Error(`No existe: canal ${cmd.channelId}`);
      project.channelOrder.splice(from, 1);
      project.channelOrder.splice(cmd.toIndex, 0, cmd.channelId);
      return { type: 'moveChannel', channelId: cmd.channelId, toIndex: from };
    }

    // Inserts propios del canal
    case 'setChannelEffect': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      const slotIndex = slotIn(cmd.slotIndex, CHANNEL_SLOTS, 'canal');
      const hadFx = channel.fx !== undefined;
      const old = channel.fx?.[slotIndex] ?? null;
      if (cmd.dropFx) {
        // Inverso de un primer efecto sobre un canal legado: si al deshacer la
        // cadena entera queda a nulls se quita el campo, para que el canal
        // vuelva a estar SIN `fx` (materializarlo rompía la identidad: el
        // .orbit ganaba un array de nulls que antes no tenía).
        if (channel.fx) {
          channel.fx[slotIndex] = null;
          if (channel.fx.every((s) => s === null)) delete channel.fx;
        }
      } else {
        channelFx(channel)[slotIndex] = cmd.slot;
      }
      return {
        type: 'setChannelEffect',
        channelId: cmd.channelId,
        slotIndex,
        slot: old,
        ...(hadFx ? null : { dropFx: true }),
      };
    }
    case 'patchChannelEffect': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      // Acceso directo (sin `channelFx`): si el slot no existe, el must lanza
      // ANTES de materializar el array, que es lo que dejaba `fx` colado en un
      // canal legado aunque el comando fallara.
      const slot = must(
        channel.fx?.[cmd.slotIndex] ?? undefined,
        `slot ${cmd.slotIndex} del canal ${cmd.channelId}`,
      );
      const inverse: Command = {
        type: 'patchChannelEffect',
        channelId: cmd.channelId,
        slotIndex: cmd.slotIndex,
        patch: pickOld(slot, cmd.patch),
      };
      Object.assign(slot, cmd.patch);
      return inverse;
    }
    case 'setChannelEffectParam': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      const slot = must(
        channel.fx?.[cmd.slotIndex] ?? undefined,
        `slot ${cmd.slotIndex} del canal ${cmd.channelId}`,
      );
      const params = slot.params;
      const had = Object.hasOwn(params, cmd.key);
      const inverse: Command = {
        type: 'setChannelEffectParam',
        channelId: cmd.channelId,
        slotIndex: cmd.slotIndex,
        key: cmd.key,
        value: had ? params[cmd.key]! : 0,
        ...(had ? null : { dropKey: true }),
      };
      if (cmd.dropKey) delete params[cmd.key];
      else params[cmd.key] = cmd.value;
      return inverse;
    }

    // Patrones
    case 'addPattern': {
      // Mismo caso que addChannel: con el id repetido, el orden se duplicaba y
      // el inverso borraba el patrón preexistente.
      if (project.patterns[cmd.pattern.id]) {
        throw new Error(`Ya existe: patrón ${cmd.pattern.id}`);
      }
      project.patterns[cmd.pattern.id] = cmd.pattern;
      const index = cmd.index ?? project.patternOrder.length;
      project.patternOrder.splice(index, 0, cmd.pattern.id);
      return { type: 'removePattern', patternId: cmd.pattern.id };
    }
    case 'removePattern': {
      // Igual que con los arrangements: siempre queda uno. Sin patrones el
      // rack, el modo PAT y la grabación en vivo se quedan sin destino.
      if (project.patternOrder.length <= 1) {
        throw new Error('No se puede borrar el último patrón');
      }
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      const index = project.patternOrder.indexOf(cmd.patternId);
      const clips = Object.values(project.clips).filter((c) => c.patternId === cmd.patternId);
      for (const c of clips) delete project.clips[c.id];
      delete project.patterns[cmd.patternId];
      // Guardia: si el patrón está en el pool pero NO en patternOrder (merge de
      // colaboración), indexOf da -1 y splice(-1,1) expulsaría al ÚLTIMO del
      // orden. Misma que removeChannel.
      if (index >= 0) project.patternOrder.splice(index, 1);
      return { type: 'restorePattern', pattern, index, clips };
    }
    case 'restorePattern': {
      project.patterns[cmd.pattern.id] = cmd.pattern;
      // index < 0 = no estaba en el orden al borrarlo: se reengancha al final.
      if (cmd.index >= 0) project.patternOrder.splice(cmd.index, 0, cmd.pattern.id);
      else project.patternOrder.push(cmd.pattern.id);
      for (const c of cmd.clips) project.clips[c.id] = c;
      return { type: 'removePattern', patternId: cmd.pattern.id };
    }
    case 'patchPattern': {
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      const inverse: Command = {
        type: 'patchPattern',
        patternId: cmd.patternId,
        patch: pickOld(pattern, cmd.patch),
      };
      Object.assign(pattern, cmd.patch);
      return inverse;
    }

    // Notas
    case 'addNotes': {
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      // Una nota repetida se cuela en la lista y su inverso (removeNotes, que
      // borra POR id) se lleva por delante la original. Se juzga antes de tocar
      // la lista, y se juzga también la lista que trae el comando.
      const previas = pattern.notes[cmd.channelId] ?? [];
      assertIdsNuevos(
        Object.fromEntries(previas.map((n) => [n.id, n])),
        cmd.notes,
        'nota',
      );
      const list = (pattern.notes[cmd.channelId] ??= []);
      list.push(...cmd.notes);
      return {
        type: 'removeNotes',
        patternId: cmd.patternId,
        channelId: cmd.channelId,
        noteIds: cmd.notes.map((n) => n.id),
      };
    }
    case 'removeNotes': {
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      const list = pattern.notes[cmd.channelId] ?? [];
      const ids = new Set(cmd.noteIds);
      const removed = list.filter((n) => ids.has(n.id));
      // Dónde estaba cada una, en la lista de ORIGEN. El orden de las notas no es
      // cosmético: desempata los eventos que comparten inicio al compilar y sale al
      // serializar, así que un `addNotes` que empuja al final dejaba el patrón en otro
      // orden al deshacer (medido: [a,b,c], borrar b y deshacer daba [a,c,b]).
      const at = removed.map((n) => list.indexOf(n));
      const remaining = list.filter((n) => !ids.has(n.id));
      // Invariante: sin notas = sin clave (mantiene identidad de undo y CRDT limpio).
      if (remaining.length === 0) delete pattern.notes[cmd.channelId];
      else pattern.notes[cmd.channelId] = remaining;
      return {
        type: 'restoreNotes',
        patternId: cmd.patternId,
        channelId: cmd.channelId,
        notes: removed,
        at,
      };
    }
    case 'restoreNotes': {
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      // Una lista VACÍA no crea la clave: `removeNotes` de un id que no existe (o con
      // lista vacía) devuelve un inverso con cero notas, y deshacerlo se llevaba por
      // delante `notes[channelId] ??= []`, dejando una clave `[]` que antes NO existía
      // (medido por SOLEANO: cambiaba el proyecto inicial al deshacer, y el proyecto
      // serializado). Aquí no se toca nada, que es lo que corresponde.
      if (cmd.notes.length === 0) {
        return {
          type: 'removeNotes',
          patternId: cmd.patternId,
          channelId: cmd.channelId,
          noteIds: [],
        };
      }
      const list = (pattern.notes[cmd.channelId] ??= []);
      // Con las posiciones, cada nota vuelve a SU sitio. Se insertan en el MISMO orden en
      // que estaban (de delante hacia atrás, que es como las da `removed`): al llegar
      // a la nota n ya están puestas todas las anteriores que también faltaban, así que
      // su índice original sigue siendo el sitio correcto. Al revés se descentraba
      // todo (medido: quitar [b,c] de [a,b,c,d] y deshacer daba [a,b,d,c]).
      for (const [i, nota] of cmd.notes.entries()) {
        const indice = Math.max(0, Math.min(cmd.at?.[i] ?? list.length, list.length));
        list.splice(indice, 0, nota);
      }
      return {
        type: 'removeNotes',
        patternId: cmd.patternId,
        channelId: cmd.channelId,
        noteIds: cmd.notes.map((n) => n.id),
      };
    }
    case 'patchNotes': {
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      const list = pattern.notes[cmd.channelId] ?? [];
      const byId = new Map(list.map((n) => [n.id, n]));
      const inversePatches: NotePatch[] = [];
      const vistos = new Map<string, Set<string>>();
      for (const patch of cmd.patches) {
        const note = byId.get(patch.id);
        if (!note) continue;
        anotarInverso<NotePatch>(inversePatches, vistos, patch.id, patch, note);
        Object.assign(note, patch);
      }
      return {
        type: 'patchNotes',
        patternId: cmd.patternId,
        channelId: cmd.channelId,
        patches: inversePatches,
      };
    }

    // Playlist
    case 'addPlaylistTrack': {
      assertIdNuevo(project.playlistTracks[cmd.track.id] !== undefined, 'pista', cmd.track.id);
      project.playlistTracks[cmd.track.id] = cmd.track;
      return { type: 'removePlaylistTrack', trackId: cmd.track.id };
    }
    case 'removePlaylistTrack': {
      const track = must(project.playlistTracks[cmd.trackId], `pista ${cmd.trackId}`);
      const clips = Object.values(project.clips).filter(
        (c) => c.playlistTrackId === cmd.trackId,
      );
      for (const c of clips) delete project.clips[c.id];
      delete project.playlistTracks[cmd.trackId];
      return { type: 'restorePlaylistTrack', track, clips };
    }
    case 'restorePlaylistTrack': {
      project.playlistTracks[cmd.track.id] = cmd.track;
      for (const c of cmd.clips) project.clips[c.id] = c;
      return { type: 'removePlaylistTrack', trackId: cmd.track.id };
    }
    case 'patchPlaylistTrack': {
      const track = must(project.playlistTracks[cmd.trackId], `pista ${cmd.trackId}`);
      const inverse: Command = {
        type: 'patchPlaylistTrack',
        trackId: cmd.trackId,
        patch: pickOld(track, cmd.patch),
      };
      Object.assign(track, cmd.patch);
      return inverse;
    }
    case 'addClips': {
      assertIdsNuevos(project.clips, cmd.clips, 'clip');
      for (const clip of cmd.clips) project.clips[clip.id] = clip;
      return { type: 'removeClips', clipIds: cmd.clips.map((c) => c.id) };
    }
    case 'removeClips': {
      const removed: Clip[] = [];
      for (const id of cmd.clipIds) {
        const clip = project.clips[id];
        if (clip) {
          removed.push(clip);
          delete project.clips[id];
        }
      }
      return { type: 'restoreClips', clips: removed };
    }
    case 'restoreClips': {
      for (const clip of cmd.clips) project.clips[clip.id] = clip;
      return { type: 'removeClips', clipIds: cmd.clips.map((c) => c.id) };
    }
    case 'patchClips': {
      const inversePatches: ClipPatch[] = [];
      const vistos = new Map<string, Set<string>>();
      for (const patch of cmd.patches) {
        const clip = project.clips[patch.id];
        if (!clip) continue;
        anotarInverso<ClipPatch>(inversePatches, vistos, patch.id, patch, clip);
        Object.assign(clip, patch);
      }
      return { type: 'patchClips', patches: inversePatches };
    }

    // Arrangements
    case 'addArrangement': {
      // Mismo caso que addChannel: con el id repetido, el orden se duplicaba y
      // el inverso borraba el arrangement preexistente.
      if (project.arrangements[cmd.arrangement.id]) {
        throw new Error(`Ya existe: arrangement ${cmd.arrangement.id}`);
      }
      project.arrangements[cmd.arrangement.id] = cmd.arrangement;
      project.arrangementOrder.push(cmd.arrangement.id);
      return { type: 'removeArrangement', arrangementId: cmd.arrangement.id };
    }
    case 'removeArrangement': {
      if (project.arrangementOrder.length <= 1) {
        throw new Error('No se puede borrar el último arrangement');
      }
      const arrangement = must(
        project.arrangements[cmd.arrangementId],
        `arrangement ${cmd.arrangementId}`,
      );
      const index = project.arrangementOrder.indexOf(cmd.arrangementId);
      const tracks = Object.values(project.playlistTracks).filter(
        (t) => t.arrangementId === cmd.arrangementId,
      );
      const trackIds = new Set(tracks.map((t) => t.id));
      const clips = Object.values(project.clips).filter((c) =>
        trackIds.has(c.playlistTrackId),
      );
      // Las secciones del arreglo también se van con él: si no, quedan en el pool
      // apuntando a un arrangement inexistente (para siempre, y viajan en cada
      // save/patch).
      const sections = Object.values(project.sections ?? {}).filter(
        (s) => s.arrangementId === cmd.arrangementId,
      );
      const activeWas = project.activeArrangementId;
      for (const c of clips) delete project.clips[c.id];
      for (const t of tracks) delete project.playlistTracks[t.id];
      for (const s of sections) delete project.sections[s.id];
      delete project.arrangements[cmd.arrangementId];
      // Si el id no estaba en el orden (estado posible tras un merge: el pool tiene la
      // entidad y el orden no), `splice(-1, 1)` expulsaba al ÚLTIMO arreglo, que no tiene
      // nada que ver con este borrado (medido en la tarjeta 010: con base/other/hidden en
      // el pool y solo [base, other] en el orden, borrar hidden dejaba [base] y `other`
      // se caía del selector sin haberlo borrado). Aquí no se toca el orden, y el
      // inverso devuelve el sitio solo si lo había.
      if (index >= 0) project.arrangementOrder.splice(index, 1);
      if (project.activeArrangementId === cmd.arrangementId) {
        project.activeArrangementId = project.arrangementOrder[0] ?? project.activeArrangementId;
      }
      return {
        type: 'restoreArrangement',
        arrangement,
        index,
        tracks,
        clips,
        sections,
        activeWas,
      };
    }
    case 'restoreArrangement': {
      project.arrangements[cmd.arrangement.id] = cmd.arrangement;
      // Mismo criterio que `restorePattern`: si el arrangement no estaba en el orden al
      // borrarlo (el caso de la tarjeta 010), `index` es -1 y lo reengancha al final; si
      // lo estaba, vuelve a SU sitio.
      if (cmd.index >= 0) project.arrangementOrder.splice(cmd.index, 0, cmd.arrangement.id);
      else project.arrangementOrder.push(cmd.arrangement.id);
      for (const t of cmd.tracks) project.playlistTracks[t.id] = t;
      for (const c of cmd.clips) project.clips[c.id] = c;
      for (const s of cmd.sections) project.sections[s.id] = s;
      // Restaurar el activo de antes: el borrado pudo reasignarlo, y sin esto el
      // inverso no era exacto (te dejaba en otro arrangement al deshacer).
      project.activeArrangementId = cmd.activeWas;
      return { type: 'removeArrangement', arrangementId: cmd.arrangement.id };
    }
    case 'patchArrangement': {
      const arr = must(project.arrangements[cmd.arrangementId], `arrangement ${cmd.arrangementId}`);
      const inverse: Command = {
        type: 'patchArrangement',
        arrangementId: cmd.arrangementId,
        patch: pickOld(arr, cmd.patch),
      };
      Object.assign(arr, cmd.patch);
      return inverse;
    }
    case 'setActiveArrangement': {
      const inverse: Command = {
        type: 'setActiveArrangement',
        arrangementId: project.activeArrangementId,
      };
      project.activeArrangementId = cmd.arrangementId;
      return inverse;
    }

    // Layouts de ventanas
    case 'setLayout': {
      const hadContainer = project.layouts !== undefined;
      const layouts = project.layouts;
      const old = layouts?.[cmd.name] ?? null;
      if (cmd.windows === null) {
        if (layouts) {
          delete layouts[cmd.name];
          // El inverso de un primer layout no puede dejar el contenedor
          // materializado en un proyecto que no traía `layouts`: el campo es
          // opcional y sin él el .orbit vuelve a ser el de antes.
          if (cmd.dropContainer && Object.keys(layouts).length === 0) delete project.layouts;
        }
        return { type: 'setLayout', name: cmd.name, windows: old };
      }
      const target = (project.layouts ??= {});
      target[cmd.name] = cmd.windows;
      return {
        type: 'setLayout',
        name: cmd.name,
        windows: old,
        ...(hadContainer ? null : { dropContainer: true }),
      };
    }

    // LFOs
    case 'addLfos': {
      assertIdsNuevos(project.lfos, cmd.lfos, 'LFO');
      for (const lfo of cmd.lfos) project.lfos[lfo.id] = lfo;
      return { type: 'removeLfos', lfoIds: cmd.lfos.map((l) => l.id) };
    }
    case 'removeLfos': {
      const removed: Lfo[] = [];
      for (const id of cmd.lfoIds) {
        const lfo = project.lfos[id];
        if (lfo) {
          removed.push(lfo);
          delete project.lfos[id];
        }
      }
      return { type: 'restoreLfos', lfos: removed };
    }
    case 'restoreLfos': {
      for (const lfo of cmd.lfos) project.lfos[lfo.id] = lfo;
      return { type: 'removeLfos', lfoIds: cmd.lfos.map((l) => l.id) };
    }
    case 'patchLfo': {
      const lfo = must(project.lfos[cmd.lfoId], `LFO ${cmd.lfoId}`);
      const inverse: Command = {
        type: 'patchLfo',
        lfoId: cmd.lfoId,
        patch: pickOld(lfo, cmd.patch),
      };
      Object.assign(lfo, cmd.patch);
      return inverse;
    }

    // Marcadores
    case 'addSections': {
      assertIdsNuevos(project.sections, cmd.sections, 'sección');
      for (const section of cmd.sections) project.sections[section.id] = section;
      return { type: 'removeSections', sectionIds: cmd.sections.map((x) => x.id) };
    }
    case 'removeSections': {
      const removed: ArrangementSection[] = [];
      for (const id of cmd.sectionIds) {
        const section = project.sections[id];
        if (section) {
          removed.push(section);
          delete project.sections[id];
        }
      }
      return { type: 'restoreSections', sections: removed };
    }
    case 'restoreSections': {
      for (const section of cmd.sections) project.sections[section.id] = section;
      return { type: 'removeSections', sectionIds: cmd.sections.map((x) => x.id) };
    }
    case 'patchSections': {
      const inversePatches: SectionPatch[] = [];
      const vistos = new Map<string, Set<string>>();
      for (const patch of cmd.patches) {
        const section = project.sections[patch.id];
        if (!section) continue;
        anotarInverso<SectionPatch>(inversePatches, vistos, patch.id, patch, section);
        Object.assign(section, patch);
      }
      return { type: 'patchSections', patches: inversePatches };
    }
    case 'addMarker': {
      assertIdNuevo(project.markers[cmd.marker.id] !== undefined, 'marcador', cmd.marker.id);
      project.markers[cmd.marker.id] = cmd.marker;
      return { type: 'removeMarker', markerId: cmd.marker.id };
    }
    case 'removeMarker': {
      const marker = must(project.markers[cmd.markerId], `marcador ${cmd.markerId}`);
      delete project.markers[cmd.markerId];
      return { type: 'addMarker', marker };
    }
    case 'patchMarker': {
      const marker = must(project.markers[cmd.markerId], `marcador ${cmd.markerId}`);
      const inverse: Command = {
        type: 'patchMarker',
        markerId: cmd.markerId,
        patch: pickOld(marker, cmd.patch),
      };
      Object.assign(marker, cmd.patch);
      return inverse;
    }

    // Mixer
    case 'patchMixerTrack': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      if (Object.hasOwn(cmd.patch, 'routeTo') && cmd.patch.routeTo !== null) {
        assertMixerConnection(project, cmd.trackIndex, cmd.patch.routeTo!);
      }
      const inverse: Command = {
        type: 'patchMixerTrack',
        trackIndex: cmd.trackIndex,
        patch: pickOld(track, cmd.patch),
      };
      Object.assign(track, cmd.patch);
      return inverse;
    }
    case 'setEffect': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      const slotIndex = slotIn(cmd.slotIndex, MIXER_SLOTS, 'mixer');
      const old = track.slots[slotIndex] ?? null;
      track.slots[slotIndex] = cmd.slot;
      return {
        type: 'setEffect',
        trackIndex: cmd.trackIndex,
        slotIndex,
        slot: old,
      };
    }
    case 'patchEffect': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      const slot = must(track.slots[cmd.slotIndex] ?? undefined, `slot ${cmd.slotIndex}`);
      const inverse: Command = {
        type: 'patchEffect',
        trackIndex: cmd.trackIndex,
        slotIndex: cmd.slotIndex,
        patch: pickOld(slot, cmd.patch),
      };
      Object.assign(slot, cmd.patch);
      return inverse;
    }
    case 'setEffectParam': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      const slot = must(track.slots[cmd.slotIndex] ?? undefined, `slot ${cmd.slotIndex}`);
      const params = slot.params;
      const had = Object.hasOwn(params, cmd.key);
      const inverse: Command = {
        type: 'setEffectParam',
        trackIndex: cmd.trackIndex,
        slotIndex: cmd.slotIndex,
        key: cmd.key,
        value: had ? params[cmd.key]! : 0,
        // Igual que en setChannelParam: sin clave, el inverso la borra.
        ...(had ? null : { dropKey: true }),
      };
      if (cmd.dropKey) delete params[cmd.key];
      else params[cmd.key] = cmd.value;
      return inverse;
    }
    case 'setSend': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      if (cmd.send && cmd.send.target !== cmd.target) {
        throw new Error('El destino del envío completo no coincide con el destino del comando.');
      }
      // Quitar un cable siempre sigue siendo posible, incluso si el archivo
      // heredado ya traía un ciclo o un destino fuera del mixer.
      if (cmd.send || cmd.level !== null) {
        assertMixerConnection(project, cmd.trackIndex, cmd.target);
      }
      const existing = track.sends.find((s) => s.target === cmd.target);
      // Clon del estado ANTERIOR completo (Send solo tiene primitivos): el
      // inverso restaura el objeto entero, no solo el nivel.
      const oldSend = existing ? { ...existing } : null;
      if (cmd.send) {
        // Inverso restaurando un envío entero: se reemplaza/re-crea completo.
        track.sends = track.sends.filter((s) => s.target !== cmd.target);
        track.sends.push({ ...cmd.send });
      } else if (cmd.level === null) {
        track.sends = track.sends.filter((s) => s.target !== cmd.target);
      } else if (existing) {
        existing.level = cmd.level;
      } else {
        track.sends.push({ target: cmd.target, level: cmd.level });
      }
      return oldSend
        ? {
            type: 'setSend',
            trackIndex: cmd.trackIndex,
            target: cmd.target,
            level: oldSend.level,
            send: oldSend,
          }
        : { type: 'setSend', trackIndex: cmd.trackIndex, target: cmd.target, level: null };
    }
    case 'patchSend': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      const send = track.sends.find((s) => s.target === cmd.target);
      // Un envío que ya no existe (lo quitó otro, o llegó tarde de la sala) no
      // se recrea a medias: el patch se cae y el inverso no toca nada.
      if (!send) {
        return { type: 'patchSend', trackIndex: cmd.trackIndex, target: cmd.target, patch: {} };
      }
      const inverse: Command = {
        type: 'patchSend',
        trackIndex: cmd.trackIndex,
        target: cmd.target,
        patch: pickOld(send, cmd.patch),
      };
      Object.assign(send, cmd.patch);
      return inverse;
    }
    case 'setRoute': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      // null desconecta; el resto comparte la validación de setSend/patch.
      if (cmd.routeTo !== null) assertMixerConnection(project, cmd.trackIndex, cmd.routeTo);
      const inverse: Command = {
        type: 'setRoute',
        trackIndex: cmd.trackIndex,
        routeTo: track.routeTo,
      };
      track.routeTo = cmd.routeTo;
      return inverse;
    }

    // Samples
    // Enrutado de entrada
    case 'addInputRoute': {
      // Tope duro: el kernel enruta sobre tablas preasignadas y la ruta que
      // pasa del máximo no tendría dónde caer. Falla aquí, con su nombre, en
      // vez de crearse en el proyecto y no sonar nunca.
      if (project.inputRouteOrder.length >= MAX_INPUT_ROUTES) {
        throw new Error(`No caben más entradas: el máximo son ${MAX_INPUT_ROUTES}`);
      }
      assertIdNuevo(project.inputRoutes[cmd.route.id] !== undefined, 'entrada', cmd.route.id);
      project.inputRoutes[cmd.route.id] = cmd.route;
      const at = cmd.index ?? project.inputRouteOrder.length;
      project.inputRouteOrder.splice(at, 0, cmd.route.id);
      return { type: 'removeInputRoute', routeId: cmd.route.id };
    }
    case 'removeInputRoute': {
      const route = must(project.inputRoutes[cmd.routeId], `entrada ${cmd.routeId}`);
      const index = project.inputRouteOrder.indexOf(cmd.routeId);
      delete project.inputRoutes[cmd.routeId];
      // Misma guardia que en `removeChannel`: con la ruta fuera del orden
      // (merge de colaboración), splice(-1, 1) expulsaría a la última.
      if (index >= 0) project.inputRouteOrder.splice(index, 1);
      // El inverso recuerda su SITIO: el índice de una ruta es lo que enlaza
      // la UI, el motor y las tomas capturadas, así que deshacer tiene que
      // devolverla a la misma posición, no al final.
      return { type: 'addInputRoute', route, index: Math.max(0, index) };
    }
    case 'patchInputRoute': {
      const route = must(project.inputRoutes[cmd.routeId], `entrada ${cmd.routeId}`);
      const inverse: Command = {
        type: 'patchInputRoute',
        routeId: cmd.routeId,
        patch: pickOld(route, cmd.patch),
      };
      Object.assign(route, cmd.patch);
      return inverse;
    }

    case 'registerSample': {
      assertIdNuevo(project.samples[cmd.sample.id] !== undefined, 'sample', cmd.sample.id);
      project.samples[cmd.sample.id] = cmd.sample;
      return { type: 'unregisterSample', sampleId: cmd.sample.id };
    }
    case 'unregisterSample': {
      const sample = must(project.samples[cmd.sampleId], `sample ${cmd.sampleId}`);
      delete project.samples[cmd.sampleId];
      return { type: 'registerSample', sample };
    }

    // Lote
    case 'batch': {
      const inverses: Command[] = [];
      try {
        for (const sub of cmd.commands) {
          inverses.push(applyCommand(project, sub));
        }
      } catch (err) {
        // Rollback: un batch es todo-o-nada. Si un sub lanza (una entidad que
        // otro borró, un must() fallido), se deshace en orden inverso lo ya
        // aplicado y se relanza, para no dejar el proyecto mutado a medias sin
        // entrada de undo ni emit (la UI mostraría estado stale imposible de
        // deshacer).
        for (let i = inverses.length - 1; i >= 0; i--) {
          try {
            applyCommand(project, inverses[i]!);
          } catch {
            // mejor esfuerzo: seguir deshaciendo el resto
          }
        }
        throw err;
      }
      inverses.reverse();
      return { type: 'batch', label: cmd.label, commands: inverses };
    }
  }
}
