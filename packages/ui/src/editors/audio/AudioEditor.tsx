/**
 * Editor de audio (Edison mini): forma de onda del sample de un clip de audio
 * con recorte por asas (audioOffset + length del clip, no destructivo),
 * ganancia del clip, escucha, y operaciones destructivas (normalizar,
 * reverse, fades) que generan un sample procesado NUEVO — se guarda como
 * grabación, se registra y el clip pasa a apuntarle, todo en un undo.
 *
 * Ese "se guarda como grabación" deja un `.wav` en disco por operación, y de
 * ahí salen las dos cosas que este archivo hace además de dibujar: el nombre va
 * por CONTENIDO (`editFileName`, que de paso cierra un pisado silencioso) y
 * cada escritura se ANOTA (`noteRecordingWritten`) para que la política de
 * disco de `state/sample-gc.ts` pueda decidir después, en un momento seguro, si
 * alguna vez sobra.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { newId, type Clip, type SampleRef } from '@orbit/core';
import { correctPitch, detectTransients, scalePitchClasses } from '@orbit/engine';
import { readSampleBytes } from '../../browser/sound-actions';
import { engine, ensureAudioReady, store } from '../../state/app';
import {
  AUDIO_EDITOR_PCM_ENTRIES,
  createUiAudioCache,
  sampleCacheKey,
} from '../../state/sample-gc';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { useThemeVersion } from '../../theme/useThemeVersion';
import { capturePointer } from '../../widgets/pointer';
import { Knob } from '../../widgets/Knob';
import { naturalRatePieces, trimAudioWindow } from '../clip-slice';
import { createAudioEditActions } from './audio-edit-actions';
import './audio-editor.css';

interface Channels {
  left: Float32Array;
  right: Float32Array;
  rate: number;
  duration: number;
}

/**
 * Caché de PCM decodificado por id:hash (decodificar es caro).
 *
 * Es la única de las tres cachés de audio del hilo de UI que lleva tope de
 * entradas, y es la única que lo necesita: sirve a UN sample —el abierto en el
 * editor— mientras las otras dos sirven al proyecto entero a la vez. Sin tope,
 * el barrido por proyecto no la acota en absoluto, porque cada Normalizar /
 * Reverse / Fade / Afinar de aquí abajo hace `registerSample` con un id nuevo y
 * el sample viejo SIGUE registrado: cinco Normalizar sobre un pad estéreo de
 * 30 s dejaban cinco buffers completos (~69 MB) que no volvían nunca. Con el
 * tope quedan dos, que son el que se está viendo y aquel del que se viene (ver
 * `AUDIO_EDITOR_PCM_ENTRIES` y la política común en `state/sample-gc.ts`).
 */
const pcmCache = createUiAudioCache<Channels>({
  name: 'editor-pcm',
  capacity: AUDIO_EDITOR_PCM_ENTRIES,
  bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
});

