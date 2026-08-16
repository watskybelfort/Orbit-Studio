/**
 * Playlist — arreglo de canción estilo FL Studio (canvas).
 *
 * Columna izquierda: cabeceras de pista del arrangement activo (LED de mute,
 * nombre editable con doble clic). Regla superior: números de compás; clic o
 * arrastre en la mitad inferior hace seek del transporte y arrastre en la
 * mitad superior define la región de loop (clic suelto la quita). Rejilla:
 * clic izquierdo pinta clips del patrón activo (arrastrando coloca varios
 * seguidos), arrastrar un clip lo mueve (pista y start), su borde derecho lo
 * redimensiona, Ctrl+arrastre lo duplica y el clic derecho lo borra.
 * Snap a beat por defecto (selector en la toolbar; Alt = sin snap).
 * Ctrl+rueda hace zoom horizontal; rueda = scroll vertical; Shift+rueda =
 * scroll horizontal. Playhead vertical en reproducción (modo SONG).
 *
 * Toda mutación pasa por store.dispatch (bus de comandos de @orbit/core);
 * las ráfagas de arrastre se funden en un solo undo con mergeKey
 * ('pl:move:<clipId>' / 'pl:resize:<clipId>'), como las perillas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPlaylistTrack,
  newId,
  type Clip,
  type Id,
  type PlaylistTrack,
  type Project,
} from '@orbit/core';
import { engine, ensureAudioReady, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { useThemeVersion } from '../../theme/useThemeVersion';
import './playlist.css';

/** Altura de la regla en px; debe coincidir con .pl-corner del CSS. */
const RULER_H = 26;
/** Zona sensible del borde derecho de un clip (resize), en px. */
const RESIZE_EDGE = 7;
const MIN_ZOOM = 6;
const MAX_ZOOM = 120;

/** 'bar' se resuelve al compás actual (timeSig.num beats). */
type SnapValue = number | 'bar' | null;

const SNAPS: { label: string; value: SnapValue }[] = [
  { label: 'Beat', value: 1 },
  { label: 'Compás', value: 'bar' },
  { label: '1/2', value: 0.5 },
  { label: '1/4', value: 0.25 },
  { label: 'Nada', value: null },
];

/** Cuantiza un beat a la rejilla (floor al pintar, round al mover/seek). */
function quant(beat: number, snap: number | null, round: boolean): number {
  if (snap === null) return Math.max(0, beat);
  const q = round ? Math.round(beat / snap) : Math.floor(beat / snap);
  return Math.max(0, q * snap);
}

/** Nombre visible de un clip: patrón, sample o parámetro automatizado. */
function clipLabel(clip: Clip, project: Project): string {
  if (clip.kind === 'pattern') {
    return (clip.patternId && project.patterns[clip.patternId]?.name) || 'Patrón';
  }
  if (clip.kind === 'audio') {
    return (clip.sampleId && project.samples[clip.sampleId]?.name) || 'Audio';
  }
  return clip.target ? `Auto · ${clip.target.param}` : 'Automatización';
}

interface RowLayout {
  track: PlaylistTrack;
  /** Offset vertical acumulado (px) dentro de la rejilla, sin scroll. */
  top: number;
}

type DragState =
  | { mode: 'paint'; trackId: Id; length: number; patternId: Id }
  | { mode: 'move'; clipId: Id; grabOffset: number }
  | { mode: 'resize'; clipId: Id }
  | { mode: 'seek' }
  | { mode: 'loop'; anchor: number; moved: boolean };

