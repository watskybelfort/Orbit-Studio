/**
 * Diff MUSICAL entre dos versiones del proyecto.
 *
 * "¿Qué cambió en el drop?" no se responde con bytes. Comparar dos `.orbit`
 * como texto da una pared de JSON donde un `id` reordenado pesa lo mismo que
 * doce notas nuevas; lo que hace falta es leerlo en los términos en los que se
 * trabaja: cuántas notas entraron en qué patrón y en qué canal, qué se movió,
 * qué canal es nuevo, cuánto subió un fader, si cambió el tempo.
 *
 * Las notas se casan por ID, no por posición: así "movida" y "nueva" no se
 * confunden — mover una nota y borrarla+crearla se ven distinto, que es justo
 * lo que uno quiere saber al mirar atrás.
 *
 * Módulo puro: dos proyectos entran, un informe sale. Sin fs, sin UI.
 */

import { gainToDb } from './notes';
import type { Id, Note, Project } from './types';

/** Cambio en las notas de un canal dentro de un patrón. */
export interface NoteDiff {
  patternId: Id;
  patternName: string;
  channelId: Id;
  channelName: string;
  added: number;
  removed: number;
  /** Misma nota (mismo id) en otro sitio o con otra duración. */
  moved: number;
  /** Misma nota, otra altura. */
  retuned: number;
  /** Misma nota, otra velocity. */
  revoiced: number;
}

export interface MixerDiff {
  trackIndex: number;
  name: string;
  /** Cambio de fader en dB. */
  volumeDb?: [number, number];
  pan?: [number, number];
  effectsAdded: string[];
  effectsRemoved: string[];
}

export interface ProjectDiff {
  title?: [string, string];
  tempo?: [number, number];
  swing?: [number, number];
  channels: {
    added: string[];
    removed: string[];
    renamed: [string, string][];
    /** Canales que cambiaron de pista de mixer. */
    rerouted: { name: string; from: number; to: number }[];
  };
  patterns: {
    added: string[];
    removed: string[];
    renamed: [string, string][];
    resized: { name: string; from: number; to: number }[];
  };
  notes: NoteDiff[];
  clips: { added: number; removed: number; moved: number };
  mixer: MixerDiff[];
  samples: { added: string[]; removed: string[] };
}

/** Un cambio de fader por debajo de esto no se cuenta (ruido de perilla). */
const DB_EPSILON = 0.1;
const PAN_EPSILON = 0.01;
const TIME_EPSILON = 1e-6;

/** Nombre del canal en ese proyecto, o cadena vacía si allí ya no existe. */
function nameOf(project: Project, channelId: Id): string {
  return project.channels[channelId]?.name ?? '';
}

/** Notas de un canal en un patrón, indexadas por id. */
function notesById(project: Project, patternId: Id, channelId: Id): Map<Id, Note> {
  const list = project.patterns[patternId]?.notes[channelId] ?? [];
  return new Map(list.map((note) => [note.id, note]));
}

function diffNotesOf(
  before: Project,
  after: Project,
  patternId: Id,
  channelId: Id,
): NoteDiff | null {
  const a = notesById(before, patternId, channelId);
  const b = notesById(after, patternId, channelId);
  if (a.size === 0 && b.size === 0) return null;

  let added = 0;
  let removed = 0;
  let moved = 0;
  let retuned = 0;
  let revoiced = 0;

  for (const [id, note] of b) {
    const old = a.get(id);
    if (!old) {
      added++;
      continue;
    }
    if (
      Math.abs(old.start - note.start) > TIME_EPSILON ||
      Math.abs(old.duration - note.duration) > TIME_EPSILON
    ) {
      moved++;
    }
    if (old.key !== note.key) retuned++;
    if (Math.abs(old.velocity - note.velocity) > 0.001) revoiced++;
  }
  for (const id of a.keys()) if (!b.has(id)) removed++;

  if (added + removed + moved + retuned + revoiced === 0) return null;
  const pattern = after.patterns[patternId] ?? before.patterns[patternId];
  return {
    patternId,
    patternName: pattern?.name ?? patternId,
    channelId,
    // Un canal borrado ya no tiene nombre en `after`: se coge el que tenía
    // antes. Enseñar su id en el informe no le dice nada a nadie.
    channelName: nameOf(after, channelId) || nameOf(before, channelId) || channelId,
    added,
    removed,
    moved,
    retuned,
    revoiced,
  };
}

