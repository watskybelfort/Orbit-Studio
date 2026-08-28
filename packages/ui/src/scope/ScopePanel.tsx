/**
 * Orbit Scope: forma de onda (arriba) y espectro (abajo) del master en vivo,
 * más los tres números de loudness (integrado, short-term, true-peak) para
 * ver que la mezcla va camino a -14 LUFS ANTES de exportar. El kernel manda
 * los últimos 2048 samples con cada frame de medidores SOLO mientras esta
 * ventana está abierta (engine.setScope). El espectro se calcula aquí con
 * `SpectrumAnalyzer` (FFT radix-2 de 1024 puntos, ventana de Hann, suavizado
 * entre frames) y el loudness con `LiveLoudnessMeter`, el mismo cálculo que
 * `analyzeMix` (engine/render/analysis.ts) pero alimentado a trozos según
 * llega el audio en vez de sobre un archivo terminado.
 */

import { useEffect, useRef } from 'react';
import { engine, ensureAudioReady } from '../state/app';
import { acquireLiveLoudness, useLiveLoudness } from '../state/live-loudness';
import { acquireScopeTracked, isScopeTrackActive, MASTER_TRACK } from '../state/scope-track';
import { useUiStore } from '../state/ui';
import { freqToBin, SpectrumAnalyzer, SPECTRUM_DB_FLOOR } from './spectrum';
import './scope.css';

const FREQ_MIN = 20;
const LUFS_TARGET = -14;

function fmtLufs(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(1)}`;
}

/** Fila compacta de loudness del master: integrado / short-term / true-peak. */
function ScopeLoudness() {
  const integrated = useLiveLoudness((s) => s.integrated);
  const shortTerm = useLiveLoudness((s) => s.shortTerm);
  const truePeak = useLiveLoudness((s) => s.truePeak);
  const stale = useLiveLoudness((s) => s.stale);
  const overTarget = integrated !== null && integrated > LUFS_TARGET;
  const hot = truePeak > -1;
  const clip = truePeak >= 0;

  useEffect(() => acquireLiveLoudness(), []);

  return (
    <div className="scope-lufs" title="LUFS del master en vivo — objetivo de streaming: -14 LUFS integrado">
      <div className="scope-lufs-item">
        <span className="scope-lufs-label">Integrado</span>
        <span className={`scope-lufs-val${overTarget ? ' hot' : ''}`}>{fmtLufs(integrated)}</span>
      </div>
      <div className="scope-lufs-item">
        <span className="scope-lufs-label">Short-term</span>
        <span className="scope-lufs-val">{fmtLufs(shortTerm)}</span>
      </div>
      <div className="scope-lufs-item">
        <span className="scope-lufs-label">True peak</span>
        <span className={`scope-lufs-val${clip ? ' clip' : hot ? ' hot' : ''}`}>
          {Number.isFinite(truePeak) ? truePeak.toFixed(1) : '—'}
        </span>
      </div>
      <div className="scope-lufs-target">objetivo {LUFS_TARGET} LUFS{stale ? ' · en pausa' : ''}</div>
    </div>
  );
}

export function ScopePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureAudioReady();
    // Préstamo con recuento: el EQ del mixer usa el MISMO tap del kernel y,
    // sin esto, plegarlo dejaba esta ventana en blanco para siempre.
    const releaseScope = acquireScopeTracked(MASTER_TRACK);
    let raf = 0;

    const spectrum = new SpectrumAnalyzer();

    const drawLoop = () => {
      raf = requestAnimationFrame(drawLoop);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const css = getComputedStyle(canvas);
      const col = (name: string) => css.getPropertyValue(name).trim();
      const accent = col('--accent');
      const dim = col('--text-dim');
      const line = col('--border');

      ctx.clearRect(0, 0, w, h);
      const waveH = Math.floor(h * 0.42);
      const specTop = waveH + 8;
      const specH = h - specTop - 14;

      // Si otra vista (un EQ del mixer, el espectro de una pista) pidió el tap
      // después que esta ventana, es SU audio el que viaja ahora por
      // scopeFrame: pintarlo igual sería mostrar la pista de otro como si
      // fuera el master. Se deja en blanco (con la rejilla) en vez de mentir.
      const owns = isScopeTrackActive(MASTER_TRACK);
      const frame = owns ? useUiStore.getState().scopeFrame : null;
      if (!owns) {
        ctx.fillStyle = dim;
        ctx.font = `10px ${css.fontFamily}`;
        ctx.fillText('En pausa — hay un espectro de otra pista abierto', 8, waveH / 2 + 3);
      }

      // ── Forma de onda ──
      ctx.strokeStyle = line;
      ctx.strokeRect(0.5, 0.5, w - 1, waveH - 1);
      ctx.beginPath();
      ctx.moveTo(0, waveH / 2);
      ctx.lineTo(w, waveH / 2);
      ctx.stroke();
      if (frame) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const s = frame[Math.floor((x / w) * frame.length)]!;
          const y = waveH / 2 - s * (waveH / 2 - 2);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // ── Espectro ──
      ctx.strokeStyle = line;
      ctx.strokeRect(0.5, specTop + 0.5, w - 1, specH - 1);
      const sr = engine.sampleRate;
      const nyquist = sr / 2;
      const logMin = Math.log10(FREQ_MIN);
      const logMax = Math.log10(nyquist);
      const freqToX = (f: number) => ((Math.log10(Math.max(FREQ_MIN, f)) - logMin) / (logMax - logMin)) * w;

      ctx.fillStyle = dim;
      ctx.font = `9px ${css.fontFamily}`;
      for (const f of [100, 1000, 10000]) {
        const x = freqToX(f);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, specTop, 1, specH);
        ctx.globalAlpha = 1;
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 3);
      }

      if (frame) {
        spectrum.update(frame);
        const db = spectrum.db;
        ctx.beginPath();
        ctx.moveTo(0, specTop + specH);
        for (let x = 0; x < w; x++) {
          const f = Math.pow(10, logMin + (x / w) * (logMax - logMin));
          const bin = freqToBin(f, spectrum.fftN, sr);
          const mag = db[bin]!;
          const y = specTop + (mag / SPECTRUM_DB_FLOOR) * specH;
          ctx.lineTo(x, Math.min(specTop + specH, y));
        }
        ctx.lineTo(w, specTop + specH);
        ctx.closePath();
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(drawLoop);

    return () => {
      cancelAnimationFrame(raf);
      releaseScope();
    };
  }, []);

  return (
    <div className="scope">
      <ScopeLoudness />
      <div className="scope-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="scope-canvas" />
      </div>
    </div>
  );
}