async function loadChannels(sample: SampleRef): Promise<Channels | null> {
  const key = sampleCacheKey(sample.id, sample.hash);
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

/** Nombres de nota para el selector de tónica. */
const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

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
  const [loadedSample, setLoadedSample] = useState<SampleRef | null>(null);
  const [editActions] = useState(() => createAudioEditActions(setBusy));

  // Cerrar o cambiar el clip invalida la operación anterior inmediatamente
  // en su controlador; el listener de reemplazo también cubre mismos IDs.
  useEffect(() => () => editActions.cancel(), [editActions, audioClipId, sample]);
  /** Transientes detectados (segundos desde el inicio del sample). */
  const [slices, setSlices] = useState<number[] | null>(null);
  /** Panel de afinación (corrección de tono de la toma). */
  const [tuneOpen, setTuneOpen] = useState(false);
  const [tuneStrength, setTuneStrength] = useState(1);
  const [tuneMode, setTuneMode] = useState<'chromatic' | 'major' | 'minor'>('chromatic');
  const [tuneRoot, setTuneRoot] = useState(0);
  const [tuneTranspose, setTuneTranspose] = useState(0);

  // Carga (cacheada) del PCM al cambiar de sample.
  useEffect(() => {
    let alive = true;
    setChannels(null);
    setLoadedSample(null);
    setSlices(null);
    if (!sample) return;
    void loadChannels(sample).then((ch) => {
      if (alive) { setChannels(ch); setLoadedSample(sample); }
    });
    return () => {
      alive = false;
    };
  }, [sample]);

  // Al cerrarse el editor, su caché PCM se queda sin lector: `loadChannels` es
  // el único que la lee y solo corre desde aquí. Hasta ahora esas dos entradas
  // sobrevivían al panel y esperaban al próximo CAMBIO DE PROYECTO, que es el
  // barrido de otra cosa — el mismo patrón de los otros dos huecos de esta
  // tarjeta: alta garantizada, baja a cargo de nadie.
  //
  // Va en un efecto propio con deps vacías, no en el `cleanup` del de arriba, y
  // ahí está la diferencia que importa: aquel corre en CADA cambio de sample y
  // tirar allí la entrada mataría justo el par que el tope de recencia existe
  // para conservar (Normalizar y Ctrl+Z, `AUDIO_EDITOR_PCM_ENTRIES`). Este
  // corre solo al desmontar, que es el único momento en que el consumidor de
  // verdad se fue (`InternalWindow` desmonta al cerrar la ventana). Reabrir
  // cuesta una relectura de disco de UN sample: lo mismo que abrirlo la primera
  // vez, y es un gesto explícito del usuario.
  useEffect(
    () => () => {
      pcmCache.clear();
    },
    [],
  );

  const secPerBeat = 60 / project.tempo;
  const offsetSec = clip?.audioOffset ?? 0;
  const clipSec = clip?.audioStretch
    ? clip.audioSourceLength ?? Math.max(0, (channels?.duration ?? sample?.duration ?? 0) - offsetSec)
    : (clip?.length ?? 0) * secPerBeat;

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

    // Transientes detectados: línea punteada por corte.
    if (slices && slices.length > 0) {
      ctx.strokeStyle = col('--meter');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (const t of slices) {
        const x = (t / dur) * w;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [channels, offsetSec, clipSec, themeVersion, slices]);

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
        store.dispatch(
          {
            type: 'patchClips',
            patches: [
              {
                id: clip.id,
                ...trimAudioWindow(clip, newOffset, offsetSec + clipSec, clipSec),
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
            patches: [{ id: clip.id, ...trimAudioWindow(clip, offsetSec, newEnd, clipSec) }],
          },
          { label: 'Recortar audio', mergeKey: `ae:trim:${clip.id}` },
        );
      }
    },
    [channels, clip, offsetSec, clipSec],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  // ── Operaciones destructivas → sample procesado nuevo ─────────────────────

  const runOp = useCallback(
    async (op: AudioOp) => {
      if (!channels || !clip || !sample || loadedSample !== sample) return;
      await editActions.run({
        clip, sample, channels, fileKind: OP_LABELS[op],
        sampleName: `${sample.name} · ${OP_LABELS[op].toLowerCase()}`,
        label: `${OP_LABELS[op]} "${sample.name}"`,
        process: () => applyOp(op, channels),
      });
    },
    [channels, clip, sample, loadedSample, editActions],
  );

  /** Busca los golpes del sample y los deja marcados sobre la onda. */
  const findTransients = useCallback(() => {
    if (!channels) return;
    const found = detectTransients(channels.left, channels.right, channels.rate, {
      sensitivity: 0.5,
      minSpacingSec: 0.04,
    });
    setSlices(found.times);
  }, [channels]);

  /**
   * Trocea el clip por las marcas: un clip por trozo, en la misma pista y
   * empezando donde estaba, todo en un solo undo. No toca el sample — cada
   * trozo es el mismo audio con su offset y su largo.
   *
   * Se trocea solamente la ventana audible de fuente, también tras un corte
   * en Playlist. Las piezas de esta herramienta usan velocidad natural.
   */
  const sliceClip = useCallback(() => {
    if (!clip || !channels || !slices || slices.length === 0) return;
    const dur = channels.duration;
    const from = offsetSec;
    const to = Math.min(dur, offsetSec + clipSec);
    const pieces = naturalRatePieces(from, to, slices);
    if (pieces.length === 0) return;
    const clips: Clip[] = pieces.map((p) => ({
      ...clip,
      id: newId(),
      start: clip.start + p.at / secPerBeat,
      length: p.seconds / secPerBeat,
      audioOffset: p.offset,
      audioSourceLength: p.seconds,
      audioGrainOffset: (clip.audioGrainOffset ?? 0) + p.offset - offsetSec,
      audioStretch: false,
    }));
    const label = `Trocear "${sample?.name ?? 'audio'}" en ${clips.length}`;
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: [
          { type: 'removeClips', clipIds: [clip.id] },
          { type: 'addClips', clips },
        ],
      },
      { label },
    );
    useUiStore.setState({ audioClipId: clips[0]!.id });
    setSlices(null);
  }, [clip, channels, slices, offsetSec, clipSec, secPerBeat, sample]);

  /**
   * Afina la toma: detecta el tono y lo lleva a la nota más cercana (o a la
   * escala elegida). Como el resto de operaciones del editor, escribe un
   * sample NUEVO y deja el original intacto, con su paso de undo.
   */
  const runTune = useCallback(async () => {
    if (!channels || !clip || !sample || loadedSample !== sample) return;
    await editActions.run({
      clip, sample, channels, fileKind: 'Afinado',
      sampleName: `${sample.name} · afinado`, label: `Afinar "${sample.name}"`,
      process: () => {
        const scale = tuneMode === 'chromatic' ? undefined : scalePitchClasses(tuneRoot, tuneMode);
        return correctPitch(channels.left, channels.right, channels.rate, {
          strength: tuneStrength, transpose: tuneTranspose,
          ...(scale ? { scale } : null),
        });
      },
      onApplied: () => setTuneOpen(false),
    });
  }, [channels, clip, sample, loadedSample, editActions, tuneStrength, tuneMode, tuneRoot, tuneTranspose]);

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
        <button
          className={`tbtn${clip.audioStretch ? ' active' : ''}`}
          title="Time-stretch: estira el audio (pitch intacto) para llenar el largo del clip — redimensiona el clip en la playlist y el audio lo sigue"
          onClick={() =>
            store.dispatch(
              { type: 'patchClips', patches: [{ id: clip.id, audioStretch: !clip.audioStretch }] },
              { label: clip.audioStretch ? 'Quitar time-stretch' : 'Time-stretch al clip' },
            )
          }
        >
          Stretch
        </button>
        <button
          className={`tbtn${slices ? ' active' : ''}`}
          disabled={!channels}
          title="Detecta dónde empieza cada golpe y lo marca sobre la onda"
          onClick={findTransients}
        >
          Transientes
        </button>
        <button
          className="tbtn"
          disabled={!slices || slices.length === 0}
          title="Parte el clip por las marcas: un clip por trozo, en un solo undo"
          onClick={sliceClip}
        >
          Trocear{slices && slices.length > 0 ? ` (${slices.length})` : ''}
        </button>
        <button
          className={`tbtn${tuneOpen ? ' active' : ''}`}
          disabled={!channels}
          title="Afinar la toma: lleva cada nota a la más cercana (o a una escala)"
          onClick={() => setTuneOpen((v) => !v)}
        >
          Afinar
        </button>
        <div className="ae-ops">
          {(Object.keys(OP_LABELS) as AudioOp[]).map((op) => (
            <button key={op} className="tbtn" disabled={busy || !channels} onClick={() => void runOp(op)}>
              {OP_LABELS[op]}
            </button>
          ))}
        </div>
      </div>
      {tuneOpen && (
        <div className="ae-tune">
          <Knob
            value={tuneStrength}
            min={0}
            max={1}
            defaultValue={1}
            size={26}
            label="Fuerza"
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={setTuneStrength}
          />
          <label className="ae-field">
            Escala
            <select
              value={tuneMode}
              onChange={(e) => setTuneMode(e.target.value as typeof tuneMode)}
            >
              <option value="chromatic">Cromática</option>
              <option value="major">Mayor</option>
              <option value="minor">Menor</option>
            </select>
          </label>
          {tuneMode !== 'chromatic' && (
            <label className="ae-field">
              Tónica
              <select value={tuneRoot} onChange={(e) => setTuneRoot(Number(e.target.value))}>
                {NOTE_NAMES.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="ae-field">
            Transponer
            <select
              value={tuneTranspose}
              onChange={(e) => setTuneTranspose(Number(e.target.value))}
            >
              {[-12, -7, -5, -3, 0, 3, 5, 7, 12].map((st) => (
                <option key={st} value={st}>
                  {st > 0 ? `+${st}` : st} st
                </option>
              ))}
            </select>
          </label>
          <button className="tbtn" disabled={busy} onClick={() => void runTune()}>
            Aplicar
          </button>
          <span className="ae-tune-hint">
            Crea un sample nuevo; el original se queda como estaba.
          </span>
        </div>
      )}
      <div className="ae-wave-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="ae-wave"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // Sin captura el asa se quedaba "agarrada" tras un gesto cortado.
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        />
      </div>
      <div className="ae-hint">
        Arrastra las asas para recortar (no destructivo) · las operaciones crean un sample nuevo
        con undo
      </div>
    </div>
  );
}
