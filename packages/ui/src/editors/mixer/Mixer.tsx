/**
 * Mixer estilo FL Studio.
 *
 * Izquierda: fila horizontal scrolleable de strips (índice 0 = Master).
 * Derecha: panel fijo (300px) con la cadena de 10 slots de efectos de la
 * pista seleccionada.
 *
 * Interacciones:
 * - Clic en un strip: seleccionar. Doble clic en el nombre: renombrar.
 * - Ctrl+clic en otro strip: alterna un SEND de la pista seleccionada (0.7).
 * - Clic derecho en otro strip: menú "Enrutar aquí" (cambia routeTo).
 * - Cadena: "+" inserta efecto; clic en el nombre expande su editor inline
 *   con perillas generadas desde EFFECT_PARAMS.
 *
 * Toda mutación pasa por store.dispatch (bus de comandos); las ráfagas de
 * perilla/fader se funden en un solo undo vía mergeKey.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  EQ_MAX,
  EQ_MIN,
  EFFECT_LABELS,
  EFFECT_PARAMS,
  MIXER_SLOTS,
  SEND_PARTS,
  SEND_PART_LABELS,
  SEND_PART_SHORT,
  SEND_TAPS,
  SEND_TAP_LABELS,
  defaultEffectParams,
  describeSend,
  resolveSend,
  sendIsShaped,
  gainToDb,
  newId,
  type EffectKind,
  type EffectSlot,
  type MixerTrack,
  type ParamSpec,
  type Send,
  type SendPart,
  type SendTap,
} from '@orbit/core';
import { reportActivity } from '../../collab/presence';
import { engine, ensureAudioReady, store } from '../../state/app';
import { acquireLiveLoudness, useLiveLoudness } from '../../state/live-loudness';
import { defaultPluginParams } from '../../state/plugin-parse';
import { usePluginsStore, type PluginInfo } from '../../state/plugins';
import { acquireScopeTracked, isScopeTrackActive } from '../../state/scope-track';
import { toggleTrackCapture, useTrackCapture } from '../../state/track-capture';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { freqToBin, SpectrumAnalyzer, SPECTRUM_DB_FLOOR } from '../../scope/spectrum';
import { Fader } from '../../widgets/Fader';
import { Knob } from '../../widgets/Knob';
import { LevelMeter } from '../../widgets/LevelMeter';
import { MenuPortal } from '../../widgets/MenuPortal';
import './mixer.css';

// Efectos nativos insertables; los slots 'plugin' se insertan desde la sección
// "Plugins JS" del menú con su pluginId (no como kind suelto).
const EFFECT_KINDS = (Object.keys(EFFECT_LABELS) as EffectKind[]).filter((k) => k !== 'plugin');
const FADER_H = 140;
const SEND_DEFAULT = 0.7;

// ── Helpers de formato ───────────────────────────────────────────────────────

function formatPan(v: number): string {
  const p = Math.round(v * 100);
  if (p === 0) return 'C';
  return p < 0 ? `${-p}L` : `${p}R`;
}

function formatParam(spec: ParamSpec, v: number): string {
  if (spec.options) {
    const i = Math.min(spec.options.length - 1, Math.max(0, Math.round(v)));
    return spec.options[i] ?? '';
  }
  if (spec.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (spec.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (spec.unit === 'dB') return `${v.toFixed(1)} dB`;
  if (spec.unit === 'st') return `${v.toFixed(1)} st`;
  const r = Math.round(v * 100) / 100;
  return spec.unit ? `${r} ${spec.unit}` : `${r}`;
}

function trackLabel(index: number, mixer: MixerTrack[]): string {
  if (index === 0) return 'Master';
  return mixer[index]?.name ?? `#${index}`;
}

/** Nombre visible de un slot: los kind 'plugin' toman el del registro. */
function slotLabel(slot: EffectSlot, plugins: PluginInfo[]): string {
  if (slot.kind !== 'plugin') return EFFECT_LABELS[slot.kind];
  return plugins.find((p) => p.id === slot.pluginId)?.name ?? EFFECT_LABELS.plugin;
}

// ── Menú flotante (efectos / routing) ────────────────────────────────────────

/**
 * Menús del mixer, por portal.
 *
 * Antes se colocaban a mano contra `window.innerWidth/innerHeight` de la
 * ventana PRINCIPAL: con el mixer desacoplado en su propia ventana, el menú se
 * recortaba contra un viewport que no era el suyo y podía acabar fuera de
 * pantalla. MenuPortal lo mide dentro de la ventana del ancla y lo pinta en su
 * <body>, fuera del `overflow: hidden` de la ventana interna.
 */
function FloatingMenu({
  x,
  y,
  anchor,
  onClose,
  children,
}: {
  x: number;
  y: number;
  anchor: Element | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <MenuPortal anchor={anchor} x={x} y={y} onClose={onClose} className="mixer-menu">
      {children}
    </MenuPortal>
  );
}

// ── Strip ────────────────────────────────────────────────────────────────────

/** Medidor aislado: solo él re-renderiza a ~20 fps con los peaks del kernel. */
function StripMeter({ index }: { index: number }) {
  const peak = useUiStore((s) => (s.trackPeaks ? (s.trackPeaks[index] ?? 0) : 0));
  // Línea de RMS de SU pista (el kernel mide todas por frame).
  const rms = useUiStore((s) => s.trackRms?.[index]);
  return <LevelMeter peak={peak} rms={rms} height={FADER_H} />;
}

/**
 * LUFS integrado del master en vivo, en el strip mismo: es lo que hace falta
 * para ver que la mezcla va camino a -14 (objetivo de streaming del
 * proyecto) SIN exportar. Vive mientras el strip del Master esté montado —
 * es decir, mientras el mixer esté abierto — igual que el Orbit Scope se
 * apaga solo al cerrar su ventana.
 */
