/**
 * Del `BeatPlan` al proyecto: los comandos del bus que lo montan.
 *
 * Regla 1 del repo: nada toca el store directo. Todo lo que hace el
 * compositor sale de aquí como una lista de `Command` que quien llama
 * despacha en UN `batch` — así el beat entero se deshace con un Ctrl+Z, llega
 * igual a la colaboración y el MCP lo hace por el mismo camino que la UI.
 *
 * Cada parte del beat acaba por separado, que es lo que se pidió: su canal
 * (con su sonido y sus insertos), su pista de mixer si queda una libre, sus
 * patrones (uno por tipo de sección) y su pista de playlist con un clip por
 * sección. Nada se mezcla en un audio.
 */

import {
  createChannel,
  createKeymapZone,
  normalizeKeymap,
  spreadKeymapRanges,
  createPattern,
  createPlaylistTrack,
  defaultEffectParams,
  findNovaPreset,
  findPrismaPreset,
  newId,
  prismaPresetParams,
  type ArrangementSection,
  type Channel,
  type Clip,
  type Command,
  type EffectSlot,
  type Note,
  type Project,
  type SampleRef,
} from '@orbit/core';
import { BEATS_PER_BAR, type BeatPlan, type PlanNote, type PlanPart } from './compose';
import type { ComposerRole, FxChoice } from './genres';
import { factorySound } from './factory-index';

export interface ApplyPlanOptions {
  /**
   * Compás donde empieza el beat. Por defecto, justo detrás de lo que ya haya
   * en la playlist (componer no pisa nada de lo existente).
   */
  startBar?: number;
  /** Si se cambian tempo y swing del proyecto al del plan (por defecto sí). */
  setTransport?: boolean;
  /** Si se añaden las secciones del arreglo (por defecto sí). */
  addSections?: boolean;
  /** Si se monta la cadena del master cuando no tiene limitador (por defecto sí). */
  masterChain?: boolean;
}

/** Lo que quedó montado: para contarlo y para recomponer una parte después. */
export interface AppliedBeat {
  startBar: number;
  parts: {
    role: ComposerRole;
    channelId: string;
    playlistTrackId: string;
    mixerTrack: number;
    /** Patrón del proyecto por clave de patrón del plan. */
    patterns: Record<string, string>;
  }[];
}

export interface PlanCommands {
  commands: Command[];
  applied: AppliedBeat;
  /**
   * Samples de fábrica que el beat registra en el proyecto y que el motor
   * todavía no tiene: quien despacha los comandos tiene que subirle sus bytes
   * (`engine.loadSample`), igual que el browser al cargar un sonido.
   */
  samples: SampleRef[];
}

/** El SampleRef de un sonido de fábrica, con el mismo id y ruta que usa el browser. */
export function factorySampleRef(id: string): SampleRef | null {
  const sound = factorySound(id);
  if (!sound) return null;
  // Sin bytes a mano no hay sha1: el id hace de identidad, que es el mismo
  // respaldo que usa el browser cuando no puede calcularlo.
  return { id: sound.id, name: sound.name, path: `factory:${sound.file}`, hash: sound.id, duration: sound.durationSec };
}

/**
 * Comandos para registrar los samples de una parte que el proyecto aún no
 * conoce (y que no se hayan registrado ya en este mismo lote).
 */
function registerSamples(project: Project, ids: Iterable<string>, seen: Set<string>, out: SampleRef[]): Command[] {
  const commands: Command[] = [];
  for (const id of ids) {
    if (seen.has(id) || Object.hasOwn(project.samples, id)) continue;
    seen.add(id);
    const ref = factorySampleRef(id);
    if (!ref) continue;
    commands.push({ type: 'registerSample', sample: ref });
    out.push(ref);
  }
  return commands;
}

const round = (x: number): number => Math.round(x * 10000) / 10000;

function toNote(n: PlanNote): Note {
  return {
    id: newId(),
    start: round(n.start),
    duration: round(Math.max(0.01, n.duration)),
    key: Math.max(0, Math.min(127, Math.round(n.key))),
    velocity: Math.max(0, Math.min(1, n.velocity)),
    pan: 0,
    slide: n.slide === true,
  };
}

