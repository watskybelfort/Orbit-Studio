/**
 * El export, sin panel: render offline + escritura de archivos.
 *
 * El panel (ExportPanel) es solo la cara; toda la maquinaria vive aquí para
 * que el mismo export se pueda disparar **sin diálogo** desde un atajo. De ahí
 * salen las dos piezas de este archivo:
 *
 *   · `runExport(path, opts)` — renderiza y escribe (WAV + stems + .mid + mp3
 *     + flac) y devuelve el resumen. No abre ningún diálogo salvo que la ruta
 *     no esté autorizada y se le pida el respaldo.
 *   · `repeatLastExport()` — repite el último export tal cual: misma fuente,
 *     mismas opciones, misma ruta con sufijo incremental (`beat.wav` →
 *     `beat-2.wav` → `beat-3.wav`). Es la función para colgar de Ctrl+E.
 *
 * ## Por qué el sufijo va por contador y no por "¿existe el archivo?"
 * El puente (`window.orbit.file`) sabe escribir, pero no sabe decir si una
 * ruta ya existe. Como el contador se persiste junto al último export, la
 * cuenta sobrevive a reinicios y ningún export pisa al anterior. Si algún día
 * el puente expone `file.exists(path)`, aquí solo hay que cambiar `nextPath`.
 *
 * ## Avisos al usuario
 * Cuando el export no lo lanza el panel (Ctrl+E con la ventana cerrada) hace
 * falta un sitio donde avisar. Se usa el canal global de avisos de la app
 * (`useBounceStore`, el que pinta App.tsx como `.app-notice`), que además da
 * exclusión mutua gratis con "consolidar a audio": los dos bloquean el hilo
 * del renderer mientras renderizan y no deben solaparse.
 */

import { create } from 'zustand';
import { encodeMidi, type Project } from '@orbit/core';
import {
  analyzeMix,
  compileProject,
  encodeFlac,
  encodeFlacStream,
  encodeOggFlac,
  encodeWav,
  gainToTarget,
  renderProject,
  renderStems,
  secondsAtBeat,
  type FlacDepth,
  type RenderResult,
  type WavDepth,
  encodeOpusFile,
} from '@orbit/engine';
import { encodeMp3 } from './mp3';
import { collectPluginSources, collectSamples } from './render-inputs';
import { canUseRenderWorker, renderProjectInWorker, renderStemsInWorker } from './render-in-worker';
import { store } from '../state/app';
import { useBounceStore } from '../state/bounce';
import { nextPaint } from '../state/next-paint';
import { useUiStore } from '../state/ui';

/** Objetivo de loudness para la normalización de streaming. */
export const TARGET_LUFS = -14;
/** Sample rates de export (el kernel renderiza a la que se pida). */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000] as const;
/** MPEG no admite más de 48 kHz: por encima, el MP3 se salta con aviso. */
export const MP3_MAX_RATE = 48000;
/** Opus trabaja a 48 kHz y sólo a 48 kHz: es la frecuencia del modo de CELT. */
export const OPUS_RATE = 48000;

/**
 * Qué se exporta. `selection` es la región marcada en la regla de la playlist
 * (la misma que el loop del transporte): se renderiza la canción entera y se
 * recorta, así que lo que suena antes de la región deja su cola dentro.
 */
export type ExportSource = 'song' | 'pattern' | 'selection';

export interface Region {
  start: number;
  end: number;
}

export interface ExportOptions {
  source: ExportSource;
  /** Patrón a renderizar cuando `source` es 'pattern'. */
  patternId: string | null;
  /** Región en beats cuando `source` es 'selection'. */
  region: Region | null;
  normalize: boolean;
  stems: boolean;
  midi: boolean;
  mp3: boolean;
  flac: boolean;
  /** También un .ogg (Ogg FLAC: sin pérdida, contenedor propio). */
  ogg: boolean;
  /** También un .opus (CELT propio, con pérdida). Sólo a 48 kHz. */
  opus: boolean;
  /** Bitrate del .opus, en bits por segundo. */
  opusBitrate: number;
  depth: WavDepth;
  sampleRate: number;
  tailSeconds: number;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  source: 'song',
  patternId: null,
  region: null,
  normalize: false,
  stems: false,
  midi: true,
  mp3: false,
  flac: false,
  ogg: false,
  opus: false,
  opusBitrate: 128000,
  depth: 16,
  sampleRate: 44100,
  tailSeconds: 2,
};

