/**
 * Forma de onda del sample de un canal sampler, con las marcas de `start` y
 * `end` arrastrables.
 *
 * Los dos parámetros ya se pueden mover con perillas, pero recortar un sonido
 * a ciegas es adivinar: aquí se VE dónde entra y dónde corta, que es lo que
 * hace falta cuando lo que quieres es "acortarlo" sin destruir el archivo.
 *
 * Del PCM decodificado solo se guardan los picos (min/max por columna): un
 * sample largo ocuparía megas en memoria y para pintar no aporta nada. La
 * caché va por `id:hash` porque decodificar es lo caro, no dibujar.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SampleRef } from '@orbit/core';
import { readSampleBytes } from '../../browser/sound-actions';
import { useThemeVersion } from '../../theme/useThemeVersion';
import { capturePointer } from '../../widgets/pointer';

/** Columnas de picos que se guardan por sample (de sobra para cualquier ancho). */
const COLS = 1400;

interface Peaks {
  min: Float32Array;
  max: Float32Array;
  duration: number;
}

const peakCache = new Map<string, Peaks>();

async function loadPeaks(sample: SampleRef): Promise<Peaks | null> {
  const key = `${sample.id}:${sample.hash}`;
  const hit = peakCache.get(key);
  if (hit) return hit;
  const bytes = await readSampleBytes(sample.path);
  if (!bytes) return null;
  const ctx = new OfflineAudioContext(2, 1, 48000);
  const decoded = await ctx.decodeAudioData(bytes);
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
  const min = new Float32Array(COLS);
  const max = new Float32Array(COLS);
  const n = left.length;
  for (let c = 0; c < COLS; c++) {
    const i0 = Math.floor((c / COLS) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / COLS) * n));
    // Muestreo salteado: con un pad de 30 s recorrer muestra a muestra congela
    // la UI y el pico visible no cambia.
    const stride = Math.max(1, Math.floor((i1 - i0) / 48));
    let lo = 1;
    let hi = -1;
    for (let i = i0; i < i1; i += stride) {
      const s = (left[i]! + right[i]!) * 0.5;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[c] = lo;
    max[c] = hi;
  }
  const peaks: Peaks = { min, max, duration: decoded.duration };
  peakCache.set(key, peaks);
  return peaks;
}

export interface SampleWaveProps {
  sample: SampleRef;
  /** 0..1 dentro del archivo. */
  start: number;
  end: number;
  /** Color del canal: la región activa se pinta con él. */
  color: string;
  onTrim: (patch: { start?: number; end?: number }) => void;
  /**
   * Modo TROZOS (Slicer): en vez de las dos marcas de recorte se pintan los
   * cortes, numerados y arrastrables. Presente (aunque venga vacío) = modo
   * trozos; ausente = el recorte de siempre del sampler.
   */
  slicePoints?: readonly number[];
  /** Cambio de los cortes: arrastrar mueve, doble clic añade, derecho quita. */
  onSlicePoints?: (points: number[]) => void;
}

