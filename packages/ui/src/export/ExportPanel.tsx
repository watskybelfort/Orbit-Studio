/**
 * Panel de Export/Render: renderiza el proyecto offline (mismo kernel que en
 * vivo) y lo escribe como WAV vía el puente de Electron. Opcional: normalizar
 * a -14 LUFS (streaming) y exportar stems (un WAV por pista de mixer usada).
 *
 * v0.1: el render corre en el hilo del renderer; antes de cada tramo
 * bloqueante se cede un frame para que la UI pinte el estado "Renderizando…".
 */

import { useMemo, useState } from 'react';
import type { Project } from '@orbit/core';
import {
  analyzeMix,
  compileProject,
  encodeWav,
  gainToTarget,
  renderProject,
  renderStems,
  type CompiledProject,
  type RenderResult,
  type SampleData,
  type WavDepth,
} from '@orbit/engine';
import { store } from '../state/app';
import { useProject } from '../state/useProject';
import { useUiStore } from '../state/ui';
import './export.css';

const TARGET_LUFS = -14;

type ExportMode = 'song' | 'pattern';

interface ExportSummary {
  path: string;
  durationSeconds: number;
  peakDb: number;
  lufs: number;
  /** Ganancia de normalización aplicada, o null si no se normalizó. */
  gainDb: number | null;
  stemsWritten: number;
  warnings: string[];
}

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'done'; summary: ExportSummary }
  | { kind: 'error'; message: string };

/** Cede un frame real al navegador: una microtarea no basta para repintar
 *  antes del render bloqueante, así que esperamos rAF + macrotarea. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Nombre de archivo seguro en Windows/mac/linux. */
function sanitizeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return clean || 'export';
}

/** Slug para sufijos de stems: sin acentos, solo [a-z0-9-]. */
function slugName(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s || 'pista';
}

/** Ruta hermana `<base>-<sufijo>.wav` a partir de la elegida en el diálogo. */
function siblingPath(mainPath: string, suffix: string): string {
  const base = mainPath.replace(/\.wav$/i, '');
  return `${base}-${suffix}.wav`;
}

