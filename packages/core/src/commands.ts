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
import { CHANNEL_SLOTS } from './model/types';

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
  | { type: 'setChannelParam'; channelId: Id; key: string; value: number }
  | { type: 'moveChannel'; channelId: Id; toIndex: number }
  // Carpetas del rack: organización pura, no tocan el audio. `members` solo lo
  // usa el inverso de borrar una carpeta, para devolver a sus canales dentro.
  | { type: 'addChannelGroup'; group: ChannelGroup; index?: number; members?: Id[] }
  | { type: 'removeChannelGroup'; groupId: Id }
  | { type: 'patchChannelGroup'; groupId: Id; patch: Partial<Omit<ChannelGroup, 'id'>> }
  // Inserts propios del canal (Channel.fx)
  | { type: 'setChannelEffect'; channelId: Id; slotIndex: number; slot: EffectSlot | null }
  | {
      type: 'patchChannelEffect';
      channelId: Id;
      slotIndex: number;
      patch: Partial<Pick<EffectSlot, 'enabled' | 'mix' | 'sidechainSource'>>;
    }
  | { type: 'setChannelEffectParam'; channelId: Id; slotIndex: number; key: string; value: number }
  // Patrones
  | { type: 'addPattern'; pattern: Pattern; index?: number }
  | { type: 'removePattern'; patternId: Id }
  | { type: 'restorePattern'; pattern: Pattern; index: number; clips: Clip[] }
  | { type: 'patchPattern'; patternId: Id; patch: Partial<Omit<Pattern, 'id' | 'notes'>> }
  // Notas
  | { type: 'addNotes'; patternId: Id; channelId: Id; notes: Note[] }
  | { type: 'removeNotes'; patternId: Id; channelId: Id; noteIds: Id[] }
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
    }
  | { type: 'patchArrangement'; arrangementId: Id; patch: Partial<Omit<Arrangement, 'id'>> }
  | { type: 'setActiveArrangement'; arrangementId: Id }
  // Layouts de ventanas guardados en el proyecto
  | { type: 'setLayout'; name: string; windows: Record<string, LayoutWindow> | null }
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
  | { type: 'setEffectParam'; trackIndex: number; slotIndex: number; key: string; value: number }
  | { type: 'setSend'; trackIndex: number; target: number; level: number | null }
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