function diffMixer(before: Project, after: Project): MixerDiff[] {
  const out: MixerDiff[] = [];
  const tracks = Math.max(before.mixer.length, after.mixer.length);
  for (let i = 0; i < tracks; i++) {
    const a = before.mixer[i];
    const b = after.mixer[i];
    if (!a || !b) continue;
    const entry: MixerDiff = {
      trackIndex: i,
      name: b.name,
      effectsAdded: [],
      effectsRemoved: [],
    };
    const dbA = gainToDb(a.volume);
    const dbB = gainToDb(b.volume);
    if (Math.abs(dbA - dbB) > DB_EPSILON) entry.volumeDb = [dbA, dbB];
    if (Math.abs(a.pan - b.pan) > PAN_EPSILON) entry.pan = [a.pan, b.pan];

    // Los efectos se casan por id de slot: mover uno de ranura no es ni
    // añadirlo ni quitarlo, y decir lo contrario sería mentir.
    const idsA = new Map(a.slots.filter((s) => s !== null).map((s) => [s!.id, s!.kind]));
    const idsB = new Map(b.slots.filter((s) => s !== null).map((s) => [s!.id, s!.kind]));
    for (const [id, kind] of idsB) if (!idsA.has(id)) entry.effectsAdded.push(kind);
    for (const [id, kind] of idsA) if (!idsB.has(id)) entry.effectsRemoved.push(kind);

    if (
      entry.volumeDb ||
      entry.pan ||
      entry.effectsAdded.length > 0 ||
      entry.effectsRemoved.length > 0
    ) {
      out.push(entry);
    }
  }
  return out;
}

export function diffProjects(before: Project, after: Project): ProjectDiff {
  const diff: ProjectDiff = {
    channels: { added: [], removed: [], renamed: [], rerouted: [] },
    patterns: { added: [], removed: [], renamed: [], resized: [] },
    notes: [],
    clips: { added: 0, removed: 0, moved: 0 },
    mixer: diffMixer(before, after),
    samples: { added: [], removed: [] },
  };

  if (before.meta.title !== after.meta.title) {
    diff.title = [before.meta.title, after.meta.title];
  }
  if (Math.abs(before.tempo - after.tempo) > 1e-6) diff.tempo = [before.tempo, after.tempo];
  if (Math.abs(before.swing - after.swing) > 1e-6) diff.swing = [before.swing, after.swing];

  // ── Canales ───────────────────────────────────────────────────────────────
  for (const id of after.channelOrder) {
    const now = after.channels[id];
    if (!now) continue;
    const old = before.channels[id];
    if (!old) {
      diff.channels.added.push(now.name);
      continue;
    }
    if (old.name !== now.name) diff.channels.renamed.push([old.name, now.name]);
    if (old.mixerTrack !== now.mixerTrack) {
      diff.channels.rerouted.push({ name: now.name, from: old.mixerTrack, to: now.mixerTrack });
    }
  }
  for (const id of before.channelOrder) {
    if (!after.channels[id] && before.channels[id]) {
      diff.channels.removed.push(before.channels[id]!.name);
    }
  }

  // ── Patrones y notas ──────────────────────────────────────────────────────
  for (const id of after.patternOrder) {
    const now = after.patterns[id];
    if (!now) continue;
    const old = before.patterns[id];
    if (!old) {
      diff.patterns.added.push(now.name);
    } else {
      if (old.name !== now.name) diff.patterns.renamed.push([old.name, now.name]);
      if (Math.abs(old.length - now.length) > TIME_EPSILON) {
        diff.patterns.resized.push({ name: now.name, from: old.length, to: now.length });
      }
    }
    // Canales con notas en cualquiera de las dos versiones del patrón.
    const channels = new Set([...Object.keys(now.notes), ...Object.keys(old?.notes ?? {})]);
    for (const channelId of channels) {
      const entry = diffNotesOf(before, after, id, channelId);
      if (entry) diff.notes.push(entry);
    }
  }
  for (const id of before.patternOrder) {
    const old = before.patterns[id];
    if (!old || after.patterns[id]) continue;
    diff.patterns.removed.push(old.name);
    // Las notas de un patrón borrado se cuentan una vez, con el patrón.
  }

  // ── Clips ─────────────────────────────────────────────────────────────────
  for (const [id, clip] of Object.entries(after.clips)) {
    const old = before.clips[id];
    if (!old) diff.clips.added++;
    else if (
      Math.abs(old.start - clip.start) > TIME_EPSILON ||
      Math.abs(old.length - clip.length) > TIME_EPSILON ||
      old.playlistTrackId !== clip.playlistTrackId
    ) {
      diff.clips.moved++;
    }
  }
  for (const id of Object.keys(before.clips)) if (!after.clips[id]) diff.clips.removed++;

  // ── Samples ───────────────────────────────────────────────────────────────
  for (const [id, sample] of Object.entries(after.samples)) {
    if (!before.samples[id]) diff.samples.added.push(sample.name);
  }
  for (const [id, sample] of Object.entries(before.samples)) {
    if (!after.samples[id]) diff.samples.removed.push(sample.name);
  }

  return diff;
}

export function isEmptyDiff(diff: ProjectDiff): boolean {
  return (
    !diff.title &&
    !diff.tempo &&
    !diff.swing &&
    diff.channels.added.length === 0 &&
    diff.channels.removed.length === 0 &&
    diff.channels.renamed.length === 0 &&
    diff.channels.rerouted.length === 0 &&
    diff.patterns.added.length === 0 &&
    diff.patterns.removed.length === 0 &&
    diff.patterns.renamed.length === 0 &&
    diff.patterns.resized.length === 0 &&
    diff.notes.length === 0 &&
    diff.clips.added === 0 &&
    diff.clips.removed === 0 &&
    diff.clips.moved === 0 &&
    diff.mixer.length === 0 &&
    diff.samples.added.length === 0 &&
    diff.samples.removed.length === 0
  );
}

