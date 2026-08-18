/**
 * Panel de Export/Render: elige qué y cómo, abre el diálogo de guardado y deja
 * que `run-export.ts` haga el trabajo (render offline con el mismo kernel que
 * suena en vivo + escritura por el puente de Electron).
 *
 * Tres fuentes: la canción entera, un patrón suelto o **la selección de la
 * playlist** (la región marcada en la regla, la misma del loop del transporte).
 *
 * El último export queda guardado: el botón "Repetir" —y el atajo Ctrl+E, que
 * llama a `repeatLastExport()`— lo repiten sin diálogo con sufijo incremental.
 *
 * v0.1: el render corre en el hilo del renderer; antes de cada tramo
 * bloqueante se cede un frame para que la UI pinte el estado "Renderizando…".
 */

import { useEffect, useMemo, useState } from 'react';
import { type WavDepth } from '@orbit/engine';
import {
  DEFAULT_EXPORT_OPTIONS,
  fileNameOf,
  loadLastExport,
  nextExportPath,
  rememberExport,
  repeatLastExport,
  runExport,
  SAMPLE_RATES,
  suggestedExportName,
  useLastExportStore,
  usedMixerTracks,
  type ExportOptions,
  type ExportSummary,
} from './run-export';
import { store } from '../state/app';
import { useProject } from '../state/useProject';
import { useUiStore } from '../state/ui';
import './export.css';

type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'done'; summary: ExportSummary }
  | { kind: 'error'; message: string };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Beat → compás legible (1-based, como la regla de la playlist). */
