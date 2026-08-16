/**
 * Panel de Export/Render: renderiza el proyecto offline (mismo kernel que en
 * vivo) y lo escribe como WAV vía el puente de Electron. Opcional: normalizar
 * a -14 LUFS (streaming) y exportar stems (un WAV por pista de mixer usada).
 *
 * v0.1: el render corre en el hilo del renderer; antes de cada tramo
 * bloqueante se cede un frame para que la UI pinte el estado "Renderizando…".
 */

import { useMemo, useState } from 'react';
import { encodeMidi, type Project } from '@orbit/core';
import {
  analyzeMix,
  compileProject,
  encodeFlac,
  encodeWav,
  gainToTarget,
  renderProject,
  renderStems,
  type CompiledProject,
  type FlacDepth,
  type RenderResult,
  type SampleData,
  type WavDepth,
} from '@orbit/engine';
import { readSampleBytes } from '../browser/sound-actions';
import { encodeMp3 } from './mp3';
import { store } from '../state/app';
import { usePluginsStore } from '../state/plugins';
import { useProject } from '../state/useProject';
import { useUiStore } from '../state/ui';
import './export.css';

const TARGET_LUFS = -14;

/** Sample rates de export (el kernel renderiza a la que se pida). */
const SAMPLE_RATES = [44100, 48000, 88200, 96000] as const;
/** MPEG no admite más de 48 kHz: por encima, el MP3 se salta con aviso. */
const MP3_MAX_RATE = 48000;

type ExportMode = 'song' | 'pattern' | 'loop';

interface ExportSummary {
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
  warnings: string[];
}

