/**
 * Editor de audio (Edison mini): forma de onda del sample de un clip de audio
 * con recorte por asas (audioOffset + length del clip, no destructivo),
 * ganancia del clip, escucha, y operaciones destructivas (normalizar,
 * reverse, fades) que generan un sample procesado NUEVO — se guarda como
 * grabación, se registra y el clip pasa a apuntarle, todo en un undo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type SampleRef } from '@orbit/core';
import { encodeWav } from '@orbit/engine';
import { readSampleBytes, sha1Hex } from '../../browser/sound-actions';
import { engine, ensureAudioReady, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { useThemeVersion } from '../../theme/useThemeVersion';
import { capturePointer } from '../../widgets/pointer';
import { Knob } from '../../widgets/Knob';
import './audio-editor.css';

interface Channels {
  left: Float32Array;
  right: Float32Array;
  rate: number;
  duration: number;
}

/** Caché de PCM decodificado por id:hash (decodificar es caro). */
const pcmCache = new Map<string, Channels>();

async function loadChannels(sample: SampleRef): Promise<Channels | null> {
  const key = `${sample.id}:${sample.hash}`;
  const hit = pcmCache.get(key);
  if (hit) return hit;
  const bytes = await readSampleBytes(sample.path);
  if (!bytes) return null;
  const ctx = new OfflineAudioContext(2, 1, 48000);
  const decoded = await ctx.decodeAudioData(bytes);
  const data: Channels = {
    left: decoded.getChannelData(0).slice(),
    right: (
      decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0)
    ).slice(),
    rate: decoded.sampleRate,
    duration: decoded.duration,
  };
  pcmCache.set(key, data);
  return data;
}

type AudioOp = 'normalize' | 'reverse' | 'fadein' | 'fadeout';

const OP_LABELS: Record<AudioOp, string> = {
  normalize: 'Normalizar',
  reverse: 'Reverse',
  fadein: 'Fade in',
  fadeout: 'Fade out',
};

function applyOp(op: AudioOp, ch: Channels): { left: Float32Array; right: Float32Array } {
  const left = ch.left.slice();
  const right = ch.right.slice();
  const n = left.length;
  if (op === 'normalize') {
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
      if (a > peak) peak = a;
    }
    const g = peak > 0 ? 0.97 / peak : 1;
    for (let i = 0; i < n; i++) {
      left[i]! *= g;
      right[i]! *= g;
    }
  } else if (op === 'reverse') {
    left.reverse();
    right.reverse();
  } else {
    // Fades lineales: 100 ms de entrada, 300 ms de salida.
    const len = Math.min(n, Math.round(ch.rate * (op === 'fadein' ? 0.1 : 0.3)));
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const idx = op === 'fadein' ? i : n - 1 - i;
      left[idx]! *= t;
      right[idx]! *= t;
    }
  }
  return { left, right };
}

