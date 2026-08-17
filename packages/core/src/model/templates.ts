/**
 * Plantillas de proyecto: abrir Orbit y estar ya dentro del género, en vez de
 * empezar con un rack vacío y montar la base otra vez.
 *
 * Cada plantilla deja canales con su sonido, un patrón con el groove básico,
 * las pistas de playlist nombradas y el mixer enrutado (con limitador en el
 * master, que es lo primero que uno pone). Son proyectos normales: todo lo que
 * traen se edita o se borra como cualquier otra cosa.
 */

import { newId } from '../ids';
import { createChannel, createEmptyProject, createPlaylistTrack } from './defaults';
import { findNovaPreset } from './nova';
import { defaultEffectParams } from './params';
import type { Channel, EffectKind, InstrumentKind, Note, Project } from './types';

export interface ProjectTemplate {
  id: string;
  name: string;
  /** Una línea de qué te encuentras al abrirla. */
  description: string;
  tempo: number;
  build: (project: Project) => void;
}

/** Nota de patrón (1/16 por defecto, que es el paso del rack). */
function n(start: number, key: number, velocity = 0.85, duration = 0.25): Note {
  return { id: newId(), start, duration, key, velocity, pan: 0, slide: false };
}

/** Piezas del kit de drums por altura MIDI (ver DRUM_MAP). */
const KICK = 36;
const SNARE = 38;
const CLAP = 39;
const HAT = 42;
const OPENHAT = 46;
const RIM = 37;

interface ChannelSpec {
  kind: InstrumentKind;
  name: string;
  mixerTrack: number;
  params?: Record<string, number>;
  novaPreset?: string;
  volume?: number;
  notes?: Note[];
}

/** Crea canales con sus notas en el patrón activo del proyecto. */
function addChannels(project: Project, specs: ChannelSpec[]): Channel[] {
  const patternId = project.patternOrder[0]!;
  const pattern = project.patterns[patternId]!;
  return specs.map((spec, i) => {
    const channel = createChannel(spec.kind, i, spec.name);
    channel.mixerTrack = spec.mixerTrack;
    if (spec.params) Object.assign(channel.params, spec.params);
    if (spec.novaPreset) {
      channel.novaPreset = spec.novaPreset;
      const preset = findNovaPreset(spec.novaPreset);
      if (preset) {
        channel.params['macro1'] = preset.macros[0].value;
        channel.params['macro2'] = preset.macros[1].value;
      }
    }
    if (spec.volume !== undefined) channel.volume = spec.volume;
    project.channels[channel.id] = channel;
    project.channelOrder.push(channel.id);
    if (spec.notes && spec.notes.length > 0) pattern.notes[channel.id] = spec.notes;
    return channel;
  });
}

/** Inserta un efecto en el primer slot libre de una pista de mixer. */
function insertEffect(
  project: Project,
  trackIndex: number,
  kind: EffectKind,
  params: Record<string, number> = {},
): void {
  const track = project.mixer[trackIndex];
  if (!track) return;
  const slotIndex = track.slots.findIndex((s) => s === null);
  if (slotIndex < 0) return;
  track.slots[slotIndex] = {
    id: newId(),
    kind,
    enabled: true,
    mix: 1,
    params: { ...defaultEffectParams(kind), ...params },
  };
}

/** Renombra las primeras pistas de playlist y añade las que falten. */
function namePlaylistTracks(project: Project, names: string[]): void {
  const tracks = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === project.activeArrangementId)
    .sort((a, b) => a.order - b.order);
  names.forEach((name, i) => {
    const track = tracks[i];
    if (track) {
      track.name = name;
      return;
    }
    const extra = createPlaylistTrack(project.activeArrangementId, tracks.length + i, name);
    project.playlistTracks[extra.id] = extra;
  });
}

