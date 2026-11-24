/**
 * Tools MCP del compositor de beats.
 *
 * El compositor es local y determinista (`@orbit/sound-library`): estas tools
 * son su volante para un modelo. Con ellas Claude puede pedir un beat entero
 * de un género, encargar algo concreto (tonalidad, tempo, progresión, qué
 * partes), rehacer solo la melodía, aprender el estilo de unos audios o
 * sacar un beat nuevo con la temática de una referencia — y todo acaba en el
 * proyecto como canales, patrones y clips separados, en UN paso de undo de
 * origen 'claude'.
 *
 * Igual que el executor, aquí no se toca disco ni audio: decodificar una
 * referencia y guardar perfiles lo hace el renderer a través de
 * `ComposerHost`.
 */

import { SCALES, type Command, type ProjectStore, type SampleRef } from '@orbit/core';
import {
  COMPOSER_GENRES,
  COMPOSER_ROLES,
  GENRE_PRESETS,
  MAX_COMPOSE_BARS,
  MAX_PROFILE_TRACKS,
  NOTE_LABELS,
  ROLE_LABELS,
  SHAPE_TOTAL,
  composeBeat,
  createProfile,
  describePlan,
  extendProfile,
  guessGenre,
  isComposerGenre,
  genreVariants,
  presetLabel,
  isComposerRole,
  planToCommands,
  recomposePart,
  replacePartCommands,
  type AppliedBeat,
  type BeatPlan,
  type ComposeOptions,
  type ComposerGenre,
  type ComposerRole,
  type StyleProfile,
  type TrackFeatures,
} from '@orbit/sound-library';
import {
  ToolError,
  optBoolean,
  optBoundedNumber,
  optNumber,
  optString,
  reqArray,
  reqString,
} from './args';

/** Lo que el renderer pone para que el compositor lea audio y guarde perfiles. */
export interface ComposerHost {
  /** Perfiles de estilo guardados (los del panel «Entrenar»). */
  listProfiles(): Promise<StyleProfile[]>;
  /** Guarda (o sustituye por id) un perfil. */
  saveProfile(profile: StyleProfile): Promise<void>;
  /**
   * Mide un audio: un sample del proyecto (id o nombre) o un sonido de la
   * librería (id del browser). `null` si no hay nada que medir.
   */
  analyzeSample(ref: string): Promise<{ name: string; features: TrackFeatures | null }>;
  /**
   * Sube al motor los samples de fábrica que un beat acaba de registrar (la
   * batería sampleada de trap, reggaetón, neo perreo y boom bap). Sin host —un
   * MCP sin app— no hace falta: no hay motor que los toque.
   */
  loadSamples?(refs: readonly SampleRef[]): Promise<void>;
}

/** Audios que learn_style mide de una vez (el esquema de tools.ts anuncia el mismo tope). */
export const MAX_LEARN_SAMPLES = 32;

/** "F#", "Gb", "f", 6 → 0..11. */
export function parseKeyRoot(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 0 && raw < 12) return raw;
    throw new ToolError('key numérica: entero 0..11 (0 = C)');
  }
  if (typeof raw !== 'string') throw new ToolError('key: nombre de nota ("F#", "Bb") o 0..11');
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)/.exec(raw);
  if (!m) throw new ToolError(`key "${raw}" no es una nota (C, C#, Db, D, …, B)`);
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[m[1]!.toUpperCase()]!;
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  return ((pc % 12) + 12) % 12;
}

/** Escala por nombre de `SCALES`, o atajos «major/minor/mayor/menor». */
export function parseScale(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new ToolError('scale debe ser texto');
  const lower = raw.trim().toLowerCase();
  const aliases: Record<string, string> = {
    major: 'Mayor', mayor: 'Mayor', minor: 'Menor natural', menor: 'Menor natural',
    'harmonic minor': 'Menor armónica', dorian: 'Dórico', phrygian: 'Frigio', mixolydian: 'Mixolidio',
  };
  if (aliases[lower]) return aliases[lower];
  const hit = Object.keys(SCALES).find((s) => s.toLowerCase() === lower);
  if (!hit) throw new ToolError(`scale "${raw}" desconocida. Válidas: ${Object.keys(SCALES).join(', ')}`);
  return hit;
}

