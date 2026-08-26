/**
 * Editor de clips de automatización (canvas).
 *
 * Sin clip abierto (`automationClipId` null o inexistente): estado vacío con
 * un formulario "Nuevo clip de automatización" — destino (mixer / canal /
 * efecto / transporte, poblado desde el proyecto y los registros de params),
 * pista de playlist, inicio y longitud; crear despacha un addClips con dos
 * puntos al valor actual del parámetro y abre el clip nuevo.
 *
 * Con clip: cabecera con el destino legible, inicio/longitud editables y
 * borrar; el canvas pinta la rejilla por beats y la curva con la MISMA
 * interpolación de tensión que el motor (réplica de compile.ts).
 *
 * Tres herramientas (P / D / R, con guarda de hover):
 * - **Puntos**: doble clic añade (snap 1/16, Alt = libre), arrastrar un punto
 *   lo mueve (clamp 0..1 y entre vecinos), arrastrar el tramo entre dos curva
 *   la tensión y el clic derecho borra (mínimo 1 punto).
 * - **Lápiz**: se dibuja a mano alzada. El trazo vive en un ref mientras dura
 *   —se pinta encima, en otro color— y al soltar se simplifica y sustituye el
 *   tramo dibujado en UN paso de undo.
 * - **Recta**: una rampa entre dos puntos, con la misma sustitución de tramo.
 *
 * Durante el arrastre se muestra el valor REAL desnormalizado junto al cursor.
 *
 * Toda mutación pasa por store.dispatch (bus de comandos de @orbit/core);
 * las ráfagas de arrastre se funden en un solo undo con mergeKey
 * ('au:points:<clipId>'). patchClips reemplaza el array points completo
 * (siempre clonado). El store recompila y sincroniza el kernel solo:
 * los cambios se oyen en vivo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EFFECT_LABELS,
  EFFECT_PARAMS,
  INSTRUMENT_PARAMS,
  describeParamRef,
  formatParamRef,
  newId,
  paramRefNorm,
  type AutomationPoint,
  type Clip,
  type EffectSlot,
  type ParamRef,
  type Project,
} from '@orbit/core';
import { store } from '../../state/app';
import { useBounceStore } from '../../state/bounce';
import { simplifyCurve, type CurveSample } from '../../state/simplify';
import { lineBetween, quantizeValue, replaceRange, strokeToPoints } from './curve-tools';
import { ShapeDialog } from './ShapeDialog';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { NumberScrubber } from '../../widgets/NumberScrubber';
import { capturePointer } from '../../widgets/pointer';
import { useThemeVersion } from '../../theme/useThemeVersion';
import './automation.css';

/** Margen del área de dibujo dentro del canvas (px). */
const PAD_X = 14;
const PAD_TOP = 14;
const PAD_BOTTOM = 18;
/** Radio visual de un punto y tolerancias de hit-test (px). */
const POINT_R = 4.5;
const HIT_POINT = 8;
const HIT_SEGMENT = 10;
/** Snap al añadir puntos: 1/16 de compás 4/4 = 0.25 beats (Alt = libre). */
const SNAP_ADD = 0.25;
/** Píxeles de arrastre vertical para recorrer toda la tensión (-1..1). */
const TENSION_PX = 120;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/**
 * Aviso efímero por el canal que ya pinta App (`.app-notice`). Lo usa
 * "Simplificar" para no ser un botón que a veces no hace nada sin decir por qué.
 */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function notify(text: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  useBounceStore.setState({ notice: text });
  noticeTimer = setTimeout(() => useBounceStore.setState({ notice: null }), 3500);
}

// ── Curva idéntica a la del motor ────────────────────────────────────────────

/** Réplica EXACTA de shape() de packages/engine/src/compile.ts. */
function shape(t: number, tension: number): number {
  if (tension > 0) return Math.pow(t, 1 + 3 * tension);
  if (tension < 0) return 1 - Math.pow(1 - t, 1 - 3 * tension);
  return t;
}

/** Réplica EXACTA de evalCurve() del motor (puntos ordenados por time). */
function evalCurve(points: AutomationPoint[], t: number): number {
  const first = points[0]!;
  if (t <= first.time) return first.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const f = shape((t - a.time) / span, a.tension);
      return a.value + (b.value - a.value) * f;
    }
  }
  return points[points.length - 1]!.value;
}

// ── Destinos (ParamRef) ──────────────────────────────────────────────────────
// La descripción, la spec y las conversiones valor ⇄ 0..1 viven en
// @orbit/core (model/paramref.ts): el motor compila las curvas con ESAS
// mismas funciones, así que aquí no puede haber una copia que se desvíe.

/** Texto del valor bajo el cursor (sin destino aún, se muestra 0..1 crudo). */
function formatValue(ref: ParamRef | undefined, project: Project, norm: number): string {
  return ref ? formatParamRef(ref, project, norm) : norm.toFixed(2);
}

// ── Componente raíz ──────────────────────────────────────────────────────────