/** Nombra pistas del mixer (para que la cadena se lea sola). */
function nameMixerTracks(project: Project, names: Record<number, string>): void {
  for (const [index, name] of Object.entries(names)) {
    const track = project.mixer[Number(index)];
    if (track) track.name = name;
  }
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'trap',
    name: 'Trap',
    description: '808 con glide, hats a 1/16 con roll y Nova para la melodía.',
    tempo: 140,
    build: (project) => {
      addChannels(project, [
        {
          kind: 'sub808',
          name: '808',
          mixerTrack: 1,
          params: { decay: 2.4, drive: 0.5, glide: 0.06, punch: 0.55 },
          notes: [
            { ...n(0, 29, 0.95, 1.5) },
            { ...n(1.5, 32, 0.9, 0.5), slide: true },
            { ...n(2, 27, 0.95, 2) },
          ],
        },
        {
          kind: 'drums',
          name: 'Drums',
          mixerTrack: 2,
          params: { kit: 0, punch: 0.6 },
          notes: [
            n(0, KICK), n(1.5, KICK), n(2.5, KICK),
            n(1, CLAP), n(3, CLAP),
            // Hats a 1/16 con el final acentuado (el empujón del trap). Se
            // quedan EN la rejilla a propósito: un roll de 1/32 marcaría el
            // canal como melódico y la batería dejaría de editarse por pasos.
            ...Array.from({ length: 16 }, (_, i) =>
              n(i * 0.25, HAT, i >= 13 ? 0.45 + (i - 12) * 0.08 : 0.45),
            ),
          ],
        },
        {
          kind: 'nova',
          name: 'Campana',
          mixerTrack: 3,
          novaPreset: 'bells/campana-fm',
          volume: 0.62,
          notes: [n(0, 72, 0.8, 1), n(1, 75, 0.7, 1), n(2, 79, 0.8, 1), n(3, 75, 0.7, 1)],
        },
      ]);
      nameMixerTracks(project, { 1: '808', 2: 'Drums', 3: 'Melodía' });
      namePlaylistTracks(project, ['808', 'Drums', 'Melodía', 'Voz']);
      insertEffect(project, 3, 'reverb', { size: 0.5, damp: 0.5 });
      insertEffect(project, 0, 'limiter', { gain: 2, ceiling: -0.5 });
    },
  },
  {
    id: 'boombap',
    name: 'Boom bap',
    description: 'Batería seca, Rhodes cálido y bajo redondo para rapear encima.',
    tempo: 88,
    build: (project) => {
      addChannels(project, [
        {
          kind: 'drums',
          name: 'Drums',
          mixerTrack: 1,
          params: { kit: 1, tone: 0.45, punch: 0.55 },
          notes: [
            n(0, KICK, 0.95), n(0.75, KICK, 0.8), n(2.5, KICK, 0.9),
            n(1, SNARE, 0.9), n(3, SNARE, 0.9),
            ...Array.from({ length: 8 }, (_, i) => n(i * 0.5, HAT, 0.4)),
            n(3.5, OPENHAT, 0.5),
          ],
        },
        {
          kind: 'nova',
          name: 'Rhodes',
          mixerTrack: 2,
          novaPreset: 'keys/rhodes-calido',
          volume: 0.7,
          notes: [n(0, 60, 0.8, 2), n(0, 63, 0.75, 2), n(0, 67, 0.7, 2), n(2, 58, 0.8, 2), n(2, 62, 0.75, 2), n(2, 65, 0.7, 2)],
        },
        {
          kind: 'nova',
          name: 'Bajo',
          mixerTrack: 3,
          novaPreset: 'bass/pluck-bajo',
          volume: 0.8,
          notes: [n(0, 36, 0.9, 0.75), n(1.5, 36, 0.8, 0.5), n(2, 34, 0.9, 0.75), n(3.5, 41, 0.8, 0.5)],
        },
      ]);
      nameMixerTracks(project, { 1: 'Drums', 2: 'Rhodes', 3: 'Bajo' });
      namePlaylistTracks(project, ['Drums', 'Rhodes', 'Bajo', 'Voz']);
      insertEffect(project, 2, 'eq', { hpFreq: 60, highGain: -4, lpFreq: 9000 });
      insertEffect(project, 0, 'limiter', { gain: 1.5, ceiling: -0.5 });
    },
  },
  {
    id: 'reggaeton',
    name: 'Reggaetón',
    description: 'Dembow, órgano de perreo y sub, listo para el flow.',
    tempo: 94,
    build: (project) => {
      addChannels(project, [
        {
          kind: 'drums',
          name: 'Dembow',
          mixerTrack: 1,
          params: { kit: 2, punch: 0.6 },
          notes: [
            // Dembow clásico: kick en cada negra, caja a contratiempo.
            n(0, KICK, 0.95), n(1, KICK, 0.9), n(2, KICK, 0.95), n(3, KICK, 0.9),
            n(0.75, SNARE, 0.85), n(1.5, SNARE, 0.8), n(2.75, SNARE, 0.85), n(3.5, SNARE, 0.8),
            ...Array.from({ length: 8 }, (_, i) => n(i * 0.5, RIM, 0.35)),
          ],
        },
        {
          kind: 'sub808',
          name: 'Sub',
          mixerTrack: 2,
          params: { decay: 1.1, drive: 0.3, punch: 0.5 },
          notes: [n(0, 33, 0.9, 1), n(1, 33, 0.85, 0.5), n(2, 31, 0.9, 1), n(3, 36, 0.85, 0.5)],
        },
        {
          kind: 'nova',
          name: 'Órgano',
          mixerTrack: 3,
          novaPreset: 'organs/organo-perreo',
          volume: 0.66,
          notes: [n(0.5, 64, 0.8, 0.5), n(1.5, 67, 0.75, 0.5), n(2.5, 62, 0.8, 0.5), n(3.5, 64, 0.75, 0.5)],
        },
      ]);
      nameMixerTracks(project, { 1: 'Dembow', 2: 'Sub', 3: 'Órgano' });
      namePlaylistTracks(project, ['Dembow', 'Sub', 'Órgano', 'Voz']);
      insertEffect(project, 3, 'delay', { time: 3, feedback: 0.3 });
      insertEffect(project, 0, 'limiter', { gain: 2, ceiling: -0.5 });
    },
  },
  {
    id: 'voz-sobre-beat',
    name: 'Voz sobre beat',
    description: 'Pista para el beat, pista para tus tomas y la cadena vocal montada.',
    tempo: 90,
    build: (project) => {
      namePlaylistTracks(project, ['Beat', 'Voz principal', 'Dobles', 'Ad-libs']);
      nameMixerTracks(project, { 1: 'Beat', 2: 'Voz', 3: 'Dobles', 4: 'Reverb voz' });
      // La cadena vocal de Orbit, ya puesta en la pista de voz.
      insertEffect(project, 2, 'eq', { hpFreq: 90, lowGain: -2.5, midGain: 1.5, highGain: 2.5 });
      insertEffect(project, 2, 'compressor', { threshold: -18, ratio: 4, attack: 0.004, release: 0.12, makeup: 3 });
      insertEffect(project, 2, 'distortion', { drive: 0.15, tone: 6000, output: 1 });
      insertEffect(project, 2, 'delay', { time: 5, feedback: 0.25, filter: 3000 });
      // Reverb en pista aparte para mandarla por send y no ahogar la voz.
      insertEffect(project, 4, 'reverb', { size: 0.55, damp: 0.5, predelay: 0.03 });
      const voz = project.mixer[2];
      if (voz) voz.sends.push({ target: 4, level: 0.35 });
      insertEffect(project, 0, 'limiter', { gain: 1, ceiling: -1 });
    },
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === id);
}

/** Proyecto nuevo a partir de una plantilla (o vacío si el id no existe). */
export function createProjectFromTemplate(id: string): Project {
  const template = findTemplate(id);
  const project = createEmptyProject(template ? template.name : 'Nuevo proyecto');
  if (!template) return project;
  project.tempo = template.tempo;
  const pattern = project.patterns[project.patternOrder[0]!];
  if (pattern) pattern.name = template.name;
  template.build(project);
  return project;
}