export interface ExportSummary {
  /** Ruta realmente escrita (puede no ser la pedida si hubo que preguntar). */
  path: string;
  durationSeconds: number;
  peakDb: number;
  lufs: number;
  /** Ganancia de normalización aplicada, o null si no se normalizó. */
  gainDb: number | null;
  stemsWritten: number;
  /** Ruta del .mid exportado junto al WAV, o null si no se pidió/falló. */
  midiPath: string | null;
  /** Ruta del .mp3 exportado junto al WAV, o null si no se pidió/falló. */
  mp3Path: string | null;
  /** Ruta del .flac exportado junto al WAV, o null si no se pidió/falló. */
  flacPath: string | null;
  /** Ruta del .ogg (Ogg FLAC), o null. */
  oggPath: string | null;
  /** Ruta del .opus, o null si no se pidió/falló. */
  opusPath: string | null;
  warnings: string[];
}

/** Aviso de progreso para la UI (el panel pinta "Renderizando…"). */
export type ExportProgress = (label: string) => void;

// ── Utilidades de nombre y ruta ──────────────────────────────────────────────

/** Nombre de archivo seguro en Windows/mac/linux. */
export function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return clean || 'export';
}

/** Slug para sufijos de stems: sin acentos, solo [a-z0-9-]. */
function slugName(name: string): string {
  const s = name
    // NFD separa la tilde de la letra y \p{M} se lleva la tilde: "canción"
    // acaba en "cancion" y no en "canci-n".
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s || 'pista';
}

/** Parte una ruta en base + extensión (la extensión, con el punto). */
function splitExtension(path: string): { base: string; ext: string } {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot > sep + 1) return { base: path.slice(0, dot), ext: path.slice(dot) };
  return { base: path, ext: '' };
}

/** Solo el nombre del archivo de una ruta (para los avisos). */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Ruta de la copia número `n` (1 = la original, 2 = `-2`, 3 = `-3`…).
 * Con esto Ctrl+E nunca pisa lo ya exportado.
 */
export function nextExportPath(path: string, n: number): string {
  if (n <= 1) return path;
  const { base, ext } = splitExtension(path);
  return `${base}-${n}${ext}`;
}

/** Ruta hermana `<base>-<sufijo>.wav` a partir de la elegida en el diálogo. */
function siblingPath(mainPath: string, suffix: string): string {
  const { base } = splitExtension(mainPath);
  return `${base}-${suffix}.wav`;
}

/** Nombre propuesto en el diálogo según lo que se vaya a exportar. */
export function suggestedExportName(project: Project, opts: ExportOptions): string {
  if (opts.source === 'pattern') {
    const pattern = opts.patternId ? project.patterns[opts.patternId] : undefined;
    return `${sanitizeFileName(pattern?.name ?? 'patron')}.wav`;
  }
  const title = project.meta.title.trim() || 'proyecto';
  return `${sanitizeFileName(title)}${opts.source === 'selection' ? '-seleccion' : ''}.wav`;
}

// ── Render ───────────────────────────────────────────────────────────────────

/** Recorta un render a un rango de samples (para exportar la selección). */
function sliceRender(res: RenderResult, s0: number, s1: number): RenderResult {
  return {
    left: res.left.slice(s0, s1),
    right: res.right.slice(s0, s1),
    sampleRate: res.sampleRate,
  };
}

/** Ganancia lineal in situ sobre un render (para normalizar). */
function applyGain(res: RenderResult, db: number): void {
  const g = Math.pow(10, db / 20);
  for (let i = 0; i < res.left.length; i++) {
    res.left[i] = res.left[i]! * g;
    res.right[i] = res.right[i]! * g;
  }
}

