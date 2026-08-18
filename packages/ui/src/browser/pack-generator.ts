/**
 * Genera un pack de sonidos con el motor de la app y lo deja en el disco.
 *
 * Las recetas (QUÉ hay que renderizar) viven en @orbit/sound-library, puras y
 * probadas; aquí está lo que ensucia: pasar cada proyecto por `renderProject`
 * —el mismo KernelCore que suena en vivo, así que el pack suena EXACTAMENTE
 * como sonaría dentro del proyecto—, dejar cada sonido presentable (pico a
 * -1 dBFS, cola recortada y fade anti-click), escribir los WAV con su
 * manifest en userData/packs/<slug>/ y decir cómo ha quedado.
 *
 * El formato del manifest es el MISMO del pack de fábrica: el browser no tiene
 * que aprender nada nuevo para enseñarlos.
 */

import { encodeWav, renderProject } from '@orbit/engine';
import {
  loadManifest,
  planPack,
  type PackPlan,
  type PackRequest,
  type SoundEntry,
  type SoundManifest,
} from '@orbit/sound-library';
import { nextPaint } from '../state/next-paint';

const SAMPLE_RATE = 44100;
/** Pico al que se normaliza cada sonido. */
const PEAK_DB = -1;
/** Por debajo de esto se considera cola muerta y se corta. */
const TAIL_DB = -60;
/** Margen que se deja tras el último pico audible. */
const TAIL_PAD_SEC = 0.05;
/** Fade de salida (anti-click). */
const FADE_MS = 5;

export interface GeneratedPack {
  slug: string;
  name: string;
  /** Sonidos escritos. */
  count: number;
  /** Carpeta donde han quedado. */
  dir: string;
  /** Duración total del pack en segundos. */
  seconds: number;
}

/**
 * Avisos de "hay packs nuevos". El browser los pinta de lo que lee al montarse,
 * pero un pack puede nacer sin que nadie toque su botón — lo pide Claude por
 * su tool— y entonces la lista se quedaba vieja: el modelo decía "ya está en
 * el browser" y en el browser no había nada.
 */
const listeners = new Set<() => void>();

export function onPacksChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyPacksChanged(): void {
  for (const cb of [...listeners]) cb();
}

export interface GeneratePackOptions {
  /** Aviso de progreso ("3 / 12 · Hat drill 03"). */
  onProgress?: (done: number, total: number, name: string) => void;
  /** Slugs que ya existen; el pack nuevo se aparta para no pisarlos. */
  taken?: readonly string[];
}

