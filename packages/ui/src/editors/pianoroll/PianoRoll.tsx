/**
 * Piano Roll de Orbit Studio (canvas).
 * Dibujar/mover/redimensionar/seleccionar notas, slide (808), velocity lane,
 * escala resaltada, ghost notes, snap, zoom, quantize y transponer.
 * Cada gesto completo = UN dispatch (undo limpio).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SCALES,
  inScale,
  midiToNote,
  newId,
  type Note,
} from '@orbit/core';
import { engine, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { useThemeVersion } from '../../theme/useThemeVersion';
import './pianoroll.css';

const KEY_H = 14;
const KEYS = 120; // B9..C0 hacia abajo
const VEL_LANE_H = 64;
const KEYBOARD_W = 64;

type SnapValue = number | null;

const SNAPS: { label: string; value: SnapValue }[] = [
  { label: 'Línea', value: 0.25 },
  { label: '1 beat', value: 1 },
  { label: '1/2', value: 0.5 },
  { label: '1/3', value: 1 / 3 },
  { label: '1/4', value: 0.25 },
  { label: '1/6', value: 1 / 6 },
  { label: '1/8', value: 0.125 },
  { label: 'Nada', value: null },
];

interface DragState {
  mode: 'move' | 'resize' | 'marquee' | 'velocity' | 'create';
  startX: number;
  startY: number;
  /** Copia de las notas al empezar el gesto (por id). */
  orig: Map<string, Note>;
  createdId?: string;
  moved: boolean;
  lastPreviewKey?: number;
  marqueeEnd?: { x: number; y: number };
}

