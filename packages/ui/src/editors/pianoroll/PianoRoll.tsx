/**
 * Piano Roll de Orbit Studio (canvas).
 * Dibujar/mover/redimensionar/seleccionar notas, slide (808), velocity lane,
 * escala resaltada, ghost notes, snap, zoom, quantize y transponer.
 * Herramientas estilo FL: Dibujar (P), Pincel (B) y Cortar (C), más la Riff
 * machine (Alt+G). Cada gesto completo = UN dispatch (undo limpio).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SCALES,
  arpeggiate,
  chop,
  chordify,
  humanize,
  inScale,
  midiToNote,
  newId,
  strum,
  type ArpeggiateOptions,
  type Command,
  type Note,
} from '@orbit/core';
import { useCollabStore } from '../../collab/collab-state';
import { reportActivity } from '../../collab/presence';
import { canRemovePattern, patternClipsHint, removePattern } from '../../palette/default-commands';
import { setActivePattern, store } from '../../state/app';
import { packNotes, readClipboard, setClipboard, unpackNotes } from '../../state/clipboard';
import { claimEditFocus, registerEditActions } from '../../state/edit-focus';
import { previewNote, useActiveKeys } from '../../state/active-notes';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { useThemeVersion } from '../../theme/useThemeVersion';
import { capturePointer } from '../../widgets/pointer';
import { ArpDialog } from './ArpDialog';
import { RiffDialog } from './RiffDialog';
import { affectedNoteIds, quantizePatches, transposePatches } from './note-tools';
import { TOOLS, applySliceCuts, occupied, sliceCuts, type PianoRollTool } from './tools';
import './pianoroll.css';

const KEY_H = 14;
const KEYS = 120; // B9..C0 hacia abajo
const VEL_LANE_H = 64;
const KEYBOARD_W = 64;

/** 'magnet' = posición libre que se pega a la rejilla solo si está cerca. */
type SnapValue = number | null | 'magnet';

const SNAPS: { label: string; value: SnapValue }[] = [
  { label: 'Línea', value: 0.25 },
  { label: 'Magnético', value: 'magnet' },
  { label: '1 beat', value: 1 },
  { label: '1/2', value: 0.5 },
  { label: '1/3', value: 1 / 3 },
  { label: '1/4', value: 0.25 },
  { label: '1/6', value: 1 / 6 },
  { label: '1/8', value: 0.125 },
  { label: 'Nada', value: null },
];

/** Rejilla base del snap magnético (líneas de 1/4 de beat). */
const MAGNET_GRID = 0.25;
/** Radio del imán en píxeles de pantalla (se convierte a beats con zoomX). */
const MAGNET_PX = 6;

/** Acordes del stamp: intervalos en semitonos desde la fundamental. */
const CHORDS: { label: string; intervals: number[] | null }[] = [
  { label: 'Ninguno', intervals: null },
  { label: 'Mayor', intervals: [0, 4, 7] },
  { label: 'Menor', intervals: [0, 3, 7] },
  { label: '7ª', intervals: [0, 4, 7, 10] },
  { label: 'm7', intervals: [0, 3, 7, 10] },
  { label: 'maj7', intervals: [0, 4, 7, 11] },
  { label: 'sus4', intervals: [0, 5, 7] },
  { label: 'power (5ª)', intervals: [0, 7] },
  { label: 'oct', intervals: [0, 12] },
];

interface DragState {
  mode: 'move' | 'resize' | 'marquee' | 'velocity' | 'create' | 'paint' | 'erase' | 'slice';
  startX: number;
  startY: number;
  /** Copia de las notas al empezar el gesto (por id). */
  orig: Map<string, Note>;
  createdId?: string;
  moved: boolean;
  lastPreviewKey?: number;
  /** Fin del gesto de área: marquee y línea de corte comparten puntero. */
  marqueeEnd?: { x: number; y: number };
  /** Pincel: notas pintadas en este gesto (aún NO están en el store). */
  painted?: Note[];
  /** Pincel-borrador: notas tocadas, se borran todas juntas al soltar. */
  erased?: Set<string>;
  /** Última celda pintada (fila:beat) para no repintarla en cada mousemove. */
  lastCell?: string;
}

