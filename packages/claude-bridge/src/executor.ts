/**
 * ToolExecutor: ejecuta las tools MCP contra un ProjectStore real.
 *
 * Corre en el RENDERER (browser-safe: sin Node APIs). Toda mutación pasa por
 * `store.dispatch` con origin 'claude' y etiqueta descriptiva — así cada tool
 * call es UN paso de undo, se ve al instante en la UI y queda en el historial
 * marcada como de Claude.
 *
 * render/analyze_mix usan el motor puro de @orbit/engine (compileProject +
 * renderProject + analyzeMix + encodeWav); para guardar el WAV se inyecta un
 * `saveFile` (el renderer lo cablea con IPC file:save-dialog + file:write).
 */

import {
  EFFECT_PARAMS,
  INSTRUMENT_PARAMS,
  MIXER_SLOTS,
  SCALES,
  arpeggiate,
  chop,
  chordify,
  humanize,
  riff,
  strum,
  type ArpMode,
  type ArrangementSection,
  type RiffCharacter,
  autoMapKeymap,
  createChannel,
  createKeymapZone,
  createPattern,
  dbToGain,

  findParamSpec,
  gainToDb,
  midiToNote,
  newId,
  normalizeKeymap,
  noteToMidi,
  spreadKeymapRanges,
  spreadKeymapVelocities,
  trackOfChannel,
  type AutomationPoint,

  type Channel,
  type Clip,
  type Command,
  type EffectKind,
  type EffectSlot,
  type InstrumentKind,
  type MixerTrack,
  type Note,
  type ParamRef,
  type ParamSpec,
  type Pattern,
  type PlaylistTrack,
  type Project,
  type ProjectStore,
  type SampleRef,
} from '@orbit/core';

import {
  analyzeMix,
  compileProject,
  encodeWav,
  neededSampleIds,
  neededPluginIds,
  renderProject,
  type CompiledProject,
  type MixAnalysis,
  type PlayMode,
  type SampleData,
} from '@orbit/engine';
import {
  MAX_PACK_SOUNDS,
  PACK_FAMILIES,
  PACK_STYLES,
  isPackFamily,
  isPackKey,
  isPackStyle,
  packKeys,
  type PackRequest,
} from '@orbit/sound-library';
import {
  STREAMING_LUFS,
  adviseMix,
  formatAdvice,
  guessGenre,
  type MixAdvice,
  type MixContext,
  type MixGenre,
  type TrackSlots,
} from './mix-advisor';
import {
  ToolError,
  asObject,
  reqString,
  optString,
  MAX_NOTES_PER_CALL,
  MAX_STEPS_LEN,
  MAX_POINTS,
  MAX_BEATS,
  reqArray,
  reqNumber,
  boundedNumber,
  optBoundedNumber,
  optNumber,
  optBoolean,
  clamp,
  f,
} from './args';
import { ComposerTools, parseKeyRoot, parseScale, type ComposerHost } from './composer-tools';

/** Guarda `data` con nombre sugerido y devuelve la ruta final. */
export type SaveFileFn = (suggestedName: string, data: Uint8Array) => Promise<string>;

/** El host resuelve bytes/plugins; el bridge no importa UI ni APIs del sistema. */
export interface RenderInputs {
  samples: Map<string, SampleData>;
  plugins: Map<string, string>;
}
export type ResolveRenderInputsFn = (project: Project, compiled: CompiledProject) => Promise<RenderInputs>;

/** Resumen de un pack recién generado (lo que el modelo necesita saber). */
export interface GeneratedPackInfo {
  slug: string;
  name: string;
  /** Sonidos escritos. */
  count: number;
  /** Carpeta donde han quedado. */
  dir: string;
  /** Duración total en segundos. */
  seconds: number;
  /** Canales sampler creados (0 si no se pidieron). */
  added: number;
}

/**
 * Genera un pack de sonidos. La inyecta el renderer (el executor no toca ni el
 * disco ni el browser), igual que `saveFile` con los WAV del render. Con
 * `addChannels`, los canales tienen que entrar con el `origin` de estas
 * opciones (el origen del historial) y en un solo paso de undo.
 */
export type GeneratePackFn = (
  request: PackRequest,
  opts: { addChannels: boolean; origin?: string; label?: string },
) => Promise<GeneratedPackInfo>;

/** Un sonido de la librería tal como lo ve el browser (fábrica o pack generado). */
export interface LibrarySound {
  /** Id del manifest, ya prefijado con su pack. Lo acepta `load_sample`. */
  id: string;
  name: string;
  /** Nombre del pack al que pertenece. */
  pack: string;
  category: string;
  subcategory?: string;
  tags: string[];
  durationSec: number;
  /** Solo en loops. */
  bpm?: number;
  /** Solo en 808s y loops. */
  keyRoot?: string;
}

/**
 * Cómo quiere el executor que el renderer despache lo que cargue.
 *
 * `origin` es lo que hace la tool deshacible por Claude y no por el usuario
 * (`undo('claude')`), y `mixerTrack` va aquí para que el ruteo salga en el
 * MISMO dispatch que los canales: la tool promete "UN solo paso de undo" y con
 * dos dispatches eran dos entradas (y la del ruteo no era ni de Claude).
 */
export interface LibraryLoadOptions {
  /** Pista de mixer a la que enrutar los canales creados, en el mismo paso. */
  mixerTrack?: number;
  /** Origen del historial para los canales creados ('claude' desde el puente). */
  origin?: string;
  /** Etiqueta legible del paso de historial. */
  label?: string;
}

/**
 * Acceso a la librería de sonidos. La inyecta el renderer por la misma razón
 * que `saveFile` y `generatePack`: el executor no lee el disco ni conoce el
 * browser, y montar un sampler es subir el WAV al motor además de despachar el
 * comando.
 */
export interface LibraryFn {
  /** Todo lo que hay en el browser: pack de fábrica + packs generados. */
  list(): Promise<LibrarySound[]>;
  /**
   * Un canal sampler por sonido, en un solo paso de undo. Devuelve los creados.
   * `opts.origin` y `opts.label` son del historial y `opts.mixerTrack` tiene que
   * aplicarse a los canales DENTRO del mismo dispatch.
   */
  load(
    ids: readonly string[],
    opts?: LibraryLoadOptions,
  ): Promise<{ id: string; name: string }[]>;
}

// Del registro de core, igual que los efectos: si core gana un instrumento
// (nova, vox, slicer…) la tool lo acepta sola y no se queda corta respecto al
// enum que anuncia su propio esquema. El pseudo-efecto `plugin` queda fuera de
// entrada: su slot necesita un `pluginId` del registro de plugins de la UI y
// aceptarlo sin él creaba un slot muerto e irreparable (el kernel lo salta en
// silencio). Para insertar un plugin está la UI, que sí tiene el registro.
const INSTRUMENT_KINDS = Object.keys(INSTRUMENT_PARAMS) as InstrumentKind[];
const EFFECT_KINDS: EffectKind[] = (Object.keys(EFFECT_PARAMS) as EffectKind[]).filter(
  (k) => k !== 'plugin',
);

// ── Helpers de validación de argumentos ──────────────────────────────────────

