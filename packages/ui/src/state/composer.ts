/**
 * Estado del compositor de beats en el renderer.
 *
 * Aquí se junta lo que el paquete puro no puede hacer: leer audio (carpeta
 * elegida, archivo soltado, sample del proyecto o de la librería), medirlo en
 * un worker, guardar los perfiles en settings.json y despachar el beat por el
 * bus de comandos. La música la decide `@orbit/sound-library`; esto solo la
 * trae y la lleva.
 *
 * Lo usan el panel Compositor y el puente de Claude (`composerHost()`): las
 * dos puertas miden con el mismo código y guardan en el mismo sitio, así que
 * un perfil entrenado desde el panel lo ve Claude, y al revés.
 */

import { create } from 'zustand';
import {
  composeBeat,
  createProfile,
  describePlan,
  extendProfile,
  extractTrackFeatures,
  loadManifest,
  parseProfile,
  planToCommands,
  recomposePart,
  replacePartCommands,
  trackDisplayName,
  type AppliedBeat,
  type BeatPlan,
  type ComposeOptions,
  type ComposerRole,
  type SoundEntry,
  type StyleProfile,
  type TrackFeatures,
} from '@orbit/sound-library';
import type { ComposerHost } from '@orbit/claude-bridge';
import { store } from './app';
import { decodeToMono } from './audio-analysis';
import { readSampleBytes } from '../browser/sample-io';
import { packEntries } from '../browser/pack-generator';
import { pathOf } from '../browser/sound-actions';
import { MAX_TRAIN_FILES, isAudioFileName, parseForm, rollSeed, type ComposerForm } from '../composer/composer-form';
import type { ComposerWorkerRequest, ComposerWorkerResponse } from '../composer/composer-worker-protocol';

const PROFILES_KEY = 'composerProfiles';
const FORM_KEY = 'composerForm';

export interface TrainingProgress {
  done: number;
  total: number;
  current: string;
}

interface ComposerState {
  form: ComposerForm;
  profiles: StyleProfile[];
  loaded: boolean;
  /** Referencia soltada en el panel (perfil de una pista, no se guarda). */
  reference: StyleProfile | null;
  training: TrainingProgress | null;
  busy: boolean;
  /** Última línea que contar (qué se compuso, qué se aprendió, qué falló). */
  status: string | null;
  error: string | null;
  /** El último beat montado, para «otra melodía». */
  last: { plan: BeatPlan; applied: AppliedBeat; options: ComposeOptions } | null;
}

export const useComposerStore = create<ComposerState>(() => ({
  form: parseForm(null, rollSeed()),
  profiles: [],
  loaded: false,
  reference: null,
  training: null,
  busy: false,
  status: null,
  error: null,
  last: null,
}));

// ── Persistencia ─────────────────────────────────────────────────────────────

let loading: Promise<void> | null = null;

export function loadComposer(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const settings = (await window.orbit?.settings.get().catch(() => null)) as Record<string, unknown> | null;
    const rawProfiles = settings?.[PROFILES_KEY];
    const profiles = Array.isArray(rawProfiles)
      ? rawProfiles.map(parseProfile).filter((p): p is StyleProfile => p !== null)
      : [];
    const form = parseForm(settings?.[FORM_KEY], rollSeed());
    if (form.profileId && !profiles.some((p) => p.id === form.profileId)) form.profileId = null;
    useComposerStore.setState({ profiles, form, loaded: true });
  })();
  return loading;
}

async function persistProfiles(profiles: StyleProfile[]): Promise<void> {
  await window.orbit?.settings.set({ [PROFILES_KEY]: profiles });
}

let formTimer: ReturnType<typeof setTimeout> | null = null;

export function updateForm(patch: Partial<ComposerForm>): void {
  const form = { ...useComposerStore.getState().form, ...patch };
  useComposerStore.setState({ form });
  if (formTimer) clearTimeout(formTimer);
  formTimer = setTimeout(() => {
    // La semilla no se guarda: abrir el panel otro día no debe repetir el beat.
    const rest: Partial<ComposerForm> = { ...form };
    delete rest.seed;
    void window.orbit?.settings.set({ [FORM_KEY]: rest });
  }, 400);
}

export async function saveProfile(profile: StyleProfile): Promise<void> {
  await loadComposer();
  const profiles = [...useComposerStore.getState().profiles];
  const i = profiles.findIndex((p) => p.id === profile.id);
  if (i >= 0) profiles[i] = profile;
  else profiles.push(profile);
  useComposerStore.setState({ profiles });
  await persistProfiles(profiles);
}

export async function deleteProfile(id: string): Promise<void> {
  const state = useComposerStore.getState();
  const profiles = state.profiles.filter((p) => p.id !== id);
  useComposerStore.setState({
    profiles,
    form: state.form.profileId === id ? { ...state.form, profileId: null } : state.form,
  });
  await persistProfiles(profiles);
}