export function AutomationEditor() {
  const project = useProject();
  const automationClipId = useUiStore((s) => s.automationClipId);

  const clip = automationClipId ? project.clips[automationClipId] : undefined;
  if (!clip || clip.kind !== 'automation') {
    return <NewClipForm project={project} />;
  }
  return <ClipEditor clip={clip} project={project} />;
}

// ── Formulario "Nuevo clip de automatización" ────────────────────────────────

type TargetKind = 'mixer' | 'channel' | 'effect' | 'transport';

const MIXER_PARAMS = ['volume', 'pan', 'stereoWidth'] as const;
const TRANSPORT_PARAMS = ['tempo', 'swing'] as const;

interface NewClipFormProps {
  project: Project;
}

function NewClipForm({ project }: NewClipFormProps) {
  const [kind, setKind] = useState<TargetKind>('mixer');
  const [mixerIdx, setMixerIdx] = useState(0);
  const [mixerParam, setMixerParam] = useState<(typeof MIXER_PARAMS)[number]>('volume');
  const [chanId, setChanId] = useState('');
  /** 'p:<key>' = parámetro del instrumento · 'm:<algo>' = channelMix. */
  const [chanParam, setChanParam] = useState('');
  const [fxTrack, setFxTrack] = useState(-1);
  const [fxSlot, setFxSlot] = useState(-1);
  const [fxParam, setFxParam] = useState('');
  const [transParam, setTransParam] = useState<(typeof TRANSPORT_PARAMS)[number]>('tempo');
  const [trackId, setTrackId] = useState('');
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(4);

  // Selecciones efectivas con fallback: si lo elegido ya no existe en el
  // proyecto (canal borrado, efecto quitado…) se cae al primer candidato.
  const channelId = chanId && project.channels[chanId] ? chanId : project.channelOrder[0] ?? '';
  const channel = channelId ? project.channels[channelId] : undefined;
  const chanOptions = channel
    ? [
        ...INSTRUMENT_PARAMS[channel.kind].map((s) => ({ value: `p:${s.key}`, label: s.label })),
        { value: 'm:volume', label: 'Volumen (mezcla)' },
        { value: 'm:pan', label: 'Pan (mezcla)' },
        { value: 'm:bend', label: 'Rueda de tono' },
      ]
    : [];
  const chanSel = chanOptions.some((o) => o.value === chanParam)
    ? chanParam
    : chanOptions[0]?.value ?? '';

  const mixerSel = project.mixer[mixerIdx] ? mixerIdx : 0;

  // Efectos: solo pistas con algún slot ocupado.
  const fxTracks = project.mixer
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.slots.some((s) => s !== null));
  const fxTrackSel = fxTracks.some((f) => f.index === fxTrack)
    ? fxTrack
    : fxTracks[0]?.index ?? -1;
  const fxSlots: { slot: EffectSlot; index: number }[] = [];
  if (fxTrackSel >= 0) {
    project.mixer[fxTrackSel]?.slots.forEach((s, i) => {
      if (s) fxSlots.push({ slot: s, index: i });
    });
  }
  const fxSlotSel = fxSlots.some((x) => x.index === fxSlot) ? fxSlot : fxSlots[0]?.index ?? -1;
  const fxSlotObj =
    fxSlotSel >= 0 ? project.mixer[fxTrackSel]?.slots[fxSlotSel] ?? null : null;
  const fxSpecs = fxSlotObj ? EFFECT_PARAMS[fxSlotObj.kind] : [];
  const fxParamSel = fxSpecs.some((s) => s.key === fxParam) ? fxParam : fxSpecs[0]?.key ?? '';

  // Pistas de playlist del arrangement activo.
  const tracks = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === project.activeArrangementId)
    .sort((a, b) => a.order - b.order);
  const trackSel =
    trackId && project.playlistTracks[trackId]?.arrangementId === project.activeArrangementId
      ? trackId
      : tracks[0]?.id ?? '';

  /** ParamRef del destino elegido (null si aún no es válido). */
  const buildRef = (): ParamRef | null => {
    switch (kind) {
      case 'mixer':
        return project.mixer[mixerSel]
          ? { kind: 'mixer', trackIndex: mixerSel, param: mixerParam }
          : null;
      case 'channel': {
        if (!channelId || !chanSel) return null;
        if (chanSel === 'm:volume') return { kind: 'channelMix', channelId, param: 'volume' };
        if (chanSel === 'm:pan') return { kind: 'channelMix', channelId, param: 'pan' };
        if (chanSel === 'm:bend') return { kind: 'channelMix', channelId, param: 'bend' };
        return { kind: 'channel', channelId, param: chanSel.slice(2) };
      }
      case 'effect':
        return fxTrackSel >= 0 && fxSlotSel >= 0 && fxParamSel
          ? { kind: 'effect', trackIndex: fxTrackSel, slotIndex: fxSlotSel, param: fxParamSel }
          : null;
      case 'transport':
        return { kind: 'transport', param: transParam };
    }
  };

  const ref = buildRef();
  const canCreate = ref !== null && trackSel !== '' && length > 0;

  const create = () => {
    if (!ref || !trackSel) return;
    // Dos puntos al valor actual del parámetro (línea recta = "sin cambio").
    const value = paramRefNorm(ref, project) ?? 0.5;
    const clip: Clip = {
      id: newId(),
      kind: 'automation',
      playlistTrackId: trackSel,
      start,
      length,
      muted: false,
      target: ref,
      points: [
        { id: newId(), time: 0, value, tension: 0 },
        { id: newId(), time: length, value, tension: 0 },
      ],
    };
    store.dispatch(
      { type: 'addClips', clips: [clip] },
      { label: `Crear automatización de ${describeParamRef(ref, project)}` },
    );
    useUiStore.setState({ automationClipId: clip.id });
  };

  return (
    <div className="automation">
      <div className="au-empty">
        <p className="au-note">
          No hay ningún clip de automatización abierto. Crea uno aquí (o haz
          clic en un clip de automatización de la Playlist) para dibujar la
          curva de un parámetro a lo largo de la canción.
        </p>

        <div className="au-form">
          <label className="au-field">
            Destino
            <select value={kind} onChange={(e) => setKind(e.target.value as TargetKind)}>
              <option value="mixer">Pista de mixer</option>
              <option value="channel">Canal (instrumento)</option>
              <option value="effect">Efecto</option>
              <option value="transport">Transporte</option>
            </select>
          </label>

          {kind === 'mixer' && (
            <div className="au-row">
              <label className="au-field">
                Pista
                <select value={mixerSel} onChange={(e) => setMixerIdx(Number(e.target.value))}>
                  {project.mixer.map((t, i) => (
                    <option key={t.id} value={i}>
                      {i === 0 ? 'M' : i} · {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="au-field">
                Parámetro
                <select
                  value={mixerParam}
                  onChange={(e) => setMixerParam(e.target.value as (typeof MIXER_PARAMS)[number])}
                >
                  {MIXER_PARAMS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {kind === 'channel' &&
            (channel ? (
              <div className="au-row">
                <label className="au-field">
                  Canal
                  <select value={channelId} onChange={(e) => setChanId(e.target.value)}>
                    {project.channelOrder.map((id) => (
                      <option key={id} value={id}>
                        {project.channels[id]?.name ?? id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="au-field">
                  Parámetro
                  <select value={chanSel} onChange={(e) => setChanParam(e.target.value)}>
                    {chanOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <p className="au-note">No hay canales en el rack todavía.</p>
            ))}

          {kind === 'effect' &&
            (fxTracks.length === 0 ? (
              <p className="au-note">No hay efectos insertados en el mixer.</p>
            ) : (
              <div className="au-row">
                <label className="au-field">
                  Pista
                  <select value={fxTrackSel} onChange={(e) => setFxTrack(Number(e.target.value))}>
                    {fxTracks.map(({ track, index }) => (
                      <option key={track.id} value={index}>
                        {index === 0 ? 'M' : index} · {track.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="au-field">
                  Efecto
                  <select value={fxSlotSel} onChange={(e) => setFxSlot(Number(e.target.value))}>
                    {fxSlots.map(({ slot, index }) => (
                      <option key={slot.id} value={index}>
                        {index + 1} · {EFFECT_LABELS[slot.kind]}
                      </option>
                    ))}
                  </select>
                </label>
                {fxSpecs.length > 0 ? (
                  <label className="au-field">
                    Parámetro
                    <select value={fxParamSel} onChange={(e) => setFxParam(e.target.value)}>
                      {fxSpecs.map((s) => (
                        <option key={s.key} value={s.key}>{s.label}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="au-note">Este efecto no tiene parámetros.</span>
                )}
              </div>
            ))}

          {kind === 'transport' && (
            <label className="au-field">
              Parámetro
              <select
                value={transParam}
                onChange={(e) => setTransParam(e.target.value as (typeof TRANSPORT_PARAMS)[number])}
              >
                {TRANSPORT_PARAMS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          )}

          <div className="au-row">
            <label className="au-field">
              Pista de playlist
              <select value={trackSel} onChange={(e) => setTrackId(e.target.value)}>
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="au-field">
              Inicio
              <NumberScrubber
                value={start}
                min={0}
                max={4096}
                step={0.25}
                decimals={2}
                suffix="b"
                onChange={setStart}
              />
            </label>
            <label className="au-field">
              Longitud
              <NumberScrubber
                value={length}
                min={0.25}
                max={4096}
                step={0.25}
                decimals={2}
                suffix="b"
                onChange={setLength}
              />
            </label>
          </div>

          <button className="au-create" onClick={create} disabled={!canCreate}>
            Crear clip de automatización
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Editor del clip (canvas) ─────────────────────────────────────────────────

type DragState =
  | { mode: 'point'; pointId: string }
  | { mode: 'tension'; leftId: string; startY: number; startTension: number; dir: 1 | -1 }
  /** Lápiz: el trazo vive en un ref y no en el modelo hasta que se suelta. */
  | { mode: 'pencil' }
  | { mode: 'line'; fromTime: number; fromValue: number; toTime: number; toValue: number };

/** Herramienta del lienzo. */
type AuTool = 'points' | 'pencil' | 'line';

const TOOLS: { id: AuTool; label: string; key: string; hint: string }[] = [
  {
    id: 'points',
    label: 'Puntos',
    key: 'P',
    hint: 'Doble clic añade un punto, arrastrarlo lo mueve y el tramo entre dos curva la tensión',
  },
  { id: 'pencil', label: 'Lápiz', key: 'D', hint: 'Arrastra y dibuja la curva a mano alzada' },
  { id: 'line', label: 'Recta', key: 'R', hint: 'Arrastra una rampa recta entre dos puntos' },
];

/**
 * Tolerancia de la simplificación del lápiz, en unidades de valor (0..1).
 *
 * Un barrido a mano deja cientos de muestras. Con 0.008 (≈0.8 % del recorrido)
 * el trazo queda en unas decenas de puntos: se dibuja igual y se puede seguir
 * retocando a mano sin pelearse con una nube de breakpoints.
 */
const PENCIL_EPS = 0.008;

/**
 * Tolerancia de "Simplificar", más generosa que la del lápiz: se pide a
 * propósito para quitar puntos, así que 1.5 % del recorrido quita de verdad sin
 * que la curva cambie de forma.
 */
const SIMPLIFY_EPS = 0.015;

/** Divisiones del snap vertical. 0 = valor libre. */
const VALUE_STEPS: { label: string; steps: number }[] = [
  { label: 'Libre', steps: 0 },
  { label: '1/2', steps: 2 },
  { label: '1/4', steps: 4 },
  { label: '1/8', steps: 8 },
  { label: '12', steps: 12 },
  { label: '1/16', steps: 16 },
];

interface ClipEditorProps {
  clip: Clip;
  project: Project;
}

function ClipEditor({ clip, project }: ClipEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  /** Rótulo de valor junto al cursor durante el arrastre. */
  const tip = useRef<{ x: number; y: number; text: string } | null>(null);
  /**
   * Muestras del trazo en curso (lápiz). Van en un ref y no en el store porque
   * un barrido son cientos de eventos: despachar cada uno llenaría el historial
   * y recompilaría el proyecto sesenta veces por segundo. Al soltar se
   * simplifica y se despacha UNA vez.
   */
  const stroke = useRef<CurveSample[]>([]);
  const [tool, setTool] = useState<AuTool>('points');
  const [shapeOpen, setShapeOpen] = useState(false);
  /**
   * Snap del eje vertical, en divisiones del recorrido. Con 12, un destino de
   * tono cae en semitonos; con 2, un interruptor solo puede estar arriba o
   * abajo. Afecta al lápiz, a la recta, al arrastre de un punto y al añadir.
   */
  const [valueSteps, setValueSteps] = useState(0);
  /**
   * Curva candidata del generador de formas, dibujada encima de la de verdad.
   *
   * Va en un ref y no en estado a propósito: el panel la recalcula en CADA
   * render suyo, así que un setState aquí lo re-renderizaría, que recalcularía,
   * que volvería a llamar… bucle infinito. Con el ref, el panel avisa y se
   * repinta el lienzo, sin tocar el árbol de React.
   */
  const preview = useRef<AutomationPoint[] | null>(null);
  /** Ratón dentro del editor: guarda de los atajos de herramienta. */
  const hovering = useRef(false);

  const target = clip.target;
  // El proyecto se muta in place (identidad estable): se ordena en cada render
  // (el componente re-renderiza con cada versión del store) en vez de memoizar.
  const points = (clip.points ?? []).slice().sort((a, b) => a.time - b.time);
  const barLen = Math.max(1, project.timeSig.num);
  const title = target ? describeParamRef(target, project) : 'Automatización (sin destino)';

  // ── Geometría beats/valor ↔ px ────────────────────────────────────────────

  const geom = useCallback(() => {
    const wrap = wrapRef.current;
    const w = wrap?.clientWidth ?? 0;
    const h = wrap?.clientHeight ?? 0;
    const x0 = PAD_X;
    const x1 = Math.max(x0 + 1, w - PAD_X);
    const y0 = PAD_TOP;
    const y1 = Math.max(y0 + 1, h - PAD_BOTTOM);
    const len = Math.max(1e-6, clip.length);
    return {
      w,
      h,
      x0,
      x1,
      y0,
      y1,
      timeToX: (t: number) => x0 + (t / len) * (x1 - x0),
      xToTime: (x: number) => ((x - x0) / (x1 - x0)) * len,
      valueToY: (v: number) => y1 - v * (y1 - y0),
      yToValue: (y: number) => (y1 - y) / (y1 - y0),
    };
  }, [clip.length]);

  // ── Dibujo ────────────────────────────────────────────────────────────────

  const themeVersion = useThemeVersion();

  const draw = useCallback(() => {
    // themeVersion en deps: los tokens se leen con getComputedStyle por tema.
    void themeVersion;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const g = geom();
    if (canvas.width !== g.w * dpr || canvas.height !== g.h * dpr) {
      canvas.width = g.w * dpr;
      canvas.height = g.h * dpr;
      canvas.style.width = `${g.w}px`;
      canvas.style.height = `${g.h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(canvas);
    const col = (name: string) => css.getPropertyValue(name).trim();
    const font = css.fontFamily;
    const curveColor = clip.color ?? col('--accent');

    ctx.clearRect(0, 0, g.w, g.h);
    ctx.fillStyle = col('--au-bg');
    ctx.fillRect(0, 0, g.w, g.h);

    // Referencias horizontales (25/50/75 %) y bordes 0/1.
    for (const v of [0.25, 0.5, 0.75]) {
      ctx.fillStyle = col('--au-grid-mid');
      ctx.fillRect(g.x0, g.valueToY(v), g.x1 - g.x0, 1);
    }
    ctx.fillStyle = col('--au-edge');
    ctx.fillRect(g.x0, g.y0, g.x1 - g.x0, 1);
    ctx.fillRect(g.x0, g.y1, g.x1 - g.x0, 1);

    // Rejilla del snap vertical: enseña a qué alturas se va a pegar lo que
    // dibujes. Sin ella, el valor salta y no se sabe por qué.
    if (valueSteps > 0 && valueSteps <= 24) {
      // Teñida con el acento y no con el gris de la rejilla: así se distingue
      // de las referencias fijas del 25/50/75 % y se lee como "esto está puesto".
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = col('--accent');
      for (let i = 1; i < valueSteps; i++) {
        ctx.fillRect(g.x0, g.valueToY(i / valueSteps), g.x1 - g.x0, 1);
      }
      ctx.restore();
    }

    // Rejilla por beats (compases más marcados; beats solo con sitio).
    const pxPerBeat = (g.x1 - g.x0) / Math.max(1e-6, clip.length);
    ctx.font = `9px ${font}`;
    for (let b = 0; b <= Math.floor(clip.length); b++) {
      const isBar = b % barLen === 0;
      if (!isBar && pxPerBeat < 7) continue;
      const x = g.timeToX(b);
      ctx.fillStyle = isBar ? col('--au-grid-bar') : col('--au-grid-beat');
      ctx.fillRect(x, g.y0, 1, g.y1 - g.y0);
      if (isBar && pxPerBeat * barLen > 26) {
        ctx.fillStyle = col('--au-text');
        ctx.fillText(String(b), x + 3, g.y1 + 12);
      }
    }
    // Borde final del clip.
    ctx.fillStyle = col('--au-edge');
    ctx.fillRect(g.timeToX(clip.length), g.y0, 1, g.y1 - g.y0);

    // Escala del parámetro: valor real de 1 (arriba) y de 0 (abajo).
    ctx.fillStyle = col('--au-text');
    ctx.fillText(formatValue(target, project, 1), g.x0 + 4, g.y0 + 10);
    ctx.fillText(formatValue(target, project, 0), g.x0 + 4, g.y1 - 4);

    // Curva con la interpolación EXACTA del motor, muestreada cada 2 px.
    if (points.length > 0) {
      const xa = g.timeToX(0);
      const xb = g.timeToX(clip.length);
      ctx.beginPath();
      ctx.moveTo(xa, g.valueToY(evalCurve(points, 0)));
      for (let px = xa + 2; px < xb; px += 2) {
        ctx.lineTo(px, g.valueToY(evalCurve(points, g.xToTime(px))));
      }
      ctx.lineTo(xb, g.valueToY(evalCurve(points, clip.length)));
      ctx.strokeStyle = curveColor;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // Relleno hasta la base.
      ctx.lineTo(xb, g.y1);
      ctx.lineTo(xa, g.y1);
      ctx.closePath();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = curveColor;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Puntos (el arrastrado, con anillo más marcado).
      const draggedId = drag.current?.mode === 'point' ? drag.current.pointId : null;
      for (const p of points) {
        const px = g.timeToX(p.time);
        const py = g.valueToY(p.value);
        ctx.beginPath();
        ctx.arc(px, py, POINT_R, 0, Math.PI * 2);
        ctx.fillStyle = curveColor;
        ctx.fill();
        ctx.strokeStyle = col('--au-point-ring');
        ctx.lineWidth = p.id === draggedId ? 1.8 : 1;
        ctx.globalAlpha = p.id === draggedId ? 1 : 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    /*
     * Lo que se está dibujando AHORA, encima de la curva y en otro color.
     *
     * Se pinta desde el ref, sin haber tocado el modelo: así se ve lo que va a
     * quedar mientras se dibuja, y hasta soltar no hay ni un dispatch. Lo que
     * se pinta es el trazo crudo, no el simplificado — el simplificado es lo
     * que se guarda, y mentiría enseñar una curva y guardar otra... salvo que
     * la tolerancia es menor que el grosor de la línea, así que coinciden.
     */
    // Curva candidata del generador de formas: discontinua y en el color del
    // trazo, para que se distinga de lo que ya está guardado.
    const pv = preview.current;
    if (pv && pv.length > 0) {
      const xa = g.timeToX(pv[0]!.time);
      const xb = g.timeToX(pv[pv.length - 1]!.time);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xa, g.valueToY(evalCurve(pv, pv[0]!.time)));
      for (let px = xa + 2; px < xb; px += 2) {
        ctx.lineTo(px, g.valueToY(evalCurve(pv, g.xToTime(px))));
      }
      ctx.lineTo(xb, g.valueToY(pv[pv.length - 1]!.value));
      ctx.strokeStyle = col('--au-draw');
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();
    }

    const d = drag.current;
    if (d?.mode === 'pencil' && stroke.current.length > 0) {
      ctx.beginPath();
      stroke.current.forEach((s, i) => {
        const px = g.timeToX(s.time);
        const py = g.valueToY(s.norm);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = col('--au-draw');
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (d?.mode === 'line') {
      ctx.beginPath();
      ctx.moveTo(g.timeToX(d.fromTime), g.valueToY(d.fromValue));
      ctx.lineTo(g.timeToX(d.toTime), g.valueToY(d.toValue));
      ctx.strokeStyle = col('--au-draw');
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Rótulo de valor junto al cursor durante el arrastre.
    if (tip.current) {
      const t = tip.current;
      ctx.font = `10px ${font}`;
      const tw = ctx.measureText(t.text).width;
      const bx = clamp(t.x + 10, 2, g.w - tw - 12);
      const by = Math.max(2, t.y - 24);
      ctx.fillStyle = col('--au-tip-bg');
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 10, 16, 4);
      ctx.fill();
      ctx.fillStyle = col('--au-tip-text');
      ctx.fillText(t.text, bx + 5, by + 12);
    }
  }, [geom, points, clip, project, target, barLen, themeVersion, valueSteps]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Redibuja al cambiar el tamaño del contenedor (ventana interna o app).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // ── Hit-testing ───────────────────────────────────────────────────────────

  const pointAt = useCallback(
    (x: number, y: number): AutomationPoint | null => {
      const g = geom();
      for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i]!;
        const dx = x - g.timeToX(p.time);
        const dy = y - g.valueToY(p.value);
        if (dx * dx + dy * dy <= HIT_POINT * HIT_POINT) return p;
      }
      return null;
    },
    [geom, points],
  );

  /** Índice del punto izquierdo del tramo bajo el cursor, o -1. */
  const segmentAt = useCallback(
    (x: number, y: number): number => {
      const g = geom();
      const t = g.xToTime(x);
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i]!;
        const b = points[i + 1]!;
        if (t < a.time || t > b.time) continue;
        const cy = g.valueToY(evalCurve(points, t));
        if (Math.abs(y - cy) <= HIT_SEGMENT) return i;
      }
      return -1;
    },
    [geom, points],
  );

  // ── Mutaciones ────────────────────────────────────────────────────────────

  /** patchClips con el array de puntos completo, siempre clonado y ordenado. */
  const patchPoints = useCallback(
    (next: AutomationPoint[], label: string, merge: boolean) => {
      const sorted = next
        .map((p) => ({ ...p }))
        .sort((a, b) => a.time - b.time);
      store.dispatch(
        { type: 'patchClips', patches: [{ id: clip.id, points: sorted }] },
        merge ? { label, mergeKey: `au:points:${clip.id}` } : { label },
      );
    },
    [clip.id],
  );

  /**
   * El panel de formas avisa de su curva candidata. Estable (deps vacías) y
   * apoyado en un ref del `draw` de AHORA: si fuese un setState, el panel
   * recalcularía en cada render suyo y se realimentaría sin parar.
   */
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const setPreview = useCallback((pts: AutomationPoint[] | null) => {
    preview.current = pts;
    drawRef.current();
  }, []);

  /**
   * Reduce los puntos sin cambiar lo que suena.
   *
   * No se poda la lista: se MUESTREA la curva tal y como la evalúa el motor
   * —tensiones incluidas— y se simplifica ese trazo. Podando la lista, quitar
   * un punto se llevaría por delante la curvatura que describía y la forma
   * cambiaría; muestreando, lo que se conserva es la curva, que es lo que el
   * usuario oye. El precio es que las tensiones se convierten en puntos, y por
   * eso es un botón y no algo automático.
   */
  const simplify = useCallback(() => {
    if (points.length <= 2) return;
    const n = clamp(Math.ceil(clip.length * 32), 64, 2048);
    const samples: CurveSample[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * clip.length;
      samples.push({ time: t, norm: evalCurve(points, t) });
    }
    const simple = simplifyCurve(samples, SIMPLIFY_EPS).map((sample) => ({
      id: newId(),
      time: sample.time,
      value: sample.norm,
      tension: 0,
    }));
    if (simple.length >= points.length) {
      notify(`La curva ya está en su mínimo: ${points.length} puntos.`);
      return;
    }
    patchPoints(simple, `Simplificar automatización (${points.length} → ${simple.length})`, false);
    notify(`Simplificada: ${points.length} → ${simple.length} puntos.`);
  }, [points, clip.length, patchPoints]);

  const removeClip = useCallback(() => {
    store.dispatch(
      { type: 'removeClips', clipIds: [clip.id] },
      { label: `Borrar clip de automatización (${title})` },
    );
    useUiStore.setState({ automationClipId: null });
  }, [clip.id, title]);

  // ── Interacción en el canvas ──────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      capturePointer(canvas, e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Clic derecho sobre un punto: borrar (mínimo 1 punto).
      if (e.button === 2) {
        const hit = pointAt(x, y);
        if (hit && points.length > 1) {
          patchPoints(
            points.filter((p) => p.id !== hit.id),
            'Borrar punto de automatización',
            false,
          );
        }
        return;
      }
      if (e.button !== 0) return;

      const g0 = geom();
      const t0 = clamp(g0.xToTime(x), 0, clip.length);
      const v0 = clamp01(g0.yToValue(y));

      if (tool === 'pencil') {
        drag.current = { mode: 'pencil' };
        stroke.current = [{ time: t0, norm: v0 }];
        tip.current = { x, y, text: formatValue(target, project, v0) };
        draw();
        return;
      }
      if (tool === 'line') {
        drag.current = { mode: 'line', fromTime: t0, fromValue: v0, toTime: t0, toValue: v0 };
        tip.current = { x, y, text: formatValue(target, project, v0) };
        draw();
        return;
      }

      const hit = pointAt(x, y);
      if (hit) {
        drag.current = { mode: 'point', pointId: hit.id };
        tip.current = { x, y, text: formatValue(target, project, hit.value) };
        draw();
        return;
      }

      // Tramo entre dos puntos: arrastre vertical = tensión. El signo se fija
      // para que arrastrar hacia arriba combe la curva hacia arriba.
      const seg = segmentAt(x, y);
      if (seg >= 0) {
        const a = points[seg]!;
        const b = points[seg + 1]!;
        drag.current = {
          mode: 'tension',
          leftId: a.id,
          startY: y,
          startTension: a.tension,
          dir: b.value >= a.value ? -1 : 1,
        };
        tip.current = { x, y, text: `curva ${a.tension.toFixed(2)}` };
        draw();
      }
    },
    [pointAt, segmentAt, points, patchPoints, target, project, draw, tool, geom, clip.length],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const d = drag.current;

      if (!d) {
        // Cursor contextual: con lápiz o recta manda la herramienta; con
        // Puntos, lo que haya debajo (punto, tramo o lienzo).
        canvas.style.cursor =
          tool !== 'points'
            ? 'crosshair'
            : pointAt(x, y)
              ? 'pointer'
              : segmentAt(x, y) >= 0
                ? 'ns-resize'
                : 'crosshair';
        return;
      }

      const g = geom();
      if (d.mode === 'pencil') {
        // Una muestra por evento; el orden y los repetidos los arregla
        // strokeToPoints al soltar (arrastrar hacia atrás es legítimo).
        const time = clamp(g.xToTime(x), 0, clip.length);
        const value = clamp01(g.yToValue(y));
        stroke.current.push({ time, norm: value });
        tip.current = { x, y, text: formatValue(target, project, value) };
        draw();
        return;
      }
      if (d.mode === 'line') {
        const time = clamp(g.xToTime(x), 0, clip.length);
        const value = clamp01(g.yToValue(y));
        drag.current = { ...d, toTime: time, toValue: value };
        tip.current = { x, y, text: formatValue(target, project, value) };
        draw();
        return;
      }
      if (d.mode === 'point') {
        const idx = points.findIndex((p) => p.id === d.pointId);
        if (idx < 0) return;
        const p = points[idx]!;
        const prev = points[idx - 1];
        const next = points[idx + 1];
        // Clamp entre vecinos y dentro del clip; valor 0..1.
        const time = clamp(g.xToTime(x), prev?.time ?? 0, next?.time ?? clip.length);
        const value = quantizeValue(g.yToValue(y), valueSteps);
        tip.current = { x, y, text: formatValue(target, project, value) };
        if (time !== p.time || value !== p.value) {
          patchPoints(
            points.map((q) => (q.id === p.id ? { ...q, time, value } : q)),
            'Mover punto de automatización',
            true,
          );
        } else {
          draw();
        }
      } else {
        const idx = points.findIndex((p) => p.id === d.leftId);
        if (idx < 0 || idx >= points.length - 1) return;
        const a = points[idx]!;
        const tension = clamp(
          d.startTension + (d.dir * (d.startY - y)) / TENSION_PX,
          -1,
          1,
        );
        tip.current = { x, y, text: `curva ${tension.toFixed(2)}` };
        if (tension !== a.tension) {
          patchPoints(
            points.map((q) => (q.id === a.id ? { ...q, tension } : q)),
            'Curvar automatización',
            true,
          );
        } else {
          draw();
        }
      }
    },
    [pointAt, segmentAt, geom, points, clip.length, patchPoints, target, project, draw, tool, valueSteps],
  );

  /**
   * Al soltar se cierra el gesto. Lápiz y recta son los únicos que despachan
   * AQUÍ (los demás ya han ido patcheando con mergeKey): el trazo entero es un
   * solo paso de undo, que es como se espera deshacer "lo que acabo de pintar".
   */
  const onPointerUp = useCallback(() => {
    const d = drag.current;
    if (d?.mode === 'pencil') {
      const fresh = strokeToPoints(stroke.current, { eps: PENCIL_EPS, valueSteps });
      if (fresh.length > 0) {
        const from = fresh[0]!.time;
        const to = fresh[fresh.length - 1]!.time;
        patchPoints(replaceRange(points, from, to, fresh), 'Dibujar automatización', false);
      }
    } else if (d?.mode === 'line') {
      const fresh = lineBetween(d.fromTime, d.fromValue, d.toTime, d.toValue, valueSteps);
      if (fresh.length > 0) {
        const from = fresh[0]!.time;
        const to = fresh[fresh.length - 1]!.time;
        patchPoints(replaceRange(points, from, to, fresh), 'Rampa de automatización', false);
      }
    }
    stroke.current = [];
    drag.current = null;
    tip.current = null;
    draw();
  }, [draw, points, patchPoints, valueSteps]);

  /** Doble clic: añadir punto (snap 1/16; Alt = libre). */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (tool !== 'points') return; // con lápiz o recta, el doble clic no añade nada
      if (pointAt(x, y)) return; // sobre un punto existente no se duplica
      const g = geom();
      const raw = clamp(g.xToTime(x), 0, clip.length);
      const time = e.altKey ? raw : clamp(Math.round(raw / SNAP_ADD) * SNAP_ADD, 0, clip.length);
      const value = quantizeValue(g.yToValue(y), valueSteps);
      patchPoints(
        [...points, { id: newId(), time, value, tension: 0 }],
        'Añadir punto de automatización',
        false,
      );
    },
    [pointAt, geom, clip.length, points, patchPoints, tool, valueSteps],
  );

  // ── Cabecera ──────────────────────────────────────────────────────────────

  const patchClip = useCallback(
    (patch: { start?: number; length?: number }, label: string, key: string) => {
      store.dispatch(
        { type: 'patchClips', patches: [{ id: clip.id, ...patch }] },
        { label, mergeKey: `au:${key}:${clip.id}` },
      );
    },
    [clip.id],
  );

  /*
   * Atajos de herramienta, con guarda de hover: P, D y R son letras sueltas y
   * el Piano Roll tiene las suyas. Solo actúan con el ratón dentro de este
   * editor (o el foco dentro), igual que hace la Playlist con Ctrl+A y Ctrl+B.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const el = e.target as HTMLElement;
      if (
        el.tagName === 'INPUT' ||
        el.tagName === 'SELECT' ||
        el.tagName === 'TEXTAREA' ||
        el.isContentEditable
      ) {
        return;
      }
      const root = rootRef.current;
      if (!hovering.current && !(root !== null && root.contains(document.activeElement))) return;
      const found = TOOLS.find((t) => t.key === e.key.toUpperCase());
      if (!found) return;
      e.preventDefault();
      setTool(found.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="automation"
      ref={rootRef}
      onPointerEnter={() => {
        hovering.current = true;
      }}
      onPointerLeave={() => {
        hovering.current = false;
      }}
    >
      <div className="au-toolbar">
        <span className="au-title" title={title}>{title}</span>
        <div className="au-tools" role="group" aria-label="Herramienta">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`au-tool${tool === t.id ? ' active' : ''}`}
              title={`${t.hint} (${t.key})`}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <label className="au-field">
          Inicio
          <NumberScrubber
            value={clip.start}
            min={0}
            max={4096}
            step={0.25}
            decimals={2}
            suffix="b"
            onChange={(v) => patchClip({ start: v }, 'Mover clip de automatización', 'start')}
          />
        </label>
        <label className="au-field">
          Longitud
          <NumberScrubber
            value={clip.length}
            min={0.25}
            max={4096}
            step={0.25}
            decimals={2}
            suffix="b"
            onChange={(v) => patchClip({ length: v }, 'Cambiar longitud de la automatización', 'len')}
          />
        </label>
        <label className="au-field" title="Alturas a las que se pega el valor al dibujar">
          Valor
          <select
            value={valueSteps}
            onChange={(e) => setValueSteps(Number(e.target.value))}
          >
            {VALUE_STEPS.map((v) => (
              <option key={v.steps} value={v.steps}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`tbtn${shapeOpen ? ' active' : ''}`}
          onClick={() => setShapeOpen((v) => !v)}
          title="Rellenar un tramo con una onda (seno, sierra, cuadrada…)"
        >
          Forma…
        </button>
        <button
          className="tbtn"
          onClick={simplify}
          disabled={points.length <= 2}
          title="Quitar puntos dejando la misma curva (las tensiones se convierten en puntos)"
        >
          Simplificar
        </button>
        <span className="au-count">{points.length} pts</span>
        <button className="au-delete" onClick={removeClip} title="Borrar este clip de la playlist">
          Borrar clip
        </button>
      </div>
      <div className="au-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="au-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
        {shapeOpen && (
          <ShapeDialog
            clipLength={clip.length}
            formatValue={(norm) => formatValue(target, project, norm)}
            onPreview={setPreview}
            onApply={(pts, from, to) => {
              patchPoints(replaceRange(points, from, to, pts), 'Forma de automatización', false);
              setPreview(null);
              setShapeOpen(false);
            }}
            onClose={() => {
              setPreview(null);
              setShapeOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