function peakOf(left: Float32Array, right: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const l = Math.abs(left[i]!);
    const r = Math.abs(right[i]!);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

/** Normaliza al pico objetivo; devuelve false si el render salió mudo. */
function normalize(left: Float32Array, right: Float32Array): boolean {
  const peak = peakOf(left, right);
  if (peak <= 1e-6) return false;
  const gain = Math.pow(10, PEAK_DB / 20) / peak;
  for (let i = 0; i < left.length; i++) {
    left[i] = left[i]! * gain;
    right[i] = right[i]! * gain;
  }
  return true;
}

/** Corta el silencio final (y respeta el tope de duración de la receta). */
function trim(
  left: Float32Array,
  right: Float32Array,
  maxSec: number,
): [Float32Array, Float32Array] {
  const threshold = Math.pow(10, TAIL_DB / 20);
  let last = -1;
  for (let i = left.length - 1; i >= 0; i--) {
    if (Math.abs(left[i]!) > threshold || Math.abs(right[i]!) > threshold) {
      last = i;
      break;
    }
  }
  const audible = last < 0 ? left.length : last + 1 + Math.round(TAIL_PAD_SEC * SAMPLE_RATE);
  const end = Math.max(1, Math.min(left.length, audible, Math.round(maxSec * SAMPLE_RATE)));
  return [left.slice(0, end), right.slice(0, end)];
}

/** Fade lineal de salida sobre el final del buffer. */
function fadeOut(left: Float32Array, right: Float32Array): void {
  const n = Math.min(left.length, Math.round((FADE_MS / 1000) * SAMPLE_RATE));
  const from = left.length - n;
  for (let i = 0; i < n; i++) {
    const gain = 1 - (i + 1) / n;
    left[from + i] = left[from + i]! * gain;
    right[from + i] = right[from + i]! * gain;
  }
}

/** Slug libre: si "hats-de-drill" está cogido, prueba "-2", "-3"… */
function freeSlug(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Renderiza el plan entero y lo escribe. Devuelve el resumen; lanza si el
 * puente de Electron no está (en web no hay dónde escribir) o si un sonido
 * sale mudo — eso siempre es una receta rota, no un caso de uso.
 */
export async function renderPackPlan(
  plan: PackPlan,
  opts: GeneratePackOptions = {},
): Promise<GeneratedPack> {
  const api = window.orbit;
  if (!api) throw new Error('Los packs se generan dentro de la app de escritorio');

  const slug = freeSlug(plan.slug, opts.taken ?? []);
  const files: { path: string; data: Uint8Array }[] = [];
  const entries: SoundEntry[] = [];
  let seconds = 0;

  for (let i = 0; i < plan.sounds.length; i++) {
    const spec = plan.sounds[i]!;
    opts.onProgress?.(i, plan.sounds.length, spec.name);
    // Un respiro entre sonidos: el render es síncrono y sin esto la ventana
    // se queda congelada mientras se hace un pack de 32.
    await nextPaint();

    const result = renderProject(spec.project, {
      sampleRate: SAMPLE_RATE,
      tailSeconds: spec.tail,
    });
    if (!normalize(result.left, result.right)) {
      throw new Error(`"${spec.name}" salió en silencio`);
    }
    const [left, right] = trim(result.left, result.right, spec.maxSec);
    fadeOut(left, right);
    const durationSec = left.length / SAMPLE_RATE;
    seconds += durationSec;

    files.push({ path: spec.file, data: encodeWav(left, right, SAMPLE_RATE) });
    const entry: SoundEntry = {
      id: `${slug}/${spec.id}`,
      name: spec.name,
      category: spec.category,
      file: spec.file,
      tags: spec.tags,
      durationSec: Math.round(durationSec * 1000) / 1000,
      gainSuggestion: spec.gainSuggestion,
    };
    if (spec.subcategory !== undefined) entry.subcategory = spec.subcategory;
    if (spec.keyRoot !== undefined) entry.keyRoot = spec.keyRoot;
    entries.push(entry);
  }

  const manifest: SoundManifest = {
    version: '1.0.0',
    pack: plan.name,
    generatedWith: `Orbit Studio — planPack(${plan.family}/${plan.style})`,
    entries,
  };
  files.push({
    path: 'manifest.json',
    data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  const saved = await api.pack.save(slug, files);
  notifyPacksChanged();
  opts.onProgress?.(plan.sounds.length, plan.sounds.length, plan.name);
  return {
    slug,
    name: plan.name,
    count: entries.length,
    dir: saved.dir,
    seconds: Math.round(seconds * 100) / 100,
  };
}

/**
 * Entradas de un pack tal y como las entiende el resto de la app: el manifest
 * guarda rutas relativas a SU carpeta, así que aquí se les antepone el pack
 * (y el esquema `pack:` al id) para que loadIntoEngine sepa por dónde leerlas.
 * Lo usan el browser y el puente de Claude: una sola forma de prefijar.
 */
export function packEntries(slug: string, manifest: SoundManifest): SoundEntry[] {
  return manifest.entries.map((entry) => ({
    ...entry,
    id: `pack:${entry.id}`,
    file: `${slug}/${entry.file}`,
    tags: [...entry.tags, 'generado'],
  }));
}

/** Entradas de un pack ya escrito, leídas de su manifest en el disco. */
export async function readPackEntries(slug: string): Promise<SoundEntry[]> {
  const packs = (await window.orbit?.pack.list()) ?? [];
  const found = packs.find((p) => p.slug === slug);
  if (!found) return [];
  return packEntries(slug, loadManifest(found.manifest));
}

/** Encargo → pack en el disco (planificar + renderizar + escribir). */
export async function generatePack(
  request: PackRequest,
  opts: GeneratePackOptions = {},
): Promise<GeneratedPack> {
  const taken = opts.taken ?? (await window.orbit?.pack.list().catch(() => []))?.map((p) => p.slug) ?? [];
  return renderPackPlan(planPack(request), { ...opts, taken });
}
