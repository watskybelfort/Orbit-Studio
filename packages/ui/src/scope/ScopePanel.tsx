/**
 * Orbit Scope: forma de onda (arriba) y espectro (abajo) del master en vivo.
 * El kernel manda los últimos 2048 samples con cada frame de medidores SOLO
 * mientras esta ventana está abierta (engine.setScope). El espectro se calcula
 * aquí con una FFT radix-2 de 1024 puntos con ventana de Hann.
 */

import { useEffect, useRef } from 'react';
import { engine, ensureAudioReady } from '../state/app';
import { useUiStore } from '../state/ui';
import './scope.css';

const FFT_N = 1024;
const DB_FLOOR = -90;
const FREQ_MIN = 20;

/** FFT radix-2 in situ sobre re/im (longitud potencia de 2). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function ScopePanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureAudioReady();
    engine.setScope(true);
    let raf = 0;

    const re = new Float32Array(FFT_N);
    const im = new Float32Array(FFT_N);
    const hann = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_N - 1)));

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

      const frame = useUiStore.getState().scopeFrame;

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
        const off = frame.length - FFT_N;
        for (let i = 0; i < FFT_N; i++) {
          re[i] = frame[off + i]! * hann[i]!;
          im[i] = 0;
        }
        fft(re, im);
        ctx.beginPath();
        ctx.moveTo(0, specTop + specH);
        for (let x = 0; x < w; x++) {
          const f = Math.pow(10, logMin + (x / w) * (logMax - logMin));
          const bin = Math.min(FFT_N / 2 - 1, Math.max(1, Math.round((f / nyquist) * (FFT_N / 2))));
          const mag = Math.hypot(re[bin]!, im[bin]!) / (FFT_N / 4);
          const db = Math.max(DB_FLOOR, 20 * Math.log10(mag + 1e-9));
          const y = specTop + ((db / DB_FLOOR) * specH);
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
      engine.setScope(false);
    };
  }, []);

  return (
    <div className="scope" ref={wrapRef}>
      <canvas ref={canvasRef} className="scope-canvas" />
    </div>
  );
}