export function PianoRoll() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId) ?? project.patternOrder[0] ?? null;
  const channelId =
    useUiStore((s) => s.pianoRollChannelId) ?? project.channelOrder[0] ?? null;
  const playing = useUiStore((s) => s.playing);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Vista
  const [zoomX, setZoomX] = useState(48); // px por beat
  const [scrollX, setScrollX] = useState(0); // beats
  const [scrollY, setScrollY] = useState(52 * KEY_H); // px desde arriba (C6 visible)
  const [snapIdx, setSnapIdx] = useState(0);
  const [scaleRoot, setScaleRoot] = useState(5); // F
  const [scaleName, setScaleName] = useState<string>('Menor natural');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lastDuration, setLastDuration] = useState(1);
  const drag = useRef<DragState | null>(null);
  /** Deltas visuales durante el gesto (sin tocar el store hasta soltar). */
  const ghost = useRef<Map<string, Note> | null>(null);

  const pattern = activePatternId ? project.patterns[activePatternId] : undefined;
  const channel = channelId ? project.channels[channelId] : undefined;
  const notes = useMemo(
    () => (pattern && channelId ? pattern.notes[channelId] ?? [] : []),
    [pattern, channelId, project],
  );
  const channelIndex = channelId ? project.channelOrder.indexOf(channelId) : -1;
  const snap = SNAPS[snapIdx]?.value ?? 0.25;
  const scale = SCALES[scaleName] ?? SCALES['Menor natural']!;

  const doSnap = useCallback(
    (beat: number, floor = true) => {
      if (snap === null) return Math.max(0, beat);
      const q = floor ? Math.floor(beat / snap) : Math.round(beat / snap);
      return Math.max(0, q * snap);
    },
    [snap],
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
          return { note: notes[i]!, edge: endX - x < 7 };
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

    // Ghost notes (otros canales)
    if (pattern && channelId) {
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

    // Notas del canal
    const accent = channel?.color ?? col('--accent');
    const current = ghost.current;
    for (const raw of notes) {
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

    // Marquee
    const d = drag.current;
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

    // ── Velocity lane ──
    ctx.fillStyle = col('--pr-lane-bg');
    ctx.fillRect(0, gridH, w, VEL_LANE_H);
    ctx.fillStyle = col('--pr-row-line');
    ctx.fillRect(0, gridH, w, 1);
    for (const raw of notes) {
      const n = current?.get(raw.id) ?? raw;
      const x = beatToX(n.start);
      if (x < -4 || x > w) continue;
      const vh = n.velocity * (VEL_LANE_H - 10);
      ctx.fillStyle = accent;
      ctx.globalAlpha = selection.size === 0 || selection.has(n.id) ? 0.95 : 0.35;
      ctx.fillRect(x + 1, gridH + (VEL_LANE_H - vh) - 4, 4, vh);
      ctx.globalAlpha = 1;
    }

    // Playhead (modo patrón)
    const ui = useUiStore.getState();
    if (ui.playing && ui.playMode === 'pattern') {
      const x = beatToX(ui.positionBeats % Math.max(1, patLen));
      ctx.fillStyle = col('--pr-playhead');
      ctx.fillRect(x, 0, 1.5, h);
    }
  }, [notes, pattern, channel, channelId, selection, scrollX, scrollY, zoomX, scaleRoot, scale, project.timeSig.num, beatToX, keyToY, themeVersion]);

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
        before.velocity !== after.velocity
      ) {
        patches.push({
          id,
          start: after.start,
          key: after.key,
          duration: after.duration,
          velocity: after.velocity,
        });
      }
    }
    ghost.current = null;
    if (patches.length > 0) {
      store.dispatch(
        { type: 'patchNotes', patternId: activePatternId, channelId, patches },
        { label: d.mode === 'resize' ? 'Redimensionar notas' : d.mode === 'velocity' ? 'Velocity' : 'Mover notas' },
      );
    } else {
      draw();
    }
  }, [activePatternId, channelId, draw]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || !activePatternId || !channelId || channelIndex < 0) return;
      canvas.setPointerCapture(e.pointerId);
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

      // Botón derecho: borrar
      if (e.button === 2) {
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
        engine.previewNote(channelIndex, hit.note.key, true);
        drag.current.lastPreviewKey = hit.note.key;
        return;
      }

      if (e.ctrlKey) {
        // Marquee
        drag.current = { mode: 'marquee', startX: x, startY: y, orig: new Map(), moved: false, marqueeEnd: { x, y } };
        return;
      }

      // Crear nota
      const start = doSnap(xToBeat(x));
      const key = yToKey(y);
      const id = newId();
      const note: Note = {
        id, start, duration: lastDuration, key, velocity: 0.8, pan: 0, slide: false,
      };
      store.dispatch(
        { type: 'addNotes', patternId: activePatternId, channelId, notes: [note] },
        { label: `Nota ${midiToNote(key)}` },
      );
      setSelection(new Set([id]));
      const orig = new Map([[id, { ...note }]]);
      ghost.current = new Map([[id, { ...note }]]);
      drag.current = { mode: 'move', startX: x, startY: y, orig, createdId: id, moved: false, lastPreviewKey: key };
      engine.previewNote(channelIndex, key, true);
    },
    [activePatternId, channelId, channelIndex, notes, selection, noteAt, doSnap, xToBeat, yToKey, lastDuration],
  );

  const applyVelocityAt = useCallback(
    (x: number, y: number, canvasH: number) => {
      const g = ghost.current;
      if (!g) return;
      const beat = xToBeat(x);
      const vel = Math.min(1, Math.max(0.05, (canvasH - y - 4) / (VEL_LANE_H - 10)));
      // Ajusta la nota más cercana en X (o todas las seleccionadas si hay selección)
      const targets = selection.size > 0
        ? [...g.values()].filter((n) => selection.has(n.id))
        : [...g.values()].sort((a, b) => Math.abs(a.start - beat) - Math.abs(b.start - beat)).slice(0, 1);
      for (const t of targets) g.set(t.id, { ...t, velocity: vel });
      draw();
    },
    [selection, xToBeat, draw],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      const canvas = canvasRef.current;
      if (!d || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      d.moved = true;

      if (d.mode === 'velocity') {
        applyVelocityAt(x, y, rect.height);
        return;
      }
      if (d.mode === 'marquee') {
        d.marqueeEnd = { x, y };
        draw();
        return;
      }
      const g = ghost.current;
      if (!g) return;
      if (d.mode === 'move') {
        const dBeat = (x - d.startX) / zoomX;
        const dKey = yToKey(y) - yToKey(d.startY);
        let previewKey: number | undefined;
        for (const [id, orig] of d.orig) {
          const start = doSnap(orig.start + dBeat, snap === null);
          const key = Math.min(KEYS - 1, Math.max(0, orig.key + dKey));
          g.set(id, { ...orig, start, key });
          previewKey = key;
        }
        if (previewKey !== undefined && previewKey !== d.lastPreviewKey && channelIndex >= 0) {
          if (d.lastPreviewKey !== undefined) engine.previewNote(channelIndex, d.lastPreviewKey, false);
          engine.previewNote(channelIndex, previewKey, true);
          d.lastPreviewKey = previewKey;
        }
      } else if (d.mode === 'resize') {
        for (const [id, orig] of d.orig) {
          const end = doSnap(xToBeat(x), false);
          const duration = Math.max(snap ?? 0.05, end - orig.start);
          g.set(id, { ...orig, duration });
        }
      }
      draw();
    },
    [zoomX, yToKey, doSnap, snap, xToBeat, draw, applyVelocityAt, channelIndex],
  );

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    if (d.lastPreviewKey !== undefined && channelIndex >= 0) {
      engine.previewNote(channelIndex, d.lastPreviewKey, false);
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
  }, [channelIndex, notes, xToBeat, yToKey, draw, commitGesture]);

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

  // Teclado: Supr borra selección; Ctrl+B duplica
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activePatternId || !channelId) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      if (e.code === 'Delete' && selection.size > 0) {
        store.dispatch(
          { type: 'removeNotes', patternId: activePatternId, channelId, noteIds: [...selection] },
          { label: `Borrar ${selection.size} nota(s)` },
        );
        setSelection(new Set());
      }
      if (e.ctrlKey && e.code === 'KeyB' && selection.size > 0) {
        e.preventDefault();
        const sel = notes.filter((n) => selection.has(n.id));
        const span = Math.max(...sel.map((n) => n.start + n.duration)) - Math.min(...sel.map((n) => n.start));
        const clones = sel.map((n) => ({ ...n, id: newId(), start: n.start + span }));
        store.dispatch(
          { type: 'addNotes', patternId: activePatternId, channelId, notes: clones },
          { label: 'Duplicar selección' },
        );
        setSelection(new Set(clones.map((c) => c.id)));
      }
      if (e.ctrlKey && e.code === 'KeyA') {
        e.preventDefault();
        setSelection(new Set(notes.map((n) => n.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, notes, activePatternId, channelId]);

  // ── Herramientas de la toolbar ────────────────────────────────────────────

  const affectedIds = useCallback(
    () => (selection.size > 0 ? [...selection] : notes.map((n) => n.id)),
    [selection, notes],
  );

  const quantize = useCallback(() => {
    if (!activePatternId || !channelId || snap === null) return;
    const ids = new Set(affectedIds());
    const patches = notes
      .filter((n) => ids.has(n.id))
      .map((n) => ({ id: n.id, start: Math.round(n.start / snap) * snap }));
    store.dispatch(
      { type: 'patchNotes', patternId: activePatternId, channelId, patches },
      { label: 'Cuantizar' },
    );
  }, [activePatternId, channelId, snap, notes, affectedIds]);

  const transpose = useCallback(
    (semis: number) => {
      if (!activePatternId || !channelId) return;
      const ids = new Set(affectedIds());
      const patches = notes
        .filter((n) => ids.has(n.id))
        .map((n) => ({ id: n.id, key: Math.min(KEYS - 1, Math.max(0, n.key + semis)) }));
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

  // ── Teclado lateral ───────────────────────────────────────────────────────

  const keyboard = useMemo(() => {
    const keys = [];
    for (let k = KEYS - 1; k >= 0; k--) {
      const semitone = ((k % 12) + 12) % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(semitone);
      keys.push(
        <div
          key={k}
          className={`pr-key${isBlack ? ' black' : ''}`}
          style={{ height: KEY_H }}
          onPointerDown={() => {
            if (channelIndex >= 0) engine.previewNote(channelIndex, k, true);
          }}
          onPointerUp={() => {
            if (channelIndex >= 0) engine.previewNote(channelIndex, k, false);
          }}
          onPointerLeave={() => {
            if (channelIndex >= 0) engine.previewNote(channelIndex, k, false);
          }}
        >
          {semitone === 0 && <span className="pr-key-label">{midiToNote(k)}</span>}
        </div>,
      );
    }
    return keys;
  }, [channelIndex]);

  if (!pattern || !channel) {
    return (
      <div className="panel-placeholder">
        Elige un canal en el Channel Rack para abrir su Piano Roll.
      </div>
    );
  }

  return (
    <div className="pianoroll">
      <div className="pr-toolbar">
        <span className="pr-channel" style={{ borderLeftColor: channel.color }}>
          {channel.name} — {pattern.name}
        </span>
        <label className="pr-field">
          Snap
          <select value={snapIdx} onChange={(e) => setSnapIdx(Number(e.target.value))}>
            {SNAPS.map((s, i) => (
              <option key={s.label} value={i}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="pr-field">
          Escala
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
        <div className="pr-tools">
          <button className="tbtn" onClick={quantize} title="Cuantizar (selección o todo)">Q</button>
          <button className="tbtn" onClick={() => transpose(12)} title="Subir octava">+8va</button>
          <button className="tbtn" onClick={() => transpose(-12)} title="Bajar octava">-8va</button>
          <button className="tbtn" onClick={toggleSlide} title="Slide (glide 808) en la selección">
            Slide
          </button>
        </div>
      </div>
      <div className="pr-main">
        <div className="pr-keyboard" style={{ width: KEYBOARD_W, transform: `translateY(${-scrollY}px)` }}>
          {keyboard}
        </div>
        <div className="pr-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className="pr-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </div>
    </div>
  );
}