/** Pistas de mixer usadas: las que reciben al menos un canal del rack. */
export function usedMixerTracks(project: Project): { idx: number; name: string }[] {
  const used = new Set<number>();
  for (const id of project.channelOrder) {
    const ch = project.channels[id];
    if (ch && ch.mixerTrack >= 0 && ch.mixerTrack < project.mixer.length) {
      used.add(ch.mixerTrack);
    }
  }
  return [...used]
    .sort((a, b) => a - b)
    .map((idx) => ({ idx, name: project.mixer[idx]?.name ?? `Pista ${idx}` }));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** ¿El fallo de escritura es "esa carpeta no está autorizada"? */
function isPathDenied(e: unknown): boolean {
  return /no permitida/i.test(errorText(e));
}

export interface RunExportConfig {
  /** Si la ruta no está autorizada, pedirla por diálogo en vez de fallar. */
  allowDialogFallback?: boolean;
  onProgress?: ExportProgress;
}

/** Un export a la vez: el render bloquea el hilo del renderer. */
let running = false;

/**
 * Renderiza y escribe. `path` es la ruta del WAV principal; el resto de
 * archivos (stems, .mid, .mp3, .flac) son rutas hermanas derivadas de ella.
 */
export async function runExport(
  path: string,
  opts: ExportOptions,
  config: RunExportConfig = {},
): Promise<ExportSummary> {
  const orbit = window.orbit;
  if (!orbit) throw new Error('Exportar requiere la app de escritorio.');
  if (running) throw new Error('Ya hay un export en marcha.');
  running = true;
  try {
    return await renderAndWrite(orbit, path, opts, config);
  } finally {
    running = false;
  }
}

async function renderAndWrite(
  orbit: OrbitApi,
  path: string,
  opts: ExportOptions,
  config: RunExportConfig,
): Promise<ExportSummary> {
  const report = async (label: string): Promise<void> => {
    config.onProgress?.(label);
    await nextPaint();
  };

  // Snapshot del proyecto al empezar (no del último render de React).
  const proj = store.project;
  const warnings: string[] = [];

  const patternId =
    opts.source === 'pattern' && opts.patternId && proj.patterns[opts.patternId]
      ? opts.patternId
      : null;
  if (opts.source === 'pattern' && !patternId) {
    throw new Error('El patrón que se quiere exportar ya no existe en el proyecto.');
  }
  const region = opts.source === 'selection' ? opts.region : null;
  if (opts.source === 'selection' && !region) {
    throw new Error('No hay ninguna región marcada en la playlist.');
  }

  await report('Renderizando…');

  const playMode = patternId ? ({ mode: 'pattern', patternId } as const) : ({ mode: 'song' } as const);
  const compiled = compileProject(proj, playMode);

  const { samples, missing } = await collectSamples(proj, compiled);
  if (missing.length > 0) {
    warnings.push(`Samples no incluidos en el render: ${missing.join(', ')}.`);
  }
  // Plugins JS usados por el mixer: sus fuentes van al render offline.
  const pluginSources = collectPluginSources(proj);
  if (pluginSources.missing.length > 0) {
    warnings.push(`Plugins JS no encontrados (van en bypass): ${pluginSources.missing.join(', ')}.`);
  }

  // Mezcla principal (la fuente Selección renderiza la canción y recorta:
  // así lo que sonaba antes de la región deja su cola dentro del archivo).
  const renderOpts = {
    samples,
    sampleRate: opts.sampleRate,
    tailSeconds: opts.tailSeconds,
    plugins: pluginSources.plugins,
  };
  // El render (donde se ejecutan los plugins JS) va en un worker aislado; en
  // Node/tests, donde no hay Worker, cae al render directo.
  let mix = canUseRenderWorker()
    ? await renderProjectInWorker(compiled, renderOpts)
    : renderProject(compiled, renderOpts);
  // El recorte convierte beats a segundos con el MAPA de tempo, que es con el
  // que se renderizó. Con el tempo plano del proyecto, un marcador que cambie
  // el tempo sacaba la región por otro sitio (en un 120 con marcador a 75, los
  // beats 16→32 salían como 8,0-16,0 s en vez de 12,8-25,6 s). Y si la cuenta
  // se salía del render, se devolvía la canción ENTERA sin decir nada mientras
  // el panel seguía anunciando "Región marcada".
  const cut = (res: RenderResult): RenderResult => {
    if (!region) return res;
    const startSec = secondsAtBeat(compiled.tempoMap, region.start, proj.tempo);
    const endSec = secondsAtBeat(compiled.tempoMap, region.end, proj.tempo);
    const s0 = Math.max(0, Math.floor(startSec * res.sampleRate));
    const s1 = Math.min(res.left.length, Math.ceil(endSec * res.sampleRate));
    if (s1 <= s0) {
      throw new Error('La región marcada cae fuera de lo que suena en la canción.');
    }
    return sliceRender(res, s0, s1);
  };
  mix = cut(mix);

  const analysis = analyzeMix(mix.left, mix.right, mix.sampleRate);
  let gainDb: number | null = null;
  if (opts.normalize) {
    gainDb = gainToTarget(analysis, TARGET_LUFS);
    applyGain(mix, gainDb);
  }
  // Una ganancia lineal desplaza peak y LUFS exactamente en gainDb.
  const finalLufs = analysis.lufsIntegrated + (gainDb ?? 0);
  const finalPeak = analysis.peakDb + (gainDb ?? 0);

  // ── Escritura del WAV principal ────────────────────────────────────────────
  // El main solo autoriza lo elegido en un diálogo y las carpetas de usuario
  // (música, descargas, documentos…). Al repetir un export con sufijo nuevo la
  // ruta puede caer fuera de esa lista: entonces se pregunta una vez.
  let target = path;
  const wav = encodeWav(mix.left, mix.right, mix.sampleRate, opts.depth);
  try {
    await orbit.file.write(target, wav);
  } catch (e) {
    if (!config.allowDialogFallback || !isPathDenied(e)) throw e;
    const chosen = await orbit.file.saveDialog(fileNameOf(target));
    if (!chosen) throw new Error('Export cancelado.');
    target = chosen;
    await orbit.file.write(target, wav);
    warnings.push('Esa carpeta no estaba autorizada: se ha pedido la ruta una vez.');
  }

  // MP3 al lado del WAV (para pasar demos rápido).
  let mp3Path: string | null = null;
  if (opts.mp3 && mix.sampleRate > MP3_MAX_RATE) {
    warnings.push(
      `MP3 solo admite hasta 48 kHz: exporta a 44.1/48 kHz si lo quieres (WAV escrito a ${(mix.sampleRate / 1000).toFixed(1)} kHz).`,
    );
  } else if (opts.mp3) {
    mp3Path = `${splitExtension(target).base}.mp3`;
    try {
      await report('Codificando MP3…');
      await orbit.file.write(mp3Path, encodeMp3(mix.left, mix.right, mix.sampleRate));
    } catch (e) {
      warnings.push(`No se pudo escribir ${mp3Path}: ${errorText(e)}`);
      mp3Path = null;
    }
  }

  // FLAC sin pérdida al lado del WAV (float 32 se escribe a 24 bits).
  let flacPath: string | null = null;
  if (opts.flac) {
    flacPath = `${splitExtension(target).base}.flac`;
    try {
      await report('Codificando FLAC…');
      const flacDepth: FlacDepth = opts.depth === 16 ? 16 : 24;
      if (opts.depth === 32) warnings.push('FLAC no admite float: el .flac va a 24 bits.');
      await orbit.file.write(flacPath, encodeFlac(mix.left, mix.right, mix.sampleRate, flacDepth));
    } catch (e) {
      warnings.push(`No se pudo escribir ${flacPath}: ${errorText(e)}`);
      flacPath = null;
    }
  }

  // OGG al lado del WAV. Es Ogg FLAC: el mismo audio sin pérdida del .flac,
  // en el contenedor que hasta v1.8 estaba descartado por no tener con qué
  // escribirlo (ver render/ogg.ts).
  let oggPath: string | null = null;
  if (opts.ogg) {
    oggPath = `${splitExtension(target).base}.ogg`;
    try {
      await report('Empaquetando OGG…');
      const oggDepth: FlacDepth = opts.depth === 16 ? 16 : 24;
      if (opts.depth === 32) warnings.push('OGG (FLAC) no admite float: el .ogg va a 24 bits.');
      const stream = encodeFlacStream(mix.left, mix.right, mix.sampleRate, oggDepth);
      await orbit.file.write(oggPath, encodeOggFlac(stream));
    } catch (e) {
      warnings.push(`No se pudo escribir ${oggPath}: ${errorText(e)}`);
      oggPath = null;
    }
  }

  // OPUS al lado del WAV, con el encoder propio. Es el único formato con
  // pérdida de Orbit que no depende de nadie: MP3 y Opus salen los dos de aquí,
  // pero éste es un códec entero escrito en casa (ver render/opus/).
  let opusPath: string | null = null;
  if (opts.opus && mix.sampleRate !== OPUS_RATE) {
    warnings.push(
      `Opus trabaja a 48 kHz: exporta a esa frecuencia si lo quieres (WAV escrito a ${(mix.sampleRate / 1000).toFixed(1)} kHz).`,
    );
  } else if (opts.opus) {
    opusPath = `${splitExtension(target).base}.opus`;
    try {
      await report('Codificando Opus…');
      // El encoder recibe las muestras entrelazadas.
      const frames = mix.left.length;
      const pcm = new Float64Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        pcm[i * 2] = mix.left[i]!;
        pcm[i * 2 + 1] = mix.right[i]!;
      }
      await orbit.file.write(
        opusPath,
        encodeOpusFile(pcm, {
          channels: 2,
          bitrate: opts.opusBitrate,
          tags: {
            ...(proj.meta.title ? { TITLE: proj.meta.title } : {}),
            ...(proj.meta.author ? { ARTIST: proj.meta.author } : {}),
            ENCODER: 'Orbit Studio',
          },
        }),
      );
    } catch (e) {
      warnings.push(`No se pudo escribir ${opusPath}: ${errorText(e)}`);
      opusPath = null;
    }
  }

  // MIDI multipista al lado del WAV (flujo FL de Orbit: .mid + wav).
  let midiPath: string | null = null;
  if (opts.midi) {
    midiPath = `${splitExtension(target).base}.mid`;
    try {
      await orbit.file.write(midiPath, encodeMidi(proj, playMode));
    } catch (e) {
      warnings.push(`No se pudo escribir ${midiPath}: ${errorText(e)}`);
      midiPath = null;
    }
  }

  // Stems: rutas hermanas <base>-<pista>.wav derivadas de la principal.
  let stemsWritten = 0;
  const stemTracks = opts.stems ? usedMixerTracks(proj) : [];
  if (stemTracks.length > 0) {
    const usedSlugs = new Set<string>();
    for (let i = 0; i < stemTracks.length; i++) {
      const t = stemTracks[i]!;
      await report(`Renderizando stem ${i + 1}/${stemTracks.length} (${t.name})…`);
      const stemMap = canUseRenderWorker()
        ? await renderStemsInWorker(compiled, [t.idx], renderOpts)
        : renderStems(compiled, [t.idx], renderOpts);
      let res = stemMap.get(t.idx);
      if (!res) continue;
      res = cut(res);
      if (gainDb !== null) applyGain(res, gainDb); // misma ganancia que el master
      let slug = slugName(t.name);
      if (usedSlugs.has(slug)) slug = `${slug}-${t.idx}`;
      usedSlugs.add(slug);
      const stemPath = siblingPath(target, slug);
      try {
        await orbit.file.write(
          stemPath,
          encodeWav(res.left, res.right, res.sampleRate, opts.depth),
        );
        stemsWritten++;
      } catch (e) {
        warnings.push(`No se pudo escribir ${stemPath}: ${errorText(e)}`);
      }
    }
  }

  return {
    path: target,
    durationSeconds: mix.left.length / mix.sampleRate,
    peakDb: finalPeak,
    lufs: finalLufs,
    gainDb,
    stemsWritten,
    midiPath,
    mp3Path,
    flacPath,
    oggPath,
    opusPath,
    warnings,
  };
}