function MasterLoudness() {
  const integrated = useLiveLoudness((s) => s.integrated);
  const stale = useLiveLoudness((s) => s.stale);
  useEffect(() => acquireLiveLoudness(), []);
  const over = integrated !== null && integrated > -14;
  return (
    <div
      className={`strip-lufs${stale ? ' stale' : ''}`}
      title={
        stale
          ? 'LUFS del master — en pausa: hay un espectro de otra pista abierto (el tap del kernel solo puede mirar una pista a la vez)'
          : 'LUFS integrado del master en vivo — objetivo de streaming: -14 LUFS'
      }
    >
      <span className={`strip-lufs-val${over ? ' hot' : ''}`}>
        {integrated === null ? '—' : integrated.toFixed(1)}
      </span>
      <span className="strip-lufs-label">LUFS</span>
    </div>
  );
}

function StripName({ index, name }: { index: number; name: string }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  if (!editing) {
    return (
      <div
        className="strip-name"
        title={`${name} (doble clic: renombrar)`}
        onDoubleClick={() => {
          cancelled.current = false;
          setEditing(true);
        }}
      >
        {name}
      </div>
    );
  }
  return (
    <input
      className="strip-name-input"
      autoFocus
      defaultValue={name}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          setEditing(false);
        }
      }}
      onBlur={(e) => {
        if (cancelled.current) return;
        setEditing(false);
        const trimmed = e.currentTarget.value.trim();
        if (trimmed && trimmed !== name) {
          store.dispatch(
            { type: 'patchMixerTrack', trackIndex: index, patch: { name: trimmed } },
            { label: `Renombrar pista → "${trimmed}"` },
          );
        }
      }}
    />
  );
}

interface StripProps {
  index: number;
  track: MixerTrack;
  selected: boolean;
  /** Muestra el puntito de send (hay otra pista seleccionada que puede enviar aquí). */
  showDot: boolean;
  sendActive: boolean;
  /** Esta pista es el routeTo de la seleccionada. */
  isRouteTarget: boolean;
  onSelect: (index: number) => void;
  onToggleSend: (index: number) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, index: number) => void;
}