function effectSlot(fx: FxChoice, sidechainSource?: number): EffectSlot {
  const slot: EffectSlot = {
    id: newId(),
    kind: fx.kind,
    enabled: true,
    mix: 1,
    params: { ...defaultEffectParams(fx.kind), ...fx.params },
  };
  if (sidechainSource !== undefined) slot.sidechainSource = sidechainSource;
  return slot;
}

/** Compás donde acaba lo que ya hay en la playlist activa (0 si está vacía). */
export function contentEndBar(project: Project): number {
  const tracks = new Set(
    Object.values(project.playlistTracks)
      .filter((t) => t.arrangementId === project.activeArrangementId)
      .map((t) => t.id),
  );
  let end = 0;
  for (const c of Object.values(project.clips)) {
    if (tracks.has(c.playlistTrackId)) end = Math.max(end, c.start + c.length);
  }
  const bpb = project.timeSig?.num ?? BEATS_PER_BAR;
  return Math.ceil(end / bpb - 1e-9);
}

/** Los samples de fábrica que pide el sonido de una parte (batería o instrumento). */
function soundSampleIds(part: PlanPart): string[] {
  return [
    ...Object.values(part.sound.samples ?? {}),
    ...(part.sound.layers ?? []).map((l) => l.sampleId),
    ...(part.sound.zones ?? []).map((z) => z.sampleId),
  ];
}

/** Pista de mixer de cada parte ya montada (para resolver los sidechain). */
type MixerOf = (role: PlanPart['role']) => number | undefined;

function channelFor(part: PlanPart, index: number, mixerOf: MixerOf = () => undefined): Channel {
  const channel = createChannel(part.sound.kind, index, part.name);
  const { preset } = part.sound;
  if (part.sound.kind === 'sampler' && part.sound.samples) {
    // Una zona por tecla, con su raíz en esa misma tecla: cada pieza suena a
    // su altura original. `sampleId` va también (el primero), como en el
    // browser: quitar el keymap no deja el canal mudo.
    const entries = Object.entries(part.sound.samples).map(([k, id]) => [Number(k), id] as const);
    const tune = (key: number) => part.sound.tunes?.[key] ?? 0;
    channel.keymap = [
      ...entries.map(([key, id]) => createKeymapZone(id, { keyLow: key, keyHigh: key, keyRoot: key, tune: tune(key) })),
      // Las capas comparten tecla (el keymap dispara todas las zonas que cubren la nota).
      ...(part.sound.layers ?? []).map((l) => createKeymapZone(l.sampleId, { keyLow: l.key, keyHigh: l.key, keyRoot: l.key })),
    ];
    if (entries[0]) channel.sampleId = entries[0][1];
  } else if (part.sound.kind === 'sampler' && part.sound.zones && part.sound.zones.length > 0) {
    // Instrumento multisampleado: el mismo reparto que hace el browser al
    // soltarlo (raíces distintas se parten el teclado; las capas de una misma
    // raíz se separan por fuerza).
    const zones = part.sound.zones.map((z) => createKeymapZone(z.sampleId, { keyRoot: z.keyRoot, velLow: z.velLow, velHigh: z.velHigh }));
    channel.keymap = normalizeKeymap(spreadKeymapRanges(zones));
    channel.sampleId = part.sound.zones[0]!.sampleId;
  }
  if (part.sound.kind === 'prisma' && preset) {
    const p = findPrismaPreset(preset);
    if (p) {
      channel.prismaPreset = preset;
      channel.params = prismaPresetParams(p);
    }
  } else if (part.sound.kind === 'nova' && preset) {
    const p = findNovaPreset(preset);
    if (p) {
      channel.novaPreset = preset;
      channel.params['macro1'] = p.macros[0].value;
      channel.params['macro2'] = p.macros[1].value;
    }
  }
  for (const [k, v] of Object.entries(part.sound.params)) {
    if (Number.isFinite(v)) channel.params[k] = v;
  }
  channel.volume = part.sound.volume;
  // Los insertos de la parte van en el propio canal: siempre hay sitio (cuatro
  // ranuras) y viajan con él si se copia a otro proyecto.
  part.fx.slice(0, channel.fx?.length ?? 4).forEach((fx, i) => {
    // Un sidechain solo vale si la parte que lo alimenta tiene su propio
    // inserto: escuchar el master (0) agacharía el bajo con todo el beat.
    const source = fx.sidechainFrom ? mixerOf(fx.sidechainFrom) : undefined;
    if (channel.fx) channel.fx[i] = effectSlot(fx, source !== undefined && source > 0 ? source : undefined);
  });
  return channel;
}