/** Pistas de mixer usadas: las que reciben al menos un canal del rack. */
function usedMixerTracks(project: Project): { idx: number; name: string }[] {
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

/** Ganancia lineal in situ sobre un render (para normalizar). */
function applyGain(res: RenderResult, db: number): void {
  const g = Math.pow(10, db / 20);
  for (let i = 0; i < res.left.length; i++) {
    res.left[i] = res.left[i]! * g;
    res.right[i] = res.right[i]! * g;
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ── Samples para el render offline ───────────────────────────────────────────
// El kernel en vivo recibe los samples por transferencia; para el render
// offline los decodificamos aquí (mejor esfuerzo: pack de fábrica vía
// library.read). Caché por id+hash para no re-decodificar en cada export.

const sampleCache = new Map<string, SampleData>();

async function collectSamples(
  project: Project,
  compiled: CompiledProject,
): Promise<{ samples: Map<string, SampleData>; missing: string[] }> {
  const needed = new Set<string>();
  for (const ch of compiled.channels) if (ch.sampleId) needed.add(ch.sampleId);
  for (const clip of compiled.audioClips) needed.add(clip.sampleId);

  const samples = new Map<string, SampleData>();
  const missing: string[] = [];
  for (const id of needed) {
    const ref = project.samples[id];
    const key = ref ? `${id}:${ref.hash}` : id;
    const cached = sampleCache.get(key);
    if (cached) {
      samples.set(id, cached);
      continue;
    }
    if (!ref || !ref.path.startsWith('factory:') || !window.orbit) {
      // Sin API para leer rutas locales arbitrarias desde el renderer (v0.1).
      missing.push(ref?.name ?? id);
      continue;
    }
    try {
      const bytes = await window.orbit.library.read(ref.path.slice('factory:'.length));
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      const left = decoded.getChannelData(0).slice();
      const right = (
        decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0)
      ).slice();
      const data: SampleData = { left, right, rate: decoded.sampleRate };
      sampleCache.set(key, data);
      samples.set(id, data);
    } catch {
      missing.push(ref.name);
    }
  }
  return { samples, missing };
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ExportPanel() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);

  const [mode, setMode] = useState<ExportMode>('song');
  const [patternId, setPatternId] = useState<string | null>(null);
  const [normalize, setNormalize] = useState(false);
  const [stems, setStems] = useState(false);
  const [depth, setDepth] = useState<WavDepth>(16);
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' });

  const isDesktop = typeof window !== 'undefined' && !!window.orbit;
  const busy = status.kind === 'busy';

  const patternOptions = useMemo(
    () => project.patternOrder.filter((id) => project.patterns[id]),
    [project],
  );
  const selectedPattern =
    (patternId && project.patterns[patternId] ? patternId : null) ??
    (activePatternId && project.patterns[activePatternId] ? activePatternId : null) ??
    patternOptions[0] ??
    null;

  const stemTracks = useMemo(() => usedMixerTracks(project), [project]);

  const canExport =
    isDesktop && !busy && (mode === 'song' || selectedPattern !== null);

  const doExport = async () => {
    if (!canExport) return;
    const orbit = window.orbit;
    if (!orbit) return;
    // Snapshot del proyecto en el momento del clic (no del último render de React).
    const proj = store.project;

    try {
      const pattern = mode === 'pattern' && selectedPattern ? proj.patterns[selectedPattern] : null;
      const baseName =
        mode === 'pattern'
          ? (pattern?.name ?? 'patron')
          : proj.meta.title.trim() || 'proyecto';
      const path = await orbit.file.saveDialog(`${sanitizeFileName(baseName)}.wav`);
      if (!path) return; // cancelado por el usuario

      setStatus({ kind: 'busy', label: 'Renderizando…' });
      await nextPaint();

      const compiled = compileProject(
        proj,
        mode === 'pattern' && selectedPattern
          ? { mode: 'pattern', patternId: selectedPattern }
          : { mode: 'song' },
      );
      const { samples, missing } = await collectSamples(proj, compiled);
      const warnings: string[] = [];
      if (missing.length > 0) {
        warnings.push(`Samples no incluidos en el render: ${missing.join(', ')}.`);
      }

      // Mezcla principal
      const mix = renderProject(compiled, { samples });
      const analysis = analyzeMix(mix.left, mix.right, mix.sampleRate);
      let gainDb: number | null = null;
      if (normalize) {
        gainDb = gainToTarget(analysis, TARGET_LUFS);
        applyGain(mix, gainDb);
      }
      // Una ganancia lineal desplaza peak y LUFS exactamente en gainDb.
      const finalLufs = analysis.lufsIntegrated + (gainDb ?? 0);
      const finalPeak = analysis.peakDb + (gainDb ?? 0);

      await orbit.file.write(path, encodeWav(mix.left, mix.right, mix.sampleRate, depth));

      // Stems: rutas hermanas <base>-<pista>.wav derivadas de la elegida.
      let stemsWritten = 0;
      if (stems && stemTracks.length > 0) {
        const usedSlugs = new Set<string>();
        for (let i = 0; i < stemTracks.length; i++) {
          const t = stemTracks[i]!;
          setStatus({
            kind: 'busy',
            label: `Renderizando stem ${i + 1}/${stemTracks.length} (${t.name})…`,
          });
          await nextPaint();
          const res = renderStems(compiled, [t.idx], { samples }).get(t.idx);
          if (!res) continue;
          if (gainDb !== null) applyGain(res, gainDb); // misma ganancia que el master
          let slug = slugName(t.name);
          if (usedSlugs.has(slug)) slug = `${slug}-${t.idx}`;
          usedSlugs.add(slug);
          const stemPath = siblingPath(path, slug);
          try {
            await orbit.file.write(stemPath, encodeWav(res.left, res.right, res.sampleRate, depth));
            stemsWritten++;
          } catch (e) {
            warnings.push(`No se pudo escribir ${stemPath}: ${errorText(e)}`);
          }
        }
      }

      setStatus({
        kind: 'done',
        summary: {
          path,
          durationSeconds: mix.left.length / mix.sampleRate,
          peakDb: finalPeak,
          lufs: finalLufs,
          gainDb,
          stemsWritten,
          warnings,
        },
      });
    } catch (e) {
      setStatus({ kind: 'error', message: errorText(e) });
    }
  };

  return (
    <div className="export-panel">
      <h3 className="exp-heading">Qué exportar</h3>

      <div className="exp-row">
        <span className="exp-label">Fuente</span>
        <div className="exp-seg">
          <button
            className={`exp-seg-btn${mode === 'song' ? ' selected' : ''}`}
            disabled={busy}
            onClick={() => setMode('song')}
          >
            Canción (playlist)
          </button>
          <button
            className={`exp-seg-btn${mode === 'pattern' ? ' selected' : ''}`}
            disabled={busy || patternOptions.length === 0}
            onClick={() => setMode('pattern')}
          >
            Patrón
          </button>
        </div>
      </div>

      {mode === 'pattern' && (
        <div className="exp-row">
          <span className="exp-label">Patrón</span>
          {patternOptions.length > 0 ? (
            <select
              className="exp-select"
              disabled={busy}
              value={selectedPattern ?? ''}
              onChange={(e) => setPatternId(e.target.value)}
            >
              {patternOptions.map((id) => (
                <option key={id} value={id}>
                  {project.patterns[id]?.name ?? id}
                </option>
              ))}
            </select>
          ) : (
            <span className="exp-note">El proyecto no tiene patrones.</span>
          )}
        </div>
      )}

      <h3 className="exp-heading">Opciones</h3>

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={normalize}
          onChange={(e) => setNormalize(e.target.checked)}
        />
        Normalizar a −14 LUFS (streaming)
      </label>

      <label className={`exp-check${stemTracks.length === 0 ? ' disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={busy || stemTracks.length === 0}
          checked={stems && stemTracks.length > 0}
          onChange={(e) => setStems(e.target.checked)}
        />
        Exportar stems (un WAV por pista de mixer usada)
      </label>
      {stems && stemTracks.length > 0 && (
        <p className="exp-note">
          {stemTracks.length} {stemTracks.length === 1 ? 'pista usada' : 'pistas usadas'}:{' '}
          {stemTracks.map((t) => t.name).join(', ')}
        </p>
      )}

      <div className="exp-row">
        <span className="exp-label">Profundidad</span>
        <select
          className="exp-select"
          disabled={busy}
          value={String(depth)}
          onChange={(e) => setDepth(Number(e.target.value) as WavDepth)}
        >
          <option value="16">16 bits</option>
          <option value="24">24 bits</option>
          <option value="32">32 bits (float)</option>
        </select>
      </div>

      <div className="exp-row">
        <button className="exp-export" disabled={!canExport} onClick={() => void doExport()}>
          Exportar WAV…
        </button>
        {busy && <span className="exp-status">{status.label}</span>}
      </div>

      {!isDesktop && <p className="exp-note">Exportar requiere la app de escritorio.</p>}

      {status.kind === 'error' && <p className="exp-error">Error al exportar: {status.message}</p>}

      {status.kind === 'done' && (
        <div className="exp-summary">
          <div className="exp-summary-row">
            <span className="exp-summary-key">Duración</span>
            <span className="exp-summary-val">
              {formatDuration(status.summary.durationSeconds)}
            </span>
          </div>
          <div className="exp-summary-row">
            <span className="exp-summary-key">Peak</span>
            <span className="exp-summary-val">{status.summary.peakDb.toFixed(1)} dBFS</span>
          </div>
          <div className="exp-summary-row">
            <span className="exp-summary-key">LUFS integrado</span>
            <span className="exp-summary-val">{status.summary.lufs.toFixed(1)} LUFS</span>
          </div>
          {status.summary.gainDb !== null && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">Normalización</span>
              <span className="exp-summary-val">
                {status.summary.gainDb >= 0 ? '+' : ''}
                {status.summary.gainDb.toFixed(1)} dB
              </span>
            </div>
          )}
          {status.summary.stemsWritten > 0 && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">Stems</span>
              <span className="exp-summary-val">
                {status.summary.stemsWritten} {status.summary.stemsWritten === 1 ? 'archivo' : 'archivos'}
              </span>
            </div>
          )}
          <span className="exp-path">{status.summary.path}</span>
          {status.summary.warnings.map((w, i) => (
            <p key={i} className="exp-warn">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
