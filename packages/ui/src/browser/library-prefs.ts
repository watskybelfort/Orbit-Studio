/**
 * Preferencias del browser de sonidos: favoritos, colecciones, volumen de
 * preview y el caché del análisis automático (BPM/tonalidad).
 *
 * Persistencia: el MISMO mecanismo que el tema y las carpetas del usuario —
 * `window.orbit.settings` (merge superficial sobre settings.json del main).
 * Fuera de Electron (vite web, tests) cae a `localStorage` para que la vista
 * siga siendo usable; si tampoco lo hay, todo vive en memoria.
 *
 * El store es zustand como el resto del estado de UI, así los componentes se
 * resuscriben solos. Las escrituras van con debounce (200 ms) porque marcar
 * favoritos o mover la perilla del preview dispara muchas seguidas.
 */

import { create } from 'zustand';

/** Claves dentro de settings.json (prefijadas para no chocar con nada). */
const KEY_FAVORITES = 'browserFavorites';
const KEY_COLLECTIONS = 'browserCollections';
const KEY_PREVIEW_GAIN = 'browserPreviewGain';
const KEY_ANALYSIS = 'browserAnalysis';
/** Espejo en localStorage cuando no hay puente de Electron. */
const LS_KEY = 'orbit.browser.prefs';

/** Metadatos estimados de un archivo (clave: la ruta del archivo). */
export interface AnalysisEntry {
  bpm?: number;
  keyRoot?: string;
  mode?: 'major' | 'minor';
  /** Duración real, leída al decodificar (el escaneo de carpeta no la trae). */
  durationSec?: number;
  /** Marca de que ya se intentó: evita reanalizar lo que no dio resultado. */
  done: true;
}

export interface LibraryPrefs {
  /** Ids de sonidos marcados con estrella. */
  favorites: ReadonlySet<string>;
  /** Colección → ids de sonidos, en orden de añadido. */
  collections: Readonly<Record<string, string[]>>;
  /** Ganancia lineal del preview, 0..1.5 (1 = el nivel sugerido del sample). */
  previewGain: number;
  /** Caché del análisis automático por ruta de archivo. */
  analysis: Readonly<Record<string, AnalysisEntry>>;
  /** Las preferencias ya se leyeron de disco (evita pisar con los valores por defecto). */
  loaded: boolean;
}

export const usePrefs = create<LibraryPrefs>(() => ({
  favorites: new Set<string>(),
  collections: {},
  previewGain: 1,
  analysis: {},
  loaded: false,
}));

// ── Persistencia ─────────────────────────────────────────────────────────────

function readLocal(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeLocal(patch: Record<string, unknown>): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    store.setItem(LS_KEY, JSON.stringify({ ...readLocal(), ...patch }));
  } catch {
    // cuota llena o storage bloqueado: las preferencias se quedan en memoria
  }
}

let pendiente: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/** Encola un patch y lo escribe agrupado (settings.set hace merge superficial). */
function persist(patch: Record<string, unknown>): void {
  pendiente = { ...pendiente, ...patch };
  if (timer !== null) return;
  timer = setTimeout(() => {
    const payload = pendiente;
    pendiente = {};
    timer = null;
    const api = window.orbit;
    if (api) void api.settings.set(payload).catch(() => writeLocal(payload));
    else writeLocal(payload);
  }, 200);
}

function toStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

function parseCollections(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim() !== '') out[name] = toStringArray(ids);
  }
  return out;
}

function parseAnalysis(raw: unknown): Record<string, AnalysisEntry> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, AnalysisEntry> = {};
  for (const [file, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    const entry: AnalysisEntry = { done: true };
    if (typeof r['bpm'] === 'number' && r['bpm'] > 0) entry.bpm = r['bpm'];
    if (typeof r['keyRoot'] === 'string') entry.keyRoot = r['keyRoot'];
    if (r['mode'] === 'major' || r['mode'] === 'minor') entry.mode = r['mode'];
    if (typeof r['durationSec'] === 'number' && r['durationSec'] > 0) {
      entry.durationSec = r['durationSec'];
    }
    out[file] = entry;
  }
  return out;
}

/** Carga las preferencias persistidas al store (una vez, al montar el browser). */
export async function loadPrefs(): Promise<void> {
  if (usePrefs.getState().loaded) return;
  let settings: Record<string, unknown> = {};
  try {
    settings = (await window.orbit?.settings.get()) ?? readLocal();
  } catch {
    settings = readLocal();
  }
  const gain = settings[KEY_PREVIEW_GAIN];
  usePrefs.setState({
    favorites: new Set(toStringArray(settings[KEY_FAVORITES])),
    collections: parseCollections(settings[KEY_COLLECTIONS]),
    previewGain: typeof gain === 'number' && gain >= 0 ? Math.min(1.5, gain) : 1,
    analysis: parseAnalysis(settings[KEY_ANALYSIS]),
    loaded: true,
  });
}

// ── Acciones ─────────────────────────────────────────────────────────────────

export function toggleFavorite(soundId: string): void {
  const next = new Set(usePrefs.getState().favorites);
  if (next.has(soundId)) next.delete(soundId);
  else next.add(soundId);
  usePrefs.setState({ favorites: next });
  persist({ [KEY_FAVORITES]: [...next] });
}

export function createCollection(name: string): void {
  const clean = name.trim();
  const { collections } = usePrefs.getState();
  if (clean === '' || collections[clean] !== undefined) return;
  const next = { ...collections, [clean]: [] };
  usePrefs.setState({ collections: next });
  persist({ [KEY_COLLECTIONS]: next });
}

export function deleteCollection(name: string): void {
  const next = { ...usePrefs.getState().collections };
  if (next[name] === undefined) return;
  delete next[name];
  usePrefs.setState({ collections: next });
  persist({ [KEY_COLLECTIONS]: next });
}

/** Añade o quita un sonido de una colección (crea la colección si hace falta). */
export function toggleInCollection(name: string, soundId: string): void {
  const { collections } = usePrefs.getState();
  const list = collections[name] ?? [];
  const next = {
    ...collections,
    [name]: list.includes(soundId) ? list.filter((id) => id !== soundId) : [...list, soundId],
  };
  usePrefs.setState({ collections: next });
  persist({ [KEY_COLLECTIONS]: next });
}

export function setPreviewGain(gain: number): void {
  const clamped = Math.max(0, Math.min(1.5, gain));
  usePrefs.setState({ previewGain: clamped });
  persist({ [KEY_PREVIEW_GAIN]: clamped });
}

/** Guarda el resultado del análisis de un archivo (o el "ya lo intenté"). */
export function rememberAnalysis(file: string, entry: AnalysisEntry): void {
  const next = { ...usePrefs.getState().analysis, [file]: entry };
  usePrefs.setState({ analysis: next });
  persist({ [KEY_ANALYSIS]: next });
}

/** Olvida lo analizado de unas rutas (al quitar una carpeta del browser). */
export function forgetAnalysis(prefix: string): void {
  const { analysis } = usePrefs.getState();
  const next: Record<string, AnalysisEntry> = {};
  let cambio = false;
  for (const [file, v] of Object.entries(analysis)) {
    if (file.startsWith(prefix)) cambio = true;
    else next[file] = v;
  }
  if (!cambio) return;
  usePrefs.setState({ analysis: next });
  persist({ [KEY_ANALYSIS]: next });
}