export function Playlist() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const playing = useUiStore((s) => s.playing);
  const playMode = useUiStore((s) => s.playMode);
  // Posición para el caret parado (durante reproducción redibuja el RAF).
  const idlePos = useUiStore((s) => (s.playing ? -1 : s.positionBeats));

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  /** Clips pendientes del gesto de pintado (un solo addClips al soltar). */
  const paintGhost = useRef<Clip[] | null>(null);

  // Vista
  const [zoom, setZoom] = useState(24); // px por beat
  const [scrollX, setScrollX] = useState(0); // beats
  const [scrollY, setScrollY] = useState(0); // px
  const [snapIdx, setSnapIdx] = useState(0);
  /** Región de loop del transporte (estado de motor, no de proyecto). */
  const [loopRegion, setLoopRegion] = useState<{ start: number; end: number } | null>(null);

  const barLen = Math.max(1, project.timeSig.num);
  const rawSnap = SNAPS[snapIdx]?.value ?? 1;
  const snapBeats = rawSnap === 'bar' ? barLen : rawSnap;
  /** Snap efectivo del evento (Alt lo desactiva). */
  const snapOf = useCallback(
    (e: { altKey: boolean }): number | null => (e.altKey ? null : snapBeats),
    [snapBeats],
  );

  // Patrón activo (fallback al primero): es lo que pinta el clic izquierdo.
  const patternId =
    activePatternId && project.patterns[activePatternId]
      ? activePatternId
      : project.patternOrder[0];
  const activePattern = patternId !== undefined ? project.patterns[patternId] : undefined;

  // ── Pistas y clips del arrangement activo ─────────────────────────────────

  const tracks = useMemo(
    () =>
      Object.values(project.playlistTracks)
        .filter((t) => t.arrangementId === project.activeArrangementId)
        .sort((a, b) => a.order - b.order),
    [project],
  );

  const rows = useMemo<RowLayout[]>(() => {
    let top = 0;
    return tracks.map((track) => {
      const row = { track, top };
      top += track.height;
      return row;
    });
  }, [tracks]);

  const totalH = useMemo(() => {
    const last = rows[rows.length - 1];
    return last ? last.top + last.track.height : 0;
  }, [rows]);

  const clipsByTrack = useMemo(() => {
    const m = new Map<Id, Clip[]>();
    for (const t of tracks) m.set(t.id, []);
    for (const c of Object.values(project.clips)) m.get(c.playlistTrackId)?.push(c);
    for (const list of m.values()) list.sort((a, b) => a.start - b.start);
    return m;
  }, [project, tracks]);

  // ── Coordenadas ───────────────────────────────────────────────────────────

  const beatToX = useCallback((b: number) => (b - scrollX) * zoom, [scrollX, zoom]);
  const xToBeat = useCallback((x: number) => x / zoom + scrollX, [scrollX, zoom]);

  const rowAtY = useCallback(
    (y: number): RowLayout | null => {
      const gy = y - RULER_H + scrollY;
      for (const r of rows) {
        if (gy >= r.top && gy < r.top + r.track.height) return r;
      }
      return null;
    },
    [rows, scrollY],
  );

  const clipAt = useCallback(
    (x: number, y: number): { clip: Clip; row: RowLayout; edge: boolean } | null => {
      const row = rowAtY(y);
      if (!row) return null;
      const beat = xToBeat(x);
      const list = clipsByTrack.get(row.track.id) ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i]!;
        if (beat >= c.start && beat < c.start + c.length) {
          const endX = beatToX(c.start + c.length);
          return { clip: c, row, edge: endX - x < RESIZE_EDGE && c.length * zoom > 16 };
        }
      }
      return null;
    },
    [rowAtY, xToBeat, beatToX, clipsByTrack, zoom],
  );

  /** ¿Está libre [start, start+length) en la pista? (para el pintado en serie) */
  const freeAt = useCallback(
    (trackId: Id, start: number, length: number): boolean => {
      const list = clipsByTrack.get(trackId) ?? [];
      return !list.some((c) => c.start < start + length && c.start + c.length > start);
    },
    [clipsByTrack],
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
    const font = css.fontFamily;
    const accent = col('--accent');

    ctx.clearRect(0, 0, w, h);

    // Preview de notas por patrón (se calcula una vez por dibujado).
    const patCache = new Map<Id, { notes: { start: number; duration: number; key: number }[]; min: number; span: number }>();
    const patternPreview = (pid: Id) => {
      let entry = patCache.get(pid);
      if (!entry) {
        const pat = project.patterns[pid];
        const flat: { start: number; duration: number; key: number }[] = [];
        let min = Infinity;
        let max = -Infinity;
        if (pat) {
          for (const list of Object.values(pat.notes)) {
            for (const n of list) {
              flat.push(n);
              if (n.key < min) min = n.key;
              if (n.key > max) max = n.key;
            }
          }
        }
        entry = { notes: flat, min, span: Math.max(1, max - min) };
        patCache.set(pid, entry);
      }
      return entry;
    };

    /** Pinta un clip (cuerpo, franja de nombre y contenido según su kind). */
    const drawClip = (c: Clip, rowY: number, rowH: number, ghost = false) => {
      const x = beatToX(c.start);
      const cw = Math.max(2, c.length * zoom - 1);
      if (x + cw < 0 || x > w) return;
      const color =
        c.color ??
        (c.kind === 'pattern' && c.patternId
          ? project.patterns[c.patternId]?.color ?? accent
          : accent);
      const base = c.muted ? 0.45 : 1;
      const stripH = Math.min(13, rowH - 6);

      ctx.beginPath();
      ctx.roundRect(x + 0.5, rowY + 1.5, cw, rowH - 4, 3);
      ctx.fillStyle = color;
      ctx.globalAlpha = base * (c.kind === 'automation' ? 0.14 : 0.24);
      ctx.fill();
      ctx.globalAlpha = base * (ghost ? 0.55 : 0.9);
      ctx.strokeStyle = ghost ? col('--pl-ghost') : color;
      if (ghost) ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      // Todo el contenido queda recortado al rectángulo del clip.
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x + 0.5, rowY + 1.5, cw, rowH - 4, 3);
      ctx.clip();

      // Franja superior con el nombre.
      ctx.globalAlpha = base * 0.85;
      ctx.fillStyle = color;
      ctx.fillRect(x + 0.5, rowY + 1.5, cw, stripH);
      if (cw > 26) {
        ctx.globalAlpha = base;
        ctx.fillStyle = col('--pl-clip-text');
        ctx.font = `9px ${font}`;
        ctx.fillText(clipLabel(c, project), x + 4, rowY + stripH - 2);
      }

      const top = rowY + 1.5 + stripH + 2;
      const ah = rowH - 4 - stripH - 5;
      if (c.kind === 'pattern' && c.patternId && ah > 4) {
        // Mini-preview de las notas; el patrón se repite a lo ancho del clip.
        const pat = project.patterns[c.patternId];
        if (pat) {
          const pv = patternPreview(c.patternId);
          const patLen = Math.max(0.25, pat.length);
          ctx.globalAlpha = base * 0.75;
          ctx.fillStyle = color;
          let tiles = 0;
          for (let tile = -(c.patternOffset ?? 0); tile < c.length && tiles < 64; tile += patLen, tiles++) {
            for (const n of pv.notes) {
              const s = tile + n.start;
              if (s + n.duration <= 0 || s >= c.length) continue;
              const nx = x + Math.max(0, s) * zoom;
              const nw = Math.max(1.5, (Math.min(c.length, s + n.duration) - Math.max(0, s)) * zoom - 0.5);
              const ny = top + (1 - (n.key - pv.min) / pv.span) * (ah - 2);
              ctx.fillRect(nx, ny, nw, 2);
            }
          }
        }
      } else if (c.kind === 'automation' && ah > 4) {
        // Curva simplificada (tension ignorada) con relleno hasta la base.
        const pts = (c.points ?? []).slice().sort((a, b) => a.time - b.time);
        if (pts.length > 0) {
          const px = (t: number) => x + Math.min(c.length, Math.max(0, t)) * zoom;
          const py = (v: number) => top + (1 - Math.min(1, Math.max(0, v))) * ah;
          ctx.beginPath();
          ctx.moveTo(x, py(pts[0]!.value));
          for (const p of pts) ctx.lineTo(px(p.time), py(p.value));
          ctx.lineTo(x + cw, py(pts[pts.length - 1]!.value));
          ctx.strokeStyle = color;
          ctx.globalAlpha = base * 0.9;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.lineTo(x + cw, top + ah);
          ctx.lineTo(x, top + ah);
          ctx.closePath();
          ctx.globalAlpha = base * 0.2;
          ctx.fillStyle = color;
          ctx.fill();
        }
      } else if (c.kind === 'audio' && ah > 4) {
        // Línea central a modo de forma de onda estilizada.
        ctx.globalAlpha = base * 0.7;
        ctx.fillStyle = color;
        ctx.fillRect(x + 2, top + ah / 2, cw - 4, 1.5);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    // ── Filas ──
    for (const r of rows) {
      const y = RULER_H + r.top - scrollY;
      const rh = r.track.height;
      if (y + rh < RULER_H || y > h) continue;
      ctx.fillStyle = col('--pl-row');
      ctx.fillRect(0, Math.max(RULER_H, y), w, Math.min(rh, y + rh - RULER_H));
      ctx.fillStyle = col('--pl-row-line');
      ctx.fillRect(0, y + rh - 1, w, 1);
    }

    // La rejilla (líneas, clips, loop) no invade la regla.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, w, h - RULER_H);
    ctx.clip();

    // Compases alternos + líneas verticales.
    const firstBar = Math.floor(scrollX / barLen);
    const lastBeat = scrollX + w / zoom;
    for (let bar = firstBar; bar * barLen <= lastBeat; bar++) {
      if (bar % 2 === 1) {
        ctx.fillStyle = col('--pl-bar-alt');
        ctx.fillRect(beatToX(bar * barLen), RULER_H, barLen * zoom, h - RULER_H);
      }
    }
    for (let b = Math.floor(scrollX); b <= lastBeat; b++) {
      const isBar = b % barLen === 0;
      if (!isBar && zoom < 12) continue; // beats solo con zoom suficiente
      ctx.fillStyle = isBar ? col('--pl-grid-bar') : col('--pl-grid-beat');
      ctx.fillRect(beatToX(b), RULER_H, 1, h - RULER_H);
    }

    // Región de loop: banda tenue + límites.
    if (loopRegion) {
      const x0 = beatToX(loopRegion.start);
      const x1 = beatToX(loopRegion.end);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.06;
      ctx.fillRect(x0, RULER_H, x1 - x0, h - RULER_H);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x0, RULER_H, 1, h - RULER_H);
      ctx.fillRect(x1, RULER_H, 1, h - RULER_H);
      ctx.globalAlpha = 1;
    }

    // Clips por pista + ghosts del gesto de pintado.
    for (const r of rows) {
      const y = RULER_H + r.top - scrollY;
      if (y + r.track.height < RULER_H || y > h) continue;
      for (const c of clipsByTrack.get(r.track.id) ?? []) drawClip(c, y, r.track.height);
    }
    if (paintGhost.current) {
      for (const c of paintGhost.current) {
        const r = rows.find((row) => row.track.id === c.playlistTrackId);
        if (r) drawClip(c, RULER_H + r.top - scrollY, r.track.height, true);
      }
    }
    ctx.restore();

    // ── Regla ──
    ctx.fillStyle = col('--pl-ruler-bg');
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = col('--pl-row-line');
    ctx.fillRect(0, RULER_H - 1, w, 1);
    if (loopRegion) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(beatToX(loopRegion.start), 0, (loopRegion.end - loopRegion.start) * zoom, 13);
      ctx.globalAlpha = 1;
    }
    // Números de compás (espaciados según zoom) y ticks.
    ctx.font = `9px ${font}`;
    const every = Math.max(1, Math.ceil(34 / (barLen * zoom)));
    for (let bar = firstBar; bar * barLen <= lastBeat; bar++) {
      const x = beatToX(bar * barLen);
      ctx.fillStyle = col('--pl-grid-bar');
      ctx.fillRect(x, RULER_H - 7, 1, 7);
      if (bar % every === 0) {
        ctx.fillStyle = col('--pl-ruler-text');
        ctx.fillText(String(bar + 1), x + 3, RULER_H - 9);
      }
    }

    // Caret de posición (siempre en SONG) + playhead en reproducción.
    const ui = useUiStore.getState();
    if (ui.playMode === 'song') {
      const px = beatToX(ui.positionBeats);
      ctx.fillStyle = col('--pl-playhead');
      ctx.beginPath();
      ctx.moveTo(px - 4, RULER_H - 8);
      ctx.lineTo(px + 4, RULER_H - 8);
      ctx.lineTo(px, RULER_H - 1);
      ctx.closePath();
      ctx.fill();
      if (ui.playing) ctx.fillRect(px, RULER_H, 1.5, h - RULER_H);
    }
  }, [rows, clipsByTrack, project, zoom, scrollX, scrollY, loopRegion, barLen, beatToX, idlePos, themeVersion]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Redibuja el playhead mientras suena la canción.
  useEffect(() => {
    if (!playing || playMode !== 'song') return;
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, playMode, draw]);

  // Redibuja al cambiar el tamaño del contenedor (ventana interna o app).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  // ── Transporte: seek y loop desde la regla ────────────────────────────────

  const doSeek = useCallback((beat: number) => {
    engine.seek(beat);
    // Reflejo inmediato del caret sin esperar al frame de medidores.
    useUiStore.setState({ positionBeats: beat });
  }, []);

  const clearLoop = useCallback(() => {
    setLoopRegion(null);
    engine.setLoop(0, 0, false);
  }, []);

  // ── Interacción en el canvas ──────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      ensureAudioReady();

      // Regla: loop (mitad superior) o seek (mitad inferior).
      if (y < RULER_H) {
        if (e.button === 2) {
          clearLoop();
          return;
        }
        if (e.button !== 0) return;
        const beat = quant(xToBeat(x), snapOf(e), true);
        if (y < RULER_H / 2) {
          drag.current = { mode: 'loop', anchor: beat, moved: false };
        } else {
          drag.current = { mode: 'seek' };
          doSeek(beat);
        }
        return;
      }

      const hit = clipAt(x, y);

      // Clic derecho: borrar el clip bajo el cursor.
      if (e.button === 2) {
        if (hit) {
          store.dispatch(
            { type: 'removeClips', clipIds: [hit.clip.id] },
            { label: `Borrar clip "${clipLabel(hit.clip, project)}"` },
          );
        }
        return;
      }
      if (e.button !== 0) return;

      if (hit) {
        if (hit.edge) {
          drag.current = { mode: 'resize', clipId: hit.clip.id };
        } else if (e.ctrlKey || e.metaKey) {
          // Ctrl+arrastre: duplica y el gesto mueve la copia.
          const copy: Clip = {
            ...hit.clip,
            id: newId(),
            points: hit.clip.points?.map((p) => ({ ...p })),
          };
          store.dispatch(
            { type: 'addClips', clips: [copy] },
            { label: `Duplicar clip "${clipLabel(hit.clip, project)}"` },
          );
          drag.current = { mode: 'move', clipId: copy.id, grabOffset: xToBeat(x) - copy.start };
        } else {
          drag.current = {
            mode: 'move',
            clipId: hit.clip.id,
            grabOffset: xToBeat(x) - hit.clip.start,
          };
        }
        return;
      }

      // Zona vacía: pintar el patrón activo (commit único al soltar).
      const row = rowAtY(y);
      if (!row || !activePattern || patternId === undefined) return;
      const length = Math.max(0.25, activePattern.length);
      const first: Clip = {
        id: newId(),
        kind: 'pattern',
        playlistTrackId: row.track.id,
        start: quant(xToBeat(x), snapOf(e), false),
        length,
        muted: false,
        patternId,
        patternOffset: 0,
      };
      paintGhost.current = [first];
      drag.current = { mode: 'paint', trackId: row.track.id, length, patternId };
      draw();
    },
    [clipAt, rowAtY, xToBeat, snapOf, doSeek, clearLoop, activePattern, patternId, project, draw],
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
        // Cursor contextual: regla, mover, redimensionar o pintar.
        const hit = y >= RULER_H ? clipAt(x, y) : null;
        canvas.style.cursor =
          y < RULER_H ? 'pointer' : hit ? (hit.edge ? 'ew-resize' : 'move') : 'crosshair';
        return;
      }

      switch (d.mode) {
        case 'seek': {
          doSeek(quant(xToBeat(x), snapOf(e), true));
          break;
        }
        case 'loop': {
          d.moved = true;
          const beat = quant(xToBeat(x), snapOf(e), true);
          const start = Math.min(d.anchor, beat);
          const end = Math.max(start + (snapOf(e) ?? 0.25), Math.max(d.anchor, beat));
          setLoopRegion({ start, end });
          engine.setLoop(start, end, true);
          break;
        }
        case 'move': {
          const clip = project.clips[d.clipId];
          if (!clip) return;
          const start = quant(xToBeat(x) - d.grabOffset, snapOf(e), true);
          const row = rowAtY(y);
          const trackId = row?.track.id ?? clip.playlistTrackId;
          if (start !== clip.start || trackId !== clip.playlistTrackId) {
            store.dispatch(
              { type: 'patchClips', patches: [{ id: clip.id, start, playlistTrackId: trackId }] },
              { label: 'Mover clip', mergeKey: `pl:move:${clip.id}` },
            );
          }
          break;
        }
        case 'resize': {
          const clip = project.clips[d.clipId];
          if (!clip) return;
          const end = quant(xToBeat(x), snapOf(e), true);
          const length = Math.max(snapOf(e) ?? 0.25, end - clip.start);
          if (length !== clip.length) {
            store.dispatch(
              { type: 'patchClips', patches: [{ id: clip.id, length }] },
              { label: 'Redimensionar clip', mergeKey: `pl:resize:${clip.id}` },
            );
          }
          break;
        }
        case 'paint': {
          // Pintado en serie: clips contiguos hacia donde avance el puntero,
          // saltando los huecos ya ocupados por otros clips.
          const g = paintGhost.current;
          if (!g || g.length === 0) return;
          const beat = xToBeat(x);
          let minStart = Infinity;
          let maxEnd = -Infinity;
          for (const c of g) {
            if (c.start < minStart) minStart = c.start;
            if (c.start + c.length > maxEnd) maxEnd = c.start + c.length;
          }
          let changed = false;
          for (let i = 0; i < 128 && beat > maxEnd; i++) {
            if (freeAt(d.trackId, maxEnd, d.length)) {
              g.push({
                id: newId(),
                kind: 'pattern',
                playlistTrackId: d.trackId,
                start: maxEnd,
                length: d.length,
                muted: false,
                patternId: d.patternId,
                patternOffset: 0,
              });
              changed = true;
            }
            maxEnd += d.length;
          }
          for (let i = 0; i < 128 && beat < minStart && minStart - d.length >= 0; i++) {
            minStart -= d.length;
            if (freeAt(d.trackId, minStart, d.length)) {
              g.push({
                id: newId(),
                kind: 'pattern',
                playlistTrackId: d.trackId,
                start: minStart,
                length: d.length,
                muted: false,
                patternId: d.patternId,
                patternOffset: 0,
              });
              changed = true;
            }
          }
          if (changed) draw();
          break;
        }
      }
    },
    [clipAt, rowAtY, xToBeat, snapOf, doSeek, freeAt, project, draw],
  );

  // Doble clic en un clip de automatización → abrirlo en su editor.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (y < RULER_H) return;
      const hit = clipAt(x, y);
      if (hit?.clip.kind === 'automation') {
        useUiStore.setState({ automationClipId: hit.clip.id });
        useUiStore.getState().openWindow('automation');
      }
    },
    [clipAt],
  );

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'paint') {
      const g = paintGhost.current;
      paintGhost.current = null;
      if (g && g.length > 0) {
        const name = project.patterns[d.patternId]?.name ?? 'patrón';
        store.dispatch(
          { type: 'addClips', clips: g },
          { label: `Colocar ${g.length} clip(s) de "${name}"` },
        );
      } else {
        draw();
      }
    } else if (d.mode === 'loop' && !d.moved) {
      // Clic suelto en la mitad superior de la regla: quita el loop.
      clearLoop();
    }
  }, [project, clearLoop, draw]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey) {
        // Zoom horizontal anclado al beat bajo el cursor.
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
        const x = rect ? e.clientX - rect.left : 0;
        const beatAt = xToBeat(x);
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (e.deltaY < 0 ? 1.15 : 0.87)));
        setZoom(next);
        setScrollX(Math.max(0, beatAt - x / next));
      } else if (e.shiftKey) {
        setScrollX(Math.max(0, scrollX + (e.deltaY > 0 ? 2 : -2)));
      } else {
        const viewH = (wrapRef.current?.clientHeight ?? 0) - RULER_H;
        setScrollY(Math.min(Math.max(0, totalH - viewH), Math.max(0, scrollY + e.deltaY)));
      }
    },
    [zoom, scrollX, scrollY, totalH, xToBeat],
  );

  // ── Toolbar ───────────────────────────────────────────────────────────────

  const changeArrangement = (arrangementId: string) => {
    const name = project.arrangements[arrangementId]?.name ?? arrangementId;
    store.dispatch(
      { type: 'setActiveArrangement', arrangementId },
      { label: `Cambiar a arrangement "${name}"` },
    );
  };

  const addTrack = () => {
    const track = createPlaylistTrack(project.activeArrangementId, tracks.length);
    store.dispatch(
      { type: 'addPlaylistTrack', track },
      { label: `Añadir pista "${track.name}"` },
    );
  };

  return (
    <div className="playlist">
      <div className="pl-toolbar">
        <label className="pl-field">
          Arrangement
          <select
            value={project.activeArrangementId}
            onChange={(e) => changeArrangement(e.target.value)}
          >
            {project.arrangementOrder.map((id) => (
              <option key={id} value={id}>
                {project.arrangements[id]?.name ?? id}
              </option>
            ))}
          </select>
        </label>
        <label className="pl-field">
          Snap
          <select value={snapIdx} onChange={(e) => setSnapIdx(Number(e.target.value))}>
            {SNAPS.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {activePattern && (
          <span className="pl-chip" title="Patrón que pinta el clic izquierdo">
            <span className="pl-dot" style={{ background: activePattern.color }} />
            {activePattern.name}
          </span>
        )}
        <button className="pl-add" onClick={addTrack} title="Añadir pista al arrangement">
          + Pista
        </button>
      </div>

      <div className="pl-main">
        <div className="pl-headers">
          <div className="pl-corner">Pistas</div>
          <div className="pl-headers-scroll">
            <div className="pl-headers-inner" style={{ transform: `translateY(${-scrollY}px)` }}>
              {rows.map((r) => (
                <TrackHeader key={r.track.id} track={r.track} />
              ))}
            </div>
          </div>
        </div>
        <div className="pl-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className="pl-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
          />
          {rows.length === 0 && (
            <div className="pl-empty">Sin pistas — añade una con “+ Pista”.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Cabecera de pista ────────────────────────────────────────────────────────

interface TrackHeaderProps {
  track: PlaylistTrack;
}

function TrackHeader({ track }: TrackHeaderProps) {
  const [editing, setEditing] = useState(false);
  const cancelName = useRef(false);

  const toggleMute = () => {
    store.dispatch(
      { type: 'patchPlaylistTrack', trackId: track.id, patch: { muted: !track.muted } },
      { label: track.muted ? `Activar pista "${track.name}"` : `Silenciar pista "${track.name}"` },
    );
  };

  const commitName = (raw: string) => {
    setEditing(false);
    if (cancelName.current) {
      cancelName.current = false;
      return;
    }
    const name = raw.trim();
    if (!name || name === track.name) return;
    store.dispatch(
      { type: 'patchPlaylistTrack', trackId: track.id, patch: { name } },
      { label: `Renombrar pista a "${name}"` },
    );
  };

  return (
    <div
      className={`pl-track${track.muted ? ' muted' : ''}`}
      style={{ height: track.height, borderLeftColor: track.color }}
    >
      <button
        className={`pl-led${track.muted ? '' : ' on'}`}
        title="Silenciar pista"
        onClick={toggleMute}
      />
      {editing ? (
        <input
          className="pl-name-input"
          defaultValue={track.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              cancelName.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className="pl-track-name"
          title="Doble clic para renombrar"
          onDoubleClick={() => setEditing(true)}
        >
          {track.name}
        </button>
      )}
    </div>
  );
}