/** Recorta un render a un rango de samples (para exportar el loop). */
function sliceRender(res: RenderResult, s0: number, s1: number): RenderResult {
  return {
    left: res.left.slice(s0, s1),
    right: res.right.slice(s0, s1),
    sampleRate: res.sampleRate,
  };
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

/**
 * Código fuente de los plugins JS que usa el proyecto (slots kind 'plugin'),
 * sacado del registro del renderer para que el render offline los instancie.
 * Los que ya no están en la carpeta se reportan (sonarán en bypass).
 */
function collectPluginSources(project: Project): {
  plugins: Map<string, string>;
  missing: string[];
} {
  const sources = usePluginsStore.getState().sources;
  const plugins = new Map<string, string>();
  const missing: string[] = [];
  for (const track of project.mixer) {
    for (const slot of track.slots) {
      if (slot?.kind !== 'plugin' || !slot.pluginId || plugins.has(slot.pluginId)) continue;
      const code = sources.get(slot.pluginId);
      if (code) plugins.set(slot.pluginId, code);
      else if (!missing.includes(slot.pluginId)) missing.push(slot.pluginId);
    }
  }
  return { plugins, missing };
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
    if (!ref || !window.orbit) {
      missing.push(ref?.name ?? id);
      continue;
    }
    try {
      const bytes = await readSampleBytes(ref.path);
      if (!bytes) {
        // Esquema de ruta que el renderer no sabe resolver (rutas locales sueltas).
        missing.push(ref.name);
        continue;
      }
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
  const [midi, setMidi] = useState(true);
  const [mp3, setMp3] = useState(false);
  const [flac, setFlac] = useState(false);
  const loopRegion = useUiStore((s) => s.loopRegion);
  const [depth, setDepth] = useState<WavDepth>(16);
  const [sampleRate, setSampleRate] = useState<number>(44100);
  const [tailSeconds, setTailSeconds] = useState(2);
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
    isDesktop &&
    !busy &&
    (mode === 'song' ||
      (mode === 'pattern' && selectedPattern !== null) ||
      (mode === 'loop' && loopRegion !== null));

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
          : `${proj.meta.title.trim() || 'proyecto'}${mode === 'loop' ? '-loop' : ''}`;
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
      // Plugins JS usados por el mixer: sus fuentes van al render offline.
      const pluginSources = collectPluginSources(proj);
      if (pluginSources.missing.length > 0) {
        warnings.push(
          `Plugins JS no encontrados (van en bypass): ${pluginSources.missing.join(', ')}.`,
        );
      }

      // Mezcla principal (la fuente Loop renderiza la canción y recorta).
      const renderOpts = { samples, sampleRate, tailSeconds, plugins: pluginSources.plugins };
      let mix = renderProject(compiled, renderOpts);
      const loop = mode === 'loop' ? loopRegion : null;
      const spb = 60 / proj.tempo;
      if (loop) {
        const s0 = Math.max(0, Math.floor(loop.start * spb * mix.sampleRate));
        const s1 = Math.min(mix.left.length, Math.ceil(loop.end * spb * mix.sampleRate));
        mix = sliceRender(mix, s0, s1);
      }
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

      // MP3 al lado del WAV (para pasar demos rápido).
      let mp3Path: string | null = null;
      if (mp3 && mix.sampleRate > MP3_MAX_RATE) {
        warnings.push(
          `MP3 solo admite hasta 48 kHz: exporta a 44.1/48 kHz si lo quieres (WAV escrito a ${(mix.sampleRate / 1000).toFixed(1)} kHz).`,
        );
      } else if (mp3) {
        mp3Path = path.replace(/\.wav$/i, '') + '.mp3';
        try {
          setStatus({ kind: 'busy', label: 'Codificando MP3…' });
          await nextPaint();
          await orbit.file.write(mp3Path, encodeMp3(mix.left, mix.right, mix.sampleRate));
        } catch (e) {
          warnings.push(`No se pudo escribir ${mp3Path}: ${errorText(e)}`);
          mp3Path = null;
        }
      }

      // FLAC sin pérdida al lado del WAV (float 32 se escribe a 24 bits).
      let flacPath: string | null = null;
      if (flac) {
        flacPath = path.replace(/\.wav$/i, '') + '.flac';
        try {
          setStatus({ kind: 'busy', label: 'Codificando FLAC…' });
          await nextPaint();
          const flacDepth: FlacDepth = depth === 16 ? 16 : 24;
          if (depth === 32) {
            warnings.push('FLAC no admite float: el .flac va a 24 bits.');
          }
          await orbit.file.write(
            flacPath,
            encodeFlac(mix.left, mix.right, mix.sampleRate, flacDepth),
          );
        } catch (e) {
          warnings.push(`No se pudo escribir ${flacPath}: ${errorText(e)}`);
          flacPath = null;
        }
      }

      // MIDI multipista al lado del WAV (flujo FL de Orbit: .mid + wav).
      let midiPath: string | null = null;
      if (midi) {
        midiPath = path.replace(/\.wav$/i, '') + '.mid';
        try {
          await orbit.file.write(
            midiPath,
            encodeMidi(
              proj,
              mode === 'pattern' && selectedPattern
                ? { mode: 'pattern', patternId: selectedPattern }
                : { mode: 'song' },
            ),
          );
        } catch (e) {
          warnings.push(`No se pudo escribir ${midiPath}: ${errorText(e)}`);
          midiPath = null;
        }
      }

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
          let res = renderStems(compiled, [t.idx], renderOpts).get(t.idx);
          if (!res) continue;
          if (loop) {
            const s0 = Math.max(0, Math.floor(loop.start * spb * res.sampleRate));
            const s1 = Math.min(res.left.length, Math.ceil(loop.end * spb * res.sampleRate));
            res = sliceRender(res, s0, s1);
          }
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
          midiPath,
          mp3Path,
          flacPath,
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
          <button
            className={`exp-seg-btn${mode === 'loop' ? ' selected' : ''}`}
            disabled={busy || loopRegion === null}
            title={loopRegion === null ? 'Marca un loop en la regla de la playlist' : undefined}
            onClick={() => setMode('loop')}
          >
            Loop
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

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={midi}
          onChange={(e) => setMidi(e.target.checked)}
        />
        MIDI multipista (.mid junto al WAV)
      </label>

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={mp3}
          onChange={(e) => setMp3(e.target.checked)}
        />
        También MP3 a 192 kbps (para pasar demos)
      </label>

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={flac}
          onChange={(e) => setFlac(e.target.checked)}
        />
        También FLAC sin pérdida (.flac junto al WAV)
      </label>

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
        <span className="exp-label">Sample rate</span>
        <select
          className="exp-select"
          disabled={busy}
          value={String(sampleRate)}
          onChange={(e) => setSampleRate(Number(e.target.value))}
        >
          {SAMPLE_RATES.map((sr) => (
            <option key={sr} value={sr}>
              {sr === 44100 ? '44.1 kHz' : `${sr / 1000} kHz`}
            </option>
          ))}
        </select>
      </div>

      <div className="exp-row">
        <span className="exp-label">Cola (reverb/delay)</span>
        <select
          className="exp-select"
          disabled={busy}
          value={String(tailSeconds)}
          onChange={(e) => setTailSeconds(Number(e.target.value))}
        >
          {[0, 1, 2, 4, 8].map((s) => (
            <option key={s} value={s}>
              {s} s
            </option>
          ))}
        </select>
      </div>

      <div className="exp-row">
        <button className="exp-export" disabled={!canExport} onClick={() => void doExport()}>
          Exportar…
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
          {status.summary.midiPath && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">MIDI</span>
              <span className="exp-summary-val">
                {status.summary.midiPath.split(/[\\/]/).pop()}
              </span>
            </div>
          )}
          {status.summary.mp3Path && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">MP3</span>
              <span className="exp-summary-val">
                {status.summary.mp3Path.split(/[\\/]/).pop()}
              </span>
            </div>
          )}
          {status.summary.flacPath && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">FLAC</span>
              <span className="exp-summary-val">
                {status.summary.flacPath.split(/[\\/]/).pop()}
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