// ── Último export (para repetirlo con un atajo) ──────────────────────────────

export interface LastExport {
  /** Ruta base: la que eligió el usuario en el diálogo la primera vez. */
  path: string;
  opts: ExportOptions;
  /** Copias ya escritas con esa base (1 = solo la original). */
  count: number;
}

interface LastExportState {
  last: LastExport | null;
  /** Ya se leyó settings.json al menos una vez. */
  loaded: boolean;
}

export const useLastExportStore = create<LastExportState>(() => ({ last: null, loaded: false }));

function parseLastExport(raw: unknown): LastExport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['path'] !== 'string' || !r['path']) return null;
  const o = (typeof r['opts'] === 'object' && r['opts'] !== null ? r['opts'] : {}) as Record<
    string,
    unknown
  >;
  const source = o['source'];
  const rawRegion = o['region'];
  const region =
    typeof rawRegion === 'object' &&
    rawRegion !== null &&
    typeof (rawRegion as Region).start === 'number' &&
    typeof (rawRegion as Region).end === 'number'
      ? { start: (rawRegion as Region).start, end: (rawRegion as Region).end }
      : null;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  const depth = num(o['depth'], DEFAULT_EXPORT_OPTIONS.depth);
  return {
    path: r['path'],
    count: Math.max(1, Math.round(num(r['count'], 1))),
    opts: {
      source: source === 'pattern' || source === 'selection' ? source : 'song',
      patternId: typeof o['patternId'] === 'string' ? o['patternId'] : null,
      region,
      normalize: bool(o['normalize'], DEFAULT_EXPORT_OPTIONS.normalize),
      stems: bool(o['stems'], DEFAULT_EXPORT_OPTIONS.stems),
      midi: bool(o['midi'], DEFAULT_EXPORT_OPTIONS.midi),
      mp3: bool(o['mp3'], DEFAULT_EXPORT_OPTIONS.mp3),
      flac: bool(o['flac'], DEFAULT_EXPORT_OPTIONS.flac),
      ogg: bool(o['ogg'], DEFAULT_EXPORT_OPTIONS.ogg),
      opus: bool(o['opus'], DEFAULT_EXPORT_OPTIONS.opus),
      opusBitrate:
        typeof o['opusBitrate'] === 'number' && Number.isFinite(o['opusBitrate'])
          ? Math.max(16000, Math.min(510000, Math.round(o['opusBitrate'])))
          : DEFAULT_EXPORT_OPTIONS.opusBitrate,
      depth: (depth === 24 || depth === 32 ? depth : 16) as WavDepth,
      sampleRate: num(o['sampleRate'], DEFAULT_EXPORT_OPTIONS.sampleRate),
      tailSeconds: num(o['tailSeconds'], DEFAULT_EXPORT_OPTIONS.tailSeconds),
    },
  };
}