export function AudioEditor() {
  const project = useProject();
  const audioClipId = useUiStore((s) => s.audioClipId);
  const themeVersion = useThemeVersion();

  const clip = audioClipId ? project.clips[audioClipId] : undefined;
  const sample = clip?.sampleId ? project.samples[clip.sampleId] : undefined;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);
  const [channels, setChannels] = useState<Channels | null>(null);
  const [busy, setBusy] = useState(false);

  // Carga (cacheada) del PCM al cambiar de sample.
  useEffect(() => {
    let alive = true;
    setChannels(null);
    if (!sample) return;
    void loadChannels(sample).then((ch) => {
      if (alive) setChannels(ch);
    });
    return () => {
      alive = false;
    };
  }, [sample]);

  const secPerBeat = 60 / project.tempo;
  const clipSec = (clip?.length ?? 0) * secPerBeat;
  const offsetSec = clip?.audioOffset ?? 0;

  // ── Dibujo ────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    // themeVersion en deps: los tokens se leen con getComputedStyle por tema.
    void themeVersion;
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
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = col('--surface');
    ctx.fillRect(0, 0, w, h);

    if (!channels) {
      ctx.fillStyle = col('--text-dim');
      ctx.font = `11px ${css.fontFamily}`;
      ctx.fillText('Cargando forma de onda…', 12, h / 2);
      return;
    }

    // Forma de onda (mono para pintar): min/max por columna.
    const { left, right } = channels;
    const n = left.length;
    ctx.strokeStyle = col('--border');
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.fillStyle = col('--accent');
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor((x / w) * n);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * n));
      let min = 1;
      let max = -1;
      for (let i = i0; i < i1; i += Math.max(1, Math.floor((i1 - i0) / 64))) {
        const s = (left[i]! + right[i]!) * 0.5;
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const y0 = h / 2 - max * (h / 2 - 4);
      const y1 = h / 2 - min * (h / 2 - 4);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    // Región del clip + asas.
    const dur = channels.duration;
    const x0 = (offsetSec / dur) * w;
    const x1 = (Math.min(dur, offsetSec + clipSec) / dur) * w;
    ctx.fillStyle = col('--text');
    ctx.globalAlpha = 0.08;
    ctx.fillRect(0, 0, x0, h);
    ctx.fillRect(x1, 0, w - x1, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col('--meter-hot');
    ctx.fillRect(x0, 0, 2, h);
    ctx.fillRect(x1 - 2, 0, 2, h);
    ctx.fillRect(x0, 0, 8, 8);
    ctx.fillRect(x1 - 8, h - 8, 8, 8);
  }, [channels, offsetSec, clipSec, themeVersion]);

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

  // ── Asas de recorte ───────────────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || !channels || !clip) return;
      capturePointer(canvas, e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const dur = channels.duration;
      const x0 = (offsetSec / dur) * rect.width;
      const x1 = (Math.min(dur, offsetSec + clipSec) / dur) * rect.width;
      drag.current = Math.abs(x - x0) <= Math.abs(x - x1) ? 'start' : 'end';
    },
    [channels, clip, offsetSec, clipSec],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      const canvas = canvasRef.current;
      if (!d || !canvas || !channels || !clip) return;
      const rect = canvas.getBoundingClientRect();
      const sec = Math.max(
        0,
        Math.min(channels.duration, ((e.clientX - rect.left) / rect.width) * channels.duration),
      );
      if (d === 'start') {
        const newOffset = Math.min(sec, offsetSec + clipSec - 0.02);
        const delta = newOffset - offsetSec;
        store.dispatch(
          {
            type: 'patchClips',
            patches: [
              {
                id: clip.id,
                audioOffset: newOffset,
                length: Math.max(0.05, clip.length - delta / secPerBeat),
              },
            ],
          },
          { label: 'Recortar audio', mergeKey: `ae:trim:${clip.id}` },
        );
      } else {
        const newEnd = Math.max(sec, offsetSec + 0.02);
        store.dispatch(
          {
            type: 'patchClips',
            patches: [{ id: clip.id, length: Math.max(0.05, (newEnd - offsetSec) / secPerBeat) }],
          },
          { label: 'Recortar audio', mergeKey: `ae:trim:${clip.id}` },
        );
      }
    },
    [channels, clip, offsetSec, clipSec, secPerBeat],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  // ── Operaciones destructivas → sample procesado nuevo ─────────────────────

  const runOp = useCallback(
    async (op: AudioOp) => {
      if (!channels || !clip || !sample || !window.orbit || busy) return;
      setBusy(true);
      try {
        const { left, right } = applyOp(op, channels);
        const wav = encodeWav(left, right, channels.rate, 24);
        const stamp = new Date();
        const two = (n: number) => String(n).padStart(2, '0');
        const file = await window.orbit.recording.save(
          `Edit ${two(stamp.getHours())}.${two(stamp.getMinutes())}.${two(stamp.getSeconds())}.wav`,
          wav,
        );
        const wavBuf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
        const newSampleId = newId();
        await engine.loadSample(newSampleId, wavBuf);
        const ref: SampleRef = {
          id: newSampleId,
          name: `${sample.name} · ${OP_LABELS[op].toLowerCase()}`,
          path: `recording:${file}`,
          hash: (await sha1Hex(wavBuf)) ?? newSampleId,
          duration: channels.duration,
        };
        const label = `${OP_LABELS[op]} "${sample.name}"`;
        store.dispatch(
          {
            type: 'batch',
            label,
            commands: [
              { type: 'registerSample', sample: ref },
              { type: 'patchClips', patches: [{ id: clip.id, sampleId: newSampleId }] },
            ],
          },
          { label },
        );
      } finally {
        setBusy(false);
      }
    },
    [channels, clip, sample, busy],
  );

  const listen = useCallback(() => {
    if (!clip?.sampleId) return;
    ensureAudioReady();
    engine.previewSample(clip.sampleId, clip.audioGain ?? 1);
  }, [clip]);

  if (!clip || clip.kind !== 'audio' || !sample) {
    return (
      <div className="panel-placeholder">
        Doble clic en un clip de audio de la playlist para editarlo aquí.
      </div>
    );
  }

  return (
    <div className="audio-editor">
      <div className="ae-toolbar">
        <span className="ae-name" title={sample.path}>
          {sample.name}
        </span>
        <button className="tbtn" onClick={listen} title="Escuchar el sample">
          ▶
        </button>
        <Knob
          value={clip.audioGain ?? 1}
          min={0}
          max={2}
          defaultValue={1}
          size={22}
          label="Ganancia"
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) =>
            store.dispatch(
              { type: 'patchClips', patches: [{ id: clip.id, audioGain: v }] },
              { label: 'Ganancia del clip', mergeKey: `ae:gain:${clip.id}` },
            )
          }
        />
        <div className="ae-ops">
          {(Object.keys(OP_LABELS) as AudioOp[]).map((op) => (
            <button key={op} className="tbtn" disabled={busy || !channels} onClick={() => void runOp(op)}>
              {OP_LABELS[op]}
            </button>
          ))}
        </div>
      </div>
      <div className="ae-wave-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="ae-wave"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
      <div className="ae-hint">
        Arrastra las asas para recortar (no destructivo) · las operaciones crean un sample nuevo
        con undo
      </div>
    </div>
  );
}