function pickOld<T extends object>(target: T, patch: Partial<T>): Partial<T> {
  const old: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    old[k] = (target as Record<string, unknown>)[k];
  }
  return old as Partial<T>;
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
      project.channelOrder.splice(index, 1);
      return { type: 'restoreChannel', channel, index, notesByPattern };
    }
    case 'restoreChannel': {
      project.channels[cmd.channel.id] = cmd.channel;
      project.channelOrder.splice(cmd.index, 0, cmd.channel.id);
      for (const [pid, notes] of Object.entries(cmd.notesByPattern)) {
        const pat = project.patterns[pid];
        if (pat) pat.notes[cmd.channel.id] = notes;
      }
      return { type: 'removeChannel', channelId: cmd.channel.id };
    }
    case 'addChannelGroup': {
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
        patch: pickOld(group, cmd.patch),
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
      const inverse: Command = {
        type: 'setChannelParam',
        channelId: cmd.channelId,
        key: cmd.key,
        value: channel.params[cmd.key] ?? 0,
      };
      channel.params[cmd.key] = cmd.value;
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
      const slots = channelFx(channel);
      const old = slots[cmd.slotIndex] ?? null;
      slots[cmd.slotIndex] = cmd.slot;
      return {
        type: 'setChannelEffect',
        channelId: cmd.channelId,
        slotIndex: cmd.slotIndex,
        slot: old,
      };
    }
    case 'patchChannelEffect': {
      const channel = must(project.channels[cmd.channelId], `canal ${cmd.channelId}`);
      const slot = must(
        channelFx(channel)[cmd.slotIndex] ?? undefined,
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
        channelFx(channel)[cmd.slotIndex] ?? undefined,
        `slot ${cmd.slotIndex} del canal ${cmd.channelId}`,
      );
      const inverse: Command = {
        type: 'setChannelEffectParam',
        channelId: cmd.channelId,
        slotIndex: cmd.slotIndex,
        key: cmd.key,
        value: slot.params[cmd.key] ?? 0,
      };
      slot.params[cmd.key] = cmd.value;
      return inverse;
    }

    // Patrones
    case 'addPattern': {
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
      project.patternOrder.splice(index, 1);
      return { type: 'restorePattern', pattern, index, clips };
    }
    case 'restorePattern': {
      project.patterns[cmd.pattern.id] = cmd.pattern;
      project.patternOrder.splice(cmd.index, 0, cmd.pattern.id);
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
      const remaining = list.filter((n) => !ids.has(n.id));
      // Invariante: sin notas = sin clave (mantiene identidad de undo y CRDT limpio).
      if (remaining.length === 0) delete pattern.notes[cmd.channelId];
      else pattern.notes[cmd.channelId] = remaining;
      return {
        type: 'addNotes',
        patternId: cmd.patternId,
        channelId: cmd.channelId,
        notes: removed,
      };
    }
    case 'patchNotes': {
      const pattern = must(project.patterns[cmd.patternId], `patrón ${cmd.patternId}`);
      const list = pattern.notes[cmd.channelId] ?? [];
      const byId = new Map(list.map((n) => [n.id, n]));
      const inversePatches: NotePatch[] = [];
      for (const patch of cmd.patches) {
        const note = byId.get(patch.id);
        if (!note) continue;
        inversePatches.push({ id: patch.id, ...pickOld(note, patch) });
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
      for (const patch of cmd.patches) {
        const clip = project.clips[patch.id];
        if (!clip) continue;
        inversePatches.push({ id: patch.id, ...pickOld(clip, patch) });
        Object.assign(clip, patch);
      }
      return { type: 'patchClips', patches: inversePatches };
    }

    // Arrangements
    case 'addArrangement': {
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
      for (const c of clips) delete project.clips[c.id];
      for (const t of tracks) delete project.playlistTracks[t.id];
      delete project.arrangements[cmd.arrangementId];
      project.arrangementOrder.splice(index, 1);
      if (project.activeArrangementId === cmd.arrangementId) {
        project.activeArrangementId = project.arrangementOrder[0]!;
      }
      return { type: 'restoreArrangement', arrangement, index, tracks, clips };
    }
    case 'restoreArrangement': {
      project.arrangements[cmd.arrangement.id] = cmd.arrangement;
      project.arrangementOrder.splice(cmd.index, 0, cmd.arrangement.id);
      for (const t of cmd.tracks) project.playlistTracks[t.id] = t;
      for (const c of cmd.clips) project.clips[c.id] = c;
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
      const layouts = (project.layouts ??= {});
      const old = layouts[cmd.name] ?? null;
      if (cmd.windows === null) delete layouts[cmd.name];
      else layouts[cmd.name] = cmd.windows;
      return { type: 'setLayout', name: cmd.name, windows: old };
    }

    // LFOs
    case 'addLfos': {
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
      for (const patch of cmd.patches) {
        const section = project.sections[patch.id];
        if (!section) continue;
        inversePatches.push({ id: patch.id, ...pickOld(section, patch) });
        Object.assign(section, patch);
      }
      return { type: 'patchSections', patches: inversePatches };
    }
    case 'addMarker': {
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
      const old = track.slots[cmd.slotIndex] ?? null;
      track.slots[cmd.slotIndex] = cmd.slot;
      return {
        type: 'setEffect',
        trackIndex: cmd.trackIndex,
        slotIndex: cmd.slotIndex,
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
      const inverse: Command = {
        type: 'setEffectParam',
        trackIndex: cmd.trackIndex,
        slotIndex: cmd.slotIndex,
        key: cmd.key,
        value: slot.params[cmd.key] ?? 0,
      };
      slot.params[cmd.key] = cmd.value;
      return inverse;
    }
    case 'setSend': {
      const track = must(project.mixer[cmd.trackIndex], `mixer ${cmd.trackIndex}`);
      const existing = track.sends.find((s) => s.target === cmd.target);
      const oldLevel = existing ? existing.level : null;
      if (cmd.level === null) {
        track.sends = track.sends.filter((s) => s.target !== cmd.target);
      } else if (existing) {
        existing.level = cmd.level;
      } else {
        track.sends.push({ target: cmd.target, level: cmd.level });
      }
      return { type: 'setSend', trackIndex: cmd.trackIndex, target: cmd.target, level: oldLevel };
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
      const inverse: Command = {
        type: 'setRoute',
        trackIndex: cmd.trackIndex,
        routeTo: track.routeTo,
      };
      track.routeTo = cmd.routeTo;
      return inverse;
    }

    // Samples
    case 'registerSample': {
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
      for (const sub of cmd.commands) {
        inverses.push(applyCommand(project, sub));
      }
      inverses.reverse();
      return { type: 'batch', label: cmd.label, commands: inverses };
    }
  }
}