// ── Medir audio ──────────────────────────────────────────────────────────────

function measureInWorker(request: ComposerWorkerRequest): Promise<TrackFeatures | null> {
  if (typeof Worker !== 'function') return Promise.resolve(extractTrackFeatures(request.mono, request.sampleRate, request.name));
  let worker: Worker;
  try {
    worker = new Worker(new URL('../composer/composer-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return Promise.resolve(extractTrackFeatures(request.mono, request.sampleRate, request.name));
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ComposerWorkerResponse>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.features);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'El medidor se detuvo.'));
    };
    worker.postMessage(request, [request.mono.buffer]);
  });
}

/** Mide unos bytes de audio. `null` = no hay nada que aprender (corto, silencio). */
export async function measureBytes(bytes: ArrayBuffer, name: string): Promise<TrackFeatures | null> {
  const { mono, sampleRate } = await decodeToMono(bytes);
  // Si el canal es el del AudioBuffer (archivo mono), se copia antes de
  // transferirlo: transferir un buffer que el contexto aún posee falla.
  const own = mono.byteOffset === 0 && mono.byteLength === mono.buffer.byteLength ? mono : mono.slice();
  return measureInWorker({ mono: own, sampleRate, name: trackDisplayName(name) });
}

/** Lee un sample del proyecto (id o nombre) o un sonido de la librería (id). */
async function bytesOfRef(ref: string): Promise<{ name: string; bytes: ArrayBuffer | null }> {
  const project = store.project;
  const lower = ref.toLowerCase();
  const sample = Object.hasOwn(project.samples, ref)
    ? project.samples[ref]
    : Object.values(project.samples).find((s) => s.name.toLowerCase() === lower);
  if (sample) return { name: sample.name, bytes: await readSampleBytes(sample.path) };

  const api = window.orbit;
  const entries: SoundEntry[] = [];
  const factory = await api?.library.manifest().catch(() => null);
  if (factory) {
    try {
      entries.push(...loadManifest(factory).entries);
    } catch {
      // manifest a medias: se busca en lo demás
    }
  }
  for (const raw of (await api?.pack.list().catch(() => [])) ?? []) {
    try {
      entries.push(...packEntries(raw.slug, loadManifest(raw.manifest)));
    } catch {
      // ídem
    }
  }
  const entry = entries.find((e) => e.id === ref) ?? entries.find((e) => e.name.toLowerCase() === lower);
  if (!entry) return { name: ref, bytes: null };
  return { name: entry.name, bytes: await readSampleBytes(pathOf(entry, entry.file)) };
}

// ── Entrenar ─────────────────────────────────────────────────────────────────

/** Mide una lista de fuentes y crea (o amplía) un perfil. */
async function train(
  sources: { name: string; read: () => Promise<ArrayBuffer | null> }[],
  name: string,
  extendId: string | null,
): Promise<void> {
  await loadComposer();
  const list = sources.slice(0, MAX_TRAIN_FILES);
  if (list.length === 0) {
    useComposerStore.setState({ error: 'No hay audios (.wav, .mp3, .ogg, .flac) para medir.' });
    return;
  }
  useComposerStore.setState({ training: { done: 0, total: list.length, current: list[0]!.name }, error: null, status: null });
  const measured: TrackFeatures[] = [];
  const failed: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const src = list[i]!;
    useComposerStore.setState({ training: { done: i, total: list.length, current: src.name } });
    try {
      const bytes = await src.read();
      const features = bytes ? await measureBytes(bytes, src.name) : null;
      if (features) measured.push(features);
      else failed.push(src.name);
    } catch {
      failed.push(src.name);
    }
  }
  useComposerStore.setState({ training: null });
  if (measured.length === 0) {
    useComposerStore.setState({ error: `No se pudo aprender de ninguno (${failed.length} sin datos: ¿audios muy cortos o sin batería?).` });
    return;
  }
  const existing = extendId ? useComposerStore.getState().profiles.find((p) => p.id === extendId) : undefined;
  const profile = existing
    ? extendProfile(existing, measured)
    : createProfile(`perfil-${Date.now().toString(36)}`, name, measured, Date.now());
  await saveProfile(profile);
  updateForm({ profileId: profile.id });
  const skipped = sources.length > MAX_TRAIN_FILES ? ` (solo los primeros ${MAX_TRAIN_FILES})` : '';
  useComposerStore.setState({
    status: `Perfil «${profile.name}»: ${measured.length} pistas aprendidas${skipped}${failed.length ? `, ${failed.length} sin datos` : ''}.`,
  });
}

