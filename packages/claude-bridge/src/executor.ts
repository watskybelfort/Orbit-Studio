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
  createChannel,
  createPattern,
  dbToGain,
  findParamSpec,
  gainToDb,
  midiToNote,
  newId,
  noteToMidi,
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
} from '@orbit/core';
import {
  analyzeMix,
  compileProject,
  encodeWav,
  renderProject,
  type MixAnalysis,
  type PlayMode,
} from '@orbit/engine';

/** Guarda `data` con nombre sugerido y devuelve la ruta final. */
export type SaveFileFn = (suggestedName: string, data: Uint8Array) => Promise<string>;

const INSTRUMENT_KINDS: InstrumentKind[] = ['sub808', 'synth', 'supersaw', 'fm', 'drums', 'sampler'];
const EFFECT_KINDS = Object.keys(EFFECT_PARAMS) as EffectKind[];

// ── Helpers de validación de argumentos ──────────────────────────────────────

class ToolError extends Error {}

function asObject(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('Los argumentos deben ser un objeto JSON');
  }
  return args as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolError(`Falta el parámetro "${key}" (string)`);
  }
  return v;
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${key}" debe ser string`);
  return v;
}

function reqNumber(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ToolError(`Falta el parámetro "${key}" (número)`);
  }
  return v;
}

function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`"${key}" debe ser número`);
  return v;
}

function optBoolean(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`"${key}" debe ser boolean`);
  return v;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Número compacto para respuestas (2 decimales máx, sin ceros de cola). */
function f(x: number, decimals = 2): string {
  const p = Math.pow(10, decimals);
  return String(Math.round(x * p) / p);
}