export function PianoRoll() {
  const project = useProject();
  // El patrón activo es estado de UI y puede haber sido BORRADO: hay que
  // comprobar que sigue existiendo, no solo que no es null, o el editor se
  // queda en blanco (y los dispatch tirarían por el `must` de core).
  const uiPatternId = useUiStore((s) => s.activePatternId);
  const activePatternId =
    (uiPatternId !== null && project.patterns[uiPatternId] ? uiPatternId : null) ??
    project.patternOrder[0] ??
    null;
  const channelId =
    useUiStore((s) => s.pianoRollChannelId) ?? project.channelOrder[0] ?? null;
  const playing = useUiStore((s) => s.playing);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** El ratón está encima del piano roll: los atajos de una tecla solo van aquí. */
  const hovering = useRef(false);

  // Vista
  const [zoomX, setZoomX] = useState(48); // px por beat
  const [scrollX, setScrollX] = useState(0); // beats
  const [scrollY, setScrollY] = useState(52 * KEY_H); // px desde arriba (C6 visible)
  const [snapIdx, setSnapIdx] = useState(0);
  /** Herramienta activa (paridad FL): dibujar, pincel o cortar. */
  const [tool, setTool] = useState<PianoRollTool>('draw');
  /** Panel de la Riff machine (Alt+G). */
  const [riffOpen, setRiffOpen] = useState(false);
  /** Panel del arpegiador (Alt+A). */
  const [arpOpen, setArpOpen] = useState(false);
  const [scaleRoot, setScaleRoot] = useState(5); // F
  const [scaleName, setScaleName] = useState<string>('Menor natural');
  /** Bloqueo a escala: crear/mover notas se ajusta a la escala activa. */
  const [scaleLock, setScaleLock] = useState(false);
  /** Stamp de acordes: índice en CHORDS (0 = Ninguno). */
  const [chordIdx, setChordIdx] = useState(0);
  /** Ghost notes: notas tenues de los demás canales de ESTE patrón. */
  const [showGhosts, setShowGhosts] = useState(true);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  /** Qué edita el carril inferior: velocity o pan por nota. */
  const [laneMode, setLaneMode] = useState<'velocity' | 'pan'>('velocity');
  // Conectados de la sesión (para pintar sus cursores remotos).
  const peers = useCollabStore((s) => s.peers);
  const [lastDuration, setLastDuration] = useState(1);
  const drag = useRef<DragState | null>(null);
  /** Deltas visuales durante el gesto (sin tocar el store hasta soltar). */
  const ghost = useRef<Map<string, Note> | null>(null);

  const pattern = activePatternId ? project.patterns[activePatternId] : undefined;
  const channel = channelId ? project.channels[channelId] : undefined;
  // `project` no se lee dentro del cuerpo: es la señal de invalidación. Los
  // comandos mutan `pattern.notes[channelId]` EN SITIO (push/Object.assign en
  // commands.ts) sin siempre reemplazar el array ni el objeto `pattern`; sin
  // `project` (nueva referencia por versión, ver useProject.ts) el memo podría
  // no recalcular tras un `addNotes`/`patchNotes` que no cambia esas referencias.
  const notes = useMemo(
    () => (pattern && channelId ? pattern.notes[channelId] ?? [] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pattern, channelId, project],
  );
  const channelIndex = channelId ? project.channelOrder.indexOf(channelId) : -1;
  /** Teclas de este canal que están sonando (se iluminan en el teclado lateral). */
  const activeKeys = useActiveKeys(channelIndex);
  const snap = SNAPS[snapIdx]?.value ?? 0.25;
  const scale = SCALES[scaleName] ?? SCALES['Menor natural']!;
  /** Paso numérico del snap para herramientas (Q, resize, arp...): el
   *  magnético cuenta como su rejilla fija; 'Nada' queda en null. */
  const snapStep: number | null = typeof snap === 'number' ? snap : snap === 'magnet' ? MAGNET_GRID : null;
  /** Paso del pincel: la rejilla del snap y, sin snap, la duración por defecto. */
  const brushStep = snapStep ?? lastDuration;

  const doSnap = useCallback(
    (beat: number, floor = true) => {
      if (snap === 'magnet') {
        // Posición libre, pero si la línea de rejilla más cercana queda a
        // menos de ~6 px de pantalla, se pega a ella (zoom-in = imán más fino).
        const nearest = Math.round(beat / MAGNET_GRID) * MAGNET_GRID;
        return Math.max(0, Math.abs(beat - nearest) < MAGNET_PX / zoomX ? nearest : beat);
      }
      if (snap === null) return Math.max(0, beat);
      const q = floor ? Math.floor(beat / snap) : Math.round(beat / snap);
      return Math.max(0, q * snap);
    },
    [snap, zoomX],
  );

  /** Nota de la escala activa más cercana a `key` (en empate, hacia abajo). */
  const snapToScale = useCallback(
    (key: number) => {
      if (inScale(key, scaleRoot, scale)) return key;
      for (let d = 1; d <= 11; d++) {
        const down = key - d;
        if (down >= 0 && inScale(down, scaleRoot, scale)) return down;
        const up = key + d;
        if (up < KEYS && inScale(up, scaleRoot, scale)) return up;
      }
      return key;
    },
    [scaleRoot, scale],
  );

  // ── Coordenadas ───────────────────────────────────────────────────────────

  const beatToX = useCallback((b: number) => (b - scrollX) * zoomX, [scrollX, zoomX]);
  const xToBeat = useCallback((x: number) => x / zoomX + scrollX, [scrollX, zoomX]);
  const keyToY = useCallback((k: number) => (KEYS - 1 - k) * KEY_H - scrollY, [scrollY]);
  const yToKey = useCallback((y: number) => KEYS - 1 - Math.floor((y + scrollY) / KEY_H), [scrollY]);

  const noteAt = useCallback(
    (x: number, y: number): { note: Note; edge: boolean } | null => {
      const beat = xToBeat(x);
      const key = yToKey(y);
      const current = ghost.current;
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = current?.get(notes[i]!.id) ?? notes[i]!;
        if (n.key === key && beat >= n.start && beat < n.start + n.duration) {
          const endX = beatToX(n.start + n.duration);
          // Tirador del borde derecho, proporcional al ancho de la nota pero
          // acotado: con 7 px fijos, una nota corta era casi todo tirador y en
          // una larga con el zoom bajo había que acertar en una rendija.
          const grip = Math.max(4, Math.min(12, (endX - beatToX(n.start)) * 0.3));
          return { note: notes[i]!, edge: endX - x <= grip };
        }
      }
      return null;
    },
    [notes, xToBeat, yToKey, beatToX],
  );

  // ── Dibujo ────────────────────────────────────────────────────────────────

  const themeVersion = useThemeVersion();

  const draw = useCallback(() => {
    // themeVersion en deps: los tokens se leen con getComputedStyle por tema.
    void themeVersion;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
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
    const gridH = h - VEL_LANE_H;

    ctx.clearRect(0, 0, w, h);

    // Filas (teclas) — resalta la escala
    for (let k = 0; k < KEYS; k++) {
      const y = keyToY(k);
      if (y + KEY_H < 0 || y > gridH) continue;
      const semitone = ((k % 12) + 12) % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(semitone);
      const inSc = inScale(k, scaleRoot, scale);
      ctx.fillStyle = inSc ? col('--pr-row-scale') : isBlack ? col('--pr-row-black') : col('--pr-row');
      ctx.fillRect(0, y, w, KEY_H);
      if (semitone === 0) {
        ctx.fillStyle = col('--pr-row-line');
        ctx.fillRect(0, y + KEY_H - 1, w, 1);
      }
    }

    // Líneas verticales
    const patLen = pattern?.length ?? 4;
    const firstBeat = Math.floor(scrollX);
    const lastBeat = Math.ceil(scrollX + w / zoomX);
    for (let b = firstBeat; b <= lastBeat; b++) {
      const x = beatToX(b);
      const isBar = b % project.timeSig.num === 0;
      ctx.fillStyle = isBar ? col('--pr-grid-bar') : col('--pr-grid-beat');
      ctx.fillRect(x, 0, 1, gridH);
      // Subdivisiones 1/4 de beat
      if (zoomX >= 32) {
        for (let s = 1; s < 4; s++) {
          ctx.fillStyle = col('--pr-grid-sub');
          ctx.fillRect(x + (s * zoomX) / 4, 0, 1, gridH);
        }
      }
    }
    // Fin del patrón
    ctx.fillStyle = col('--pr-pattern-end');
    ctx.fillRect(beatToX(patLen), 0, 2, gridH);

    // Ghost notes (otros canales de ESTE patrón; se pueden apagar)
    if (showGhosts && pattern && channelId) {
      ctx.fillStyle = col('--pr-ghost');
      for (const [cid, list] of Object.entries(pattern.notes)) {
        if (cid === channelId) continue;
        for (const n of list) {
          const y = keyToY(n.key);
          if (y + KEY_H < 0 || y > gridH) continue;
          ctx.fillRect(beatToX(n.start) + 1, y + 3, Math.max(2, n.duration * zoomX - 2), KEY_H - 6);
        }
      }
    }

    // Notas del canal (las que borra el pincel-borrador se ocultan ya)
    const accent = channel?.color ?? col('--accent');
    const current = ghost.current;
    const d = drag.current;
    for (const raw of notes) {
      if (d?.erased?.has(raw.id)) continue;
      const n = current?.get(raw.id) ?? raw;
      const y = keyToY(n.key);
      const x = beatToX(n.start);
      const nw = Math.max(3, n.duration * zoomX - 1);
      if (y + KEY_H < 0 || y > gridH || x + nw < 0 || x > w) continue;
      const selected = selection.has(n.id);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.35 + n.velocity * 0.6;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1.5, nw, KEY_H - 3, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selected) {
        ctx.strokeStyle = col('--text');
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      // Slide: triángulo a la izquierda
      if (n.slide) {
        ctx.fillStyle = col('--text');
        ctx.beginPath();
        ctx.moveTo(x + 3, y + 3);
        ctx.lineTo(x + 9, y + KEY_H / 2);
        ctx.lineTo(x + 3, y + KEY_H - 3);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Notas del pincel: aún no están en el store, se pintan igual que las vivas.
    if (d?.painted) {
      for (const n of d.painted) {
        const y = keyToY(n.key);
        const x = beatToX(n.start);
        const nw = Math.max(3, n.duration * zoomX - 1);
        if (y + KEY_H < 0 || y > gridH || x + nw < 0 || x > w) continue;
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.35 + n.velocity * 0.6;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1.5, nw, KEY_H - 3, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Línea de corte (herramienta Cortar): el tajo que se va a dar al soltar.
    if (d?.mode === 'slice' && d.marqueeEnd) {
      ctx.strokeStyle = col('--pr-playhead');
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(d.startX, d.startY);
      ctx.lineTo(d.marqueeEnd.x, d.marqueeEnd.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }

    // Marquee
    if (d?.mode === 'marquee' && d.marqueeEnd) {
      ctx.strokeStyle = col('--accent');
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(d.startX, d.marqueeEnd.x),
        Math.min(d.startY, d.marqueeEnd.y),
        Math.abs(d.marqueeEnd.x - d.startX),
        Math.abs(d.marqueeEnd.y - d.startY),
      );
      ctx.setLineDash([]);
    }

    // ── Carril inferior: velocity o pan por nota ──
    ctx.fillStyle = col('--pr-lane-bg');
    ctx.fillRect(0, gridH, w, VEL_LANE_H);
    ctx.fillStyle = col('--pr-row-line');
    ctx.fillRect(0, gridH, w, 1);
    if (laneMode === 'pan') {
      ctx.fillRect(0, gridH + VEL_LANE_H / 2, w, 1);
    }
    for (const raw of notes) {
      if (d?.erased?.has(raw.id)) continue;
      const n = current?.get(raw.id) ?? raw;
      const x = beatToX(n.start);
      if (x < -4 || x > w) continue;
      ctx.fillStyle = accent;
      ctx.globalAlpha = selection.size === 0 || selection.has(n.id) ? 0.95 : 0.35;
      if (laneMode === 'velocity') {
        const vh = n.velocity * (VEL_LANE_H - 10);
        ctx.fillRect(x + 1, gridH + (VEL_LANE_H - vh) - 4, 4, vh);
      } else {
        // Pan: barra desde la línea central (arriba = derecha, abajo = izquierda).
        const mid = gridH + VEL_LANE_H / 2;
        const ph = ((n.pan ?? 0) / 2) * (VEL_LANE_H - 10);
        if (ph >= 0) ctx.fillRect(x + 1, mid - Math.max(2, ph), 4, Math.max(2, ph));
        else ctx.fillRect(x + 1, mid, 4, Math.max(2, -ph));
      }
      ctx.globalAlpha = 1;
    }

    // Cursores remotos: línea + celda con nombre de quien toca un piano roll.
    for (const p of peers) {
      const a = p.activity;
      if (p.isSelf || !a || !a.editor.startsWith('Piano Roll') || a.beat === undefined) continue;
      const px = beatToX(a.beat);
      if (px < -80 || px > w + 20) continue;
      ctx.fillStyle = p.user.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px, 0, 1.5, gridH);
      if (a.key !== undefined) {
        ctx.fillRect(px - 4, keyToY(a.key), 9, KEY_H);
      }
      ctx.font = `9px ${css.fontFamily}`;
      const tw = ctx.measureText(p.user.name).width;
      ctx.fillRect(px, 2, tw + 8, 12);
      ctx.fillStyle = col('--pr-lane-bg');
      ctx.fillText(p.user.name, px + 4, 11.5);
      ctx.globalAlpha = 1;
    }

    // Playhead (modo patrón)
    const ui = useUiStore.getState();
    if (ui.playing && ui.playMode === 'pattern') {
      const x = beatToX(ui.positionBeats % Math.max(1, patLen));
      ctx.fillStyle = col('--pr-playhead');
      ctx.fillRect(x, 0, 1.5, h);
    }
  }, [notes, pattern, channel, channelId, selection, laneMode, peers, scrollX, zoomX, scaleRoot, scale, showGhosts, project.timeSig.num, beatToX, keyToY, themeVersion]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Redibuja el playhead mientras suena
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw]);

  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  // ── Interacción ───────────────────────────────────────────────────────────

  const commitGesture = useCallback(() => {
    const d = drag.current;
    const g = ghost.current;
    drag.current = null;
    if (!d || !g || !activePatternId || !channelId) {
      ghost.current = null;
      draw();
      return;
    }
    const patches = [];
    for (const [id, after] of g) {
      const before = d.orig.get(id);
      if (!before) continue;
      if (
        before.start !== after.start ||
        before.key !== after.key ||
        before.duration !== after.duration ||
        before.velocity !== after.velocity ||
        (before.pan ?? 0) !== (after.pan ?? 0)
      ) {
        patches.push({
          id,
          start: after.start,
          key: after.key,
          duration: after.duration,
          velocity: after.velocity,
          pan: after.pan ?? 0,
        });
      }
    }
    ghost.current = null;
    if (patches.length > 0) {
      store.dispatch(
        { type: 'patchNotes', patternId: activePatternId, channelId, patches },
        {
          label:
            d.mode === 'resize'
              ? 'Redimensionar notas'
              : d.mode === 'velocity'
                ? laneMode === 'pan'
                  ? 'Pan por nota'
                  : 'Velocity'
                : 'Mover notas',
        },
      );
    } else {
      draw();
    }
  }, [activePatternId, channelId, laneMode, draw]);

  /** Pincel: pinta la celda (fila, beat) bajo el puntero si está libre. */
  const paintAt = useCallback(
    (x: number, y: number) => {
      const d = drag.current;
      if (!d || d.mode !== 'paint' || !d.painted) return;
      const rawKey = yToKey(y);
      const key = scaleLock ? snapToScale(rawKey) : rawKey;
      if (key < 0 || key >= KEYS) return;
      const start = Math.max(0, Math.floor(xToBeat(x) / brushStep) * brushStep);
      const cell = `${key}:${start}`;
      if (cell === d.lastCell) return;
      d.lastCell = cell;
      // Ni encima de lo que ya había ni encima de lo recién pintado.
      if (occupied(notes, key, start) || occupied(d.painted, key, start)) return;
      d.painted.push({
        id: newId(),
        start,
        duration: lastDuration,
        key,
        velocity: 0.8,
        pan: 0,
        slide: false,
      });
      if (channelIndex >= 0 && key !== d.lastPreviewKey) {
        if (d.lastPreviewKey !== undefined) previewNote(channelIndex, d.lastPreviewKey, false);
        previewNote(channelIndex, key, true);
        d.lastPreviewKey = key;
      }
      draw();
    },
    [notes, yToKey, xToBeat, brushStep, lastDuration, scaleLock, snapToScale, channelIndex, draw],
  );

  /** Pincel-borrador: marca la nota bajo el puntero (se borran todas al soltar). */
  const eraseAt = useCallback(
    (x: number, y: number) => {
      const d = drag.current;
      if (!d || d.mode !== 'erase' || !d.erased) return;
      const hit = noteAt(x, y);
      if (hit && !d.erased.has(hit.note.id)) {
        d.erased.add(hit.note.id);
        draw();
      }
    },
    [noteAt, draw],
  );

  // Declarado ANTES de `onPointerDown` a propósito: éste la llama (lane de
  // velocity/pan) y necesita tenerla en sus deps para no quedarse con una
  // cerradura vieja de `laneMode`/`selection` — y una `const` no puede
  // aparecer en el array de deps de un hook declarado más arriba.
  const applyVelocityAt = useCallback(
    (x: number, y: number, canvasH: number) => {
      const g = ghost.current;
      if (!g) return;
      const beat = xToBeat(x);
      // Ajusta las seleccionadas; sin selección (o con ids muertos), la más cercana en X.
      let targets = selection.size > 0
        ? [...g.values()].filter((n) => selection.has(n.id))
        : [];
      if (targets.length === 0) {
        targets = [...g.values()]
          .sort((a, b) => Math.abs(a.start - beat) - Math.abs(b.start - beat))
          .slice(0, 1);
      }
      if (laneMode === 'velocity') {
        const vel = Math.min(1, Math.max(0.05, (canvasH - y - 4) / (VEL_LANE_H - 10)));
        for (const t of targets) g.set(t.id, { ...t, velocity: vel });
      } else {
        const raw = ((canvasH - y - 4) / (VEL_LANE_H - 10)) * 2 - 1;
        const pan = Math.min(1, Math.max(-1, raw));
        for (const t of targets) g.set(t.id, { ...t, pan });
      }
      draw();
    },
    [selection, laneMode, xToBeat, draw],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || !activePatternId || !channelId || channelIndex < 0) return;
      capturePointer(canvas, e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gridH = rect.height - VEL_LANE_H;

      // Velocity lane
      if (y >= gridH) {
        const orig = new Map(notes.map((n) => [n.id, { ...n }]));
        drag.current = { mode: 'velocity', startX: x, startY: y, orig, moved: false };
        ghost.current = new Map(orig);
        applyVelocityAt(x, y, rect.height);
        return;
      }

      // Botón derecho: borrar. Con el pincel, arrastrando (todo en un undo).
      if (e.button === 2) {
        if (tool === 'brush') {
          drag.current = {
            mode: 'erase',
            startX: x,
            startY: y,
            orig: new Map(),
            erased: new Set(),
            moved: false,
          };
          eraseAt(x, y);
          return;
        }
        const hit = noteAt(x, y);
        if (hit) {
          const ids = selection.has(hit.note.id) && selection.size > 1 ? [...selection] : [hit.note.id];
          store.dispatch(
            { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: ids },
            { label: `Borrar ${ids.length} nota(s)` },
          );
          setSelection(new Set());
        }
        return;
      }

      // Ctrl+arrastre sigue siendo el marquee, también con pincel o corte.
      if (e.ctrlKey && tool !== 'draw') {
        drag.current = { mode: 'marquee', startX: x, startY: y, orig: new Map(), moved: false, marqueeEnd: { x, y } };
        return;
      }

      // Cortar: la línea se dibuja mientras arrastras y parte al soltar.
      if (tool === 'slice') {
        drag.current = {
          mode: 'slice',
          startX: x,
          startY: y,
          orig: new Map(),
          moved: false,
          marqueeEnd: { x, y },
        };
        return;
      }

      // Pincel: notas seguidas mientras arrastras (respetando snap y duración).
      if (tool === 'brush') {
        drag.current = {
          mode: 'paint',
          startX: x,
          startY: y,
          orig: new Map(),
          painted: [],
          moved: false,
        };
        setSelection(new Set());
        paintAt(x, y);
        return;
      }

      const hit = noteAt(x, y);
      if (hit) {
        // Selección
        let sel = new Set(selection);
        if (e.shiftKey) {
          if (sel.has(hit.note.id)) sel.delete(hit.note.id);
          else sel.add(hit.note.id);
        } else if (!sel.has(hit.note.id)) {
          sel = new Set([hit.note.id]);
        }
        setSelection(sel);
        const affected = notes.filter((n) => sel.has(n.id));
        const orig = new Map(affected.map((n) => [n.id, { ...n }]));
        ghost.current = new Map(affected.map((n) => [n.id, { ...n }]));
        drag.current = {
          mode: hit.edge ? 'resize' : 'move',
          startX: x,
          startY: y,
          orig,
          moved: false,
        };
        previewNote(channelIndex, hit.note.key, true);
        drag.current.lastPreviewKey = hit.note.key;
        return;
      }

      if (e.ctrlKey) {
        // Marquee
        drag.current = { mode: 'marquee', startX: x, startY: y, orig: new Map(), moved: false, marqueeEnd: { x, y } };
        return;
      }

      // Crear nota (o acorde completo si el stamp está activo)
      const start = doSnap(xToBeat(x));
      // Con bloqueo a escala la fundamental se ajusta primero; los intervalos
      // del acorde NO se reajustan (se apilan tal cual desde ahí).
      const key = scaleLock ? snapToScale(yToKey(y)) : yToKey(y);
      const chordDef = CHORDS[chordIdx];
      const created: Note[] = [];
      if (chordDef?.intervals) {
        // Stamp de acorde: todas las notas en UN dispatch (undo limpio).
        const keys = [...new Set(chordDef.intervals.map((iv) => Math.min(KEYS - 1, Math.max(0, key + iv))))];
        for (const k of keys) {
          created.push({ id: newId(), start, duration: lastDuration, key: k, velocity: 0.8, pan: 0, slide: false });
        }
        store.dispatch(
          { type: 'addNotes', patternId: activePatternId, channelId, notes: created },
          { label: `Acorde ${chordDef.label} en ${midiToNote(key)}` },
        );
      } else {
        created.push({ id: newId(), start, duration: lastDuration, key, velocity: 0.8, pan: 0, slide: false });
        store.dispatch(
          { type: 'addNotes', patternId: activePatternId, channelId, notes: created },
          { label: `Nota ${midiToNote(key)}` },
        );
      }
      setSelection(new Set(created.map((n) => n.id)));
      // Gesto de dibujo, como en FL: el arrastre que sigue decide qué hace.
      // Si va en horizontal, ESTIRA la nota recién puesta (y esa duración
      // queda de plantilla para las siguientes); si va en vertical, la mueve.
      // Se resuelve en `onPointerMove` con el primer movimiento que pase del
      // umbral, y a partir de ahí el modo ya no cambia.
      const orig = new Map(created.map((n) => [n.id, { ...n }]));
      ghost.current = new Map(created.map((n) => [n.id, { ...n }]));
      drag.current = { mode: 'create', startX: x, startY: y, orig, createdId: created[0]!.id, moved: false, lastPreviewKey: key };
      previewNote(channelIndex, key, true);
    },
    // `applyVelocityAt` faltaba en la lista original. Ojo con el porqué, que la
    // verificación de la v3.7 corrigió: NO producía un fallo visible. `laneMode`
    // no puede cambiar sin recrear `draw` → `paintAt` → este manejador, y
    // `paintAt` ya estaba listado, así que la cerradura nunca llegaba a ser vieja.
    // Se lista igual porque esa cobertura es ACCIDENTAL: el día que `paintAt`
    // deje de arrastrar `draw`, el bug aparece de verdad y nadie se entera.
    [activePatternId, channelId, channelIndex, notes, selection, noteAt, doSnap, xToBeat, yToKey, lastDuration, scaleLock, snapToScale, chordIdx, tool, paintAt, eraseAt, applyVelocityAt],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Presencia: dónde está nuestro cursor (throttled; no-op sin sesión).
      reportActivity(channel ? `Piano Roll · ${channel.name}` : 'Piano Roll', {
        beat: xToBeat(x),
        key: yToKey(y),
      });

      const d = drag.current;
      if (!d) {
        // Sin gesto: el cursor delata qué haría un clic aquí — el tirador del
        // borde derecho estira la nota, el cuerpo la mueve.
        if (tool === 'draw') {
          const over = noteAt(x, y);
          canvas.style.cursor = over ? (over.edge ? 'ew-resize' : 'move') : '';
        } else if (canvas.style.cursor !== '') {
          canvas.style.cursor = '';
        }
        return;
      }
      d.moved = true;

      // Gesto de dibujo recién empezado: el primer movimiento que pase del
      // umbral decide si se estira (horizontal, como el arrastre de FL) o se
      // mueve (vertical). Una vez decidido, el modo se queda fijo.
      if (d.mode === 'create') {
        const dx = x - d.startX;
        const dy = y - d.startY;
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        d.mode = Math.abs(dx) >= Math.abs(dy) ? 'resize' : 'move';
      }

      if (d.mode === 'velocity') {
        applyVelocityAt(x, y, rect.height);
        return;
      }
      if (d.mode === 'paint') {
        paintAt(x, y);
        return;
      }
      if (d.mode === 'erase') {
        eraseAt(x, y);
        return;
      }
      if (d.mode === 'marquee' || d.mode === 'slice') {
        d.marqueeEnd = { x, y };
        draw();
        return;
      }
      const g = ghost.current;
      if (!g) return;
      if (d.mode === 'move') {
        // Clamp de GRUPO: el delta se limita para que NINGUNA nota cruce los
        // bordes (beat 0 o el rango de teclas). Así la selección entera se
        // frena en bloque y conserva las posiciones relativas, en vez de que
        // cada nota se clave en el borde y se apilen unas sobre otras.
        let minStart = Infinity;
        let minKey = Infinity;
        let maxKey = -Infinity;
        for (const orig of d.orig.values()) {
          if (orig.start < minStart) minStart = orig.start;
          if (orig.key < minKey) minKey = orig.key;
          if (orig.key > maxKey) maxKey = orig.key;
        }
        const dBeat = Math.max(-minStart, (x - d.startX) / zoomX);
        const dKey = Math.min(
          KEYS - 1 - maxKey,
          Math.max(-minKey, yToKey(y) - yToKey(d.startY)),
        );
        let previewKey: number | undefined;
        for (const [id, orig] of d.orig) {
          const start = doSnap(orig.start + dBeat, snap === null);
          let key = orig.key + dKey;
          // Bloqueo a escala: solo si hay movimiento vertical (dKey !== 0);
          // arrastrar en horizontal no toca la key.
          if (scaleLock && dKey !== 0) key = snapToScale(key);
          g.set(id, { ...orig, start, key });
          previewKey = key;
        }
        if (previewKey !== undefined && previewKey !== d.lastPreviewKey && channelIndex >= 0) {
          if (d.lastPreviewKey !== undefined) previewNote(channelIndex, d.lastPreviewKey, false);
          previewNote(channelIndex, previewKey, true);
          d.lastPreviewKey = previewKey;
        }
      } else if (d.mode === 'resize') {
        for (const [id, orig] of d.orig) {
          const end = doSnap(xToBeat(x), false);
          const duration = Math.max(snapStep ?? 0.05, end - orig.start);
          g.set(id, { ...orig, duration });
        }
      }
      draw();
    },
    [zoomX, yToKey, doSnap, snap, snapStep, scaleLock, snapToScale, xToBeat, draw, applyVelocityAt, paintAt, eraseAt, channelIndex, channel, tool, noteAt],
  );

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    if (d.lastPreviewKey !== undefined && channelIndex >= 0) {
      previewNote(channelIndex, d.lastPreviewKey, false);
    }

    // Pincel: todo lo pintado entra en UN solo addNotes (un paso de undo).
    if (d.mode === 'paint') {
      drag.current = null;
      const painted = d.painted ?? [];
      if (painted.length > 0 && activePatternId && channelId) {
        store.dispatch(
          { type: 'addNotes', patternId: activePatternId, channelId, notes: painted },
          { label: `Pintar ${painted.length} nota(s)` },
        );
        setSelection(new Set(painted.map((n) => n.id)));
      } else {
        draw();
      }
      return;
    }

    // Pincel-borrador: un solo removeNotes con todo lo que tocó el arrastre.
    if (d.mode === 'erase') {
      drag.current = null;
      const ids = [...(d.erased ?? [])];
      if (ids.length > 0 && activePatternId && channelId) {
        store.dispatch(
          { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: ids },
          { label: `Borrar ${ids.length} nota(s)` },
        );
        setSelection(new Set());
      } else {
        draw();
      }
      return;
    }

    // Cortar: cabezas acortadas + colas nuevas en UN batch (un paso de undo).
    if (d.mode === 'slice') {
      drag.current = null;
      const end = d.marqueeEnd ?? { x: d.startX, y: d.startY };
      const cuts = sliceCuts(
        notes,
        { x0: d.startX, y0: d.startY, x1: end.x, y1: end.y },
        (key) => keyToY(key) + KEY_H / 2,
        xToBeat,
      );
      const { patches, tails } = applySliceCuts(cuts);
      if (patches.length > 0 && activePatternId && channelId) {
        const label = `Cortar ${patches.length} nota(s)`;
        store.dispatch(
          {
            type: 'batch',
            label,
            commands: [
              { type: 'patchNotes', patternId: activePatternId, channelId, patches },
              { type: 'addNotes', patternId: activePatternId, channelId, notes: tails },
            ],
          },
          { label },
        );
        setSelection(new Set(tails.map((n) => n.id)));
      } else {
        draw();
      }
      return;
    }

    if (d.mode === 'marquee') {
      const end = d.marqueeEnd ?? { x: d.startX, y: d.startY };
      const b0 = xToBeat(Math.min(d.startX, end.x));
      const b1 = xToBeat(Math.max(d.startX, end.x));
      const k0 = yToKey(Math.max(d.startY, end.y));
      const k1 = yToKey(Math.min(d.startY, end.y));
      const sel = new Set<string>();
      for (const n of notes) {
        if (n.start + n.duration > b0 && n.start < b1 && n.key >= k0 && n.key <= k1) sel.add(n.id);
      }
      setSelection(sel);
      drag.current = null;
      ghost.current = null;
      draw();
      return;
    }
    // Recuerda la última duración usada al redimensionar
    if (d.mode === 'resize' && ghost.current) {
      const first = [...ghost.current.values()][0];
      if (first) setLastDuration(first.duration);
    }
    commitGesture();
  }, [activePatternId, channelId, channelIndex, notes, xToBeat, yToKey, keyToY, draw, commitGesture]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey) {
        const next = Math.min(160, Math.max(12, zoomX * (e.deltaY < 0 ? 1.15 : 0.87)));
        setZoomX(next);
      } else if (e.shiftKey) {
        setScrollX(Math.max(0, scrollX + (e.deltaY > 0 ? 2 : -2)));
      } else {
        setScrollY(Math.min(KEYS * KEY_H - 200, Math.max(0, scrollY + e.deltaY)));
      }
    },
    [zoomX, scrollX, scrollY],
  );

  // ── Selección: borrar, duplicar, seleccionar todo y portapapeles ──────────
  //
  // Salen como callbacks y no sueltos dentro del keydown porque los usan tres
  // sitios: el teclado de aquí, los atajos globales y el menú Editar (que pide
  // estas mismas acciones al editor que tenga el turno).

  const selectedNotes = useCallback(
    () => notes.filter((n) => selection.has(n.id)),
    [notes, selection],
  );

  const deleteSelection = useCallback(() => {
    if (!activePatternId || !channelId || selection.size === 0) return;
    store.dispatch(
      { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: [...selection] },
      { label: `Borrar ${selection.size} nota(s)` },
    );
    setSelection(new Set());
  }, [activePatternId, channelId, selection]);

  const duplicateSelection = useCallback(() => {
    if (!activePatternId || !channelId || selection.size === 0) return;
    const sel = selectedNotes();
    if (sel.length === 0) return;
    const span =
      Math.max(...sel.map((n) => n.start + n.duration)) - Math.min(...sel.map((n) => n.start));
    const clones = sel.map((n) => ({ ...n, id: newId(), start: n.start + span }));
    store.dispatch(
      { type: 'addNotes', patternId: activePatternId, channelId, notes: clones },
      { label: 'Duplicar selección' },
    );
    setSelection(new Set(clones.map((c) => c.id)));
  }, [activePatternId, channelId, selection, selectedNotes]);

  const selectAllNotes = useCallback(() => {
    setSelection(new Set(notes.map((n) => n.id)));
  }, [notes]);

  /** Copiar (y cortar): lo copiado se normaliza al beat 0 en el portapapeles. */
  const copySelection = useCallback(
    (cut: boolean) => {
      if (!activePatternId || !channelId) return;
      const sel = selectedNotes();
      const payload = packNotes(sel, channel?.name ?? '');
      if (payload === null) return;
      setClipboard(payload);
      if (!cut) return;
      store.dispatch(
        { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: sel.map((n) => n.id) },
        { label: `Cortar ${sel.length} nota(s)` },
      );
      setSelection(new Set());
    },
    [activePatternId, channelId, channel, selectedNotes],
  );

  /**
   * Pega en el caret (el playhead dentro del patrón), con el snap vigente.
   *
   * El caret es global y avanza con la canción, así que se le aplica el módulo
   * de la longitud del patrón: es exactamente la línea que el Piano Roll pinta,
   * y pegar donde se ve la línea es lo único que no sorprende.
   */
  const pasteClipboard = useCallback(() => {
    if (!activePatternId || !channelId) return;
    const payload = readClipboard();
    if (payload === null || payload.kind !== 'notes') return;
    const patLen = Math.max(1, pattern?.length ?? 4);
    const fresh = unpackNotes(payload, doSnap(useUiStore.getState().positionBeats % patLen));
    if (fresh.length === 0) return;
    store.dispatch(
      { type: 'addNotes', patternId: activePatternId, channelId, notes: fresh },
      { label: `Pegar ${fresh.length} nota(s)` },
    );
    setSelection(new Set(fresh.map((n) => n.id)));
  }, [activePatternId, channelId, pattern, doSnap]);

  // El menú Editar y los atajos globales preguntan por aquí. Se registra un
  // PROVEEDOR (no el objeto) para que siempre lean la selección de ahora.
  const editActionsRef = useRef({
    selectionCount: 0,
    accepts: 'notes' as const,
    noun: 'notas',
    copy: () => {},
    cut: () => {},
    paste: () => {},
    duplicate: () => {},
    selectAll: () => {},
    remove: () => {},
  });
  editActionsRef.current = {
    selectionCount: pattern && channel ? selection.size : 0,
    accepts: 'notes',
    noun: 'notas',
    copy: () => copySelection(false),
    cut: () => copySelection(true),
    paste: pasteClipboard,
    duplicate: duplicateSelection,
    selectAll: selectAllNotes,
    remove: deleteSelection,
  };
  useEffect(() => registerEditActions('pianoRoll', () => editActionsRef.current), []);

  // Teclado: Supr borra selección; Ctrl+B duplica
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activePatternId || !channelId) return;
      const target = e.target as HTMLElement;
      // Si el foco está en un campo de texto (p. ej. el textarea de Notas del
      // proyecto), estas teclas son para escribir: Ctrl+A seleccionaría todas
      // las notas y Supr las borraría sin que el usuario mire el Piano Roll.
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
        return;
      // Supr A SECAS borra las notas; con Ctrl+Shift es el atajo global de
      // borrar el patrón (useShortcuts) y aquí no se toca la selección.
      if (e.code === 'Delete' && !e.ctrlKey && !e.shiftKey && !e.altKey && selection.size > 0) {
        deleteSelection();
      }
      if (e.ctrlKey && e.code === 'KeyB' && selection.size > 0) {
        e.preventDefault();
        duplicateSelection();
      }
      if (e.ctrlKey && e.code === 'KeyA') {
        e.preventDefault();
        selectAllNotes();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, activePatternId, channelId, deleteSelection, duplicateSelection, selectAllNotes]);

  // ── Herramientas de la toolbar ────────────────────────────────────────────

  // La regla —a qué notas afecta un botón de la toolbar, y qué parche produce—
  // vive en `note-tools.ts`, sin React delante y con sus tests. Aquí queda el
  // cableado: leer el estado, llamar, despachar.
  const affectedIds = useCallback(
    () => affectedNoteIds(notes, selection),
    [selection, notes],
  );

  const quantize = useCallback(() => {
    // Con snap magnético la Q cuantiza a la rejilla fija (snapStep = 0.25).
    if (!activePatternId || !channelId || snapStep === null) return;
    const patches = quantizePatches(notes, new Set(affectedIds()), snapStep);
    store.dispatch(
      { type: 'patchNotes', patternId: activePatternId, channelId, patches },
      { label: 'Cuantizar' },
    );
  }, [activePatternId, channelId, snapStep, notes, affectedIds]);

  const transpose = useCallback(
    (semis: number) => {
      if (!activePatternId || !channelId) return;
      const patches = transposePatches(notes, new Set(affectedIds()), semis, KEYS - 1);
      store.dispatch(
        { type: 'patchNotes', patternId: activePatternId, channelId, patches },
        { label: semis > 0 ? 'Subir octava' : 'Bajar octava' },
      );
    },
    [activePatternId, channelId, notes, affectedIds],
  );

  const toggleSlide = useCallback(() => {
    if (!activePatternId || !channelId || selection.size === 0) return;
    const sel = notes.filter((n) => selection.has(n.id));
    const allSlide = sel.every((n) => n.slide);
    store.dispatch(
      {
        type: 'patchNotes',
        patternId: activePatternId,
        channelId,
        patches: sel.map((n) => ({ id: n.id, slide: !allSlide })),
      },
      { label: allSlide ? 'Quitar slide' : 'Slide' },
    );
  }, [activePatternId, channelId, selection, notes]);

  // ── Herramientas de composición (note-tools de core) ──────────────────────
  // Cada una reemplaza las notas afectadas (selección o todo) en un solo undo.

  const applyTools = useCallback(
    (label: string, transform: (sel: Note[]) => Note[]) => {
      if (!activePatternId || !channelId) return;
      const ids = new Set(affectedIds());
      const sel = notes.filter((n) => ids.has(n.id));
      if (sel.length === 0) return;
      const result = transform(sel);
      store.dispatch(
        {
          type: 'batch',
          label,
          commands: [
            { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: [...ids] },
            { type: 'addNotes', patternId: activePatternId, channelId, notes: result },
          ],
        },
        { label },
      );
      setSelection(new Set(result.map((n) => n.id)));
    },
    [activePatternId, channelId, notes, affectedIds],
  );

  // ── Arpegiador (panel con previsualización en vivo) ───────────────────────

  /**
   * Sesión del arpegiador: las notas tal y como estaban al abrirlo, lo que hay
   * escrito AHORA de esta pasada, y qué entrada del historial la puso.
   *
   * `base` hace falta porque cada toque de perilla vuelve a arpegiar desde el
   * ORIGINAL — no desde lo ya arpegiado, que se multiplicaría a cada toque. Y
   * `entryId` porque la pasada anterior se DESHACE antes de la siguiente (ver
   * `previewArp`).
   */
  const arpSession = useRef<{ base: Note[]; currentIds: string[]; entryId: string | null } | null>(
    null,
  );

  /** ¿La última entrada aplicada del historial es la que puso esta pasada? */
  const arpEntryOnTop = useCallback((entryId: string | null): boolean => {
    if (entryId === null) return false;
    const { entries, present } = store.historyView();
    return entries[present - 1]?.id === entryId;
  }, []);

  const previewArp = useCallback(
    (opts: ArpeggiateOptions) => {
      const session = arpSession.current;
      if (!session || !activePatternId || !channelId) return;

      /**
       * Antes de pintar la pasada nueva se DESHACE la anterior.
       *
       * Lo evidente sería fundirlas con `mergeKey`, como las perillas, pero
       * ahí eso está mal: al fusionar se conserva el inverso de la PRIMERA y
       * se sustituye el comando por el último. Con perillas da igual (patch
       * sobre los mismos ids), pero cada pasada del arpegio borra unas notas y
       * crea otras nuevas, así que ese inverso acaba apuntando a ids que ya no
       * existen: un Ctrl+Z después de aceptar dejaba el arpegio Y las notas
       * originales encima, sonando a la vez. Deshaciendo, el historial queda
       * con UNA entrada limpia y el estado siempre parte del original.
       */
      if (arpEntryOnTop(session.entryId)) {
        store.undo();
        // Deshacer ha devuelto las notas ORIGINALES: lo que hay que quitar
        // ahora son esas, no las que generó la pasada anterior (que ya no
        // existen). Sin esta línea, la pasada nueva se sumaba a las originales
        // y acababas con el arpegio y el acorde sonando a la vez.
        session.currentIds = session.base.map((n) => n.id);
      }
      session.entryId = null;

      const generated = arpeggiate(session.base, opts);
      if (generated.length === 0) return;
      const label = 'Arpegiar';
      store.dispatch(
        {
          type: 'batch',
          label,
          commands: [
            {
              type: 'removeNotes',
              patternId: activePatternId,
              channelId,
              noteIds: session.currentIds,
            },
            { type: 'addNotes', patternId: activePatternId, channelId, notes: generated },
          ],
        },
        { label },
      );
      const { entries, present } = store.historyView();
      session.entryId = entries[present - 1]?.id ?? null;
      session.currentIds = generated.map((n) => n.id);
      setSelection(new Set(session.currentIds));
    },
    [activePatternId, channelId, arpEntryOnTop],
  );

  /** Abre el panel con las notas afectadas (selección o todas) congeladas. */
  const openArp = useCallback(() => {
    if (!activePatternId || !channelId) return;
    const ids = new Set(affectedIds());
    const base = notes.filter((n) => ids.has(n.id)).map((n) => ({ ...n }));
    arpSession.current = { base, currentIds: base.map((n) => n.id), entryId: null };
    // Los dos paneles salen en la misma esquina: abrir uno cierra el otro.
    setRiffOpen(false);
    setArpOpen(true);
  }, [activePatternId, channelId, affectedIds, notes]);

  /** Cancelar: devuelve exactamente las notas de partida (ids incluidos). */
  const cancelArp = useCallback(() => {
    const session = arpSession.current;
    arpSession.current = null;
    setArpOpen(false);
    if (!session || !activePatternId || !channelId) return;
    // Lo normal: deshacer la pasada, que además borra su rastro del historial.
    if (arpEntryOnTop(session.entryId)) {
      store.undo();
      setSelection(new Set(session.base.map((n) => n.id)));
      return;
    }
    if (session.entryId === null) return;
    // Si mientras tanto se hizo otra cosa, la entrada del arpegio ya no está
    // arriba y deshacer se llevaría por delante lo del usuario: se restaura a
    // mano, aunque cueste una entrada más de historial.
    const label = 'Deshacer arpegio';
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: [
          { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: session.currentIds },
          { type: 'addNotes', patternId: activePatternId, channelId, notes: session.base },
        ],
      },
      { label },
    );
    setSelection(new Set(session.base.map((n) => n.id)));
  }, [activePatternId, channelId, arpEntryOnTop]);

  const acceptArp = useCallback(() => {
    arpSession.current = null;
    setArpOpen(false);
  }, []);

  const doStrum = useCallback(() => {
    applyTools('Strum', (sel) => strum(sel, { spread: (snapStep ?? 0.25) / 2, direction: 'up' }));
  }, [applyTools, snapStep]);

  const doHumanize = useCallback(() => {
    applyTools('Humanizar', (sel) =>
      humanize(sel, { timing: 0.03, velocity: 0.1, seed: (Math.random() * 0xffffffff) >>> 0 }),
    );
  }, [applyTools]);

  const doChop = useCallback(() => {
    applyTools('Chop', (sel) => chop(sel, { grid: snapStep ?? 0.25 }));
  }, [applyTools, snapStep]);

  /**
   * Convierte en acordes las notas seleccionadas (o todas si no hay
   * selección), con el acorde elegido en la toolbar.
   *
   * No pasa por `applyTools`: ese borra y reescribe lo afectado, y aquí las
   * notas originales tienen que quedarse EXACTAMENTE como están —con su id,
   * su velocity y su slide—. Solo se añade lo que falta, así que deshacer
   * quita el acorde y deja la melodía intacta.
   *
   * Con el bloqueo a escala encendido el acorde se arrima a la tonalidad
   * activa: la misma forma sobre grados distintos deja de sonar a copia
   * transportada y empieza a sonar a progresión.
   */
  const applyChordToSelection = useCallback(() => {
    if (!activePatternId || !channelId) return;
    const chordDef = CHORDS[chordIdx];
    if (!chordDef?.intervals) return;
    const ids = new Set(affectedIds());
    const targets = notes.filter((n) => ids.has(n.id));
    if (targets.length === 0) return;
    const added = chordify(targets, {
      intervals: chordDef.intervals,
      maxKey: KEYS - 1,
      existing: notes,
      ...(scaleLock ? { scale, root: scaleRoot } : {}),
    });
    if (added.length === 0) return;
    const label = `Acorde ${chordDef.label} en ${targets.length} nota(s)`;
    store.dispatch(
      { type: 'addNotes', patternId: activePatternId, channelId, notes: added },
      { label },
    );
    // La selección pasa a ser el acorde entero (originales + añadidas): lo
    // siguiente que hagas —mover, arpegiar, strum— cae sobre todo el acorde.
    setSelection(new Set([...targets.map((n) => n.id), ...added.map((n) => n.id)]));
  }, [activePatternId, channelId, chordIdx, affectedIds, notes, scaleLock, scale, scaleRoot]);

  // ── Riff machine ──────────────────────────────────────────────────────────

  /**
   * Vuelca el riff generado en el canal y patrón activos con UN solo paso de
   * undo: borra antes solo si el usuario pidió reemplazar, y si el motivo se
   * sale del patrón lo alarga hasta el compás siguiente (todo en el mismo lote).
   */
  const applyRiff = useCallback(
    (generated: Note[], replace: boolean) => {
      if (!activePatternId || !channelId || !pattern || generated.length === 0) return;
      const commands: Command[] = [];
      if (replace && notes.length > 0) {
        commands.push({
          type: 'removeNotes',
          patternId: activePatternId,
          channelId,
          noteIds: notes.map((n) => n.id),
        });
      }
      commands.push({
        type: 'addNotes',
        patternId: activePatternId,
        channelId,
        notes: generated,
      });
      const end = Math.max(...generated.map((n) => n.start + n.duration));
      const bar = Math.max(1, project.timeSig.num);
      if (end > pattern.length + 1e-6) {
        commands.push({
          type: 'patchPattern',
          patternId: activePatternId,
          patch: { length: Math.ceil(end / bar) * bar },
        });
      }
      const label = replace ? 'Riff machine (reemplazar)' : 'Riff machine';
      store.dispatch(
        commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
        { label },
      );
      setSelection(new Set(generated.map((n) => n.id)));
    },
    [activePatternId, channelId, pattern, notes, project.timeSig.num],
  );

  // Atajos de herramientas estilo FL: Alt+A arpegiar, Alt+S strum, Alt+U chop,
  // Alt+R humanizar, Alt+C acorde sobre la selección, Alt+G Riff machine,
  // Ctrl+Q cuantizar, Ctrl+Shift+flechas
  // transponer octava. Solo activos con la ventana del Piano Roll montada
  // (como Supr/Ctrl+B).
  // Los modos de herramienta van con UNA tecla (P dibujar, B pincel, C cortar,
  // como en FL) y por eso solo responden con el ratón encima del piano roll o
  // el foco dentro: así no se los robamos a la playlist ni al rack.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
        return;
      }
      // Esc con el arpegiador abierto = cancelar (las notas vuelven a como
      // estaban). Va lo primero: con el panel abierto, Esc no es otra cosa.
      if (e.code === 'Escape' && arpOpen) {
        e.preventDefault();
        cancelArp();
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        const root = rootRef.current;
        const here = hovering.current || (root !== null && root.contains(document.activeElement));
        const picked = TOOLS.find((t) => t.key === e.code);
        if (here && picked) {
          e.preventDefault();
          setTool(picked.id);
          return;
        }
      }
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.code === 'KeyA') {
          e.preventDefault();
          openArp();
        } else if (e.code === 'KeyS') {
          e.preventDefault();
          doStrum();
        } else if (e.code === 'KeyU') {
          e.preventDefault();
          doChop();
        } else if (e.code === 'KeyR') {
          e.preventDefault();
          doHumanize();
        } else if (e.code === 'KeyG') {
          e.preventDefault();
          if (arpOpen) cancelArp();
          setRiffOpen((open) => !open);
        } else if (e.code === 'KeyC') {
          e.preventDefault();
          applyChordToSelection();
        }
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyQ') {
        e.preventDefault();
        quantize();
      } else if (e.ctrlKey && e.shiftKey && e.code === 'ArrowUp') {
        e.preventDefault();
        transpose(12);
      } else if (e.ctrlKey && e.shiftKey && e.code === 'ArrowDown') {
        e.preventDefault();
        transpose(-12);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openArp, doStrum, doChop, doHumanize, quantize, transpose, applyChordToSelection, arpOpen, cancelArp]);

  // ── Minimapa ──────────────────────────────────────────────────────────────
  // Vista completa del patrón con las notas y el rectángulo del viewport;
  // clic o arrastre = centrar la vista en ese punto.

  const miniRef = useRef<HTMLCanvasElement>(null);

  const drawMini = useCallback(() => {
    const canvas = miniRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const col = (name: string) => css.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = col('--pr-lane-bg');
    ctx.fillRect(0, 0, w, h);

    const patLen = pattern?.length ?? 4;
    let minKey = Infinity;
    let maxKey = -Infinity;
    for (const n of notes) {
      if (n.key < minKey) minKey = n.key;
      if (n.key > maxKey) maxKey = n.key;
    }
    if (!Number.isFinite(minKey)) {
      minKey = 48;
      maxKey = 72;
    }
    const span = Math.max(12, maxKey - minKey + 1);
    ctx.fillStyle = col('--accent');
    for (const n of notes) {
      const x = (n.start / patLen) * w;
      const nw = Math.max(1.5, (n.duration / patLen) * w);
      const y = 2 + (1 - (n.key - minKey) / span) * (h - 6);
      ctx.fillRect(x, y, nw, 2);
    }

    // Viewport actual
    const viewW = wrapRef.current?.clientWidth ?? 0;
    const v0 = (scrollX / patLen) * w;
    const v1 = ((scrollX + viewW / zoomX) / patLen) * w;
    ctx.strokeStyle = col('--pr-playhead');
    ctx.globalAlpha = 0.8;
    ctx.strokeRect(v0 + 0.5, 0.5, Math.max(6, v1 - v0) - 1, h - 1);
    ctx.globalAlpha = 1;
  }, [notes, pattern, scrollX, zoomX]);

  useEffect(() => {
    drawMini();
  }, [drawMini, themeVersion]);

  const onMiniPointer = useCallback(
    (e: React.PointerEvent) => {
      if (e.type === 'pointermove' && (e.buttons & 1) === 0) return;
      const canvas = miniRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const patLen = pattern?.length ?? 4;
      const beat = ((e.clientX - rect.left) / rect.width) * patLen;
      const viewBeats = (wrapRef.current?.clientWidth ?? 0) / zoomX;
      setScrollX(Math.max(0, beat - viewBeats / 2));
    },
    [pattern, zoomX],
  );

  // ── Teclado lateral ───────────────────────────────────────────────────────

  const keyboard = useMemo(() => {
    const keys = [];
    for (let k = KEYS - 1; k >= 0; k--) {
      const semitone = ((k % 12) + 12) % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(semitone);
      keys.push(
        <div
          key={k}
          className={`pr-key${isBlack ? ' black' : ''}${activeKeys.has(k) ? ' active' : ''}`}
          style={{ height: KEY_H }}
          onPointerDown={() => {
            if (channelIndex >= 0) previewNote(channelIndex, k, true);
          }}
          onPointerUp={() => {
            if (channelIndex >= 0) previewNote(channelIndex, k, false);
          }}
          onPointerLeave={() => {
            if (channelIndex >= 0) previewNote(channelIndex, k, false);
          }}
          onPointerCancel={() => {
            if (channelIndex >= 0) previewNote(channelIndex, k, false);
          }}
        >
          {semitone === 0 && <span className="pr-key-label">{midiToNote(k)}</span>}
        </div>,
      );
    }
    return keys;
  }, [channelIndex, activeKeys]);

  if (!pattern || !channel) {
    return (
      <div className="panel-placeholder">
        Elige un canal en el Channel Rack para abrir su Piano Roll.
      </div>
    );
  }

  return (
    <div
      className="pianoroll"
      ref={rootRef}
      // Tocar el Piano Roll le da el turno de edición: a partir de aquí,
      // Ctrl+C/X/V y el menú Editar hablan de SUS notas, no de los clips.
      onPointerDown={() => claimEditFocus('pianoRoll')}
      onPointerEnter={() => {
        hovering.current = true;
      }}
      onPointerLeave={() => {
        hovering.current = false;
      }}
    >
      {/*
        Toolbar por GRUPOS con su etiqueta.
        Antes era una fila de trece botones sueltos donde "Q", "+8va" y "Hum"
        pesaban lo mismo que "Dibujar", y para saber qué hacía cada uno había
        que pasar el ratón por todos. Ahora cada bloque dice de qué va, así que
        se busca por sitio y no por memoria: lo que edita lo que ya hay, lo que
        inventa notas nuevas y lo que solo cambia la vista no se mezclan.
      */}
      <div className="pr-toolbar">
        <div className="pr-group pr-group-context">
          <span className="pr-group-label">Editando</span>
          <div className="pr-group-row">
            <span className="pr-channel" style={{ borderLeftColor: channel.color }}>
              {channel.name}
            </span>
            <label className="pr-field" title="Patrón que estás editando (cambia también el patrón activo)">
              <span className="pr-pattern-dot" style={{ background: pattern.color }} />
              <select value={pattern.id} onChange={(e) => setActivePattern(e.target.value)}>
                {project.patternOrder.map((pid) => (
                  <option key={pid} value={pid}>
                    {project.patterns[pid]?.name ?? pid}
                  </option>
                ))}
              </select>
              {/* Borrar el patrón que se está editando. Deshabilitado con uno
                  solo: core lanza en vez de dejar el proyecto sin patrones. */}
              <button
                className="tbtn pr-pattern-del"
                disabled={!canRemovePattern()}
                title={
                  canRemovePattern()
                    ? `Borrar "${pattern.name}"${patternClipsHint(pattern.id)} · Ctrl+Shift+Supr, Ctrl+Z lo devuelve`
                    : 'El proyecto siempre tiene un patrón'
                }
                onClick={() => removePattern(pattern.id)}
              >
                ✕
              </button>
            </label>
          </div>
        </div>

        <div className="pr-group">
          <span className="pr-group-label">Herramienta</span>
          <div className="pr-group-row">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tbtn${tool === t.id ? ' active' : ''}`}
                onClick={() => setTool(t.id)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="pr-group">
          <span className="pr-group-label">Rejilla</span>
          <div className="pr-group-row">
            <label className="pr-field" title="A qué se pegan las notas al crearlas y moverlas">
              <select value={snapIdx} onChange={(e) => setSnapIdx(Number(e.target.value))}>
                {SNAPS.map((s, i) => (
                  <option key={s.label} value={i}>{s.label}</option>
                ))}
              </select>
            </label>
            <button
              className="tbtn"
              onClick={quantize}
              title="Cuantizar: pega a la rejilla lo seleccionado, o todo si no hay selección (Ctrl+Q)"
            >
              Cuantizar
            </button>
          </div>
        </div>

        <div className="pr-group">
          <span className="pr-group-label">Armonía</span>
          <div className="pr-group-row">
            <label className="pr-field" title="Escala que se resalta en el teclado y a la que se ajusta el bloqueo">
              <select value={scaleRoot} onChange={(e) => setScaleRoot(Number(e.target.value))}>
                {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((n, i) => (
                  <option key={n} value={i}>{n}</option>
                ))}
              </select>
              <select value={scaleName} onChange={(e) => setScaleName(e.target.value)}>
                {Object.keys(SCALES).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <button
              className={`tbtn${scaleLock ? ' active' : ''}`}
              onClick={() => setScaleLock(!scaleLock)}
              title="Bloqueo a escala: crear y mover notas se ajusta a la escala activa"
            >
              Bloq
            </button>
            <label className="pr-field" title="Acorde que se estampa al crear una nota (y el que aplica el botón)">
              <select value={chordIdx} onChange={(e) => setChordIdx(Number(e.target.value))}>
                {CHORDS.map((c, i) => (
                  <option key={c.label} value={i}>{c.label}</option>
                ))}
              </select>
              {/* El desplegable solo decidía qué se estampa al CREAR una nota.
                  Esto lo aplica a lo que ya está escrito, que es lo que uno
                  quiere cuando ya tiene la melodía puesta. */}
              <button
                className="tbtn"
                disabled={chordIdx === 0}
                onClick={applyChordToSelection}
                title={
                  chordIdx === 0
                    ? 'Elige un acorde para poder aplicarlo'
                    : `Convertir en ${CHORDS[chordIdx]?.label} las notas seleccionadas (o todas si no hay selección) · Alt+C${
                        scaleLock ? ' · ajustado a la escala activa' : ''
                      }`
                }
              >
                Aplicar
              </button>
            </label>
          </div>
        </div>

        <div className="pr-group">
          <span className="pr-group-label">Notas</span>
          <div className="pr-group-row">
            <button className="tbtn" onClick={() => transpose(12)} title="Subir una octava lo seleccionado (Ctrl+Shift+↑)">
              8va ▲
            </button>
            <button className="tbtn" onClick={() => transpose(-12)} title="Bajar una octava lo seleccionado (Ctrl+Shift+↓)">
              8va ▼
            </button>
            <button className="tbtn" onClick={toggleSlide} title="Slide (el glide del 808) en la selección">
              Slide
            </button>
            <button className="tbtn" onClick={doChop} title="Trocear a la rejilla del snap (Alt+U)">
              Trocear
            </button>
            <button className="tbtn" onClick={doStrum} title="Strum: abanicar los inicios del acorde (Alt+S)">
              Strum
            </button>
            <button className="tbtn" onClick={doHumanize} title="Humanizar: mover un pelo el timing y la velocity (Alt+R)">
              Humanizar
            </button>
          </div>
        </div>

        <div className="pr-group">
          <span className="pr-group-label">Generar</span>
          <div className="pr-group-row">
            <button
              className={`tbtn${arpOpen ? ' active' : ''}`}
              onClick={() => (arpOpen ? cancelArp() : openArp())}
              title="Arpegiador: separa las notas del acorde con recorrido, paso, gate y rampas (Alt+A)"
            >
              Arpegiar
            </button>
            <button
              className={`tbtn${riffOpen ? ' active' : ''}`}
              onClick={() => {
                if (arpOpen) cancelArp();
                setRiffOpen(!riffOpen);
              }}
              title="Riff machine: generar un motivo sobre la escala activa (Alt+G)"
            >
              Riff
            </button>
          </div>
        </div>

        <div className="pr-group pr-group-view">
          <span className="pr-group-label">Ver</span>
          <div className="pr-group-row">
            <button
              className={`tbtn${laneMode === 'pan' ? ' active' : ''}`}
              onClick={() => setLaneMode(laneMode === 'velocity' ? 'pan' : 'velocity')}
              title="Qué edita el carril de abajo: velocity o pan por nota"
            >
              {laneMode === 'velocity' ? 'Vel' : 'Pan'}
            </button>
            <button
              className={`tbtn${showGhosts ? ' active' : ''}`}
              onClick={() => setShowGhosts(!showGhosts)}
              title="Ghost notes: notas tenues de los OTROS canales de este patrón (no son del patrón anterior; apágalas si molestan)"
            >
              Ghost
            </button>
          </div>
        </div>
      </div>
      <div className="pr-minimap-wrap">
        <canvas
          ref={miniRef}
          className="pr-minimap"
          title="Minimapa — clic para centrar la vista"
          onPointerDown={onMiniPointer}
          onPointerMove={onMiniPointer}
        />
      </div>
      <div className="pr-main">
        <div className="pr-keyboard" style={{ width: KEYBOARD_W, transform: `translateY(${-scrollY}px)` }}>
          {keyboard}
        </div>
        <div className="pr-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={`pr-canvas tool-${tool}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
        {arpOpen && (
          <ArpDialog
            gridStep={snapStep ?? 0.25}
            targetCount={arpSession.current?.base.length ?? 0}
            onPreview={previewArp}
            onAccept={acceptArp}
            onCancel={cancelArp}
          />
        )}
        {riffOpen && (
          <RiffDialog
            root={scaleRoot}
            scaleName={scaleName}
            beatsPerBar={Math.max(1, project.timeSig.num)}
            patternBars={Math.max(1, Math.round(pattern.length / Math.max(1, project.timeSig.num)))}
            onGenerate={applyRiff}
            onClose={() => setRiffOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