/** Último export persistido (se lee de settings.json una sola vez). */
export async function loadLastExport(): Promise<LastExport | null> {
  const state = useLastExportStore.getState();
  if (state.loaded) return state.last;
  let last: LastExport | null = null;
  try {
    const settings = await window.orbit?.settings.get();
    last = settings ? parseLastExport(settings['lastExport']) : null;
  } catch {
    last = null;
  }
  useLastExportStore.setState({ last, loaded: true });
  return last;
}

/** Guarda el último export (memoria + settings.json). */
export async function rememberExport(path: string, opts: ExportOptions, count: number): Promise<void> {
  const last: LastExport = { path, opts, count };
  useLastExportStore.setState({ last, loaded: true });
  try {
    await window.orbit?.settings.set({ lastExport: last });
  } catch {
    // Que no se pueda persistir no invalida el export que acaba de salir.
  }
}

// ── Avisos (canal global de la app) ──────────────────────────────────────────

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function notify(notice: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  useBounceStore.setState({ notice });
  noticeTimer = setTimeout(() => useBounceStore.setState({ notice: null }), 6000);
}

// ── Repetir el último export (Ctrl+E) ────────────────────────────────────────

/**
 * Repite el último export sin preguntar nada: misma fuente, mismas opciones y
 * la misma ruta con sufijo incremental. Si la fuente era la selección de la
 * playlist se usa la región marcada AHORA (y si no hay, la que se guardó).
 *
 * Es la función pensada para colgar del atajo global Ctrl+E.
 */