/** Inserts del mixer sin usar: ni canal enrutado, ni efectos, ni nombre propio. */
function freeMixerTracks(project: Project): number[] {
  const used = new Set(Object.values(project.channels).map((c) => c.mixerTrack));
  const free: number[] = [];
  project.mixer.forEach((t, i) => {
    if (i === 0 || used.has(i)) return;
    if (t.slots.some((s) => s !== null)) return;
    if (!/^Insert \d+$/.test(t.name)) return;
    free.push(i);
  });
  return free;
}

/**
 * Monta un plan en el proyecto. No muta `project`: solo lo lee para elegir
 * ids libres, pistas vacías y el compás de arranque.
 */
export function planToCommands(project: Project, plan: BeatPlan, opts: ApplyPlanOptions = {}): PlanCommands {
  const bpb = project.timeSig?.num ?? BEATS_PER_BAR;
  const startBar = Math.max(0, Math.floor(opts.startBar ?? contentEndBar(project)));
  const startBeat = startBar * bpb;
  const commands: Command[] = [];

  if (opts.setTransport !== false) {
    commands.push({ type: 'setTempo', tempo: plan.bpm });
    commands.push({ type: 'setSwing', swing: plan.swing });
  }

  // Pistas de playlist vacías del arrangement activo, en orden: se reutilizan
  // antes de crear nuevas (el proyecto vacío trae ocho «Pista N»).
  const arrangementId = project.activeArrangementId;
  const tracks = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === arrangementId)
    .sort((a, b) => a.order - b.order);
  const busy = new Set(Object.values(project.clips).map((c) => c.playlistTrackId));
  const emptyTracks = tracks.filter((t) => !busy.has(t.id) && /^Pista \d+$/.test(t.name));
  let nextOrder = tracks.reduce((m, t) => Math.max(m, t.order), -1) + 1;

  const freeMixer = freeMixerTracks(project);
  const channelBase = project.channelOrder.length;
  const patternBase = project.patternOrder.length;
  const applied: AppliedBeat = { startBar, parts: [] };
  const clips: Clip[] = [];
  const samples: SampleRef[] = [];
  const seenSamples = new Set<string>();
  let patternIndex = 0;

  const mixerByRole = new Map<PlanPart['role'], number>();
  plan.parts.forEach((part, i) => {
    const ids = soundSampleIds(part);
    if (ids.length > 0) commands.push(...registerSamples(project, ids, seenSamples, samples));
    const channel = channelFor(part, channelBase + i, (role) => mixerByRole.get(role));
    const mixerTrack = freeMixer.shift() ?? 0;
    mixerByRole.set(part.role, mixerTrack);
    channel.mixerTrack = mixerTrack;
    commands.push({ type: 'addChannel', channel });
    if (mixerTrack > 0) {
      commands.push({ type: 'patchMixerTrack', trackIndex: mixerTrack, patch: { name: part.name, color: channel.color } });
    }

    let trackId: string;
    const reuse = emptyTracks.shift();
    if (reuse) {
      trackId = reuse.id;
      commands.push({
        type: 'patchPlaylistTrack',
        trackId,
        patch: { name: part.name, color: channel.color, mixerTrack },
      });
    } else {
      const track = createPlaylistTrack(arrangementId, nextOrder++, part.name);
      track.color = channel.color;
      track.mixerTrack = mixerTrack;
      trackId = track.id;
      commands.push({ type: 'addPlaylistTrack', track });
    }

    const patternIds: Record<string, string> = {};
    for (const p of part.patterns) {
      const pattern = createPattern(patternBase + patternIndex++, p.name);
      pattern.length = p.bars * bpb;
      pattern.color = channel.color;
      patternIds[p.id] = pattern.id;
      commands.push({ type: 'addPattern', pattern });
      commands.push({ type: 'addNotes', patternId: pattern.id, channelId: channel.id, notes: p.notes.map(toNote) });
    }
    for (const c of part.clips) {
      const patternId = patternIds[c.patternId];
      if (!patternId) continue;
      clips.push({
        id: newId(),
        kind: 'pattern',
        playlistTrackId: trackId,
        start: startBeat + c.startBar * bpb,
        length: c.bars * bpb,
        muted: false,
        patternId,
        color: channel.color,
      });
    }
    applied.parts.push({ role: part.role, channelId: channel.id, playlistTrackId: trackId, mixerTrack, patterns: patternIds });
  });

  if (clips.length > 0) commands.push({ type: 'addClips', clips });

  if (opts.addSections !== false && plan.sections.length > 1) {
    const sections: ArrangementSection[] = plan.sections.map((s) => ({
      id: newId(),
      arrangementId,
      name: s.name,
      start: startBeat + s.startBar * bpb,
      length: s.bars * bpb,
      // El modelo conoce las secciones de club; el hook es el pico (como un
      // drop) y el verso no tiene equivalente: va sin tipo, con su nombre.
      ...(s.kind === 'verse' ? null : { kind: s.kind === 'hook' ? ('drop' as const) : s.kind }),
    }));
    commands.push({ type: 'addSections', sections });
  }

  // Cadena del master: solo si aún no tiene limitador (no se apila otro encima
  // del que el usuario ya puso).
  const master = project.mixer[0];
  if (opts.masterChain !== false && master && !master.slots.some((s) => s?.kind === 'limiter')) {
    const free = master.slots.map((s, i) => (s === null ? i : -1)).filter((i) => i >= 0);
    plan.master.forEach((fx, i) => {
      const slotIndex = free[i];
      if (slotIndex !== undefined) commands.push({ type: 'setEffect', trackIndex: 0, slotIndex, slot: effectSlot(fx) });
    });
  }

  return { commands, applied, samples };
}