function validateParams(
  raw: unknown,
  specs: ParamSpec[],
  what: string,
): Record<string, number> {
  const o = asObject(raw);
  const out: Record<string, number> = {};
  const valid = specs.map((s) => s.key);
  for (const [key, value] of Object.entries(o)) {
    const spec = findParamSpec(specs, key);
    if (!spec) {
      throw new ToolError(
        `Parámetro desconocido "${key}" para ${what}. Válidos: ${valid.join(', ') || '(ninguno)'}`,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ToolError(`El parámetro "${key}" debe ser número`);
    }
    out[key] = clamp(value, spec.min, spec.max);
  }
  return out;
}

// ── Executor ─────────────────────────────────────────────────────────────────

export class ToolExecutor {
  constructor(
    private readonly store: ProjectStore,
    private readonly saveFile?: SaveFileFn,
    /** Petición pendiente del usuario (panel de Claude); consumirla la borra. */
    private readonly takeUserRequest?: () => string | null,
    /** Generador de packs de sonidos (lo cablea el renderer). */
    private readonly generatePack?: GeneratePackFn,
    /** Librería de sonidos del browser (lo cablea el renderer). */
    private readonly library?: LibraryFn,
    /** Mismas entradas del render/export de la aplicación. */
    private readonly resolveRenderInputs?: ResolveRenderInputsFn,
    /** Audio y perfiles de estilo para el compositor (lo cablea el renderer). */
    composerHost?: ComposerHost,
  ) {
    this.composer = new ComposerTools(store, composerHost);
  }

  /** El compositor de beats (sus tools viven en composer-tools.ts). */
  private readonly composer: ComposerTools;

  /** Adjunta la petición pendiente del usuario al texto de get_project. */
  private withRequest(text: string): string {
    const req = this.takeUserRequest?.();
    return req ? `${text}\n\nPETICIÓN DEL USUARIO (atiéndela ahora): ${req}` : text;
  }

  private get project(): Project {
    return this.store.project;
  }

  /** Toda mutación sale por aquí: UN comando, origin 'claude', label legible. */
  private dispatch(cmd: Command, label: string): void {
    this.store.dispatch(cmd, { origin: 'claude', label });
  }

  /** Ejecuta una tool; lanza Error con mensaje claro en español si algo falla. */
  async execute(name: string, args: unknown): Promise<{ text: string }> {
    const a = asObject(args);
    switch (name) {
      case 'get_project': return { text: this.getProject(a) };
      case 'get_notes': return { text: this.getNotes(a) };
      case 'set_notes': return { text: this.setNotes(a) };
      case 'add_channel': return { text: this.addChannel(a) };
      case 'set_channel': return { text: this.setChannel(a) };
      case 'set_keymap': return { text: this.setKeymap(a) };
      case 'set_steps': return { text: this.setSteps(a) };

      case 'add_pattern': return { text: this.addPattern(a) };
      case 'arrange_clip': return { text: this.arrangeClip(a) };
      case 'set_tempo': return { text: this.setTempo(a) };
      case 'set_swing': return { text: this.setSwing(a) };
      case 'set_mixer': return { text: this.setMixer(a) };
      case 'add_effect': return { text: this.addEffect(a) };
      case 'set_effect': return { text: this.setEffect(a) };
      case 'remove_effect': return { text: this.removeEffect(a) };
      case 'set_automation': return { text: this.setAutomation(a) };
      case 'render': return { text: await this.render(a) };
      case 'analyze_mix': return { text: await this.analyzeMixTool() };
      case 'advise_mix': return { text: await this.adviseMixTool(a) };
      case 'list_library': return { text: await this.listLibrary(a) };
      case 'load_sample': return { text: await this.loadSample(a) };
      case 'generate_pack': return { text: await this.generatePackTool(a) };
      case 'list_genres': return { text: await this.composer.listGenres() };
      case 'compose_beat': return { text: await this.composer.composeBeatTool(a) };
      case 'recompose_part': return { text: await this.composer.recomposePartTool(a) };
      case 'list_style_profiles': return { text: await this.composer.listProfilesTool() };
      case 'learn_style': return { text: await this.composer.learnStyleTool(a) };
      case 'analyze_reference': return { text: await this.composer.analyzeReferenceTool(a) };
      case 'compose_from_reference': return { text: await this.composer.composeFromReferenceTool(a) };
      case 'riff': return { text: this.riffTool(a) };
      case 'transform_notes': return { text: this.transformNotes(a) };
      case 'delete_channel': return { text: this.deleteChannel(a) };
      case 'delete_pattern': return { text: this.deletePattern(a) };
      case 'sections': return { text: this.sectionsTool(a) };
      case 'undo': return { text: this.undo() };
      case 'redo': return { text: this.redo() };
      default:
        throw new ToolError(`Tool desconocida: "${name}"`);
    }
  }

  // ── Resolución de entidades (acepta id o nombre exacto) ───────────────────

  /**
   * Propiedad PROPIA del pool, no heredada.
   *
   * `patterns[ref]`, `channels[ref]`, `samples[ref]` y `clips[id]` a secas dan
   * por buenos `'__proto__'`, `'constructor'`, `'toString'`… (viven en
   * `Object.prototype`, son truthy) y devuelven entidades que no existen: la
   * búsqueda encontraba algo, la validación pasaba y el comando acababa
   * mutando el prototipo o escribiendo `project.clips['undefined']`.
   */
  private static own<T>(pool: Record<string, T>, id: string): T | undefined {
    return Object.hasOwn(pool, id) ? pool[id] : undefined;
  }

  private findPattern(ref: string): Pattern {
    const p = this.project;
    const byId = ToolExecutor.own(p.patterns, ref);
    if (byId) return byId;
    const lower = ref.toLowerCase();
    for (const id of p.patternOrder) {
      const pat = p.patterns[id];
      if (pat && pat.name.toLowerCase() === lower) return pat;
    }
    const names = p.patternOrder.map((id) => `"${p.patterns[id]?.name}"`).join(', ');
    throw new ToolError(`No existe el patrón "${ref}". Disponibles: ${names || '(ninguno)'}`);
  }

  /** Sample del proyecto por id o por nombre exacto. */
  private findSample(ref: string): SampleRef {
    const p = this.project;
    const byId = ToolExecutor.own(p.samples, ref);
    if (byId) return byId;
    const lower = ref.toLowerCase();
    for (const s of Object.values(p.samples)) {
      if (s.name.toLowerCase() === lower) return s;
    }
    const names = Object.values(p.samples).map((s) => `"${s.name}"`).slice(0, 12).join(', ');
    throw new ToolError(`No hay ningún sample "${ref}" en el proyecto. Hay: ${names || '(ninguno)'}`);
  }

  private findChannel(ref: string): Channel {

    const p = this.project;
    const byId = ToolExecutor.own(p.channels, ref);
    if (byId) return byId;
    const lower = ref.toLowerCase();
    for (const id of p.channelOrder) {
      const ch = p.channels[id];
      if (ch && ch.name.toLowerCase() === lower) return ch;
    }
    const names = p.channelOrder.map((id) => `"${p.channels[id]?.name}"`).join(', ');
    throw new ToolError(`No existe el canal "${ref}". Disponibles: ${names || '(ninguno)'}`);
  }

  /** Pistas de playlist del arrangement activo, ordenadas de arriba a abajo. */
  private playlistTracks(): PlaylistTrack[] {
    const p = this.project;
    return Object.values(p.playlistTracks)
      .filter((t) => t.arrangementId === p.activeArrangementId)
      .sort((x, y) => x.order - y.order);
  }

  private playlistTrack(index: number): PlaylistTrack {
    const tracks = this.playlistTracks();
    const t = tracks[index];
    if (!t) {
      throw new ToolError(`trackIndex ${index} fuera de rango: la playlist tiene ${tracks.length} pistas (0..${tracks.length - 1})`);
    }
    return t;
  }

  private mixerTrack(index: number): MixerTrack {
    const t = this.project.mixer[index];
    if (!t) {
      throw new ToolError(`trackIndex ${index} fuera de rango: el mixer tiene ${this.project.mixer.length} pistas (0 = Master)`);
    }
    return t;
  }

  private slotAt(trackIndex: number, slotIndex: number): EffectSlot {
    if (slotIndex < 0 || slotIndex >= MIXER_SLOTS) {
      throw new ToolError(`slotIndex ${slotIndex} fuera de rango (0..${MIXER_SLOTS - 1})`);
    }
    const slot = this.mixerTrack(trackIndex).slots[slotIndex];
    if (!slot) throw new ToolError(`El slot ${slotIndex} de la pista ${trackIndex} está vacío`);
    return slot;
  }

  // ── get_project ────────────────────────────────────────────────────────────

  private getProject(a: Record<string, unknown>): string {
    const detail = optString(a, 'detail') ?? 'summary';
    if (detail === 'full') return this.withRequest(JSON.stringify(this.project));
    if (detail !== 'summary') throw new ToolError('detail debe ser "summary" o "full"');

    const p = this.project;
    const lines: string[] = [];
    lines.push(
      `Proyecto "${p.meta.title}" — ${f(p.tempo)} BPM, ${p.timeSig.num}/${p.timeSig.den}, swing ${f(p.swing)}`,
    );

    // Canales
    lines.push(`Canales (${p.channelOrder.length}):`);
    if (p.channelOrder.length === 0) lines.push('  (ninguno — usa add_channel)');
    for (const id of p.channelOrder) {
      const ch = p.channels[id];
      if (!ch) continue;
      const flags = [ch.mute ? 'mute' : '', ch.solo ? 'solo' : ''].filter(Boolean).join(' ');
      // Por `trackOfChannel` y no por `ch.mixerTrack` crudo: un canal sin
      // pista propia dentro de una carpeta con bus compila en el BUS, no en
      // lo que diga el campo — mismo motivo que ya documenta el resumen del
      // mixer, unas líneas más abajo.
      lines.push(
        `  - "${ch.name}" [${ch.kind}] id=${ch.id} · vol ${f(gainToDb(ch.volume), 1)} dB · pan ${f(ch.pan)} · mixer ${trackOfChannel(p, ch.id)}${flags ? ' · ' + flags : ''}`,
      );
    }

    // Patrones
    lines.push(`Patrones (${p.patternOrder.length}):`);
    for (const id of p.patternOrder) {
      const pat = p.patterns[id];
      if (!pat) continue;
      const parts: string[] = [];
      for (const [chId, notes] of Object.entries(pat.notes)) {
        if (notes.length > 0) parts.push(`"${p.channels[chId]?.name ?? chId}"×${notes.length}`);
      }
      lines.push(
        `  - "${pat.name}" id=${pat.id} · ${f(pat.length)} beats · ${parts.length ? 'notas: ' + parts.join(', ') : 'sin notas'}`,
      );
    }

    // Playlist
    const arrangement = p.arrangements[p.activeArrangementId];
    const tracks = this.playlistTracks();
    const clips = Object.values(p.clips).filter((c) =>
      tracks.some((t) => t.id === c.playlistTrackId),
    );
    lines.push(
      `Playlist "${arrangement?.name ?? '?'}" (${tracks.length} pistas, ${clips.length} clips):`,
    );
    for (const clip of [...clips].sort((x, y) => x.start - y.start)) {
      const trackIdx = tracks.findIndex((t) => t.id === clip.playlistTrackId);
      let what: string;
      if (clip.kind === 'pattern') {
        what = `patrón "${p.patterns[clip.patternId ?? '']?.name ?? clip.patternId}"`;
      } else if (clip.kind === 'automation') {
        what = `automatización (${clip.target ? clip.target.kind + ':' + clip.target.param : '?'})`;
      } else {
        what = `audio "${p.samples[clip.sampleId ?? '']?.name ?? clip.sampleId}"`;
      }
      lines.push(
        `  - clip id=${clip.id} · ${what} · pista ${trackIdx} · beats ${f(clip.start)}–${f(clip.start + clip.length)}${clip.muted ? ' · mute' : ''}`,
      );
    }

    // Mixer: solo las pistas "en uso" para mantener el resumen compacto.
    const used = new Set<number>([0]);
    for (const id of p.channelOrder) {
      // Por `trackOfChannel` y no por `ch.mixerTrack`: un canal dentro de una
      // carpeta con bus se compila en la pista del BUS, así que leer el campo
      // crudo le daría a Claude una pista que ese canal no usa — y le dejaría
      // fuera del resumen la que de verdad lleva el sonido del grupo.
      if (p.channels[id]) used.add(trackOfChannel(p, id));
    }
    p.mixer.forEach((t, i) => {
      const nonDefault =
        t.slots.some((s) => s !== null) ||
        t.volume !== 1 || t.pan !== 0 || t.mute || t.solo || t.sends.length > 0 ||
        (i !== 0 && t.routeTo !== 0);
      if (nonDefault) used.add(i);
    });
    lines.push(`Mixer (${p.mixer.length} pistas; se listan las usadas):`);
    for (const i of [...used].sort((x, y) => x - y)) {
      const t = p.mixer[i];
      if (!t) continue;
      const fx = t.slots
        .map((s, si) => (s ? `[${si}] ${s.kind}${s.sidechainSource !== undefined ? ` (sc:${s.sidechainSource})` : ''}${s.enabled ? '' : ' (off)'}` : null))
        .filter(Boolean)
        .join(', ');
      const flags = [t.mute ? 'mute' : '', t.solo ? 'solo' : ''].filter(Boolean).join(' ');
      const route = t.routeTo === null ? '' : ` → ${t.routeTo}`;
      lines.push(
        `  - ${i} "${t.name}" · vol ${f(gainToDb(t.volume), 1)} dB · pan ${f(t.pan)}${route}${flags ? ' · ' + flags : ''}${fx ? ' · fx: ' + fx : ''}`,
      );
    }

    if (Object.keys(p.samples).length > 0) {
      lines.push(`Samples registrados: ${Object.keys(p.samples).length}`);
    }
    return this.withRequest(lines.join('\n'));
  }

  // ── Notas ──────────────────────────────────────────────────────────────────

  private getNotes(a: Record<string, unknown>): string {
    const pattern = this.findPattern(reqString(a, 'patternId'));
    const channel = this.findChannel(reqString(a, 'channelId'));
    const notes = pattern.notes[channel.id] ?? [];
    if (notes.length === 0) {
      return `El canal "${channel.name}" no tiene notas en "${pattern.name}".`;
    }
    const lines = [...notes]
      .sort((x, y) => x.start - y.start || x.key - y.key)
      .map(
        (n) =>
          `  ${midiToNote(n.key)} · start ${f(n.start)} · dur ${f(n.duration)} · vel ${f(n.velocity)}${n.pan !== 0 ? ` · pan ${f(n.pan)}` : ''}${n.slide ? ' · slide' : ''}`,
      );
    return `Notas de "${channel.name}" en "${pattern.name}" (${notes.length}):\n${lines.join('\n')}`;
  }

  private setNotes(a: Record<string, unknown>): string {
    const pattern = this.findPattern(reqString(a, 'patternId'));
    const channel = this.findChannel(reqString(a, 'channelId'));
    const replace = optBoolean(a, 'replace') ?? false;
    const rawNotes = a['notes'];
    if (!Array.isArray(rawNotes) || rawNotes.length === 0) {
      throw new ToolError('Falta "notes": array con al menos una nota');
    }
    if (rawNotes.length > MAX_NOTES_PER_CALL) {
      throw new ToolError(`Demasiadas notas en una llamada (${rawNotes.length} > ${MAX_NOTES_PER_CALL})`);
    }

    const notes: Note[] = rawNotes.map((raw, i) => {
      const n = asObject(raw);
      const start = boundedNumber(n, 'start', 0, MAX_BEATS);
      const duration = boundedNumber(n, 'duration', 0, MAX_BEATS);
      if (duration <= 0) {
        throw new ToolError(`Nota ${i}: duration debe ser > 0`);
      }
      let key = optNumber(n, 'key');
      const noteName = optString(n, 'note');
      if (key === undefined && noteName !== undefined) key = noteToMidi(noteName);
      if (key === undefined) throw new ToolError(`Nota ${i}: falta "key" (MIDI) o "note" ("F2")`);
      if (key < 0 || key > 127 || !Number.isInteger(key)) {
        throw new ToolError(`Nota ${i}: key ${key} fuera de rango MIDI 0..127`);
      }
      return {
        id: newId(),
        start,
        duration,
        key,
        velocity: clamp(optNumber(n, 'velocity') ?? 0.9, 0, 1),
        pan: clamp(optNumber(n, 'pan') ?? 0, -1, 1),
        slide: optBoolean(n, 'slide') ?? false,
      };
    });

    const commands: Command[] = [];
    const previous = pattern.notes[channel.id] ?? [];
    if (replace && previous.length > 0) {
      commands.push({
        type: 'removeNotes',
        patternId: pattern.id,
        channelId: channel.id,
        noteIds: previous.map((n) => n.id),
      });
    }
    commands.push({ type: 'addNotes', patternId: pattern.id, channelId: channel.id, notes });

    // El patrón crece si las notas se salen (redondeado a compás de 4 beats).
    const maxEnd = Math.max(...notes.map((n) => n.start + n.duration));
    let grew = '';
    if (maxEnd > pattern.length) {
      const newLength = Math.ceil(maxEnd / 4) * 4;
      commands.push({ type: 'patchPattern', patternId: pattern.id, patch: { length: newLength } });
      grew = ` (patrón ampliado a ${newLength} beats)`;
    }

    const label = `${notes.length} nota(s) en "${channel.name}" (${pattern.name})`;
    this.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      label,
    );
    const replaced = replace && previous.length > 0 ? `, reemplazando las ${previous.length} anteriores` : '';
    return `Añadidas ${notes.length} notas a "${channel.name}" en "${pattern.name}"${replaced}${grew}.`;
  }

  /**
   * Multisample por el bridge. La gracia de que Claude pueda montarlo es la
   * de siempre: las muestras las tiene el usuario y el reparto es aritmética
   * aburrida — decir "hazme un piano con esas doce" es más rápido que
   * arrastrar doce bordes.
   */
  private setKeymap(a: Record<string, unknown>): string {
    const channel = this.findChannel(reqString(a, 'channelId'));
    if (channel.kind !== 'sampler') {
      throw new ToolError(
        `El canal "${channel.name}" es ${channel.kind}, y el keymap es del sampler`,
      );
    }
    const refs = reqArray(a, 'samples').map((v, i) => {
      if (typeof v !== 'string') throw new ToolError(`samples[${i}] no es un texto`);
      return v;
    });

    const label = `Keymap de "${channel.name}"`;
    if (refs.length === 0) {
      this.dispatch({ type: 'patchChannel', channelId: channel.id, patch: { keymap: [] } }, label);
      return `Keymap quitado: "${channel.name}" vuelve a su único sample`;
    }

    const samples = refs.map((ref) => this.findSample(ref));
    const roots = a['roots'] === undefined ? null : reqArray(a, 'roots');
    if (roots !== null && roots.length !== samples.length) {
      throw new ToolError(`roots trae ${roots.length} notas y samples ${samples.length}`);
    }

    let zones;
    let unreadable: string[] = [];
    if (roots !== null) {
      // Raíces a mano: no hay nada que adivinar, solo repartir los rangos.
      zones = spreadKeymapRanges(
        samples.map((s, i) => {
          const root = roots[i];
          if (typeof root !== 'number') throw new ToolError(`roots[${i}] no es un número`);
          return createKeymapZone(s.id, { keyRoot: root });
        }),
      );
      if (a['velocityLayers'] !== false) zones = spreadKeymapVelocities(zones);
    } else {
      const result = autoMapKeymap(
        // El nombre del ARCHIVO, que es donde va la nota: el del SampleRef
        // puede venir ya limpio y sin ella.
        samples.map((s) => ({ id: s.id, name: s.path.replace(/^[a-z]+:/, '') || s.name })),
        {
          octaveOffset: optNumber(a, 'octaveOffset') ?? 0,
          velocityLayers: optBoolean(a, 'velocityLayers') !== false,
        },
      );
      zones = result.zones;
      unreadable = result.unreadable;
      if (zones.length === 0) {
        throw new ToolError(
          `No he sabido leer la nota de ninguno de esos nombres (${unreadable.join(', ')}). ` +
            'Pásalas en `roots`.',
        );
      }
    }

    this.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: { keymap: normalizeKeymap(zones) ?? [] } },
      label,
    );
    const range = `${midiToNote(zones[0]!.keyLow)}–${midiToNote(zones[zones.length - 1]!.keyHigh)}`;
    const aviso = unreadable.length > 0 ? ` (fuera, sin nota legible: ${unreadable.join(', ')})` : '';
    return `Keymap de "${channel.name}": ${zones.length} zona(s) cubriendo ${range}${aviso}`;
  }

  private setSteps(a: Record<string, unknown>): string {

    const pattern = this.findPattern(reqString(a, 'patternId'));
    const channel = this.findChannel(reqString(a, 'channelId'));
    const steps = reqString(a, 'steps');
    if (steps.length > MAX_STEPS_LEN) {
      throw new ToolError(`"steps" demasiado largo (${steps.length} > ${MAX_STEPS_LEN})`);
    }
    const key = optNumber(a, 'key') ?? 36;
    if (!Number.isInteger(key) || key < 0 || key > 127) {
      throw new ToolError(`key ${key} fuera de rango MIDI 0..127`);
    }

    const notes: Note[] = [];
    for (let i = 0; i < steps.length; i++) {
      const c = steps[i]!;
      let velocity: number | null = null;
      if (c === 'x' || c === 'X') velocity = 0.9;
      else if (c >= '1' && c <= '9') velocity = Number(c) / 9;
      else if (c === '-' || c === '.' || c === ' ') velocity = null;
      else throw new ToolError(`Carácter inválido "${c}" en steps (usa x, 1-9, - o .)`);
      if (velocity !== null) {
        notes.push({
          id: newId(),
          start: i * 0.25,
          duration: 0.25,
          key,
          velocity,
          pan: 0,
          slide: false,
        });
      }
    }

    const commands: Command[] = [];
    // Semántica de step sequencer: reemplaza los pasos previos de ESTA altura.
    const previousSameKey = (pattern.notes[channel.id] ?? []).filter((n) => n.key === key);
    if (previousSameKey.length > 0) {
      commands.push({
        type: 'removeNotes',
        patternId: pattern.id,
        channelId: channel.id,
        noteIds: previousSameKey.map((n) => n.id),
      });
    }
    if (notes.length > 0) {
      commands.push({ type: 'addNotes', patternId: pattern.id, channelId: channel.id, notes });
    }
    const stepBeats = steps.length * 0.25;
    let grew = '';
    if (stepBeats > pattern.length) {
      const newLength = Math.ceil(stepBeats / 4) * 4;
      commands.push({ type: 'patchPattern', patternId: pattern.id, patch: { length: newLength } });
      grew = ` (patrón ampliado a ${newLength} beats)`;
    }
    if (commands.length === 0) {
      return `Sin cambios: steps vacío y "${channel.name}" no tenía pasos en key ${key}.`;
    }

    const label = `Steps de "${channel.name}" (${pattern.name}, key ${key})`;
    this.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      label,
    );
    return `Programados ${notes.length} pasos (key ${key} = ${midiToNote(key)}) en "${channel.name}" de "${pattern.name}"${grew}.`;
  }

  // ── Canales ────────────────────────────────────────────────────────────────

  private addChannel(a: Record<string, unknown>): string {
    const kind = reqString(a, 'kind') as InstrumentKind;
    if (!INSTRUMENT_KINDS.includes(kind)) {
      throw new ToolError(`kind inválido "${kind}". Válidos: ${INSTRUMENT_KINDS.join(', ')}`);
    }
    const channel = createChannel(kind, this.project.channelOrder.length, optString(a, 'name'));
    const mixerTrack = optNumber(a, 'mixerTrack');
    if (mixerTrack !== undefined) {
      this.mixerTrack(mixerTrack); // valida el rango
      channel.mixerTrack = mixerTrack;
    }
    if (a['params'] !== undefined) {
      const params = validateParams(a['params'], INSTRUMENT_PARAMS[kind], kind);
      Object.assign(channel.params, params);
    }
    this.dispatch({ type: 'addChannel', channel }, `Añadir canal "${channel.name}"`);
    return `Canal "${channel.name}" (${kind}) creado con id=${channel.id}, mixer ${channel.mixerTrack}.`;
  }

  private setChannel(a: Record<string, unknown>): string {
    const channel = this.findChannel(reqString(a, 'channelId'));
    const patch = asObject(a['patch']);
    const commands: Command[] = [];
    const changed: string[] = [];

    const simple: Partial<Omit<Channel, 'id'>> = {};
    const name = optString(patch, 'name');
    if (name !== undefined) { simple.name = name; changed.push(`nombre "${name}"`); }
    const volumeDb = optNumber(patch, 'volumeDb');
    const volume = optNumber(patch, 'volume');
    if (volumeDb !== undefined) { simple.volume = clamp(dbToGain(volumeDb), 0, 2); changed.push(`vol ${f(volumeDb, 1)} dB`); }
    else if (volume !== undefined) { simple.volume = clamp(volume, 0, 2); changed.push(`vol ${f(gainToDb(simple.volume), 1)} dB`); }
    const pan = optNumber(patch, 'pan');
    if (pan !== undefined) { simple.pan = clamp(pan, -1, 1); changed.push(`pan ${f(simple.pan)}`); }
    const mute = optBoolean(patch, 'mute');
    if (mute !== undefined) { simple.mute = mute; changed.push(mute ? 'mute' : 'sin mute'); }
    const solo = optBoolean(patch, 'solo');
    if (solo !== undefined) { simple.solo = solo; changed.push(solo ? 'solo' : 'sin solo'); }
    const mixerTrack = optNumber(patch, 'mixerTrack');
    if (mixerTrack !== undefined) {
      this.mixerTrack(mixerTrack);
      simple.mixerTrack = mixerTrack;
      changed.push(`mixer ${mixerTrack}`);
    }
    if (Object.keys(simple).length > 0) {
      commands.push({ type: 'patchChannel', channelId: channel.id, patch: simple });
    }

    if (patch['params'] !== undefined) {
      const params = validateParams(patch['params'], INSTRUMENT_PARAMS[channel.kind], channel.kind);
      for (const [key, value] of Object.entries(params)) {
        commands.push({ type: 'setChannelParam', channelId: channel.id, key, value });
        changed.push(`${key}=${f(value)}`);
      }
    }

    if (commands.length === 0) throw new ToolError('El patch está vacío: nada que cambiar');
    const label = `Ajustar canal "${channel.name}"`;
    this.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      label,
    );
    return `Canal "${channel.name}" ajustado: ${changed.join(', ')}.`;
  }

  // ── Patrones / playlist ────────────────────────────────────────────────────

  private addPattern(a: Record<string, unknown>): string {
    const pattern = createPattern(this.project.patternOrder.length, optString(a, 'name'));
    const length = optNumber(a, 'length');
    if (length !== undefined) {
      if (length <= 0 || length > MAX_BEATS) {
        throw new ToolError(`length debe estar entre 0 y ${MAX_BEATS} beats`);
      }
      pattern.length = length;
    }
    this.dispatch({ type: 'addPattern', pattern }, `Añadir "${pattern.name}"`);
    return `Patrón "${pattern.name}" creado con id=${pattern.id} (${f(pattern.length)} beats).`;
  }

  private arrangeClip(a: Record<string, unknown>): string {
    const action = reqString(a, 'action');
    if (action === 'add') {
      const pattern = this.findPattern(reqString(a, 'patternId'));
      const track = this.playlistTrack(optNumber(a, 'trackIndex') ?? 0);
      const start = optBoundedNumber(a, 'startBeat', 0, MAX_BEATS) ?? 0;
      const length = optBoundedNumber(a, 'lengthBeats', 0, MAX_BEATS) ?? pattern.length;
      if (length <= 0) throw new ToolError('startBeat >= 0 y lengthBeats > 0');
      const clip: Clip = {
        id: newId(),
        kind: 'pattern',
        playlistTrackId: track.id,
        start,
        length,
        muted: false,
        patternId: pattern.id,
      };
      this.dispatch({ type: 'addClips', clips: [clip] }, `Colocar "${pattern.name}" en playlist`);
      return `Clip de "${pattern.name}" colocado en pista "${track.name}" (beats ${f(start)}–${f(start + length)}), id=${clip.id}.`;
    }

    if (action === 'move') {
      const clipId = reqString(a, 'clipId');
      const clip = ToolExecutor.own(this.project.clips, clipId);
      if (!clip) throw new ToolError(`No existe el clip ${clipId}`);
      const patch: { id: string; start?: number; length?: number; playlistTrackId?: string } = { id: clipId };
      const changed: string[] = [];
      const start = optBoundedNumber(a, 'startBeat', 0, MAX_BEATS);
      if (start !== undefined) { patch.start = start; changed.push(`start ${f(patch.start)}`); }
      const length = optBoundedNumber(a, 'lengthBeats', 0, MAX_BEATS);
      if (length !== undefined) {
        if (length <= 0) throw new ToolError('lengthBeats debe ser > 0');
        patch.length = length; changed.push(`length ${f(length)}`);
      }
      const trackIndex = optNumber(a, 'trackIndex');
      if (trackIndex !== undefined) {
        patch.playlistTrackId = this.playlistTrack(trackIndex).id;
        changed.push(`pista ${trackIndex}`);
      }
      if (changed.length === 0) throw new ToolError('move sin cambios: pasa startBeat, lengthBeats o trackIndex');
      this.dispatch({ type: 'patchClips', patches: [patch] }, 'Mover clip');
      return `Clip ${clipId} movido: ${changed.join(', ')}.`;
    }

    if (action === 'remove') {
      const clipId = reqString(a, 'clipId');
      if (!ToolExecutor.own(this.project.clips, clipId)) throw new ToolError(`No existe el clip ${clipId}`);
      this.dispatch({ type: 'removeClips', clipIds: [clipId] }, 'Borrar clip');
      return `Clip ${clipId} borrado de la playlist.`;
    }

    throw new ToolError(`action inválida "${action}" (add | move | remove)`);
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  private setTempo(a: Record<string, unknown>): string {
    const bpm = reqNumber(a, 'bpm');
    if (bpm < 20 || bpm > 999) throw new ToolError('bpm fuera de rango 20..999');
    this.dispatch({ type: 'setTempo', tempo: bpm }, `Tempo → ${f(bpm)} BPM`);
    return `Tempo cambiado a ${f(bpm)} BPM.`;
  }

  private setSwing(a: Record<string, unknown>): string {
    const amount = reqNumber(a, 'amount');
    if (amount < 0 || amount > 1) throw new ToolError('amount fuera de rango 0..1');
    this.dispatch({ type: 'setSwing', swing: amount }, `Swing → ${f(amount)}`);
    return `Swing global ajustado a ${f(amount)}.`;
  }

  // ── Mixer / efectos ────────────────────────────────────────────────────────

  private setMixer(a: Record<string, unknown>): string {
    const trackIndex = reqNumber(a, 'trackIndex');
    const track = this.mixerTrack(trackIndex);
    const patch = asObject(a['patch']);
    const commands: Command[] = [];
    const changed: string[] = [];

    const simple: Partial<Omit<MixerTrack, 'id' | 'slots' | 'sends'>> = {};
    const volumeDb = optNumber(patch, 'volumeDb');
    const volume = optNumber(patch, 'volume');
    if (volumeDb !== undefined) { simple.volume = clamp(dbToGain(volumeDb), 0, 2); changed.push(`vol ${f(volumeDb, 1)} dB`); }
    else if (volume !== undefined) { simple.volume = clamp(volume, 0, 2); changed.push(`vol ${f(gainToDb(simple.volume), 1)} dB`); }
    const pan = optNumber(patch, 'pan');
    if (pan !== undefined) { simple.pan = clamp(pan, -1, 1); changed.push(`pan ${f(simple.pan)}`); }
    const mute = optBoolean(patch, 'mute');
    if (mute !== undefined) { simple.mute = mute; changed.push(mute ? 'mute' : 'sin mute'); }
    const solo = optBoolean(patch, 'solo');
    if (solo !== undefined) { simple.solo = solo; changed.push(solo ? 'solo' : 'sin solo'); }
    const name = optString(patch, 'name');
    if (name !== undefined) { simple.name = name; changed.push(`nombre "${name}"`); }
    if (Object.keys(simple).length > 0) {
      commands.push({ type: 'patchMixerTrack', trackIndex, patch: simple });
    }

    if ('routeTo' in patch) {
      const routeTo = patch['routeTo'];
      if (routeTo !== null && (typeof routeTo !== 'number' || !Number.isInteger(routeTo))) {
        throw new ToolError('routeTo debe ser un índice de pista o null');
      }
      if (trackIndex === 0) throw new ToolError('El Master no se re-rutea');
      if (routeTo !== null) this.mixerTrack(routeTo);
      commands.push({ type: 'setRoute', trackIndex, routeTo: routeTo as number | null });
      changed.push(`ruta → ${routeTo === null ? 'ninguna' : routeTo}`);
    }

    if (commands.length === 0) throw new ToolError('El patch está vacío: nada que cambiar');
    const label = `Mixer ${trackIndex} "${track.name}"`;
    this.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      label,
    );
    return `Pista de mixer ${trackIndex} "${track.name}" ajustada: ${changed.join(', ')}.`;
  }

  private addEffect(a: Record<string, unknown>): string {
    const trackIndex = reqNumber(a, 'trackIndex');
    const slotIndex = reqNumber(a, 'slotIndex');
    const kind = reqString(a, 'kind') as EffectKind;
    if (!EFFECT_KINDS.includes(kind)) {
      throw new ToolError(`kind inválido "${kind}". Válidos: ${EFFECT_KINDS.join(', ')}`);
    }
    const track = this.mixerTrack(trackIndex);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MIXER_SLOTS) {
      throw new ToolError(`slotIndex ${slotIndex} fuera de rango (entero 0..${MIXER_SLOTS - 1})`);
    }
    const existing = track.slots[slotIndex];
    if (existing) {
      throw new ToolError(
        `El slot ${slotIndex} de la pista ${trackIndex} ya tiene un ${existing.kind}; usa set_effect para ajustarlo o remove_effect para quitarlo`,
      );
    }

    const params: Record<string, number> = {};
    for (const spec of EFFECT_PARAMS[kind]) params[spec.key] = spec.default;
    if (a['params'] !== undefined) {
      Object.assign(params, validateParams(a['params'], EFFECT_PARAMS[kind], kind));
    }
    const sidechainSource = optNumber(a, 'sidechainSource');
    if (sidechainSource !== undefined) this.mixerTrack(sidechainSource);

    const slot: EffectSlot = {
      id: newId(),
      kind,
      enabled: true,
      mix: clamp(optNumber(a, 'mix') ?? 1, 0, 1),
      params,
      ...(sidechainSource !== undefined ? { sidechainSource } : {}),
    };
    this.dispatch(
      { type: 'setEffect', trackIndex, slotIndex, slot },
      `Insertar ${kind} en mixer ${trackIndex}`,
    );
    const sc = sidechainSource !== undefined ? `, sidechain desde la pista ${sidechainSource}` : '';
    return `Efecto ${kind} insertado en pista ${trackIndex} "${track.name}", slot ${slotIndex}${sc}.`;
  }

  private setEffect(a: Record<string, unknown>): string {
    const trackIndex = reqNumber(a, 'trackIndex');
    const slotIndex = reqNumber(a, 'slotIndex');
    const slot = this.slotAt(trackIndex, slotIndex);
    const commands: Command[] = [];
    const changed: string[] = [];

    if (a['params'] !== undefined) {
      const params = validateParams(a['params'], EFFECT_PARAMS[slot.kind], slot.kind);
      for (const [key, value] of Object.entries(params)) {
        commands.push({ type: 'setEffectParam', trackIndex, slotIndex, key, value });
        changed.push(`${key}=${f(value)}`);
      }
    }
    const enabled = optBoolean(a, 'enabled');
    const mix = optNumber(a, 'mix');
    if (enabled !== undefined || mix !== undefined) {
      const patch: { enabled?: boolean; mix?: number } = {};
      if (enabled !== undefined) { patch.enabled = enabled; changed.push(enabled ? 'on' : 'off'); }
      if (mix !== undefined) { patch.mix = clamp(mix, 0, 1); changed.push(`mix ${f(patch.mix)}`); }
      commands.push({ type: 'patchEffect', trackIndex, slotIndex, patch });
    }

    if (commands.length === 0) throw new ToolError('Nada que cambiar: pasa params, enabled o mix');
    const label = `Ajustar ${slot.kind} (mixer ${trackIndex}, slot ${slotIndex})`;
    this.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      label,
    );
    return `Efecto ${slot.kind} de la pista ${trackIndex} (slot ${slotIndex}) ajustado: ${changed.join(', ')}.`;
  }

  private removeEffect(a: Record<string, unknown>): string {
    const trackIndex = reqNumber(a, 'trackIndex');
    const slotIndex = reqNumber(a, 'slotIndex');
    const slot = this.slotAt(trackIndex, slotIndex);
    this.dispatch(
      { type: 'setEffect', trackIndex, slotIndex, slot: null },
      `Quitar ${slot.kind} (mixer ${trackIndex})`,
    );
    return `Efecto ${slot.kind} quitado del slot ${slotIndex} de la pista ${trackIndex}.`;
  }

  // ── Automatización ─────────────────────────────────────────────────────────

  private setAutomation(a: Record<string, unknown>): string {
    const track = this.playlistTrack(reqNumber(a, 'trackIndex'));
    const startBeat = boundedNumber(a, 'startBeat', 0, MAX_BEATS);
    const lengthBeats = boundedNumber(a, 'lengthBeats', 0, MAX_BEATS);
    if (lengthBeats <= 0) throw new ToolError('lengthBeats > 0');

    let targetRaw = a['targetJson'];
    if (typeof targetRaw === 'string') {
      try {
        targetRaw = JSON.parse(targetRaw) as unknown;
      } catch {
        throw new ToolError('targetJson no es JSON válido');
      }
    }
    const target = this.validateParamRef(targetRaw);

    const rawPoints = a['points'];
    if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
      throw new ToolError('Falta "points": array con al menos un punto {time, value, tension?}');
    }
    if (rawPoints.length > MAX_POINTS) {
      throw new ToolError(`Demasiados puntos (${rawPoints.length} > ${MAX_POINTS})`);
    }
    const points: AutomationPoint[] = rawPoints
      .map((raw, i) => {
        const o = asObject(raw);
        const time = boundedNumber(o, 'time', 0, MAX_BEATS);
        return {
          id: newId(),
          time,
          value: clamp(reqNumber(o, 'value'), 0, 1),
          tension: clamp(optNumber(o, 'tension') ?? 0, -1, 1),
        };
      })
      .sort((x, y) => x.time - y.time);

    const clip: Clip = {
      id: newId(),
      kind: 'automation',
      playlistTrackId: track.id,
      start: startBeat,
      length: lengthBeats,
      muted: false,
      target,
      points,
    };
    const what = `${target.kind}:${target.param}`;
    this.dispatch({ type: 'addClips', clips: [clip] }, `Automatizar ${what}`);
    return `Clip de automatización de ${what} creado en pista "${track.name}" (beats ${f(startBeat)}–${f(startBeat + lengthBeats)}, ${points.length} puntos), id=${clip.id}.`;
  }

  /** Valida un ParamRef llegado del exterior (ids reales, formas correctas). */
  private validateParamRef(raw: unknown): ParamRef {
    const o = asObject(raw);
    const kind = reqString(o, 'kind');
    switch (kind) {
      case 'channel': {
        const ch = this.findChannel(reqString(o, 'channelId'));
        const param = reqString(o, 'param');
        if (!findParamSpec(INSTRUMENT_PARAMS[ch.kind], param)) {
          throw new ToolError(
            `El canal "${ch.name}" (${ch.kind}) no tiene el parámetro "${param}". Válidos: ${INSTRUMENT_PARAMS[ch.kind].map((s) => s.key).join(', ')}`,
          );
        }
        return { kind: 'channel', channelId: ch.id, param };
      }
      case 'channelMix': {
        const ch = this.findChannel(reqString(o, 'channelId'));
        const param = reqString(o, 'param');
        if (param !== 'volume' && param !== 'pan') {
          throw new ToolError('channelMix.param debe ser "volume" o "pan"');
        }
        return { kind: 'channelMix', channelId: ch.id, param };
      }
      case 'mixer': {
        const trackIndex = reqNumber(o, 'trackIndex');
        this.mixerTrack(trackIndex);
        const param = reqString(o, 'param');
        if (param !== 'volume' && param !== 'pan' && param !== 'stereoWidth') {
          throw new ToolError('mixer.param debe ser "volume", "pan" o "stereoWidth"');
        }
        return { kind: 'mixer', trackIndex, param };
      }
      case 'effect': {
        const trackIndex = reqNumber(o, 'trackIndex');
        const slotIndex = reqNumber(o, 'slotIndex');
        const slot = this.slotAt(trackIndex, slotIndex);
        const param = reqString(o, 'param');
        if (!findParamSpec(EFFECT_PARAMS[slot.kind], param)) {
          throw new ToolError(
            `El ${slot.kind} del slot ${slotIndex} no tiene el parámetro "${param}". Válidos: ${EFFECT_PARAMS[slot.kind].map((s) => s.key).join(', ')}`,
          );
        }
        return { kind: 'effect', trackIndex, slotIndex, param };
      }
      case 'transport': {
        const param = reqString(o, 'param');
        // El swing se aplica al compilar el inicio de cada nota. El kernel no
        // puede mover esas notas con una curva en runtime: confirmar ese clip
        // sería un éxito falso (la UI ya excluye ese destino).
        if (param === 'swing') {
          throw new ToolError('El swing no admite automatización; usa set_swing para ajustar el swing global.');
        }
        if (param !== 'tempo') {
          throw new ToolError('transport.param debe ser "tempo"');
        }
        return { kind: 'transport', param };
      }
      default:
        throw new ToolError(
          `ParamRef.kind inválido "${kind}" (channel | channelMix | mixer | effect | transport)`,
        );
    }
  }

  // ── Render / análisis ──────────────────────────────────────────────────────

  private compileFor(a: Record<string, unknown>): { play: PlayMode; what: string } {
    const mode = optString(a, 'mode') ?? 'song';
    if (mode === 'pattern') {
      const ref = optString(a, 'patternId');
      const pattern = ref !== undefined
        ? this.findPattern(ref)
        : this.project.patterns[this.project.patternOrder[0] ?? ''];
      if (!pattern) throw new ToolError('No hay patrones en el proyecto');
      return { play: { mode: 'pattern', patternId: pattern.id }, what: `patrón "${pattern.name}"` };
    }
    if (mode !== 'song') throw new ToolError('mode debe ser "song" o "pattern"');
    return { play: { mode: 'song' }, what: 'canción' };
  }

  private assertRenderCurrent(version: number): void {
    if (this.store.version !== version) {
      throw new ToolError('El proyecto cambió mientras se preparaba el audio. Repite la operación sobre el proyecto actual.');
    }
  }

  private async renderInputs(project: Project, compiled: CompiledProject): Promise<RenderInputs> {
    const inputs = this.resolveRenderInputs
      ? await this.resolveRenderInputs(project, compiled)
      : { samples: new Map<string, SampleData>(), plugins: new Map<string, string>() };
    // Comprobar los mapas, no confiar en que un host siempre enumerará sus
    // errores. Un análisis parcial podría recomendar cambios destructivos a
    // una mezcla que en realidad está completa en vivo.
    const missingSamples = [...neededSampleIds(compiled)].filter((id) => !inputs.samples.has(id));
    const missingPlugins = [...neededPluginIds(compiled)].filter((id) => !inputs.plugins.get(id));
    if (missingSamples.length || missingPlugins.length) {
      const missing = [
        missingSamples.length ? `muestras: ${missingSamples.map((id) => project.samples[id]?.name ?? id).join(', ')}` : '',
        missingPlugins.length ? `plugins: ${missingPlugins.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new ToolError(`Audio incompleto: faltan ${missing}. No se generó audio ni se aplicaron consejos de mezcla.`);
    }
    return inputs;
  }

  private async render(a: Record<string, unknown>): Promise<string> {
    if (!this.saveFile) {
      throw new ToolError(
        'Guardar no disponible: el puente de archivos no está conectado en esta sesión (falta saveFile)',
      );
    }
    const { play, what } = this.compileFor(a);
    const version = this.store.version;
    const project = structuredClone(this.project);
    const compiled = compileProject(project, play);
    if (compiled.events.length === 0 && compiled.audioClips.length === 0) {
      throw new ToolError(
        play.mode === 'song'
          ? 'La playlist no tiene clips con notas; usa arrange_clip o renderiza con mode "pattern"'
          : 'El patrón no tiene notas',
      );
    }

    const inputs = await this.renderInputs(project, compiled);
    this.assertRenderCurrent(version);
    const { left, right, sampleRate } = renderProject(compiled, { sampleRate: 44100, tailSeconds: 2, ...inputs });
    const analysis = analyzeMix(left, right, sampleRate);
    const wav = encodeWav(left, right, sampleRate, 16);

    const title = project.meta.title || 'orbit';
    const suggested = optString(a, 'path')
      ?? `${`${title} — ${what}`.replace(/[\\/:*?"<>|]/g, '_')}.wav`;
    const finalPath = await this.saveFile(suggested, wav);

    const seconds = left.length / sampleRate;
    return (
      `WAV renderizado (${what}) y guardado en ${finalPath}.\n` +
      `Duración ${f(seconds, 1)} s · peak ${f(analysis.peakDb, 1)} dBFS · LUFS integrado: ${f(analysis.lufsIntegrated, 1)}.`
    );
  }

  /**
   * Render en memoria de lo que haya que analizar: la canción si la playlist
   * tiene contenido y, si no, el primer patrón con notas.
   */
  private async renderForAnalysis(): Promise<{ analysis: MixAnalysis; what: string; seconds: number; lengthBeats: number; version: number }> {
    const version = this.store.version;
    const project = structuredClone(this.project);
    let play: PlayMode = { mode: 'song' };
    let what = 'canción';
    let compiled = compileProject(project, play);
    if (compiled.events.length === 0 && compiled.audioClips.length === 0) {
      const withNotes = project.patternOrder
        .map((id) => project.patterns[id])
        .find((p) => p && Object.values(p.notes).some((n) => n.length > 0));
      if (!withNotes) {
        throw new ToolError('El proyecto no tiene notas todavía: nada que analizar');
      }
      play = { mode: 'pattern', patternId: withNotes.id };
      what = `patrón "${withNotes.name}"`;
      compiled = compileProject(project, play);
    }
    const inputs = await this.renderInputs(project, compiled);
    this.assertRenderCurrent(version);
    const { left, right, sampleRate } = renderProject(compiled, { sampleRate: 44100, tailSeconds: 1, ...inputs });
    return {
      analysis: analyzeMix(left, right, sampleRate),
      what,
      seconds: left.length / sampleRate,
      lengthBeats: compiled.lengthBeats,
      version,
    };
  }

  private async analyzeMixTool(): Promise<string> {
    const { analysis: m, what, seconds, lengthBeats, version } = await this.renderForAnalysis();
    this.assertRenderCurrent(version);
    if (m.peakDb < -60 || !Number.isFinite(m.stereoCorrelation)) {
      throw new ToolError(
        'La mezcla está en silencio: no hay nada que medir. Revisa mutes, samples sin cargar y clips muted.',
      );
    }
    const toTarget = -14 - m.lufsIntegrated;
    return [
      `Análisis de mezcla (${what}, ${f(lengthBeats)} beats, ${f(seconds, 1)} s render):`,
      `- LUFS integrado: ${f(m.lufsIntegrated, 1)} (para -14 LUFS de streaming: ${toTarget >= 0 ? '+' : ''}${f(toTarget, 1)} dB)`,
      `- Peak: ${f(m.peakDb, 1)} dBFS`,
      `- Bandas (dB rel. al total): low ${f(m.bands.low, 1)} · low-mid ${f(m.bands.lowMid, 1)} · high-mid ${f(m.bands.highMid, 1)} · high ${f(m.bands.high, 1)}`,
      `- Correlación estéreo: ${f(m.stereoCorrelation)}`,
    ].join('\n');
  }

  // ── Consejo de mezcla ──────────────────────────────────────────────────────

  /** Foto de una pista de mixer para el asistente (qué efectos tiene ya). */
  private trackSlots(index: number): TrackSlots {
    const track = this.mixerTrack(index);
    return {
      index,
      name: track.name,
      slots: track.slots.map((s) => (s ? s.kind : null)),
    };
  }

  /**
   * Busca la pista de mixer de un papel (voz, 808, beat): primero por el
   * nombre de la propia pista, y si no, por el canal que la alimenta.
   */
  private findRoleTrack(
    nameRe: RegExp,
    channelKinds: InstrumentKind[],
  ): TrackSlots | undefined {
    const p = this.project;
    for (let i = 1; i < p.mixer.length; i++) {
      const track = p.mixer[i];
      if (track && nameRe.test(track.name)) return this.trackSlots(i);
    }
    for (const id of p.channelOrder) {
      const ch = p.channels[id];
      if (!ch) continue;
      // Igual que arriba: la pista efectiva, que con carpeta-bus no es la suya.
      const track = trackOfChannel(p, id);
      if (track === 0) continue;
      if (nameRe.test(ch.name) || channelKinds.includes(ch.kind)) {
        return this.trackSlots(track);
      }
    }
    return undefined;
  }

  private async adviseMixTool(a: Record<string, unknown>): Promise<string> {
    const { analysis, what, version } = await this.renderForAnalysis();
    this.assertRenderCurrent(version);
    if (analysis.peakDb < -60 || !Number.isFinite(analysis.stereoCorrelation)) {
      throw new ToolError(
        'La mezcla está en silencio: no hay nada que medir. Revisa mutes, samples sin cargar y clips muted.',
      );
    }

    const genreArg = optString(a, 'genre') ?? 'auto';
    const genres: MixGenre[] = ['trap', 'boombap', 'reggaeton', 'generico'];
    if (genreArg !== 'auto' && !genres.includes(genreArg as MixGenre)) {
      throw new ToolError(`genre inválido "${genreArg}". Válidos: ${genres.join(', ')}, auto`);
    }
    const genre: MixGenre =
      genreArg === 'auto' ? guessGenre(this.project.tempo) : (genreArg as MixGenre);

    const targetLufs = optNumber(a, 'targetLufs') ?? STREAMING_LUFS;
    if (targetLufs < -30 || targetLufs > -6) {
      throw new ToolError('targetLufs fuera de rango -30..-6');
    }

    const explicit = (key: string): TrackSlots | undefined => {
      const index = optNumber(a, key);
      if (index === undefined) return undefined;
      if (index === 0) throw new ToolError(`${key} no puede ser el master (0)`);
      return this.trackSlots(index);
    };

    const voice = explicit('voiceTrack') ?? this.findRoleTrack(/voz|vocal|vox|voice|cantad/i, ['vox']);
    const low = explicit('lowTrack') ?? this.findRoleTrack(/808|sub|bajo|bass/i, ['sub808']);
    const beat = explicit('beatTrack') ?? this.findRoleTrack(/beat|instrumental|pista base/i, []);

    const ctx: MixContext = {
      genre,
      targetLufs,
      master: this.trackSlots(0),
      ...(voice ? { voice } : null),
      // El beat solo tiene sentido si es OTRA pista distinta de la voz.
      ...(beat && beat.index !== voice?.index ? { beat } : null),
      ...(low ? { low } : null),
    };

    const advice = adviseMix(analysis, ctx);
    const detected = [
      voice ? `voz = mixer ${voice.index} "${voice.name}"` : 'voz no detectada',
      low ? `808/sub = mixer ${low.index} "${low.name}"` : null,
      ctx.beat ? `beat = mixer ${ctx.beat.index} "${ctx.beat.name}"` : null,
    ].filter(Boolean);

    const parts = [formatAdvice(advice, analysis, what), '', `Pistas: ${detected.join(' · ')}.`];
    if (optBoolean(a, 'apply') === true) {
      parts.push(this.applyAdvice(advice));
    } else {
      parts.push('Nada aplicado todavía: repite con apply=true para dejarlo puesto (un solo undo).');
    }
    return parts.join('\n');
  }

  /** Aplica la cadena propuesta como UN comando batch (un paso de undo). */
  private applyAdvice(advice: MixAdvice): string {
    const commands: Command[] = [];
    const done: string[] = [];

    for (const step of advice.chain) {
      const specs = EFFECT_PARAMS[step.kind];
      const params = validateParams(step.params, specs, step.kind);
      if (step.existing) {
        // Un efecto que YA estaba conserva sus parámetros viejos si solo se
        // mandan los del plan. Lo anunciado era «esta cadena», así que se
        // reescribe entera: defaults del tipo y encima los del consejo, igual
        // que hace el camino de inserción.
        const full: Record<string, number> = {};
        for (const spec of specs) full[spec.key] = spec.default;
        Object.assign(full, params);
        for (const [key, value] of Object.entries(full)) {
          commands.push({
            type: 'setEffectParam',
            trackIndex: step.trackIndex,
            slotIndex: step.slotIndex,
            key,
            value,
          });
        }
        const patch: { enabled?: boolean; mix?: number; sidechainSource?: number } = { enabled: true };
        patch.mix = clamp(step.mix ?? 1, 0, 1);
        if (step.sidechainSource !== undefined) patch.sidechainSource = step.sidechainSource;
        commands.push({
          type: 'patchEffect',
          trackIndex: step.trackIndex,
          slotIndex: step.slotIndex,
          patch,
        });
        done.push(`ajustado ${step.kind} en mixer ${step.trackIndex} (slot ${step.slotIndex})`);
      } else {
        const full: Record<string, number> = {};
        for (const spec of specs) full[spec.key] = spec.default;
        Object.assign(full, params);
        const slot: EffectSlot = {
          id: newId(),
          kind: step.kind,
          enabled: true,
          mix: clamp(step.mix ?? 1, 0, 1),
          params: full,
          ...(step.sidechainSource !== undefined
            ? { sidechainSource: step.sidechainSource }
            : {}),
        };
        commands.push({
          type: 'setEffect',
          trackIndex: step.trackIndex,
          slotIndex: step.slotIndex,
          slot,
        });
        done.push(`${step.kind} en mixer ${step.trackIndex} (slot ${step.slotIndex})`);
      }
    }

    for (const gain of advice.gains) {
      commands.push({
        type: 'patchMixerTrack',
        trackIndex: gain.trackIndex,
        patch: { volume: clamp(dbToGain(gain.volumeDb), 0, 2) },
      });
      done.push(`fader de mixer ${gain.trackIndex} a ${f(gain.volumeDb, 1)} dB`);
    }

    if (commands.length === 0) return 'No había nada que aplicar.';
    const label = `Cadena de mezcla (${advice.chain.length} efecto(s))`;
    this.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      label,
    );
    return `Aplicado en un solo paso de undo: ${done.join(', ')}.`;
  }

  // ── Librería de sonidos ───────────────────────────────────────────

  /** Sin acentos, sin mayúsculas: buscar "percusion" tiene que encontrar "percusión". */
  private static plano(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  private libraryOrFail(): LibraryFn {
    if (!this.library) {
      throw new ToolError(
        'La librería no está disponible en esta sesión (falta el puente del browser)',
      );
    }
    return this.library;
  }

  /**
   * Qué hay en el browser. Existe porque sin esto la única forma de que un
   * sonido del pack llegue a un canal era que el usuario lo arrastrase a mano:
   * el puente podía escribir notas pero no elegir con qué sonaban.
   */
  private async listLibrary(a: Record<string, unknown>): Promise<string> {
    const all = await this.libraryOrFail().list();
    if (all.length === 0) {
      return 'La librería está vacía: no hay pack de fábrica instalado ni packs generados.';
    }

    const busca = optString(a, 'busca');
    const pack = optString(a, 'pack');
    const categoria = optString(a, 'categoria');
    const limite = Math.max(1, Math.round(optNumber(a, 'limite') ?? 120));

    const needle = busca ? ToolExecutor.plano(busca) : null;
    const filtered = all.filter((sound) => {
      if (pack && !ToolExecutor.plano(sound.pack).includes(ToolExecutor.plano(pack))) return false;
      if (categoria && ToolExecutor.plano(sound.category) !== ToolExecutor.plano(categoria)) return false;
      if (!needle) return true;
      const haystack = ToolExecutor.plano(
        [sound.name, sound.category, sound.subcategory ?? '', sound.pack, ...sound.tags].join(' '),
      );
      return haystack.includes(needle);
    });

    if (filtered.length === 0) {
      const que = [busca && `"${busca}"`, pack && `pack "${pack}"`, categoria && `categoría "${categoria}"`]
        .filter(Boolean)
        .join(', ');
      return `Ningún sonido cuadra con ${que || 'el filtro'}. Hay ${all.length} en la librería.`;
    }

    const shown = filtered.slice(0, limite);
    const porPack = new Map<string, LibrarySound[]>();
    for (const sound of shown) {
      const list = porPack.get(sound.pack) ?? [];
      list.push(sound);
      porPack.set(sound.pack, list);
    }

    const lines: string[] = [
      `${filtered.length} sonido(s)${filtered.length > shown.length ? `, muestro ${shown.length}` : ''}:`,
    ];
    for (const [nombre, sounds] of porPack) {
      lines.push(`\n${nombre} (${sounds.length}):`);
      for (const sound of sounds) {
        // El BPM y la nota son lo que decide si un loop entra en el proyecto o
        // no: van en la línea, no escondidos detrás de otra llamada.
        const extra = [
          sound.bpm !== undefined ? `${f(sound.bpm)} BPM` : null,
          sound.keyRoot ? sound.keyRoot : null,
          `${f(sound.durationSec, 2)} s`,
        ]
          .filter(Boolean)
          .join(' · ');
        const grupo = sound.subcategory ? `${sound.category}/${sound.subcategory}` : sound.category;
        // El id va impreso: `load_sample` lo acepta y sin él dos packs con el
        // mismo nombre visible ("Kick Trap 01" de fábrica y "Kick trap 01"
        // generado) dejan la tool en un callejón sin salida.
        lines.push(`  - "${sound.name}" · ${grupo} · ${extra} · id=${sound.id}`);
      }
    }
    lines.push('\nPara meterlos en el proyecto: load_sample con sus nombres o con el id que sale aquí.');
    return lines.join('\n');
  }

  /**
   * Un canal sampler por sonido, lo mismo que arrastrarlos al rack.
   *
   * La resolución por NOMBRE es deliberada: los ids del manifest
   * (`pack:drums/warehouse/kick-hard-groove-01`) no se pueden teclear de memoria
   * y el nombre visible sí. Un nombre ambiguo se rechaza diciendo cuáles
   * coincidían, en vez de elegir uno a ciegas.
   */
  private async loadSample(a: Record<string, unknown>): Promise<string> {
    const library = this.libraryOrFail();
    const raw = a['sonidos'];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ToolError('Falta "sonidos": una lista de nombres o ids de la librería');
    }
    const wanted = raw.map((x, i) => {
      if (typeof x !== 'string' || x.trim() === '') {
        throw new ToolError(`"sonidos[${i}]" debe ser un nombre o id no vacío`);
      }
      return x.trim();
    });

    const mixerTrack = optNumber(a, 'mixerTrack');
    if (mixerTrack !== undefined) this.mixerTrack(mixerTrack);

    const all = await library.list();
    const ids: string[] = [];
    for (const query of wanted) {
      const exact = all.filter(
        (s) => s.id === query || ToolExecutor.plano(s.name) === ToolExecutor.plano(query),
      );
      const candidates = exact.length > 0
        ? exact
        : all.filter((s) => ToolExecutor.plano(s.name).includes(ToolExecutor.plano(query)));

      if (candidates.length === 0) {
        throw new ToolError(`No hay ningún sonido "${query}" en la librería (mira list_library)`);
      }
      if (candidates.length > 1) {
        const nombres = candidates.slice(0, 6).map((s) => `"${s.name}" (id ${s.id})`).join(', ');
        throw new ToolError(
          `"${query}" cuadra con ${candidates.length} sonidos (${nombres}${candidates.length > 6 ? '…' : ''}): concreta con uno de los ids`,
        );
      }
      ids.push(candidates[0]!.id);
    }

    // Los canales Y su ruteo salen del MISMO dispatch —el renderer hacia
    // dentro— con origin 'claude': la tool promete "UN solo paso de undo" y
    // antes eran dos entradas, la primera además como cambio local (Claude no
    // podía deshacerla).
    const total = ids.length;
    const label = mixerTrack !== undefined
      ? `Cargar ${total} sonido(s) de la librería al mixer ${mixerTrack}`
      : `Cargar ${total} sonido(s) de la librería`;
    const created = await library.load(ids, {
      ...(mixerTrack !== undefined ? { mixerTrack } : {}),
      origin: 'claude',
      label,
    });
    if (created.length === 0) throw new ToolError('No se pudo cargar ningún sonido');

    // Red de seguridad: si el renderer todavía no lee `mixerTrack` de las
    // opciones, los canales vienen sin rutear y se aplica aquí para no perder
    // el destino (serán dos entradas hasta que pase las opciones; cuando las
    // pase, esto no dispara nada).
    if (mixerTrack !== undefined) {
      const sinRutear = created.filter((c) => this.project.channels[c.id]?.mixerTrack !== mixerTrack);
      if (sinRutear.length > 0) {
        const commands: Command[] = sinRutear.map((channel) => ({
          type: 'patchChannel',
          channelId: channel.id,
          patch: { mixerTrack },
        }));
        const labelRuteo = `Enrutar ${sinRutear.length} sampler(s) al mixer ${mixerTrack}`;
        this.dispatch(
          commands.length === 1 ? commands[0]! : { type: 'batch', label: labelRuteo, commands },
          labelRuteo,
        );
      }
    }

    const destino = mixerTrack !== undefined ? `, en el mixer ${mixerTrack}` : '';
    const lista = created.map((c) => `  - "${c.name}" id=${c.id}`).join('\n');
    return `${created.length} canal(es) sampler creados${destino}:\n${lista}`;
  }

  // ── Packs de sonidos a medida ─────────────────────────────────────

  /**
   * "Dame 12 hats de drill": el encargo se valida aquí (la familia es
   * obligatoria y el estilo tiene que existir) y el trabajo sucio —renderizar
   * con el motor y escribir los WAV— lo hace el renderer por la función
   * inyectada, igual que con los WAV de `render`.
   */
  private async generatePackTool(a: Record<string, unknown>): Promise<string> {
    if (!this.generatePack) {
      throw new ToolError(
        'Generar packs no está disponible en esta sesión (falta el puente de la librería)',
      );
    }
    const family = a['family'];
    if (!isPackFamily(family)) {
      throw new ToolError(
        `Familia desconocida: "${String(family)}". Válidas: ${PACK_FAMILIES.join(', ')}`,
      );
    }
    const request: PackRequest = { family };

    const style = a['style'];
    if (style !== undefined) {
      if (!isPackStyle(style)) {
        throw new ToolError(
          `Estilo desconocido: "${String(style)}". Válidos: ${PACK_STYLES.join(', ')}`,
        );
      }
      request.style = style;
    }

    const count = a['count'];
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new ToolError('count debe ser un número');
      }
      request.count = Math.round(clamp(count, 1, MAX_PACK_SOUNDS));
    }

    const name = a['name'];
    if (typeof name === 'string' && name.trim() !== '') request.name = name.trim();
    const key = a['key'];
    if (typeof key === 'string' && key.trim() !== '') {
      const clean = key.trim().toUpperCase();
      if (!isPackKey(clean)) {
        throw new ToolError(
          `Tonalidad desconocida: "${key}". Válidas: ${packKeys().join(', ')}`,
        );
      }
      request.key = clean;
    }
    const seed = a['seed'];
    if (typeof seed === 'number' && Number.isFinite(seed)) request.seed = Math.round(seed);

    const pack = await this.generatePack(request, {
      addChannels: a['addChannels'] === true,
      origin: 'claude',
      label: `Generar pack "${request.name ?? request.family}"`,
    });
    const added =
      pack.added > 0 ? ` Y ${pack.added} canal(es) sampler nuevos en el proyecto.` : '';
    return (
      `Pack "${pack.name}" generado: ${pack.count} sonidos (${f(pack.seconds, 2)} s de audio) en ${pack.dir}.
` +
      `Ya está en el browser, sección "Packs generados": se arrastran al rack o a la playlist como los de fábrica.${added}`
    );
  }

  // ── Undo / redo ──────────────────────────────────────────────────────────

  // ── Edición de notas: riff y transformaciones ──────────────────────────────

  private riffTool(a: Record<string, unknown>): string {
    const pattern = this.findPattern(reqString(a, 'patternId'));
    const channel = this.findChannel(reqString(a, 'channelId'));
    const root = parseKeyRoot(a['key']) ?? 0;
    const scaleName = parseScale(a['scale']) ?? 'Menor natural';
    const bpb = this.project.timeSig.num;
    const bars = Math.round(optBoundedNumber(a, 'bars', 1, 64) ?? Math.max(1, Math.round(pattern.length / bpb)));
    const character = (optString(a, 'character') ?? 'sincopado') as RiffCharacter;
    if (!['sostenido', 'sincopado', 'puntillo'].includes(character)) {
      throw new ToolError('character: sostenido | sincopado | puntillo');
    }
    const seed = Math.floor(optBoundedNumber(a, 'seed', 0, 0xffffffff) ?? Math.random() * 0xffffffff) >>> 0;
    const notes = riff({
      seed,
      root,
      scale: SCALES[scaleName]!,
      bars,
      beatsPerBar: bpb,
      density: optBoundedNumber(a, 'density', 1, 32) ?? 4,
      octaveLow: Math.round(optBoundedNumber(a, 'octave', 0, 9) ?? 5),
      octaves: Math.round(optBoundedNumber(a, 'octaves', 1, 3) ?? 1),
      character,
    });
    const replace = optBoolean(a, 'replace') ?? true;
    const commands: Command[] = [];
    const existing = pattern.notes[channel.id] ?? [];
    if (replace && existing.length > 0) {
      commands.push({ type: 'removeNotes', patternId: pattern.id, channelId: channel.id, noteIds: existing.map((n) => n.id) });
    }
    commands.push({ type: 'addNotes', patternId: pattern.id, channelId: channel.id, notes });
    const end = bars * bpb;
    if (end > pattern.length) commands.push({ type: 'patchPattern', patternId: pattern.id, patch: { length: end } });
    this.dispatch({ type: 'batch', label: 'Riff', commands }, `Riff en "${channel.name}"`);
    return `Riff de ${notes.length} notas (${scaleName}, semilla ${seed}) en "${channel.name}" / "${pattern.name}"${replace ? ', sustituyendo lo que había' : ''}.`;
  }

  private transformNotes(a: Record<string, unknown>): string {
    const pattern = this.findPattern(reqString(a, 'patternId'));
    const channel = this.findChannel(reqString(a, 'channelId'));
    const op = reqString(a, 'op');
    const notes = pattern.notes[channel.id] ?? [];
    if (notes.length === 0) throw new ToolError(`"${channel.name}" no tiene notas en "${pattern.name}"`);
    const seed = Math.floor(optBoundedNumber(a, 'seed', 0, 0xffffffff) ?? 1) >>> 0;
    let next: Note[];
    let added: Note[] | null = null;
    switch (op) {
      case 'humanize':
        next = humanize(notes, {
          timing: optBoundedNumber(a, 'amount', 0, 0.5) ?? 0.02,
          velocity: optBoundedNumber(a, 'velocity', 0, 1) ?? 0.08,
          seed,
        });
        break;
      case 'strum':
        next = strum(notes, {
          spread: optBoundedNumber(a, 'amount', 0, 2) ?? 0.12,
          direction: optString(a, 'direction') === 'down' ? 'down' : 'up',
        });
        break;
      case 'arpeggiate': {
        const mode = (optString(a, 'mode') ?? 'up') as ArpMode;
        if (!['up', 'down', 'updown', 'downup', 'alternate', 'random', 'chord'].includes(mode)) {
          throw new ToolError('mode: up | down | updown | downup | alternate | random | chord');
        }
        next = arpeggiate(notes, {
          rate: optBoundedNumber(a, 'grid', 0.03125, 4) ?? 0.25,
          mode,
          octaves: Math.round(optBoundedNumber(a, 'octaves', 1, 4) ?? 1),
          seed,
        });
        break;
      }
      case 'chop':
        next = chop(notes, { grid: optBoundedNumber(a, 'grid', 0.03125, 4) ?? 0.25 });
        break;
      case 'chordify': {
        const raw = a['intervals'];
        const intervals: unknown[] = Array.isArray(raw) ? raw : [0, 4, 7];
        if (
          intervals.length === 0 ||
          intervals.length > 8 ||
          !intervals.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= -24 && x <= 24)
        ) {
          throw new ToolError('intervals: de 1 a 8 semitonos enteros (-24..24), p. ej. [0,3,7]');
        }
        const scaleName = parseScale(a['scale']);
        added = chordify(notes, {
          intervals: intervals as number[],
          ...(scaleName ? { scale: SCALES[scaleName]!, root: parseKeyRoot(a['key']) ?? 0 } : null),
          existing: notes,
        });
        next = notes;
        break;
      }
      case 'transpose': {
        const semis = Math.round(optBoundedNumber(a, 'amount', -48, 48) ?? 12);
        next = notes.map((n) => ({ ...n, key: clamp(n.key + semis, 0, 127) }));
        break;
      }
      case 'quantize': {
        const grid = optBoundedNumber(a, 'grid', 0.03125, 4) ?? 0.25;
        const strength = optBoundedNumber(a, 'amount', 0, 1) ?? 1;
        next = notes.map((n) => {
          const target = Math.round(n.start / grid) * grid;
          return { ...n, start: Math.max(0, n.start + (target - n.start) * strength) };
        });
        break;
      }
      case 'velocity': {
        const scale = optBoundedNumber(a, 'amount', 0, 2) ?? 1;
        next = notes.map((n) => ({ ...n, velocity: clamp(n.velocity * scale, 0.02, 1) }));
        break;
      }
      default:
        throw new ToolError('op: humanize | strum | arpeggiate | chop | chordify | transpose | quantize | velocity');
    }
    const commands: Command[] = [];
    if (added) {
      if (added.length === 0) return 'chordify no añadió nada (las notas ya formaban esos acordes).';
      commands.push({ type: 'addNotes', patternId: pattern.id, channelId: channel.id, notes: added });
    } else {
      // Sustituir entero, con ids nuevos: es UN paso de undo y no depende de qué
      // ids conserve cada transformación.
      commands.push({ type: 'removeNotes', patternId: pattern.id, channelId: channel.id, noteIds: notes.map((n) => n.id) });
      commands.push({
        type: 'addNotes',
        patternId: pattern.id,
        channelId: channel.id,
        notes: next.map((n) => ({ ...n, id: newId() })),
      });
    }
    this.dispatch({ type: 'batch', label: `Notas: ${op}`, commands }, `Notas: ${op} en "${channel.name}"`);
    const count = added ? added.length : next.length;
    return `${op} aplicado a "${channel.name}" / "${pattern.name}": ${added ? `${count} notas añadidas` : `${notes.length} → ${count} notas`}.`;
  }

  // ── Borrar canales y patrones ──────────────────────────────────────────────

  private deleteChannel(a: Record<string, unknown>): string {
    const channel = this.findChannel(reqString(a, 'channelId'));
    this.dispatch({ type: 'removeChannel', channelId: channel.id }, `Borrar canal "${channel.name}"`);
    return `Canal "${channel.name}" borrado (con sus notas). undo lo devuelve.`;
  }

  private deletePattern(a: Record<string, unknown>): string {
    const pattern = this.findPattern(reqString(a, 'patternId'));
    if (this.project.patternOrder.length <= 1) throw new ToolError('No se puede borrar el último patrón');
    this.dispatch({ type: 'removePattern', patternId: pattern.id }, `Borrar patrón "${pattern.name}"`);
    return `Patrón "${pattern.name}" borrado (y sus clips de la playlist). undo lo devuelve.`;
  }

  // ── Secciones del arreglo ──────────────────────────────────────────────────

  private sectionsTool(a: Record<string, unknown>): string {
    const action = reqString(a, 'action');
    const p = this.project;
    const bpb = p.timeSig.num;
    const sections = Object.values(p.sections ?? {})
      .filter((s) => s.arrangementId === p.activeArrangementId)
      .sort((x, y) => x.start - y.start);
    if (action === 'list') {
      if (sections.length === 0) return 'El arrangement activo no tiene secciones.';
      return sections
        .map((s) => `- "${s.name}"${s.kind ? ` (${s.kind})` : ''} id=${s.id}: compás ${f(s.start / bpb)}–${f((s.start + s.length) / bpb)}`)
        .join('\n');
    }
    if (action === 'add') {
      const name = reqString(a, 'name').slice(0, 60);
      const startBar = optBoundedNumber(a, 'startBar', 0, MAX_BEATS / bpb) ?? 0;
      const bars = optBoundedNumber(a, 'bars', 0.25, 1024) ?? 4;
      const kind = optString(a, 'kind');
      if (kind !== undefined && !['intro', 'build', 'drop', 'break', 'outro'].includes(kind)) {
        throw new ToolError('kind: intro | build | drop | break | outro');
      }
      const section: ArrangementSection = {
        id: newId(),
        arrangementId: p.activeArrangementId,
        name,
        start: startBar * bpb,
        length: bars * bpb,
        ...(kind ? { kind: kind as NonNullable<ArrangementSection['kind']> } : null),
      };
      this.dispatch({ type: 'addSections', sections: [section] }, `Sección "${name}"`);
      return `Sección "${name}" añadida en el compás ${f(startBar)} (${f(bars)} compases), id=${section.id}.`;
    }
    if (action === 'remove') {
      const id = reqString(a, 'sectionId');
      const hit = sections.find((s) => s.id === id || s.name.toLowerCase() === id.toLowerCase());
      if (!hit) throw new ToolError(`No existe la sección "${id}"`);
      this.dispatch({ type: 'removeSections', sectionIds: [hit.id] }, `Quitar sección "${hit.name}"`);
      return `Sección "${hit.name}" quitada (los clips siguen en su sitio).`;
    }
    throw new ToolError('action: list | add | remove');
  }

  private undo(): string {
    const entry = [...this.store.history].reverse().find((e) => e.origin === 'claude');
    if (!this.store.undo('claude')) return 'No hay cambios de Claude que deshacer.';
    return `Deshecho: ${entry?.label ?? 'último cambio de Claude'}.`;
  }

  private redo(): string {
    if (!this.store.redo('claude')) return 'No hay cambios de Claude que rehacer.';
    return 'Rehecho el último cambio de Claude deshecho.';
  }
}