export async function repeatLastExport(): Promise<void> {
  if (!window.orbit) {
    notify('Exportar requiere la app de escritorio.');
    return;
  }
  // Ya hay un render bloqueando el hilo (otro export o un consolidar).
  if (useBounceStore.getState().busy) return;

  const last = await loadLastExport();
  if (!last) {
    notify('Todavía no hay ningún export que repetir: haz el primero desde Exportar…');
    useUiStore.getState().openWindow('export');
    return;
  }

  const liveRegion = useUiStore.getState().loopRegion;
  const opts: ExportOptions =
    last.opts.source === 'selection'
      ? { ...last.opts, region: liveRegion ?? last.opts.region }
      : last.opts;

  const target = nextExportPath(last.path, last.count + 1);
  useBounceStore.setState({ busy: `Exportando ${fileNameOf(target)}…` });
  try {
    const summary = await runExport(target, opts, {
      allowDialogFallback: true,
      onProgress: (label) => useBounceStore.setState({ busy: label }),
    });
    // Si hubo que preguntar la ruta, esa pasa a ser la nueva base.
    const sameBase = summary.path === target;
    await rememberExport(sameBase ? last.path : summary.path, opts, sameBase ? last.count + 1 : 1);
    const extra = summary.warnings.length > 0 ? ` (${summary.warnings.length} aviso(s))` : '';
    notify(`Exportado ${fileNameOf(summary.path)}${extra}`);
  } catch (e) {
    notify(`No se pudo exportar: ${errorText(e)}`);
  } finally {
    useBounceStore.setState({ busy: null });
  }
}