function barOf(beat: number, beatsPerBar: number): string {
  return (beat / beatsPerBar + 1).toFixed(beat % beatsPerBar === 0 ? 0 : 2);
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function ExportPanel() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const loopRegion = useUiStore((s) => s.loopRegion);
  const lastExport = useLastExportStore((s) => s.last);

  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' });

  // El último export vive en settings.json: se lee una vez para poder ofrecer
  // "Repetir" nada más abrir el panel.
  useEffect(() => {
    void loadLastExport();
  }, []);

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]): void => {
    setOpts((o) => ({ ...o, [key]: value }));
  };

  const isDesktop = typeof window !== 'undefined' && !!window.orbit;
  const busy = status.kind === 'busy';

  const patternOptions = useMemo(
    () => project.patternOrder.filter((id) => project.patterns[id]),
    [project],
  );
  const selectedPattern =
    (opts.patternId && project.patterns[opts.patternId] ? opts.patternId : null) ??
    (activePatternId && project.patterns[activePatternId] ? activePatternId : null) ??
    patternOptions[0] ??
    null;

  const stemTracks = useMemo(() => usedMixerTracks(project), [project]);
  const beatsPerBar = Math.max(1, project.timeSig.num);

  /** Lo que se exporta de verdad: las opciones del panel + lo que hay vivo. */
  const effective: ExportOptions = {
    ...opts,
    patternId: selectedPattern,
    region: opts.source === 'selection' ? loopRegion : null,
  };

  const canExport =
    isDesktop &&
    !busy &&
    (opts.source === 'song' ||
      (opts.source === 'pattern' && selectedPattern !== null) ||
      (opts.source === 'selection' && loopRegion !== null));

  const doExport = async () => {
    if (!canExport) return;
    const orbit = window.orbit;
    if (!orbit) return;
    try {
      // Snapshot del proyecto en el momento del clic (no del render de React).
      const path = await orbit.file.saveDialog(suggestedExportName(store.project, effective));
      if (!path) return; // cancelado por el usuario

      setStatus({ kind: 'busy', label: 'Renderizando…' });
      const summary = await runExport(path, effective, {
        onProgress: (label) => setStatus({ kind: 'busy', label }),
      });
      // Base nueva: el siguiente Ctrl+E irá a "<esto>-2.wav".
      await rememberExport(summary.path, effective, 1);
      setStatus({ kind: 'done', summary });
    } catch (e) {
      setStatus({ kind: 'error', message: errorText(e) });
    }
  };

  const repeatTarget = lastExport
    ? fileNameOf(nextExportPath(lastExport.path, lastExport.count + 1))
    : null;

  return (
    <div className="export-panel">
      <h3 className="exp-heading">Qué exportar</h3>

      <div className="exp-row">
        <span className="exp-label">Fuente</span>
        <div className="exp-seg">
          <button
            className={`exp-seg-btn${opts.source === 'song' ? ' selected' : ''}`}
            disabled={busy}
            onClick={() => set('source', 'song')}
          >
            Canción (playlist)
          </button>
          <button
            className={`exp-seg-btn${opts.source === 'pattern' ? ' selected' : ''}`}
            disabled={busy || patternOptions.length === 0}
            onClick={() => set('source', 'pattern')}
          >
            Patrón
          </button>
          <button
            className={`exp-seg-btn${opts.source === 'selection' ? ' selected' : ''}`}
            disabled={busy || loopRegion === null}
            title={
              loopRegion === null
                ? 'Marca una región arrastrando en la mitad superior de la regla de la playlist'
                : undefined
            }
            onClick={() => set('source', 'selection')}
          >
            Selección
          </button>
        </div>
      </div>

      {opts.source === 'selection' && loopRegion && (
        <p className="exp-note">
          Región marcada: compás {barOf(loopRegion.start, beatsPerBar)} →{' '}
          {barOf(loopRegion.end, beatsPerBar)} ({(loopRegion.end - loopRegion.start).toFixed(2)}{' '}
          beats). Se renderiza la canción entera y se recorta ahí, así que lo que sonaba antes
          entra con su cola.
        </p>
      )}

      {opts.source === 'pattern' && (
        <div className="exp-row">
          <span className="exp-label">Patrón</span>
          {patternOptions.length > 0 ? (
            <select
              className="exp-select"
              disabled={busy}
              value={selectedPattern ?? ''}
              onChange={(e) => set('patternId', e.target.value)}
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
          checked={opts.normalize}
          onChange={(e) => set('normalize', e.target.checked)}
        />
        Normalizar a −14 LUFS (streaming)
      </label>

      <label className={`exp-check${stemTracks.length === 0 ? ' disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={busy || stemTracks.length === 0}
          checked={opts.stems && stemTracks.length > 0}
          onChange={(e) => set('stems', e.target.checked)}
        />
        Exportar stems (un WAV por pista de mixer usada)
      </label>
      {opts.stems && stemTracks.length > 0 && (
        <p className="exp-note">
          {stemTracks.length} {stemTracks.length === 1 ? 'pista usada' : 'pistas usadas'}:{' '}
          {stemTracks.map((t) => t.name).join(', ')}
        </p>
      )}

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={opts.midi}
          onChange={(e) => set('midi', e.target.checked)}
        />
        MIDI multipista (.mid junto al WAV)
      </label>

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={opts.mp3}
          onChange={(e) => set('mp3', e.target.checked)}
        />
        También MP3 a 192 kbps (para pasar demos)
      </label>

      <label className="exp-check">
        <input
          type="checkbox"
          disabled={busy}
          checked={opts.flac}
          onChange={(e) => set('flac', e.target.checked)}
        />
        También FLAC sin pérdida (.flac junto al WAV)
      </label>

      <label className="exp-check" title="Ogg FLAC: el mismo audio sin pérdida, en contenedor Ogg">
        <input
          type="checkbox"
          disabled={busy}
          checked={opts.ogg}
          onChange={(e) => set('ogg', e.target.checked)}
        />
        También OGG (Ogg FLAC, sin pérdida)
      </label>

      <div className="exp-row">
        <span className="exp-label">Profundidad</span>
        <select
          className="exp-select"
          disabled={busy}
          value={String(opts.depth)}
          onChange={(e) => set('depth', Number(e.target.value) as WavDepth)}
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
          value={String(opts.sampleRate)}
          onChange={(e) => set('sampleRate', Number(e.target.value))}
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
          value={String(opts.tailSeconds)}
          onChange={(e) => set('tailSeconds', Number(e.target.value))}
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
        <button
          className="exp-repeat"
          disabled={!isDesktop || busy || !repeatTarget}
          title={
            repeatTarget
              ? `Repite el último export sin preguntar nada: ${repeatTarget}`
              : 'Aún no hay ningún export que repetir'
          }
          onClick={() => void repeatLastExport()}
        >
          Repetir (Ctrl+E)
        </button>
        {busy && <span className="exp-status">{status.label}</span>}
      </div>

      {repeatTarget && !busy && (
        <p className="exp-note">
          El próximo "Repetir" escribirá <strong>{repeatTarget}</strong> con las mismas opciones.
        </p>
      )}

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
                {status.summary.stemsWritten}{' '}
                {status.summary.stemsWritten === 1 ? 'archivo' : 'archivos'}
              </span>
            </div>
          )}
          {status.summary.midiPath && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">MIDI</span>
              <span className="exp-summary-val">{fileNameOf(status.summary.midiPath)}</span>
            </div>
          )}
          {status.summary.mp3Path && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">MP3</span>
              <span className="exp-summary-val">{fileNameOf(status.summary.mp3Path)}</span>
            </div>
          )}
          {status.summary.flacPath && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">FLAC</span>
              <span className="exp-summary-val">{fileNameOf(status.summary.flacPath)}</span>
            </div>
          )}
          {status.summary.oggPath && (
            <div className="exp-summary-row">
              <span className="exp-summary-key">OGG</span>
              <span className="exp-summary-val">{fileNameOf(status.summary.oggPath)}</span>
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