export function SampleWave({
  sample,
  start,
  end,
  color,
  onTrim,
  slicePoints,
  onSlicePoints,
}: SampleWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);
  /** Modo trozos: qué corte se está arrastrando (el 0 no se mueve nunca). */
  const sliceDrag = useRef<number | null>(null);
  const sliceMode = slicePoints !== undefined;
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [failed, setFailed] = useState(false);
  const themeVersion = useThemeVersion();

  useEffect(() => {
    let alive = true;
    setPeaks(null);
    setFailed(false);
    void loadPeaks(sample)
      .then((p) => {
        if (!alive) return;
        setPeaks(p);
        if (!p) setFailed(true);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [sample]);

  const draw = useCallback(() => {
    // themeVersion en deps: los tokens se leen con getComputedStyle al pintar.
    void themeVersion;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const col = (name: string) => css.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = col('--surface');
    ctx.fillRect(0, 0, w, h);

    if (!peaks) {
      ctx.fillStyle = col('--text-dim');
      ctx.font = `11px ${css.fontFamily}`;
      ctx.fillText(failed ? 'Sin forma de onda para este sample.' : 'Cargando forma de onda…', 12, h / 2);
      return;
    }

    const mid = h / 2;
    const amp = h / 2 - 4;
    ctx.strokeStyle = col('--border');
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    const x0 = start * w;
    const x1 = end * w;
    for (let x = 0; x < w; x++) {
      const c = Math.min(COLS - 1, Math.floor((x / w) * COLS));
      const y0 = mid - peaks.max[c]! * amp;
      const y1 = mid - peaks.min[c]! * amp;
      // Fuera del recorte la onda sigue viéndose, pero apagada: es lo que se
      // está tirando y conviene saber qué hay ahí antes de mover la marca.
      // En modo trozos no se tira nada, así que todo va encendido.
      const inside = sliceMode || (x >= x0 && x <= x1);
      ctx.fillStyle = inside ? color : col('--text-dim');
      ctx.globalAlpha = inside ? 1 : 0.25;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    ctx.globalAlpha = 1;

    if (sliceMode) {
      // Cortes numerados: el número es la tecla que dispara ese trozo contando
      // desde C3, que es lo que hace falta saber para tocarlo.
      ctx.font = `10px ${css.fontFamily}`;
      slicePoints!.forEach((p, i) => {
        const x = p * w;
        ctx.fillStyle = col('--meter-hot');
        ctx.fillRect(x, 0, i === 0 ? 1 : 2, h);
        if (i > 0) ctx.fillRect(x - 3, 0, 8, 8);
        // El número solo si cabe: en una ráfaga de golpes los cortes se juntan
        // y los números se pisan hasta ser una mancha ilegible.
        const next = slicePoints![i + 1];
        const room = next === undefined ? w - x : (next - p) * w;
        if (room >= 14) {
          ctx.fillStyle = col('--text-dim');
          ctx.fillText(String(i + 1), x + 4, h - 4);
        }
      });
      return;
    }

    // Marcas de recorte.
    ctx.fillStyle = col('--meter-hot');
    ctx.fillRect(x0, 0, 2, h);
    ctx.fillRect(Math.max(0, x1 - 2), 0, 2, h);
    ctx.fillRect(x0, 0, 8, 8);
    ctx.fillRect(Math.max(0, x1 - 8), h - 8, 8, 8);
  }, [peaks, failed, start, end, color, themeVersion, sliceMode, slicePoints]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  const posOf = (clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  /** Corte más cercano a esa posición, si cae dentro del radio de agarre. */
  const sliceNear = (t: number): number | null => {
    const canvas = canvasRef.current;
    if (!canvas || !slicePoints) return null;
    const radius = 8 / Math.max(1, canvas.getBoundingClientRect().width);
    let best: number | null = null;
    let bestDist = radius;
    // El primero (0) no se coge: el primer trozo empieza donde empieza el
    // sample, y moverlo sería inventarse un silencio inicial.
    for (let i = 1; i < slicePoints.length; i++) {
      const d = Math.abs(slicePoints[i]! - t);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!peaks) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    capturePointer(canvas, e.pointerId);
    const t = posOf(e.clientX);
    if (sliceMode) {
      sliceDrag.current = sliceNear(t);
      if (sliceDrag.current !== null) move(e.clientX);
      return;
    }
    drag.current = Math.abs(t - start) <= Math.abs(t - end) ? 'start' : 'end';
    move(e.clientX);
  };

  const move = (clientX: number) => {
    const t = posOf(clientX);
    if (sliceMode) {
      const i = sliceDrag.current;
      if (i === null || !slicePoints || !onSlicePoints) return;
      // Un corte no adelanta al anterior ni pasa al siguiente: si no, la lista
      // deja de estar ordenada y los trozos se cruzan.
      const min = (slicePoints[i - 1] ?? 0) + 0.002;
      const max = (slicePoints[i + 1] ?? 1) - 0.002;
      const next = [...slicePoints];
      next[i] = Math.min(max, Math.max(min, t));
      onSlicePoints(next);
      return;
    }
    const d = drag.current;
    if (!d) return;
    // Un margen mínimo entre marcas: con start === end el sampler no lee nada
    // y parecería que el canal se ha quedado mudo.
    if (d === 'start') onTrim({ start: Math.min(t, end - 0.002) });
    else onTrim({ end: Math.max(t, start + 0.002) });
  };

  /** Doble clic: corte nuevo aquí (y el trozo de al lado se parte en dos). */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!sliceMode || !slicePoints || !onSlicePoints) return;
    const t = posOf(e.clientX);
    if (slicePoints.some((p) => Math.abs(p - t) < 0.002)) return;
    onSlicePoints([...slicePoints, t].sort((a, b) => a - b));
  };

  /** Clic derecho sobre un corte: fuera (los dos trozos se funden en uno). */
  const onContextMenu = (e: React.MouseEvent) => {
    if (!sliceMode || !slicePoints || !onSlicePoints) return;
    e.preventDefault();
    const i = sliceNear(posOf(e.clientX));
    if (i === null) return;
    onSlicePoints(slicePoints.filter((_, idx) => idx !== i));
  };

  return (
    <div className="chan-wave" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          if (sliceMode && sliceDrag.current === null) return;
          move(e.clientX);
        }}
        onPointerUp={() => {
          drag.current = null;
          sliceDrag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
          sliceDrag.current = null;
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      <span className="chan-wave-hint">
        {sliceMode
          ? 'Arrastra un corte para moverlo · doble clic añade · derecho quita'
          : 'Arrastra las marcas para recortar el sonido'}
      </span>
    </div>
  );
}