/** Elige una carpeta y aprende de sus audios. */
export async function trainFromFolder(name: string, extendId: string | null = null): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  const dir = await api.folder.pick();
  if (!dir) return;
  await api.folder.register(dir);
  const files = (await api.folder.scan(dir)).filter((f) => isAudioFileName(f.file));
  await train(
    files.map((f) => ({ name: f.name, read: () => api.folder.read(f.file) })),
    name,
    extendId,
  );
}

/** Aprende de archivos soltados en el panel. */
export async function trainFromFiles(files: readonly File[], name: string, extendId: string | null = null): Promise<void> {
  await train(
    files.filter((f) => isAudioFileName(f.name)).map((f) => ({ name: f.name, read: () => f.arrayBuffer() })),
    name,
    extendId,
  );
}

/** Mide un archivo soltado como referencia (no se guarda como perfil). */
export async function setReferenceFile(file: File): Promise<void> {
  if (!isAudioFileName(file.name)) {
    useComposerStore.setState({ error: 'La referencia tiene que ser un audio (.wav, .mp3, .ogg o .flac).' });
    return;
  }
  useComposerStore.setState({ busy: true, error: null, status: `Midiendo «${file.name}»…` });
  try {
    const features = await measureBytes(await file.arrayBuffer(), file.name);
    if (!features) throw new Error('No hay nada que medir: ¿audio muy corto o en silencio?');
    useComposerStore.setState({
      reference: createProfile(`ref-${Date.now().toString(36)}`, features.name, [features], Date.now()),
      status: `Referencia «${features.name}» lista: el próximo beat saldrá con su temática.`,
    });
  } catch (error) {
    useComposerStore.setState({ error: error instanceof Error ? error.message : 'No se pudo medir la referencia.', status: null });
  } finally {
    useComposerStore.setState({ busy: false });
  }
}

export function clearReference(): void {
  useComposerStore.setState({ reference: null, status: null });
}

// ── Componer ─────────────────────────────────────────────────────────────────

/** Compone y monta el beat en el proyecto (un paso de undo). */
export function composeIntoProject(options: ComposeOptions): BeatPlan | null {
  try {
    const plan = composeBeat(options);
    const { commands, applied } = planToCommands(store.project, plan);
    const label = `Componer beat (${describePlan(plan).split(' · ')[0]})`;
    store.dispatch({ type: 'batch', label, commands }, { label });
    useComposerStore.setState({
      last: { plan, applied, options },
      status: `${describePlan(plan)} · semilla ${plan.seed}. Ctrl+Z lo deshace entero.`,
      error: null,
    });
    return plan;
  } catch (error) {
    useComposerStore.setState({ error: error instanceof Error ? error.message : 'No se pudo componer.' });
    return null;
  }
}

/** Recompone una parte del último beat con otra semilla. */
export function recomposeLast(role: ComposerRole, newSound: boolean): void {
  const last = useComposerStore.getState().last;
  if (!last) return;
  const target = last.applied.parts.find((p) => p.role === role);
  if (!target || !store.project.channels[target.channelId]) {
    useComposerStore.setState({ error: 'Esa parte ya no está en el proyecto: compón otro beat.' });
    return;
  }
  const seed = rollSeed();
  const part = recomposePart(last.plan, role, seed, {
    profile: last.options.profile ?? null,
    ...(last.options.influence !== undefined ? { influence: last.options.influence } : {}),
    ...(last.options.complexity !== undefined ? { complexity: last.options.complexity } : {}),
    ...(last.options.soundVariation !== undefined ? { soundVariation: last.options.soundVariation } : {}),
  });
  if (!part) {
    useComposerStore.setState({ error: 'Con esa semilla la parte salió vacía; prueba otra vez.' });
    return;
  }
  const commands = replacePartCommands(store.project, target, part, { sound: newSound });
  if (commands.length === 0) return;
  const label = `Recomponer ${part.name}`;
  store.dispatch({ type: 'batch', label, commands }, { label });
  useComposerStore.setState({
    last: { ...last, plan: { ...last.plan, parts: last.plan.parts.map((p) => (p.role === role ? part : p)) } },
    status: `${part.name} nueva (semilla ${seed})${newSound ? ' con otro sonido' : ''}. Ctrl+Z la devuelve.`,
    error: null,
  });
}

// ── Puente de Claude ─────────────────────────────────────────────────────────

/** Lo que el MCP necesita para medir audio y guardar perfiles. */
export function composerHost(): ComposerHost {
  return {
    async listProfiles() {
      await loadComposer();
      return useComposerStore.getState().profiles;
    },
    saveProfile,
    async analyzeSample(ref) {
      const { name, bytes } = await bytesOfRef(ref);
      if (!bytes) return { name, features: null };
      try {
        return { name, features: await measureBytes(bytes, name) };
      } catch {
        return { name, features: null };
      }
    },
  };
}