function parseRoles(raw: unknown): ComposerRole[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError(`parts: lista no vacía de ${COMPOSER_ROLES.join(', ')}`);
  for (const r of raw) if (!isComposerRole(r)) throw new ToolError(`parte desconocida "${String(r)}" (${COMPOSER_ROLES.join(', ')})`);
  return [...new Set(raw as ComposerRole[])];
}

function parseShape(a: Record<string, unknown>): Pick<ComposeOptions, 'shape' | 'loopBars'> {
  const shape = a['shape'];
  const loopBars = optBoundedNumber(a, 'loopBars', 1, 32);
  if (shape === undefined || shape === 'song') return loopBars !== undefined ? { shape: 'loop', loopBars: Math.round(loopBars) } : {};
  if (shape === 'loop') return { shape: 'loop', loopBars: loopBars !== undefined ? Math.round(loopBars) : 8 };
  if (typeof shape === 'number' && Number.isInteger(shape) && shape >= 0 && shape < SHAPE_TOTAL) return { shape };
  throw new ToolError(`shape: "song" (forma completa al azar del género), "loop", o 0..${SHAPE_TOTAL - 1} (forma concreta)`);
}

function parseProgression(raw: unknown): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) throw new ToolError('progression: de 1 a 16 grados (0 = tónica … 6)');
  for (const d of raw) if (!(Number.isInteger(d) && d >= 0 && d <= 6)) throw new ToolError('progression: grados enteros 0..6');
  return raw as number[];
}

function seedOf(a: Record<string, unknown>): number {
  const seed = optNumber(a, 'seed');
  if (seed === undefined) return Math.floor(Math.random() * 0xffffffff) >>> 0;
  if (!Number.isFinite(seed) || seed < 0) throw new ToolError('seed: entero >= 0');
  return Math.floor(seed) >>> 0;
}

function registered(commands: readonly Command[]): SampleRef[] {
  return commands.flatMap((c) => (c.type === 'registerSample' ? [c.sample] : []));
}

function profileSummary(p: StyleProfile): string {
  const bpms = p.tracks.map((t) => (t.bpm === null ? '?' : Math.round(t.bpm))).join(', ');
  return `"${p.name}" (id=${p.id}) — ${p.tracks.length} pistas; tempos ${bpms}`;
}