/** Valida un objeto de params contra los specs del registro y los clampa. */
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
  ) {}

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
      case 'analyze_mix': return { text: this.analyzeMixTool() };
      case 'undo': return { text: this.undo() };
      case 'redo': return { text: this.redo() };
      default:
        throw new ToolError(`Tool desconocida: "${name}"`);
    }
  }

  // ── Resolución de entidades (acepta id o nombre exacto) ───────────────────

  private findPattern(ref: string): Pattern {
    const p = this.project;
    const byId = p.patterns[ref];
    if (byId) return byId;
    const lower = ref.toLowerCase();
    for (const id of p.patternOrder) {
      const pat = p.patterns[id];
      if (pat && pat.name.toLowerCase() === lower) return pat;
    }
    const names = p.patternOrder.map((id) => `"${p.patterns[id]?.name}"`).join(', ');
    throw new ToolError(`No existe el patrón "${ref}". Disponibles: ${names || '(ninguno)'}`);
  }

  private findChannel(ref: string): Channel {
    const p = this.project;
    const byId = p.channels[ref];
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
      lines.push(
        `  - "${ch.name}" [${ch.kind}] id=${ch.id} · vol ${f(gainToDb(ch.volume), 1)} dB · pan ${f(ch.pan)} · mixer ${ch.mixerTrack}${flags ? ' · ' + flags : ''}`,
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
      const ch = p.channels[id];
      if (ch) used.add(ch.mixerTrack);
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

    const notes: Note[] = rawNotes.map((raw, i) => {
      const n = asObject(raw);
      const start = reqNumber(n, 'start');
      const duration = reqNumber(n, 'duration');
      if (start < 0 || duration <= 0) {
        throw new ToolError(`Nota ${i}: start debe ser >= 0 y duration > 0`);
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

  private setSteps(a: Record<string, unknown>): string {
    const pattern = this.findPattern(reqString(a, 'patternId'));
    const channel = this.findChannel(reqString(a, 'channelId'));
    const steps = reqString(a, 'steps');
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
      if (length <= 0) throw new ToolError('length debe ser > 0 beats');
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
      const start = optNumber(a, 'startBeat') ?? 0;
      const length = optNumber(a, 'lengthBeats') ?? pattern.length;
      if (start < 0 || length <= 0) throw new ToolError('startBeat >= 0 y lengthBeats > 0');
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
      const clip = this.project.clips[clipId];
      if (!clip) throw new ToolError(`No existe el clip ${clipId}`);
      const patch: { id: string; start?: number; length?: number; playlistTrackId?: string } = { id: clipId };
      const changed: string[] = [];
      const start = optNumber(a, 'startBeat');
      if (start !== undefined) { patch.start = Math.max(0, start); changed.push(`start ${f(patch.start)}`); }
      const length = optNumber(a, 'lengthBeats');
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
      if (!this.project.clips[clipId]) throw new ToolError(`No existe el clip ${clipId}`);
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
    if (slotIndex < 0 || slotIndex >= MIXER_SLOTS) {
      throw new ToolError(`slotIndex ${slotIndex} fuera de rango (0..${MIXER_SLOTS - 1})`);
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
    const startBeat = reqNumber(a, 'startBeat');
    const lengthBeats = reqNumber(a, 'lengthBeats');
    if (startBeat < 0 || lengthBeats <= 0) throw new ToolError('startBeat >= 0 y lengthBeats > 0');

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
    const points: AutomationPoint[] = rawPoints
      .map((raw, i) => {
        const o = asObject(raw);
        const time = reqNumber(o, 'time');
        if (time < 0) throw new ToolError(`Punto ${i}: time debe ser >= 0`);
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
        if (param !== 'tempo' && param !== 'swing') {
          throw new ToolError('transport.param debe ser "tempo" o "swing"');
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

  private async render(a: Record<string, unknown>): Promise<string> {
    if (!this.saveFile) {
      throw new ToolError(
        'Guardar no disponible: el puente de archivos no está conectado en esta sesión (falta saveFile)',
      );
    }
    const { play, what } = this.compileFor(a);
    const compiled = compileProject(this.project, play);
    if (compiled.events.length === 0 && compiled.audioClips.length === 0) {
      throw new ToolError(
        play.mode === 'song'
          ? 'La playlist no tiene clips con notas; usa arrange_clip o renderiza con mode "pattern"'
          : 'El patrón no tiene notas',
      );
    }

    const { left, right, sampleRate } = renderProject(compiled, { sampleRate: 44100, tailSeconds: 2 });
    const analysis = analyzeMix(left, right, sampleRate);
    const wav = encodeWav(left, right, sampleRate, 16);

    const title = this.project.meta.title || 'orbit';
    const suggested = optString(a, 'path')
      ?? `${`${title} — ${what}`.replace(/[\\/:*?"<>|]/g, '_')}.wav`;
    const finalPath = await this.saveFile(suggested, wav);

    const seconds = left.length / sampleRate;
    return (
      `WAV renderizado (${what}) y guardado en ${finalPath}.\n` +
      `Duración ${f(seconds, 1)} s · peak ${f(analysis.peakDb, 1)} dBFS · LUFS integrado: ${f(analysis.lufsIntegrated, 1)}.`
    );
  }

  private analyzeMixTool(): string {
    // Song si la playlist tiene contenido; si no, primer patrón con notas.
    let play: PlayMode = { mode: 'song' };
    let what = 'canción';
    let compiled = compileProject(this.project, play);
    if (compiled.events.length === 0 && compiled.audioClips.length === 0) {
      const withNotes = this.project.patternOrder
        .map((id) => this.project.patterns[id])
        .find((p) => p && Object.values(p.notes).some((n) => n.length > 0));
      if (!withNotes) {
        throw new ToolError('El proyecto no tiene notas todavía: nada que analizar');
      }
      play = { mode: 'pattern', patternId: withNotes.id };
      what = `patrón "${withNotes.name}"`;
      compiled = compileProject(this.project, play);
    }

    const { left, right, sampleRate } = renderProject(compiled, { sampleRate: 44100, tailSeconds: 1 });
    const m: MixAnalysis = analyzeMix(left, right, sampleRate);
    const seconds = left.length / sampleRate;
    const toTarget = -14 - m.lufsIntegrated;
    return [
      `Análisis de mezcla (${what}, ${f(compiled.lengthBeats)} beats, ${f(seconds, 1)} s render):`,
      `- LUFS integrado: ${f(m.lufsIntegrated, 1)} (para -14 LUFS de streaming: ${toTarget >= 0 ? '+' : ''}${f(toTarget, 1)} dB)`,
      `- Peak: ${f(m.peakDb, 1)} dBFS`,
      `- Bandas (dB rel. al total): low ${f(m.bands.low, 1)} · low-mid ${f(m.bands.lowMid, 1)} · high-mid ${f(m.bands.highMid, 1)} · high ${f(m.bands.high, 1)}`,
      `- Correlación estéreo: ${f(m.stereoCorrelation)}`,
    ].join('\n');
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────

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