/**
 * Sustituye las notas de una parte ya montada por las de una parte nueva
 * (misma forma). Si la parte nueva trae otro sonido, también se cambia.
 */
export function replacePartCommands(
  project: Project,
  applied: AppliedBeat['parts'][number],
  part: PlanPart,
  opts: { sound?: boolean } = {},
): Command[] {
  const commands: Command[] = [];
  const bpb = project.timeSig?.num ?? BEATS_PER_BAR;
  for (const p of part.patterns) {
    const patternId = applied.patterns[p.id];
    const pattern = patternId ? project.patterns[patternId] : undefined;
    if (!pattern || !patternId) continue;
    const existing = pattern.notes[applied.channelId] ?? [];
    if (existing.length > 0) {
      commands.push({ type: 'removeNotes', patternId, channelId: applied.channelId, noteIds: existing.map((n) => n.id) });
    }
    commands.push({ type: 'addNotes', patternId, channelId: applied.channelId, notes: p.notes.map(toNote) });
    if (pattern.length !== p.bars * bpb) {
      commands.push({ type: 'patchPattern', patternId, patch: { length: p.bars * bpb } });
    }
  }
  if (opts.sound) {
    const channel = project.channels[applied.channelId];
    if (channel) {
      const fresh = channelFor(part, 0);
      const patch: Partial<Channel> = { params: fresh.params, volume: fresh.volume };
      if (fresh.kind === channel.kind) {
        if (fresh.prismaPreset) patch.prismaPreset = fresh.prismaPreset;
        if (fresh.novaPreset) patch.novaPreset = fresh.novaPreset;
        if (fresh.keymap && soundSampleIds(part).length > 0) {
          commands.unshift(...registerSamples(project, soundSampleIds(part), new Set(), []));
          patch.keymap = fresh.keymap;
          if (fresh.sampleId) patch.sampleId = fresh.sampleId;
        }
        commands.push({ type: 'patchChannel', channelId: applied.channelId, patch });
      }
    }
  }
  return commands;
}