export class ComposerTools {
  /** El último beat montado, para recompose_part. Vive lo que vive la sesión. */
  private last: { plan: BeatPlan; applied: AppliedBeat; profile: StyleProfile | null } | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly host?: ComposerHost,
  ) {}

  private dispatchBatch(label: string, commands: Parameters<ProjectStore['dispatch']>[0][]): void {
    this.store.dispatch({ type: 'batch', label, commands }, { origin: 'claude', label });
  }

  private requireHost(): ComposerHost {
    if (!this.host) throw new ToolError('Esta sesión no tiene acceso a audio ni a perfiles (solo funciona con la app abierta)');
    return this.host;
  }

  private async findProfile(ref: string | undefined): Promise<StyleProfile | null> {
    if (!ref) return null;
    const profiles = await this.requireHost().listProfiles();
    const lower = ref.toLowerCase();
    const hit = profiles.find((p) => p.id === ref) ?? profiles.find((p) => p.name.toLowerCase() === lower);
    if (!hit) {
      throw new ToolError(`No hay ningún perfil "${ref}". Hay: ${profiles.map((p) => `"${p.name}"`).join(', ') || '(ninguno: usa learn_style)'}`);
    }
    return hit;
  }

  // ── list_genres ────────────────────────────────────────────────────────────

  async listGenres(): Promise<string> {
    const lines = ['Géneros del compositor (compose_beat → genre):'];
    for (const g of COMPOSER_GENRES) {
      const p = GENRE_PRESETS[g];
      lines.push(
        `- ${g} — ${p.name}: ${p.description} BPM ${p.bpm.min}–${p.bpm.max} (por defecto ${p.bpm.default}); ` +
          `escalas ${p.scales.map((s) => s.name).join(' / ')}; swing ${p.swing}.`,
      );
      for (const v of genreVariants(g)) {
        lines.push(`  · variant="${v.id}" — ${v.name}: ${v.description} BPM ${v.preset.bpm.min}–${v.preset.bpm.max}.`);
      }
    }
    lines.push(`Partes (parts): ${COMPOSER_ROLES.map((r) => `${r} (${ROLE_LABELS[r]})`).join(', ')}.`);
    lines.push(`Escalas (scale): ${Object.keys(SCALES).join(', ')}.`);
    lines.push('Formas (shape): "song" = la del género (trap, reggaetón, neo perreo y boom bap: canción de rap con versos de 16 y hooks de 8; techno y rave: intro/subida/drop/puente/final); "loop" = un bucle de loopBars compases; 0..2 = formas de club, 3..4 = formas de rap.');
    if (this.host) {
      const profiles = await this.host.listProfiles();
      lines.push(profiles.length > 0 ? `Perfiles de estilo (profile): ${profiles.map(profileSummary).join(' · ')}` : 'Perfiles de estilo: ninguno todavía (learn_style).');
    }
    return lines.join('\n');
  }

  // ── compose_beat ───────────────────────────────────────────────────────────

  private composeOptions(a: Record<string, unknown>, profile: StyleProfile | null, genre: ComposerGenre): ComposeOptions {
    return {
      genre,
      variant: optString(a, 'variant'),
      seed: seedOf(a),
      bpm: optBoundedNumber(a, 'bpm', 40, 250),
      keyRoot: parseKeyRoot(a['key']),
      scale: parseScale(a['scale']),
      ...parseShape(a),
      roles: parseRoles(a['parts']),
      profile,
      influence: optBoundedNumber(a, 'influence', 0, 1),
      soundVariation: optBoundedNumber(a, 'soundVariation', 0, 1),
      complexity: optBoundedNumber(a, 'complexity', 0, 1),
      progression: parseProgression(a['progression']),
    };
  }

  private async composeAndApply(
    a: Record<string, unknown>,
    opts: ComposeOptions,
    profile: StyleProfile | null,
    label: string,
  ): Promise<string> {
    let plan: BeatPlan;
    try {
      plan = composeBeat(opts);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    if (optBoolean(a, 'dryRun')) return `PLAN (sin aplicar): ${this.describe(plan, null)}`;
    const startBar = optBoundedNumber(a, 'startBar', 0, 10_000);
    const { commands, applied, samples } = planToCommands(this.store.project, plan, {
      startBar: startBar === undefined ? undefined : Math.floor(startBar),
      setTransport: optBoolean(a, 'setTempo') ?? true,
    });
    this.dispatchBatch(label, commands);
    await this.host?.loadSamples?.(samples);
    this.last = { plan, applied, profile };
    return this.describe(plan, applied);
  }

  private describe(plan: BeatPlan, applied: AppliedBeat | null): string {
    const project = this.store.project;
    const lines = [`${describePlan(plan)} · semilla ${plan.seed} · swing ${plan.swing}`];
    const degrees = plan.progression.map((d) => ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'][d]).join('-');
    lines.push(`Progresión (grados): ${degrees}. Forma: ${plan.sections.map((s) => `${s.name} ${s.bars}c`).join(' → ')}.`);
    for (const part of plan.parts) {
      const notes = part.patterns.reduce((s, p) => s + p.notes.length, 0);
      const sound = `${part.sound.kind}${part.sound.preset ? ` «${part.sound.preset}»` : ''}`;
      const a = applied?.parts.find((x) => x.role === part.role);
      const where = a
        ? ` → canal "${project.channels[a.channelId]?.name}" id=${a.channelId}, mixer ${a.mixerTrack}, patrones ${Object.values(a.patterns).join(',')}`
        : '';
      lines.push(`- ${part.role}: ${sound}, ${part.patterns.length} patrones, ${notes} notas, ${part.clips.length} clips${where}`);
    }
    if (applied) {
      lines.push(`Montado desde el compás ${applied.startBar} en UN paso de undo. Para cambiar una parte: recompose_part.`);
    }
    if (plan.style) {
      lines.push(`Estilo «${plan.style.profile}»: ${plan.style.matched} pistas encajan con el género, ${plan.style.grooved} aportan groove; influencia ${plan.style.influence}.`);
    }
    return lines.join('\n');
  }

  async composeBeatTool(a: Record<string, unknown>): Promise<string> {
    const genre = reqString(a, 'genre');
    if (!isComposerGenre(genre)) throw new ToolError(`genre "${genre}" desconocido (${COMPOSER_GENRES.join(', ')})`);
    const profile = await this.findProfile(optString(a, 'profile'));
    const opts = this.composeOptions(a, profile, genre);
    return this.composeAndApply(a, opts, profile, `Componer beat ${presetLabel(genre, opts.variant)}`);
  }

  // ── recompose_part ─────────────────────────────────────────────────────────

  async recomposePartTool(a: Record<string, unknown>): Promise<string> {
    const role = reqString(a, 'part');
    if (!isComposerRole(role)) throw new ToolError(`part "${role}" desconocida (${COMPOSER_ROLES.join(', ')})`);
    if (!this.last) throw new ToolError('No hay beat compuesto en esta sesión: usa compose_beat primero');
    const target = this.last.applied.parts.find((p) => p.role === role);
    if (!target) throw new ToolError(`El último beat no tiene la parte "${role}"`);
    if (!this.store.project.channels[target.channelId]) {
      throw new ToolError(`El canal de "${role}" ya no está en el proyecto (lo borraron): compón otro beat`);
    }
    const seed = seedOf(a);
    const fresh = recomposePart(this.last.plan, role, seed, {
      profile: this.last.profile,
      complexity: optBoundedNumber(a, 'complexity', 0, 1),
      soundVariation: optBoundedNumber(a, 'soundVariation', 0, 1),
    });
    if (!fresh) throw new ToolError(`Con esa semilla la parte "${role}" sale vacía; prueba otra`);
    const sound = optBoolean(a, 'newSound') ?? false;
    const commands = replacePartCommands(this.store.project, target, fresh, { sound });
    if (commands.length === 0) throw new ToolError('Los patrones de esa parte ya no existen');
    this.dispatchBatch(`Recomponer ${ROLE_LABELS[role]}`, commands);
    await this.host?.loadSamples?.(registered(commands));
    this.last = {
      ...this.last,
      plan: { ...this.last.plan, parts: this.last.plan.parts.map((p) => (p.role === role ? fresh : p)) },
    };
    const notes = fresh.patterns.reduce((s, p) => s + p.notes.length, 0);
    return `${ROLE_LABELS[role]} recompuesta con semilla ${seed}: ${notes} notas en ${fresh.patterns.length} patrones${sound ? ', sonido nuevo' : ''}. Un paso de undo.`;
  }

  // ── Perfiles de estilo ─────────────────────────────────────────────────────

  async listProfilesTool(): Promise<string> {
    const profiles = await this.requireHost().listProfiles();
    if (profiles.length === 0) return 'No hay perfiles de estilo. Crea uno con learn_style (o desde el panel Compositor → Entrenar).';
    return profiles
      .map((p) => {
        const tracks = p.tracks
          .slice(0, 12)
          .map((t) => `  · ${t.name}: ${t.bpm === null ? '? BPM' : `${Math.round(t.bpm)} BPM`}${t.keyRoot === null ? '' : ` ${NOTE_LABELS[t.keyRoot]} ${t.keyMode === 'major' ? 'mayor' : 'menor'}`}, swing ${t.swing}, brillo ${t.brightness}, suciedad ${t.grit} → suena a ${guessGenre(t)}`)
          .join('\n');
        return `${profileSummary(p)}\n${tracks}`;
      })
      .join('\n');
  }

  private async measure(refs: unknown[]): Promise<{ ok: TrackFeatures[]; failed: string[] }> {
    const host = this.requireHost();
    const ok: TrackFeatures[] = [];
    const failed: string[] = [];
    for (const r of refs) {
      if (typeof r !== 'string' || r.length === 0 || r.length > 500) throw new ToolError('cada sample es un id o nombre (texto)');
      const res = await host.analyzeSample(r);
      if (res.features) ok.push(res.features);
      else failed.push(res.name || r);
    }
    return { ok, failed };
  }

  async learnStyleTool(a: Record<string, unknown>): Promise<string> {
    const host = this.requireHost();
    const refs = reqArray(a, 'samples');
    if (refs.length === 0 || refs.length > MAX_LEARN_SAMPLES) throw new ToolError(`samples: de 1 a ${MAX_LEARN_SAMPLES}`);
    const name = optString(a, 'name') ?? 'Mi estilo';
    const { ok, failed } = await this.measure(refs);
    if (ok.length === 0) throw new ToolError(`No se pudo medir ninguno (${failed.join(', ')}): ¿son audios con batería de más de 6 s?`);
    const existing = await this.findProfile(optString(a, 'profile')).catch(() => null);
    const profile = existing
      ? extendProfile(existing, ok)
      : createProfile(`perfil-${Date.now().toString(36)}`, name, ok, Date.now());
    await host.saveProfile(profile);
    return (
      `Perfil ${existing ? 'ampliado' : 'creado'}: ${profileSummary(profile)} (máximo ${MAX_PROFILE_TRACKS} pistas).` +
      (failed.length > 0 ? ` Sin datos: ${failed.join(', ')}.` : '') +
      ` Úsalo con compose_beat profile="${profile.name}".`
    );
  }

  async analyzeReferenceTool(a: Record<string, unknown>): Promise<string> {
    const ref = reqString(a, 'sample');
    const { ok, failed } = await this.measure([ref]);
    const t = ok[0];
    if (!t) throw new ToolError(`No se pudo medir "${failed[0] ?? ref}"`);
    const fmt = (lane: number[]): string => lane.map((v) => (v > 0.6 ? 'X' : v > 0.35 ? 'x' : v > 0.15 ? '·' : '-')).join('');
    return [
      `Referencia "${t.name}": ${t.bpm === null ? 'tempo sin medir' : `${t.bpm} BPM (confianza ${t.bpmConfidence})`}` +
        (t.bpmCandidates?.length ? `, otros tempos posibles ${t.bpmCandidates.join(', ')}` : ''),
      `Tonalidad: ${t.keyRoot === null ? 'sin medir' : `${NOTE_LABELS[t.keyRoot]} ${t.keyMode === 'major' ? 'mayor' : 'menor'} (confianza ${t.keyConfidence})`}`,
      `Groove por semicorchea (X fuerte · x a menudo · · a veces):`,
      `  grave ${fmt(t.lanes.low)}  medio ${fmt(t.lanes.mid)}  agudo ${fmt(t.lanes.high)}`,
      `Swing ${t.swing} · brillo ${t.brightness} · suciedad ${t.grit} · golpes/compás ${JSON.stringify(t.density)}`,
      `Suena a: ${guessGenre(t)} (sugerencia). Para sacar beats con esta temática: compose_from_reference.`,
    ].join('\n');
  }

  async composeFromReferenceTool(a: Record<string, unknown>): Promise<string> {
    const ref = reqString(a, 'sample');
    const { ok, failed } = await this.measure([ref]);
    const t = ok[0];
    if (!t) throw new ToolError(`No se pudo medir "${failed[0] ?? ref}"`);
    const rawGenre = optString(a, 'genre');
    if (rawGenre !== undefined && !isComposerGenre(rawGenre)) throw new ToolError(`genre "${rawGenre}" desconocido (${COMPOSER_GENRES.join(', ')})`);
    const genre: ComposerGenre = (rawGenre as ComposerGenre | undefined) ?? guessGenre(t);
    const profile = createProfile(`ref-${Date.now().toString(36)}`, t.name, [t], Date.now());
    const opts = this.composeOptions(a, profile, genre);
    if (opts.influence === undefined) opts.influence = 0.7;
    return this.composeAndApply(a, opts, profile, `Beat con la temática de "${t.name}"`);
  }
}