function Strip({
  index,
  track,
  selected,
  showDot,
  sendActive,
  isRouteTarget,
  onSelect,
  onToggleSend,
  onContextMenu,
}: StripProps) {
  const setVolume = useCallback(
    (volume: number) => {
      store.dispatch(
        { type: 'patchMixerTrack', trackIndex: index, patch: { volume } },
        { mergeKey: `mixer:${index}:vol`, label: 'Volumen' },
      );
    },
    [index],
  );

  const setPan = useCallback(
    (pan: number) => {
      store.dispatch(
        { type: 'patchMixerTrack', trackIndex: index, patch: { pan } },
        { mergeKey: `mixer:${index}:pan`, label: 'Pan' },
      );
    },
    [index],
  );

  const db = gainToDb(track.volume);

  return (
    <div
      className={`strip${selected ? ' selected' : ''}${index === 0 ? ' master' : ''}`}
      onClick={(e) => {
        if ((e.ctrlKey || e.metaKey) && showDot) onToggleSend(index);
        else onSelect(index);
      }}
      onContextMenu={(e) => onContextMenu(e, index)}
    >
      <label
        className="strip-color"
        style={{ background: track.color }}
        title="Color de pista (clic para cambiar)"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          type="color"
          className="strip-color-input"
          value={track.color}
          onChange={(e) =>
            store.dispatch(
              { type: 'patchMixerTrack', trackIndex: index, patch: { color: e.target.value } },
              { mergeKey: `mixer:${index}:color`, label: 'Color de pista' },
            )
          }
        />
      </label>
      <div className="strip-num">{index === 0 ? 'M' : index}</div>
      <StripName index={index} name={track.name} />
      <Knob
        value={track.pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={22}
        format={formatPan}
        onChange={setPan}
        paramRef={{ kind: 'mixer', trackIndex: index, param: 'pan' }}
      />
      <div className="strip-fader-row">
        <StripMeter index={index} />
        <Fader
          value={track.volume}
          height={FADER_H}
          onChange={setVolume}
          paramRef={{ kind: 'mixer', trackIndex: index, param: 'volume' }}
        />
      </div>
      <div className="strip-db">{db <= -96 ? '-∞' : db.toFixed(1)}</div>
      {index === 0 && <MasterLoudness />}
      <div className="strip-ms">
        <button
          className={`strip-btn${track.mute ? ' on-mute' : ''}`}
          title="Mute"
          onClick={(e) => {
            e.stopPropagation();
            store.dispatch(
              { type: 'patchMixerTrack', trackIndex: index, patch: { mute: !track.mute } },
              { label: track.mute ? 'Quitar mute' : 'Mute' },
            );
          }}
        >
          M
        </button>
        <button
          className={`strip-btn${track.solo ? ' on-solo' : ''}`}
          title="Solo"
          onClick={(e) => {
            e.stopPropagation();
            store.dispatch(
              { type: 'patchMixerTrack', trackIndex: index, patch: { solo: !track.solo } },
              { label: track.solo ? 'Quitar solo' : 'Solo' },
            );
          }}
        >
          S
        </button>
      </div>
      <div className="strip-route">
        {isRouteTarget ? (
          <span className="strip-route-arrow" title="La pista seleccionada desemboca aquí">
            ▶
          </span>
        ) : showDot ? (
          <span
            className={`strip-route-dot${sendActive ? ' active' : ''}`}
            title="Ctrl+clic: alternar send desde la pista seleccionada"
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Analizador del Orbit EQ: espectro en vivo + curva de respuesta ───────────

const FREQ_MIN = 20;
/** Escala vertical de la curva de respuesta: ±18 dB (0 dB al centro). */
const CURVE_DB = 18;

/**
 * Coeficientes RBJ (a0 normalizado a 1), réplica EXACTA de las fórmulas de
 * dsp/filters.ts del motor para que la curva pinte lo que suena.
 */
interface BiquadCoefs { b0: number; b1: number; b2: number; a1: number; a2: number }

function rbjLowpass(f: number, q: number, sr: number): BiquadCoefs {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = ((1 - cw) / 2) / a0;
  return { b0, b1: (1 - cw) / a0, b2: b0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function rbjHighpass(f: number, q: number, sr: number): BiquadCoefs {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = ((1 + cw) / 2) / a0;
  return { b0, b1: (-(1 + cw)) / a0, b2: b0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function rbjPeaking(f: number, db: number, q: number, sr: number): BiquadCoefs {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cw) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

function rbjLowShelf(f: number, db: number, sr: number): BiquadCoefs {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const S = 1;
  const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 + (A - 1) * cw + twoSqrtAAlpha;
  return {
    b0: (A * (A + 1 - (A - 1) * cw + twoSqrtAAlpha)) / a0,
    b1: (2 * A * (A - 1 - (A + 1) * cw)) / a0,
    b2: (A * (A + 1 - (A - 1) * cw - twoSqrtAAlpha)) / a0,
    a1: (-2 * (A - 1 + (A + 1) * cw)) / a0,
    a2: (A + 1 + (A - 1) * cw - twoSqrtAAlpha) / a0,
  };
}

function rbjHighShelf(f: number, db: number, sr: number): BiquadCoefs {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const S = 1;
  const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cw + twoSqrtAAlpha;
  return {
    b0: (A * (A + 1 + (A - 1) * cw + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cw - twoSqrtAAlpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cw)) / a0,
    a2: (A + 1 - (A - 1) * cw - twoSqrtAAlpha) / a0,
  };
}

/**
 * Etapas activas del Orbit EQ como biquads RBJ. Mismo orden y mismos umbrales
 * de activación que EqUnit (dsp/effects.ts): HP si > 22 Hz, LP si < 19.5 kHz.
 */
function eqStages(p: Record<string, number>, sr: number): BiquadCoefs[] {
  const stages: BiquadCoefs[] = [];
  const hp = p['hpFreq'] ?? 20;
  const lp = p['lpFreq'] ?? 20000;
  if (hp > 22) stages.push(rbjHighpass(hp, 0.707, sr));
  stages.push(rbjLowShelf(p['lowFreq'] ?? 120, p['lowGain'] ?? 0, sr));
  stages.push(rbjPeaking(p['midFreq'] ?? 1000, p['midGain'] ?? 0, p['midQ'] ?? 1, sr));
  stages.push(rbjHighShelf(p['highFreq'] ?? 6000, p['highGain'] ?? 0, sr));
  if (lp < 19500) stages.push(rbjLowpass(lp, 0.707, sr));
  return stages;
}

/** Magnitud |H(e^jw)| en dB de un biquad a la frecuencia f. */
function biquadDb(c: BiquadCoefs, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const num =
    c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 +
    2 * (c.b0 * c.b1 + c.b1 * c.b2) * cw + 2 * c.b0 * c.b2 * c2w;
  const den =
    1 + c.a1 * c.a1 + c.a2 * c.a2 +
    2 * (c.a1 + c.a1 * c.a2) * cw + 2 * c.a2 * c2w;
  return 10 * Math.log10(Math.max(1e-12, num) / Math.max(1e-12, den));
}

/**
 * Canvas del Orbit EQ: espectro en vivo de la pista (tap del kernel) con la
 * curva de respuesta del EQ superpuesta. Mientras está montado redirige el
 * scope a su pista; si el Orbit Scope está abierto a la vez, el último gana.
 */
function EqAnalyzer({ trackIndex, slotIndex }: { trackIndex: number; slotIndex: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureAudioReady();
    // Préstamo con recuento: el tap del kernel es uno solo y lo comparte con la
    // ventana del Orbit Scope. Al plegar este EQ, el tap vuelve a quien lo
    // tuviera antes en vez de apagarse y dejar al otro en blanco.
    const releaseScope = acquireScopeTracked(trackIndex);
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
      ctx.strokeStyle = line;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      const sr = engine.sampleRate;
      const nyquist = sr / 2;
      const logMin = Math.log10(FREQ_MIN);
      const logMax = Math.log10(nyquist);
      const xToFreq = (x: number) => Math.pow(10, logMin + (x / w) * (logMax - logMin));
      const freqToX = (f: number) =>
        ((Math.log10(Math.max(FREQ_MIN, f)) - logMin) / (logMax - logMin)) * w;

      // Rejilla de frecuencias
      ctx.fillStyle = dim;
      ctx.font = `9px ${css.fontFamily}`;
      for (const f of [100, 1000, 10000]) {
        const x = freqToX(f);
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x, 0, 1, h);
        ctx.globalAlpha = 1;
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 3);
      }

      // ── Espectro en vivo (relleno translúcido) ──
      // Igual que el Orbit Scope: si otra vista se llevó el tap por delante,
      // no se dibuja el audio de una pista ajena como si fuera la de aquí.
      const owns = isScopeTrackActive(trackIndex);
      const frame = owns ? useUiStore.getState().scopeFrame : null;
      if (frame) {
        spectrum.update(frame);
        const db = spectrum.db;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x < w; x++) {
          const f = xToFreq(x);
          const bin = freqToBin(f, spectrum.fftN, sr);
          const mag = db[bin]!;
          ctx.lineTo(x, Math.min(h, (mag / SPECTRUM_DB_FLOOR) * h));
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (!owns) {
        ctx.fillStyle = dim;
        ctx.font = `9px ${css.fontFamily}`;
        ctx.fillText('En pausa — Orbit Scope u otra pista tiene el tap', 6, h / 2);
      }

      // ── Curva de respuesta del EQ (±18 dB, línea de 0 dB al centro) ──
      const dbToY = (db: number) =>
        h / 2 - (Math.max(-CURVE_DB, Math.min(CURVE_DB, db)) / CURVE_DB) * (h / 2 - 4);
      ctx.strokeStyle = dim;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, dbToY(0) + 0.5);
      ctx.lineTo(w, dbToY(0) + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Params en vivo del store (la perilla mueve la curva en el mismo frame).
      const slot = store.project.mixer[trackIndex]?.slots[slotIndex];
      if (slot?.kind === 'eq') {
        const stages = eqStages(slot.params, sr);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const f = xToFreq(x);
          let db = 0;
          for (const c of stages) db += biquadDb(c, f, sr);
          const y = dbToY(db);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    };
    raf = requestAnimationFrame(drawLoop);

    return () => {
      cancelAnimationFrame(raf);
      releaseScope();
    };
  }, [trackIndex, slotIndex]);

  return (
    <div className="eq-viz" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/**
 * Espectro en vivo de la pista seleccionada, SIEMPRE visible en el panel de
 * cadena — a diferencia de `EqAnalyzer`, no hace falta insertar ni abrir un
 * EQ para verlo. Es lo que hace falta para encontrar dónde choca el 808 con
 * el bombo sin exportar: seleccioná la pista y mirá dónde se pisa la energía.
 *
 * Mismo tap y misma FFT que el Orbit Scope y el EQ (`SpectrumAnalyzer`,
 * `acquireScopeTracked`): si otra vista pidió el tap después, este panel se
 * queda en pausa en vez de mostrar el audio de una pista ajena.
 */
function TrackSpectrum({ trackIndex }: { trackIndex: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureAudioReady();
    const releaseScope = acquireScopeTracked(trackIndex);
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
      ctx.strokeStyle = line;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      const sr = engine.sampleRate;
      const nyquist = sr / 2;
      const logMin = Math.log10(FREQ_MIN);
      const logMax = Math.log10(nyquist);
      const freqToX = (f: number) =>
        ((Math.log10(Math.max(FREQ_MIN, f)) - logMin) / (logMax - logMin)) * w;

      ctx.fillStyle = dim;
      ctx.font = `9px ${css.fontFamily}`;
      for (const f of [60, 250, 1000, 5000, 12000]) {
        const x = freqToX(f);
        ctx.globalAlpha = 0.3;
        ctx.fillRect(x, 0, 1, h);
        ctx.globalAlpha = 1;
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 3);
      }

      const owns = isScopeTrackActive(trackIndex);
      const frame = owns ? useUiStore.getState().scopeFrame : null;
      if (frame) {
        spectrum.update(frame);
        const db = spectrum.db;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x < w; x++) {
          const f = Math.pow(10, logMin + (x / w) * (logMax - logMin));
          const bin = freqToBin(f, spectrum.fftN, sr);
          const mag = db[bin]!;
          ctx.lineTo(x, Math.min(h, (mag / SPECTRUM_DB_FLOOR) * h));
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (!owns) {
        ctx.fillStyle = dim;
        ctx.font = `9px ${css.fontFamily}`;
        ctx.fillText('En pausa — el Orbit Scope tiene el tap abierto', 6, h / 2);
      }
    };
    raf = requestAnimationFrame(drawLoop);

    return () => {
      cancelAnimationFrame(raf);
      releaseScope();
    };
  }, [trackIndex]);

  return (
    <div className="track-spectrum" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// ── Editor de un efecto (perillas desde EFFECT_PARAMS) ───────────────────────

function EffectEditor({
  trackIndex,
  slotIndex,
  slot,
  mixer,
}: {
  trackIndex: number;
  slotIndex: number;
  slot: EffectSlot;
  mixer: MixerTrack[];
}) {
  // Los plugins JS declaran sus perillas en su archivo: specs del registro.
  const plugins = usePluginsStore((s) => s.plugins);
  const plugin = slot.kind === 'plugin' ? plugins.find((p) => p.id === slot.pluginId) : undefined;
  const specs = slot.kind === 'plugin' ? (plugin?.params ?? []) : EFFECT_PARAMS[slot.kind];
  const pluginMissing = slot.kind === 'plugin' && !plugin;

  return (
    <div className="fx-editor">
      {slot.kind === 'eq' && <EqAnalyzer trackIndex={trackIndex} slotIndex={slotIndex} />}
      {pluginMissing && (
        <div className="fx-warn">Plugin no encontrado: {slot.pluginId ?? '(sin id)'}</div>
      )}
      {specs.length === 0 && slot.kind !== 'compressor' && !pluginMissing && (
        <div className="fx-empty">Sin parámetros.</div>
      )}
      {specs.map((spec) =>
        spec.options ? (
          <div className="fx-opt" key={spec.key}>
            <select
              className="mixer-select"
              value={Math.min(
                spec.options.length - 1,
                Math.max(0, Math.round(slot.params[spec.key] ?? spec.default)),
              )}
              onChange={(e) =>
                store.dispatch(
                  {
                    type: 'setEffectParam',
                    trackIndex,
                    slotIndex,
                    key: spec.key,
                    value: Number(e.target.value),
                  },
                  { label: `Efecto: ${spec.label}` },
                )
              }
            >
              {spec.options.map((opt, oi) => (
                <option key={opt} value={oi}>
                  {opt}
                </option>
              ))}
            </select>
            <span className="knob-label">{spec.label}</span>
          </div>
        ) : (
          <Knob
            key={spec.key}
            value={slot.params[spec.key] ?? spec.default}
            min={spec.min}
            max={spec.max}
            defaultValue={spec.default}
            curve={spec.curve}
            label={spec.label}
            size={30}
            format={(v) => formatParam(spec, v)}
            onChange={(v) =>
              store.dispatch(
                { type: 'setEffectParam', trackIndex, slotIndex, key: spec.key, value: v },
                { mergeKey: `fx:${trackIndex}:${slotIndex}:${spec.key}`, label: spec.label },
              )
            }
            // Los plugins JS declaran sus rangos fuera del registro de params:
            // sin spec, automatización y LFO no sabrían desnormalizar.
            paramRef={
              slot.kind === 'plugin'
                ? undefined
                : { kind: 'effect', trackIndex, slotIndex, param: spec.key }
            }
          />
        ),
      )}
      {slot.kind === 'compressor' && (
        <label className="fx-side">
          <span>Sidechain</span>
          <select
            className="mixer-select"
            value={slot.sidechainSource ?? -1}
            onChange={(e) => {
              const v = Number(e.target.value);
              store.dispatch(
                {
                  type: 'patchEffect',
                  trackIndex,
                  slotIndex,
                  patch: { sidechainSource: v < 0 ? undefined : v },
                },
                { label: 'Sidechain' },
              );
            }}
          >
            <option value={-1}>Ninguno</option>
            {mixer.map((t, ti) =>
              ti === 0 ? null : (
                <option key={t.id} value={ti}>
                  {ti} — {t.name}
                </option>
              ),
            )}
          </select>
        </label>
      )}
    </div>
  );
}

// ── Panel de cadena (pista seleccionada) ─────────────────────────────────────

function ChainPanel({
  trackIndex,
  track,
  mixer,
}: {
  trackIndex: number;
  track: MixerTrack;
  mixer: MixerTrack[];
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fxMenu, setFxMenu] = useState<{
    slot: number;
    x: number;
    y: number;
    anchor: Element;
  } | null>(null);
  /** Qué envío tiene abierto su panel de "qué lleva". */
  const [sendMenu, setSendMenu] = useState<{
    x: number;
    y: number;
    trackIndex: number;
    target: number;
  } | null>(null);
  const plugins = usePluginsStore((s) => s.plugins);
  const capturing = useTrackCapture((s) => s.trackIndex === trackIndex);
  const captureSeconds = useTrackCapture((s) => s.seconds);
  const captureError = useTrackCapture((s) => s.error);

  /** patchMixerTrack con mergeKey: el arrastre de la perilla es un solo undo. */
  const patchTrack = useCallback(
    (patch: Partial<MixerTrack>, label: string, key: string) => {
      store.dispatch(
        { type: 'patchMixerTrack', trackIndex, patch },
        { label, mergeKey: `mixer:${trackIndex}:${key}` },
      );
    },
    [trackIndex],
  );

  // Cambiar de pista cierra editor y menú (los slots son de otra cadena).
  useEffect(() => {
    setExpanded(null);
    setFxMenu(null);
  }, [trackIndex]);

  const insert = useCallback(
    (slotIndex: number, kind: EffectKind) => {
      const slot: EffectSlot = {
        id: newId(),
        kind,
        enabled: true,
        mix: 1,
        params: defaultEffectParams(kind),
      };
      store.dispatch(
        { type: 'setEffect', trackIndex, slotIndex, slot },
        { label: `Insertar ${EFFECT_LABELS[kind]}` },
      );
      setExpanded(slotIndex);
    },
    [trackIndex],
  );

  // Insertar un plugin JS: slot kind 'plugin' con su pluginId y los defaults
  // de las perillas que declara el propio archivo.
  const insertPlugin = useCallback(
    (slotIndex: number, plugin: PluginInfo) => {
      const slot: EffectSlot = {
        id: newId(),
        kind: 'plugin',
        enabled: true,
        mix: 1,
        params: defaultPluginParams(plugin.params),
        pluginId: plugin.id,
      };
      store.dispatch(
        { type: 'setEffect', trackIndex, slotIndex, slot },
        { label: `Insertar ${plugin.name}` },
      );
      setExpanded(slotIndex);
    },
    [trackIndex],
  );

  // La cadena vocal de Orbit: EQ que limpia y da presencia, compresor que
  // sujeta, saturación suave, slap 1/4 y cola corta — la voz por encima.
  const freeSlots = track.slots.filter((s) => !s).length;
  const applyVocalChain = useCallback(() => {
    const free: number[] = [];
    for (let i = 0; i < MIXER_SLOTS && free.length < 5; i++) {
      if (!track.slots[i]) free.push(i);
    }
    if (free.length < 5) return;
    const mk = (kind: EffectKind, overrides: Record<string, number>, mix = 1): EffectSlot => ({
      id: newId(),
      kind,
      enabled: true,
      mix,
      params: { ...defaultEffectParams(kind), ...overrides },
    });
    const chain: [number, EffectSlot][] = [
      [free[0]!, mk('eq', { hpFreq: 90, lowGain: -2, lowFreq: 250, midGain: 2.5, midFreq: 3200, midQ: 0.9, highGain: 2, highFreq: 11000 })],
      [free[1]!, mk('compressor', { threshold: -18, ratio: 3, attack: 0.008, release: 0.12, makeup: 4 })],
      [free[2]!, mk('distortion', { drive: 0.18, tone: 5500, mode: 0, output: 1 }, 0.22)],
      [free[3]!, mk('delay', { time: 5, feedback: 0.28, pingpong: 1, filter: 3000 }, 0.15)],
      [free[4]!, mk('reverb', { size: 0.55, damp: 0.5, predelay: 0.03 }, 0.16)],
    ];
    const label = `Cadena vocal en "${track.name}"`;
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: chain.map(([slotIndex, slot]) => ({
          type: 'setEffect' as const,
          trackIndex,
          slotIndex,
          slot,
        })),
      },
      { label },
    );
  }, [track, trackIndex]);

  return (
    <div className="mixer-chain">
      <div className="mixer-chain-header">
        <div className="mixer-chain-title" title={track.name}>
          {trackIndex === 0 ? 'M' : trackIndex} · {track.name}
        </div>
        <div className="mixer-chain-route">
          {track.routeTo === null ? 'Salida final' : `→ ${trackLabel(track.routeTo, mixer)}`}
          {track.sends.length > 0 &&
            ` · ${track.sends.length} send${track.sends.length > 1 ? 's' : ''}`}
        </div>
        <button
          className="vocal-chain-btn"
          title="Monta la cadena vocal de Orbit (EQ + compresor + saturación + delay 1/4 + reverb) en 5 slots libres"
          disabled={freeSlots < 5}
          onClick={applyVocalChain}
        >
          Cadena vocal
        </button>
        <button
          className={`track-rec-btn${capturing ? ' on' : ''}`}
          title={
            captureError
              ? `Grabación de pista: ${captureError}`
              : capturing
                ? 'Grabando la salida de esta pista — clic para parar y colocar la toma'
                : 'Graba la salida de esta pista (post-fader) a un WAV y la coloca en la playlist'
          }
          onClick={() => void toggleTrackCapture(trackIndex)}
        >
          <span className="rec-dot" />
          {capturing ? `${captureSeconds.toFixed(1)} s` : 'Grabar salida'}
        </button>
      </div>
      <TrackSpectrum trackIndex={trackIndex} />
      {/* EQ rápido del strip + separación estéreo (post-efectos, pre-fader). */}
      <div className="strip-eq">
        <span className="strip-eq-label" title="EQ de la pista: 120 Hz · 1 kHz · 6 kHz">
          EQ
        </span>
        <Knob
          value={track.eqLow ?? 0}
          min={EQ_MIN}
          max={EQ_MAX}
          defaultValue={0}
          size={26}
          label="Low"
          format={(v) => `${v.toFixed(1)} dB`}
          onChange={(v) => patchTrack({ eqLow: v }, 'EQ de pista: graves', 'eqLow')}
          paramRef={{ kind: 'mixer', trackIndex, param: 'eqLow' }}
        />
        <Knob
          value={track.eqMid ?? 0}
          min={EQ_MIN}
          max={EQ_MAX}
          defaultValue={0}
          size={26}
          label="Mid"
          format={(v) => `${v.toFixed(1)} dB`}
          onChange={(v) => patchTrack({ eqMid: v }, 'EQ de pista: medios', 'eqMid')}
          paramRef={{ kind: 'mixer', trackIndex, param: 'eqMid' }}
        />
        <Knob
          value={track.eqHigh ?? 0}
          min={EQ_MIN}
          max={EQ_MAX}
          defaultValue={0}
          size={26}
          label="High"
          format={(v) => `${v.toFixed(1)} dB`}
          onChange={(v) => patchTrack({ eqHigh: v }, 'EQ de pista: agudos', 'eqHigh')}
          paramRef={{ kind: 'mixer', trackIndex, param: 'eqHigh' }}
        />
        <Knob
          value={track.stereoWidth}
          min={0}
          max={2}
          defaultValue={1}
          size={26}
          label="Width"
          format={(v) => (v === 0 ? 'Mono' : `${Math.round(v * 100)}%`)}
          onChange={(v) => patchTrack({ stereoWidth: v }, 'Separación estéreo', 'width')}
          paramRef={{ kind: 'mixer', trackIndex, param: 'stereoWidth' }}
        />
      </div>
      {track.sends.length > 0 && (
        <div className="mixer-sends">
          {track.sends.map((s) => (
            <div key={s.target} className="send-row">
              {/* La etiqueta abre lo que el envío ES. El strip mide 88 px: los
                  cinco controles no caben en la fila, y meterlos escondería el
                  nivel, que es lo que se toca a diario. */}
              <button
                className={`send-label${sendIsShaped(s) ? ' shaped' : ''}`}
                title={
                  describeSend(s)
                    ? `Send hacia ${trackLabel(s.target, mixer)} — ${describeSend(s)}`
                    : `Send hacia ${trackLabel(s.target, mixer)}. Clic para elegir qué lleva.`
                }
                onClick={(e) =>
                  setSendMenu({ x: e.clientX, y: e.clientY, trackIndex, target: s.target })
                }
              >
                → {trackLabel(s.target, mixer)}
                {sendIsShaped(s) && (
                  <span className="send-tag">
                    {resolveSend(s).tap === 'pre' ? 'pre' : ''}
                    {SEND_PART_SHORT[resolveSend(s).part]}
                    {resolveSend(s).invert ? 'ø' : ''}
                  </span>
                )}
              </button>
              <Knob
                value={s.level}
                min={0}
                max={2}
                defaultValue={0.7}
                size={18}
                format={(v) => `Send ${Math.round(v * 100)}%`}
                onChange={(v) =>
                  store.dispatch(
                    { type: 'setSend', trackIndex, target: s.target, level: v },
                    { label: 'Nivel de send', mergeKey: `mx:send:${trackIndex}:${s.target}` },
                  )
                }
              />
              <button
                className="send-del"
                title="Quitar send"
                onClick={() =>
                  store.dispatch(
                    { type: 'setSend', trackIndex, target: s.target, level: null },
                    { label: 'Quitar send' },
                  )
                }
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mixer-chain-slots">
        {Array.from({ length: MIXER_SLOTS }, (_, i) => {
          const slot = track.slots[i] ?? null;
          if (!slot) {
            return (
              <div key={`empty-${i}`} className="fx-slot empty">
                <button
                  className="fx-add"
                  title="Insertar efecto"
                  onClick={(e) => {
                    // Se pide debajo del botón; meterlo dentro del viewport de
                    // la ventana que toque ya lo hace MenuPortal midiéndolo.
                    const r = e.currentTarget.getBoundingClientRect();
                    setFxMenu({ slot: i, x: r.left, y: r.bottom + 2, anchor: e.currentTarget });
                  }}
                >
                  +
                </button>
              </div>
            );
          }
          const fxName = slotLabel(slot, plugins);
          return (
            <div key={slot.id} className="fx-slot">
              <div className={`fx-row${slot.enabled ? '' : ' off'}`}>
                <button
                  className={`fx-led${slot.enabled ? ' on' : ''}`}
                  title={slot.enabled ? 'Apagar' : 'Encender'}
                  onClick={() =>
                    store.dispatch(
                      {
                        type: 'patchEffect',
                        trackIndex,
                        slotIndex: i,
                        patch: { enabled: !slot.enabled },
                      },
                      {
                        label: `${slot.enabled ? 'Apagar' : 'Encender'} ${fxName}`,
                      },
                    )
                  }
                />
                <button
                  className="fx-name"
                  title="Editar parámetros"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  {fxName}
                </button>
                <Knob
                  value={slot.mix}
                  min={0}
                  max={1}
                  defaultValue={1}
                  size={18}
                  format={(v) => `Mix ${Math.round(v * 100)}%`}
                  onChange={(v) =>
                    store.dispatch(
                      { type: 'patchEffect', trackIndex, slotIndex: i, patch: { mix: v } },
                      { mergeKey: `fx:${trackIndex}:${i}:mix`, label: 'Mix' },
                    )
                  }
                />
                <button
                  className="fx-del"
                  title="Quitar efecto"
                  onClick={() => {
                    store.dispatch(
                      { type: 'setEffect', trackIndex, slotIndex: i, slot: null },
                      { label: `Quitar ${fxName}` },
                    );
                    if (expanded === i) setExpanded(null);
                  }}
                >
                  ×
                </button>
              </div>
              {expanded === i && (
                <EffectEditor trackIndex={trackIndex} slotIndex={i} slot={slot} mixer={mixer} />
              )}
            </div>
          );
        })}
      </div>
      {sendMenu && (
        <SendMenu
          x={sendMenu.x}
          y={sendMenu.y}
          trackIndex={sendMenu.trackIndex}
          send={
            mixer[sendMenu.trackIndex]?.sends.find((s) => s.target === sendMenu.target) ?? null
          }
          label={trackLabel(sendMenu.target, mixer)}
          onClose={() => setSendMenu(null)}
        />
      )}
      {fxMenu && (
        <FloatingMenu
          x={fxMenu.x}
          y={fxMenu.y}
          anchor={fxMenu.anchor}
          onClose={() => setFxMenu(null)}
        >
          {EFFECT_KINDS.map((kind) => (
            <button
              key={kind}
              className="menu-item"
              onClick={() => {
                insert(fxMenu.slot, kind);
                setFxMenu(null);
              }}
            >
              {EFFECT_LABELS[kind]}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="fx-menu-title">Plugins JS</div>
          {plugins.map((p) => (
            <button
              key={p.id}
              className="menu-item"
              title={`Plugin JS de usuario (${p.id}.js)`}
              onClick={() => {
                insertPlugin(fxMenu.slot, p);
                setFxMenu(null);
              }}
            >
              {p.name}
            </button>
          ))}
          {plugins.length === 0 && (
            <div className="fx-menu-hint">Pon archivos .js en la carpeta de plugins</div>
          )}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              // El ?. doble cubre la web (sin puente) y preloads viejos sin `plugins`.
              void window.orbit?.plugins?.openFolder();
              setFxMenu(null);
            }}
          >
            Abrir carpeta de plugins…
          </button>
        </FloatingMenu>
      )}
    </div>
  );
}

// ── Mixer ────────────────────────────────────────────────────────────────────

export function Mixer() {
  const project = useProject();
  const selectedRaw = useUiStore((s) => s.selectedMixerTrack);
  /** Menú del strip pulsado con el botón derecho (seleccionar / rutas). */
  const [stripMenu, setStripMenu] = useState<{
    target: number;
    x: number;
    y: number;
    anchor: Element;
  } | null>(null);

  const mixer = project.mixer;
  const selIndex = selectedRaw >= 0 && selectedRaw < mixer.length ? selectedRaw : 0;
  const selTrack = mixer[selIndex];

  const onSelect = useCallback(
    (i: number) => {
      useUiStore.setState({ selectedMixerTrack: i });
      reportActivity('Mixer', { detail: mixer[i]?.name });
    },
    [mixer],
  );

  const onToggleSend = useCallback(
    (target: number) => {
      const t = store.project.mixer[selIndex];
      if (!t || selIndex === 0 || target === selIndex) return;
      const has = t.sends.some((s) => s.target === target);
      store.dispatch(
        { type: 'setSend', trackIndex: selIndex, target, level: has ? null : SEND_DEFAULT },
        { label: has ? `Quitar send ${selIndex} → ${target}` : `Send ${selIndex} → ${target}` },
      );
    },
    [selIndex],
  );

  /**
   * Clic derecho en un strip: SIEMPRE abre menú.
   *
   * Antes hacía `preventDefault()` y se marchaba cuando la pista pulsada era
   * la seleccionada o cuando la seleccionada era el Master — que es el valor
   * por defecto. Resultado: recién abierto el mixer, el clic derecho sobre
   * cualquier strip mataba el menú del sistema y no abría el propio: no pasaba
   * absolutamente nada. Ahora el menú se abre igual y son sus opciones las que
   * se desactivan (con el porqué en el title) cuando no aplican.
   */
  const onStripContext = useCallback((e: React.MouseEvent<HTMLDivElement>, i: number) => {
    e.preventDefault();
    setStripMenu({ target: i, x: e.clientX, y: e.clientY, anchor: e.currentTarget });
  }, []);

  if (!selTrack) return null;

  // Opciones de ruta del menú: el Master no se re-enruta y una pista no puede
  // enrutarse ni enviarse a sí misma.
  const menuTarget = stripMenu?.target ?? -1;
  const canRoute = stripMenu !== null && menuTarget !== selIndex && selIndex !== 0;
  const sendActive = canRoute && selTrack.sends.some((s) => s.target === menuTarget);
  const routeHint =
    selIndex === 0
      ? 'El Master es la salida final: no se enruta a ninguna pista'
      : menuTarget === selIndex
        ? 'Una pista no puede enrutarse a sí misma — selecciona antes la pista de origen'
        : `Manda la salida de ${trackLabel(selIndex, mixer)} a esta pista`;

  return (
    <div className="mixer">
      <div className="mixer-strips">
        {mixer.map((t, i) => (
          <Strip
            key={t.id}
            index={i}
            track={t}
            selected={i === selIndex}
            showDot={i !== selIndex && selIndex !== 0}
            sendActive={i !== selIndex && selTrack.sends.some((s) => s.target === i)}
            isRouteTarget={i !== selIndex && selTrack.routeTo === i}
            onSelect={onSelect}
            onToggleSend={onToggleSend}
            onContextMenu={onStripContext}
          />
        ))}
      </div>
      <ChainPanel trackIndex={selIndex} track={selTrack} mixer={mixer} />
      {stripMenu && (
        <FloatingMenu
          x={stripMenu.x}
          y={stripMenu.y}
          anchor={stripMenu.anchor}
          onClose={() => setStripMenu(null)}
        >
          {menuTarget !== selIndex && (
            <button
              className="menu-item"
              onClick={() => {
                onSelect(menuTarget);
                setStripMenu(null);
              }}
            >
              Seleccionar {trackLabel(menuTarget, mixer)}
            </button>
          )}
          <button
            className="menu-item"
            disabled={!canRoute}
            title={routeHint}
            onClick={() => {
              store.dispatch(
                { type: 'setRoute', trackIndex: selIndex, routeTo: menuTarget },
                {
                  label: `Enrutar ${trackLabel(selIndex, mixer)} → ${trackLabel(menuTarget, mixer)}`,
                },
              );
              setStripMenu(null);
            }}
          >
            Enrutar aquí ({trackLabel(menuTarget, mixer)})
          </button>
          <button
            className="menu-item"
            disabled={!canRoute}
            title={
              canRoute
                ? 'Manda una copia con nivel propio (lo mismo que Ctrl+clic)'
                : routeHint
            }
            onClick={() => {
              onToggleSend(menuTarget);
              setStripMenu(null);
            }}
          >
            {sendActive ? 'Quitar send hacia aquí' : 'Send hacia aquí'}
          </button>
        </FloatingMenu>
      )}
    </div>
  );
}


/**
 * Qué lleva un envío: de dónde toma la señal, qué parte y con qué polaridad.
 *
 * En un menú flotante y no en el strip porque el strip mide 88 px de ancho:
 * cinco controles más ahí dentro esconderían el nivel, que es lo que se toca a
 * diario. Aquí se entra a decidir, no a mezclar.
 */
function SendMenu({
  x,
  y,
  trackIndex,
  send,
  label,
  onClose,
}: {
  x: number;
  y: number;
  trackIndex: number;
  send: Send | null;
  label: string;
  onClose: () => void;
}) {
  if (!send) return null;
  const r = resolveSend(send);
  const patch = (p: Partial<Omit<Send, 'target'>>, what: string): void => {
    store.dispatch(
      { type: 'patchSend', trackIndex, target: send.target, patch: p },
      { label: `Send: ${what}` },
    );
  };

  return (
    <MenuPortal anchor={null} x={x} y={y} onClose={onClose} className="param-menu send-menu">
      <div className="send-menu-title">Send → {label}</div>

      <label className="send-menu-row">
        Toma
        <select
          value={r.tap}
          onChange={(e) => patch({ tap: e.target.value as SendTap }, 'toma')}
        >
          {SEND_TAPS.map((tap) => (
            <option key={tap} value={tap}>
              {SEND_TAP_LABELS[tap]}
            </option>
          ))}
        </select>
      </label>
      <p className="send-menu-note">
        {r.tap === 'pre'
          ? 'Antes del fader: lo que mandas se queda aunque cierres la pista (pero no si la muteas).'
          : 'Después del fader: bajar la pista baja también lo que mandas.'}
      </p>

      <label className="send-menu-row">
        Manda
        <select
          value={r.part}
          onChange={(e) => patch({ part: e.target.value as SendPart }, 'parte')}
        >
          {SEND_PARTS.map((part) => (
            <option key={part} value={part}>
              {SEND_PART_LABELS[part]}
            </option>
          ))}
        </select>
      </label>
      <p className="send-menu-note">
        {r.part === 'side'
          ? 'Solo lo que se sale del centro: tratar los lados sin tocar lo que va en medio.'
          : r.part === 'mid'
            ? 'Solo el centro: la voz y el bombo sin lo que abre la imagen.'
            : r.part === 'stereo'
              ? 'La señal entera, como siempre.'
              : 'Ese canal, en mono a las dos salidas.'}
      </p>

      <label className="send-menu-row">
        Pan
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={r.pan}
          onChange={(e) => patch({ pan: Number(e.target.value) }, 'pan')}
        />
      </label>

      <label className="send-menu-check">
        <input
          type="checkbox"
          checked={r.invert}
          onChange={(e) => patch({ invert: e.target.checked }, 'polaridad')}
        />
        Invertir la polaridad (resta en vez de sumar)
      </label>
      <label className="send-menu-check">
        <input
          type="checkbox"
          checked={r.mute}
          onChange={(e) => patch({ mute: e.target.checked }, 'mute')}
        />
        Silenciar este envío
      </label>

      {describeSend(send) !== '' && <div className="send-menu-summary">{describeSend(send)}</div>}
    </MenuPortal>
  );
}