function db(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * El informe en líneas legibles, de lo más gordo a lo más fino: primero lo que
 * cambia la canción entera (tempo, canales, patrones), luego las notas patrón
 * a patrón, y al final la mezcla.
 */
export function describeDiff(diff: ProjectDiff): string[] {
  const lines: string[] = [];

  if (diff.title) lines.push(`Título: «${diff.title[0]}» → «${diff.title[1]}»`);
  if (diff.tempo) {
    lines.push(`Tempo: ${diff.tempo[0].toFixed(2)} → ${diff.tempo[1].toFixed(2)} BPM`);
  }
  if (diff.swing) {
    lines.push(`Swing: ${Math.round(diff.swing[0] * 100)} % → ${Math.round(diff.swing[1] * 100)} %`);
  }

  for (const name of diff.channels.added) lines.push(`Canal nuevo: «${name}»`);
  for (const name of diff.channels.removed) lines.push(`Canal borrado: «${name}»`);
  for (const [from, to] of diff.channels.renamed) lines.push(`Canal «${from}» → «${to}»`);
  for (const move of diff.channels.rerouted) {
    lines.push(`«${move.name}» pasa de la pista ${move.from} a la ${move.to}`);
  }

  for (const name of diff.patterns.added) lines.push(`Patrón nuevo: «${name}»`);
  for (const name of diff.patterns.removed) lines.push(`Patrón borrado: «${name}»`);
  for (const [from, to] of diff.patterns.renamed) lines.push(`Patrón «${from}» → «${to}»`);
  for (const change of diff.patterns.resized) {
    lines.push(`«${change.name}»: ${change.from} → ${change.to} beats`);
  }

  for (const note of diff.notes) {
    const parts: string[] = [];
    if (note.added > 0) parts.push(`+${plural(note.added, 'nota', 'notas')}`);
    if (note.removed > 0) parts.push(`-${plural(note.removed, 'nota', 'notas')}`);
    if (note.moved > 0) parts.push(`${plural(note.moved, 'movida', 'movidas')}`);
    if (note.retuned > 0) parts.push(`${plural(note.retuned, 'afinada', 'afinadas')}`);
    if (note.revoiced > 0) parts.push(`${plural(note.revoiced, 'con otra fuerza', 'con otra fuerza')}`);
    lines.push(`«${note.patternName}» · ${note.channelName}: ${parts.join(', ')}`);
  }

  if (diff.clips.added > 0) lines.push(`+${plural(diff.clips.added, 'clip', 'clips')} en la playlist`);
  if (diff.clips.removed > 0) {
    lines.push(`-${plural(diff.clips.removed, 'clip', 'clips')} en la playlist`);
  }
  if (diff.clips.moved > 0) lines.push(`${plural(diff.clips.moved, 'clip movido', 'clips movidos')}`);

  for (const track of diff.mixer) {
    const parts: string[] = [];
    if (track.volumeDb) parts.push(`fader ${db(track.volumeDb[0])} → ${db(track.volumeDb[1])}`);
    if (track.pan) parts.push(`pan ${track.pan[0].toFixed(2)} → ${track.pan[1].toFixed(2)}`);
    for (const kind of track.effectsAdded) parts.push(`efecto nuevo: ${kind}`);
    for (const kind of track.effectsRemoved) parts.push(`efecto fuera: ${kind}`);
    lines.push(`${track.name}: ${parts.join(', ')}`);
  }

  for (const name of diff.samples.added) lines.push(`Sonido nuevo en el proyecto: «${name}»`);
  for (const name of diff.samples.removed) lines.push(`Sonido fuera del proyecto: «${name}»`);

  return lines;
}

/** Una línea de resumen para la lista de versiones. */
export function summarizeDiff(diff: ProjectDiff): string {
  if (isEmptyDiff(diff)) return 'Sin cambios';
  const bits: string[] = [];
  const notesAdded = diff.notes.reduce((n, d) => n + d.added, 0);
  const notesRemoved = diff.notes.reduce((n, d) => n + d.removed, 0);
  const notesTouched = diff.notes.reduce((n, d) => n + d.moved + d.retuned + d.revoiced, 0);
  if (notesAdded > 0) bits.push(`+${notesAdded} notas`);
  if (notesRemoved > 0) bits.push(`-${notesRemoved} notas`);
  if (notesTouched > 0) bits.push(`${notesTouched} tocadas`);
  const channels = diff.channels.added.length + diff.channels.removed.length;
  if (channels > 0) bits.push(plural(channels, 'canal', 'canales'));
  const patterns = diff.patterns.added.length + diff.patterns.removed.length;
  if (patterns > 0) bits.push(plural(patterns, 'patrón', 'patrones'));
  const clips = diff.clips.added + diff.clips.removed + diff.clips.moved;
  if (clips > 0) bits.push(plural(clips, 'clip', 'clips'));
  if (diff.mixer.length > 0) bits.push('mezcla');
  if (diff.tempo) bits.push('tempo');
  return bits.length > 0 ? bits.join(' · ') : 'Cambios menores';
}
