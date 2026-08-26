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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  TRACK_ICONS,
  clampFades,
  clipsInSpan,
  createPlaylistTrack,
  newId,
  pickColor,
  type Clip,
  type Id,
  type Marker,
  type PlaylistTrack,
  type Project,
} from '@orbit/core';
import { hasSystemFiles, importTriaged, triageDrop } from '../../browser/dropped-audio';
import { addAudioClips, getDragEntries, SOUND_MIME } from '../../browser/sound-actions';
import { notifyBanner } from '../../state/bounce';
import { IconTrack } from '../../icons';
import { useCollabStore } from '../../collab/collab-state';
import { reportActivity } from '../../collab/presence';
import { engine, ensureAudioReady, store } from '../../state/app';
import {
  bounceTrack,
  bounceableClipsOfTrack,
  freezeTrack,
  frozenClipOfTrack,
  unfreezeTrack,
  useBounceStore,
} from '../../state/bounce';
import { packClips, readClipboard, setClipboard, unpackClips } from '../../state/clipboard';
import { claimEditFocus, registerEditActions } from '../../state/edit-focus';
import { PEAK_COLS, onPeaksReady, requestPeaks } from '../../state/sample-peaks';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { useThemeVersion } from '../../theme/useThemeVersion';
import { capturePointer } from '../../widgets/pointer';
import { MenuPortal } from '../../widgets/MenuPortal';
import { SectionLane } from './SectionLane';
import {
  clampGroupMove,
  clipsInMarquee,
  type MoveAnchor,
  type SelectableClip,
} from './selection';
import './playlist.css';

/** Altura de la regla en px; debe coincidir con .pl-corner del CSS. */
const RULER_H = 26;
/** Ancho de la caja de edición de marcador; debe coincidir con el CSS. */
const MARKER_EDIT_W = 330;
/** Zona sensible del borde derecho de un clip (resize), en px. */
const RESIZE_EDGE = 7;
/** Límites de la altura de pista (px) y valor al que vuelve con doble clic. */
const TRACK_H_MIN = 30;
const TRACK_H_MAX = 220;
const TRACK_H_DEFAULT = 56;
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
  /**
   * Mueve la SELECCIÓN entera. `clipId` es el clip agarrado (el que se pega a
   * la rejilla) y `orig` la foto de dónde estaban todos al empezar: los
   * desplazamientos se calculan contra esa foto, nunca acumulando, que es lo
   * que evita que un arrastre rápido descuadre el grupo.
   */
  | { mode: 'move'; clipId: Id; grabOffset: number; orig: Map<Id, MoveAnchor> }
  | { mode: 'resize'; clipId: Id }
  | { mode: 'seek' }
  | { mode: 'loop'; anchor: number; moved: boolean }
  /** Rectángulo de selección. `add` = suma a lo ya seleccionado (Shift). */
  | { mode: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  /**
   * Ctrl sobre un clip: aún no se sabe qué quiere el usuario. Si suelta sin
   * moverse es "añadir/quitar de la selección"; si arrastra, el duplicado de
   * siempre. Se resuelve en el primer movimiento que pase del umbral.
   */
  | { mode: 'ctrlpick'; clipId: Id; x: number; y: number }
  /** Arrastre de un tirador de fundido (entrada o salida) de un clip de audio. */
  | { mode: 'fade'; clipId: Id; which: 'in' | 'out' };

/** Píxeles que hay que mover para que un Ctrl+clic pase a ser Ctrl+arrastre. */
const CTRL_DRAG_PX = 4;
/** Radio del tirador de fundido en px, y alto de la banda donde se coge. */
const FADE_HANDLE_R = 3.5;
const FADE_GRAB_PX = 9;
/** Banda superior del clip reservada a los tiradores de fundido. */
const FADE_BAND_H = 11;

export function Playlist() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const playing = useUiStore((s) => s.playing);
  const playMode = useUiStore((s) => s.playMode);
  // Posición para el caret parado (durante reproducción redibuja el RAF).
  const idlePos = useUiStore((s) => (s.playing ? -1 : s.positionBeats));
  // Conectados de la sesión (para pintar sus cursores remotos).
  const peers = useCollabStore((s) => s.peers);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  /** Clips pendientes del gesto de pintado (un solo addClips al soltar). */
  const paintGhost = useRef<Clip[] | null>(null);
  /** El ratón está encima de la playlist: los atajos sin modificador van aquí. */
  const hovering = useRef(false);

  /** Clips seleccionados. Vacío = se trabaja sobre el clip bajo el cursor. */
  const [selection, setSelection] = useState<Set<Id>>(new Set());

  // Vista
  const [zoom, setZoom] = useState(24); // px por beat
  const [scrollX, setScrollX] = useState(0); // beats
  const [scrollY, setScrollY] = useState(0); // px
  const [snapIdx, setSnapIdx] = useState(0);
  /**
   * Marcador en edición (caja flotante sobre la regla). NO guarda la x: la
   * posición se deriva del beat del marcador en cada render. Guardarla dejaba
   * la caja clavada donde se abrió mientras la bandera se iba con el scroll o
   * el zoom.
   */
  const [markerEdit, setMarkerEdit] = useState<{ id: Id; name: string } | null>(null);
  /** Región de loop del transporte (estado de motor, no de proyecto). */
  // La región de loop vive en el estado global (el export la ofrece como fuente).
  const loopRegion = useUiStore((s) => s.loopRegion);
  const setLoopRegion = useCallback(
    (region: { start: number; end: number } | null) => useUiStore.setState({ loopRegion: region }),
    [],
  );

  const barLen = Math.max(1, project.timeSig.num);

  /**
   * Compases visibles teniendo en cuenta los cambios de compás por marcador:
   * la rejilla ya no puede asumir que todos los compases miden lo mismo. Sin
   * marcadores de compás sale exactamente la rejilla de siempre.
   */
  const meterMap = useMemo(() => {
    const map: { beat: number; num: number }[] = [{ beat: 0, num: barLen }];
    for (const m of Object.values(project.markers).sort((a, b) => a.time - b.time)) {
      const num = m.timeSigNum ? Math.round(m.timeSigNum) : 0;
      if (num <= 0) continue;
      if (m.time <= 0) map[0]!.num = num;
      else if (num !== map[map.length - 1]!.num) map.push({ beat: m.time, num });
    }
    return map;
  }, [project, barLen]);

  /** Inicios de compás dentro de [from, to), con su número (1-based). */
  const barsIn = useCallback(
    (from: number, to: number): { beat: number; index: number; num: number }[] => {
      const out: { beat: number; index: number; num: number }[] = [];
      let beat = 0;
      let index = 0;
      let seg = 0;
      // Recorre compás a compás desde el 0: son unos pocos miles como mucho y
      // así el número de compás que se ve es el de verdad.
      while (beat <= to && out.length < 4096) {
        while (seg + 1 < meterMap.length && meterMap[seg + 1]!.beat <= beat + 1e-9) seg++;
        const num = meterMap[seg]!.num;
        if (beat >= from - num) out.push({ beat, index, num });
        beat += num;
        index++;
        if (index > 20000) break;
      }
      return out;
    },
    [meterMap],
  );
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

  /** Índice de fila de cada pista (el arrastre de grupo se mueve por índices). */
  const trackIndexOf = useMemo(() => {
    const m = new Map<Id, number>();
    tracks.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [tracks]);

  // ── Selección ─────────────────────────────────────────────────────────────

  /**
   * Selección viva: la poda contra los clips que existen AHORA. Deshacer un
   * borrado, cambiar de arrangement o recibir cambios de la sala dejan ids
   * muertos dentro, y un "borrar selección" con basura silenciaría el gesto.
   */
  const selectedIds = useMemo(() => {
    const out: Id[] = [];
    for (const t of tracks) {
      for (const c of clipsByTrack.get(t.id) ?? []) if (selection.has(c.id)) out.push(c.id);
    }
    return out;
  }, [selection, tracks, clipsByTrack]);

  const selectAll = useCallback(() => {
    const all = new Set<Id>();
    for (const t of tracks) for (const c of clipsByTrack.get(t.id) ?? []) all.add(c.id);
    setSelection(all);
  }, [tracks, clipsByTrack]);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    store.dispatch(
      { type: 'removeClips', clipIds: selectedIds },
      { label: `Borrar ${selectedIds.length} clip(s)` },
    );
    setSelection(new Set());
  }, [selectedIds]);

  /** Duplica la selección un "ancho de selección" a la derecha (Ctrl+B). */
  const duplicateSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    const clips = selectedIds.map((id) => project.clips[id]!).filter(Boolean);
    if (clips.length === 0) return;
    const from = Math.min(...clips.map((c) => c.start));
    const to = Math.max(...clips.map((c) => c.start + c.length));
    const span = Math.max(0.25, to - from);
    const copies = clips.map((c) => ({
      ...c,
      id: newId(),
      start: c.start + span,
      points: c.points?.map((p) => ({ ...p })),
    }));
    store.dispatch(
      { type: 'addClips', clips: copies },
      { label: `Duplicar ${copies.length} clip(s)` },
    );
    setSelection(new Set(copies.map((c) => c.id)));
  }, [selectedIds, project]);

  // ── Portapapeles ──────────────────────────────────────────────────────────

  /**
   * Fila donde caerá el próximo pegado: la que tiene el ratón encima.
   *
   * Sin ratón dentro (se copió, se movió el caret con el teclado y se pegó) se
   * cae a la fila de la que salió lo copiado, que es lo que uno espera de un
   * "copiar y pegar más adelante" en la misma pista.
   */
  const pasteRow = useRef<number | null>(null);

  const copySelection = useCallback(
    (cut: boolean) => {
      const items = selectedIds
        .map((id) => project.clips[id])
        .filter((c): c is Clip => c !== undefined)
        .map((clip) => ({ clip, row: trackIndexOf.get(clip.playlistTrackId) ?? 0 }));
      const payload = packClips(items);
      if (payload === null) return;
      setClipboard(payload);
      if (!cut) return;
      store.dispatch(
        { type: 'removeClips', clipIds: items.map(({ clip }) => clip.id) },
        { label: `Cortar ${items.length} clip(s)` },
      );
      setSelection(new Set());
    },
    [selectedIds, project, trackIndexOf],
  );

  /** Pega en el caret (beat del transporte) y en la fila de destino. */
  const pasteClipboard = useCallback(() => {
    const payload = readClipboard();
    if (payload === null || payload.kind !== 'clips') return;
    const at = quant(useUiStore.getState().positionBeats, snapBeats, false);
    const row = pasteRow.current ?? payload.homeRow;
    const fresh = unpackClips(
      payload,
      at,
      row,
      tracks.map((t) => t.id),
    );
    if (fresh.length === 0) return;
    store.dispatch({ type: 'addClips', clips: fresh }, { label: `Pegar ${fresh.length} clip(s)` });
    setSelection(new Set(fresh.map((c) => c.id)));
  }, [snapBeats, tracks]);

  /** Mutea o desmutea la selección entera (según el primero). */
  const toggleSelectionMuted = useCallback(() => {
    if (selectedIds.length === 0) return;
    const muted = !project.clips[selectedIds[0]!]?.muted;
    store.dispatch(
      { type: 'patchClips', patches: selectedIds.map((id) => ({ id, muted })) },
      { label: muted ? `Mutear ${selectedIds.length} clip(s)` : `Activar ${selectedIds.length} clip(s)` },
    );
  }, [selectedIds, project]);

  // El menú Editar y los atajos globales preguntan por aquí; se registra un
  // PROVEEDOR para que siempre lean la selección de ahora, no la del montaje.
  const editActionsRef = useRef({
    selectionCount: 0,
    accepts: 'clips' as const,
    noun: 'clips',
    copy: () => {},
    cut: () => {},
    paste: () => {},
    duplicate: () => {},
    selectAll: () => {},
    remove: () => {},
  });
  editActionsRef.current = {
    selectionCount: selectedIds.length,
    accepts: 'clips',
    noun: 'clips',
    copy: () => copySelection(false),
    cut: () => copySelection(true),
    paste: pasteClipboard,
    duplicate: duplicateSelection,
    selectAll,
    remove: deleteSelection,
  };
  useEffect(() => registerEditActions('playlist', () => editActionsRef.current), []);

  // ── Coordenadas ───────────────────────────────────────────────────────────

  const beatToX = useCallback((b: number) => (b - scrollX) * zoom, [scrollX, zoom]);
  const xToBeat = useCallback((x: number) => x / zoom + scrollX, [scrollX, zoom]);

  /** Marcador cuya bandera cae a ±5 px de la x dada (para clic/borrar/renombrar). */
  const markerAt = useCallback(
    (x: number): Marker | null => {
      for (const m of Object.values(project.markers)) {
        if (Math.abs((m.time - scrollX) * zoom - x) <= 5) return m;
      }
      return null;
    },
    [project, scrollX, zoom],
  );

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

  /**
   * Carriles de toma de una pista: se derivan de los clips (no hay ajuste que
   * mantener). Una pista normal tiene 1 y se pinta exactamente como siempre;
   * en cuanto hay tomas apiladas, la fila se divide.
   */
  const laneCount = useCallback(
    (trackId: Id): number => {
      let max = 0;
      for (const c of clipsByTrack.get(trackId) ?? []) max = Math.max(max, c.lane ?? 0);
      return max + 1;
    },
    [clipsByTrack],
  );

  const clipAt = useCallback(
    (x: number, y: number): { clip: Clip; row: RowLayout; edge: boolean } | null => {
      const row = rowAtY(y);
      if (!row) return null;
      const beat = xToBeat(x);
      const list = clipsByTrack.get(row.track.id) ?? [];
      // Con tomas apiladas, el clic elige el carril bajo el cursor; con una
      // sola toma el cálculo da 0 y todo funciona como siempre.
      const lanes = laneCount(row.track.id);
      const laneH = row.track.height / lanes;
      const localY = y - RULER_H + scrollY - row.top;
      const lane = Math.min(lanes - 1, Math.max(0, Math.floor(localY / laneH)));
      const hit = (wanted: number | null) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const c = list[i]!;
          if (wanted !== null && (c.lane ?? 0) !== wanted) continue;
          if (beat >= c.start && beat < c.start + c.length) {
            const endX = beatToX(c.start + c.length);
            return { clip: c, row, edge: endX - x < RESIZE_EDGE && c.length * zoom > 16 };
          }
        }
        return null;
      };
      return hit(lane) ?? (lanes > 1 ? null : hit(null));
    },
    [rowAtY, xToBeat, beatToX, clipsByTrack, zoom, laneCount, scrollY],
  );

  /**
   * Tirador de fundido bajo el cursor.
   *
   * Los dos viven en la banda superior del clip (FADE_BAND_H) para no pelearse
   * con el borde de redimensionar, que ocupa todo el lado derecho: arriba
   * mandan los fundidos, del resto de la altura se encarga el resize.
   */
  const fadeHandleAt = useCallback(
    (x: number, y: number): { clip: Clip; which: 'in' | 'out' } | null => {
      const row = rowAtY(y);
      if (!row) return null;
      const lanes = laneCount(row.track.id);
      const laneH = row.track.height / lanes;
      const localY = y - RULER_H + scrollY - row.top;
      if (localY % laneH > FADE_BAND_H) return null;
      const lane = Math.min(lanes - 1, Math.max(0, Math.floor(localY / laneH)));
      for (const c of clipsByTrack.get(row.track.id) ?? []) {
        if (c.kind !== 'audio' || (c.lane ?? 0) !== lane) continue;
        const cw = c.length * zoom;
        if (cw <= 12) continue;
        const x0 = beatToX(c.start);
        const f = clampFades(c.fadeIn, c.fadeOut, c.length);
        if (Math.abs(x - (x0 + f.fadeIn * zoom)) <= FADE_GRAB_PX) return { clip: c, which: 'in' };
        if (Math.abs(x - (x0 + cw - f.fadeOut * zoom)) <= FADE_GRAB_PX) {
          return { clip: c, which: 'out' };
        }
      }
      return null;
    },
    [rowAtY, laneCount, clipsByTrack, scrollY, zoom, beatToX],
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
    const drawClip = (c: Clip, rowY: number, rowH: number, ghost = false, selected = false) => {
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

      // Seleccionado: velo + marco del acento. Va con el acento y no con el
      // color del clip porque un clip ya es de su color: sin un tono ajeno,
      // "seleccionado" no se distingue de "es una pista azul".
      if (selected) {
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }

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
        // Forma de onda REAL del sample, no una raya decorativa: con los FX de
        // la librería, ver dónde pega el golpe es la diferencia entre colocar
        // el clip y adivinarlo. Los picos vienen de la caché compartida;
        // mientras se decodifican se pinta la línea central de siempre, así que
        // el clip nunca sale vacío.
        const sample = c.sampleId ? project.samples[c.sampleId] : undefined;
        const pk = sample ? requestPeaks(sample) : undefined;
        ctx.globalAlpha = base * 0.7;
        ctx.fillStyle = color;
        if (pk && pk.duration > 0) {
          const offset = c.audioOffset ?? 0;
          // Con stretch el sample (desde su offset) se estira hasta llenar el
          // clip; sin él avanza a tiempo real y puede acabarse antes.
          const spanSec = c.audioStretch
            ? Math.max(0.001, pk.duration - offset)
            : c.length * (60 / project.tempo);
          const mid = top + ah / 2;
          const amp = ah / 2 - 0.5;
          const from = Math.max(0, Math.floor(-x));
          const to = Math.min(cw, Math.ceil(w - x));
          for (let px = from; px < to; px++) {
            const sec = offset + (px / cw) * spanSec;
            if (sec < 0 || sec >= pk.duration) continue;
            const ci = Math.min(PEAK_COLS - 1, Math.floor((sec / pk.duration) * PEAK_COLS));
            const yTop = mid - pk.max[ci]! * amp;
            const yBot = mid - pk.min[ci]! * amp;
            ctx.fillRect(x + px, yTop, 1, Math.max(1, yBot - yTop));
          }
        } else {
          ctx.fillRect(x + 2, top + ah / 2, cw - 4, 1.5);
        }
      }
      // Fundidos (solo audio): la recta que se aplica de verdad, con la zona
      // que se está quitando sombreada y un tirador redondo en la punta. El
      // tirador se pinta AUNQUE el fundido sea 0 — pegado a la esquina — o
      // nadie sabría que se puede arrastrar.
      if (c.kind === 'audio' && cw > 12) {
        const f = clampFades(c.fadeIn, c.fadeOut, c.length);
        const yTop = rowY + 2;
        const yBot = rowY + rowH - 3;
        /** Cuña de lo que se está quitando + la recta de la rampa. */
        const wedge = (cornerX: number, tipX: number) => {
          ctx.beginPath();
          ctx.moveTo(cornerX, yTop);
          ctx.lineTo(tipX, yTop);
          ctx.lineTo(cornerX, yBot);
          ctx.closePath();
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = col('--pl-row');
          ctx.fill();
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = col('--pl-fade');
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(cornerX, yBot);
          ctx.lineTo(tipX, yTop);
          ctx.stroke();
        };
        if (f.fadeIn > 0) wedge(x, x + f.fadeIn * zoom);
        if (f.fadeOut > 0) wedge(x + cw, x + cw - f.fadeOut * zoom);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col('--pl-fade');
        ctx.lineWidth = 1;
        for (const hx of [x + f.fadeIn * zoom, x + cw - f.fadeOut * zoom]) {
          ctx.beginPath();
          ctx.arc(
            Math.min(x + cw - 2, Math.max(x + 2, hx)),
            yTop + 1,
            FADE_HANDLE_R,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
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

    // Compases alternos + líneas verticales (con compases variables).
    const lastBeat = scrollX + w / zoom;
    const bars = barsIn(scrollX, lastBeat);
    const barStarts = new Set<number>();
    for (const bar of bars) {
      barStarts.add(Math.round(bar.beat * 1000));
      if (bar.index % 2 === 1) {
        ctx.fillStyle = col('--pl-bar-alt');
        ctx.fillRect(beatToX(bar.beat), RULER_H, bar.num * zoom, h - RULER_H);
      }
    }
    for (let b = Math.floor(scrollX); b <= lastBeat; b++) {
      const isBar = barStarts.has(Math.round(b * 1000));
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
      const lanes = laneCount(r.track.id);
      const laneH = r.track.height / lanes;
      for (const c of clipsByTrack.get(r.track.id) ?? []) {
        const lane = Math.min(lanes - 1, Math.max(0, c.lane ?? 0));
        drawClip(c, y + lane * laneH, laneH, false, selection.has(c.id));
      }
      // Línea fina entre carriles para que se vea que hay tomas apiladas.
      if (lanes > 1) {
        ctx.fillStyle = col('--pl-grid-beat');
        for (let l = 1; l < lanes; l++) ctx.fillRect(0, y + l * laneH, w, 1);
      }
    }
    if (paintGhost.current) {
      for (const c of paintGhost.current) {
        const r = rows.find((row) => row.track.id === c.playlistTrackId);
        if (r) drawClip(c, RULER_H + r.top - scrollY, r.track.height, true);
      }
    }

    // Rectángulo de selección en curso.
    const dm = drag.current;
    if (dm?.mode === 'marquee') {
      const mx = Math.min(dm.x0, dm.x1);
      const my = Math.min(dm.y0, dm.y1);
      const mw = Math.abs(dm.x1 - dm.x0);
      const mh = Math.abs(dm.y1 - dm.y0);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(mx, my, mw, mh);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = accent;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(mx + 0.5, my + 0.5, mw, mh);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
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
    for (const bar of bars) {
      const x = beatToX(bar.beat);
      ctx.fillStyle = col('--pl-grid-bar');
      ctx.fillRect(x, RULER_H - 7, 1, 7);
      if (bar.index % every === 0) {
        ctx.fillStyle = col('--pl-ruler-text');
        ctx.fillText(String(bar.index + 1), x + 3, RULER_H - 9);
      }
    }

    // Marcadores de sección: bandera con nombre en la regla + guía en la rejilla.
    for (const m of Object.values(project.markers)) {
      const mx = beatToX(m.time);
      if (mx < -100 || mx > w + 20) continue;
      ctx.fillStyle = m.color;
      ctx.fillRect(mx, 0, 2, RULER_H);
      ctx.globalAlpha = 0.16;
      ctx.fillRect(mx, RULER_H, 1, h - RULER_H);
      ctx.globalAlpha = 1;
      ctx.font = `9px ${font}`;
      const tw = ctx.measureText(m.name).width;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(mx + 2, 1, tw + 8, 11);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col('--pl-ruler-bg');
      ctx.fillText(m.name, mx + 6, 9.5);
    }

    // Cursores remotos: caret con nombre de quien está tocando la playlist.
    for (const p of peers) {
      if (p.isSelf || p.activity?.editor !== 'Playlist' || p.activity.beat === undefined) continue;
      const px = beatToX(p.activity.beat);
      if (px < -80 || px > w + 20) continue;
      ctx.fillStyle = p.user.color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(px, RULER_H, 1.5, h - RULER_H);
      ctx.font = `9px ${font}`;
      const tw = ctx.measureText(p.user.name).width;
      ctx.fillRect(px, RULER_H + 2, tw + 8, 12);
      ctx.fillStyle = col('--pl-ruler-bg');
      ctx.fillText(p.user.name, px + 4, RULER_H + 11.5);
      ctx.globalAlpha = 1;
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
  }, [rows, clipsByTrack, project, zoom, scrollX, scrollY, loopRegion, barLen, beatToX, idlePos, peers, themeVersion, laneCount, barsIn, selection]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Los picos de un sample llegan tarde (hay que decodificar el archivo): el
  // clip se pinta ya y se repinta solo cuando su onda está lista.
  useEffect(() => onPeaksReady(draw), [draw]);

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
    // Quitar la región NO para el transporte: se vuelve a ciclar el timeline
    // entero (enabled=true, sin región). Con `false` el patrón sonaba una sola
    // vez y el transporte se quedaba muerto.
    engine.setLoop(0, 0, true);
  }, []);

  /** Corta un clip en el beat dado (dos clips, con offsets coherentes). */
  const sliceClip = useCallback(
    (clip: Clip, cut: number) => {
      if (cut <= clip.start + 0.05 || cut >= clip.start + clip.length - 0.05) return;
      const firstLen = cut - clip.start;
      const second: Clip = { ...clip, id: newId(), start: cut, length: clip.length - firstLen };
      // Los fundidos se reparten: la cabeza se queda el de entrada y la cola el
      // de salida. Copiar los dos a los dos trozos metería un fundido a mitad
      // del sonido justo donde antes no había ninguno.
      const cutFades = clampFades(clip.fadeIn, clip.fadeOut, clip.length);
      const headFadeIn = Math.min(cutFades.fadeIn, firstLen);
      const tailFadeOut = Math.min(cutFades.fadeOut, second.length);
      second.fadeIn = 0;
      second.fadeOut = tailFadeOut;
      if (clip.kind === 'pattern') {
        second.patternOffset = (clip.patternOffset ?? 0) + firstLen;
      } else if (clip.kind === 'audio') {
        second.audioOffset = (clip.audioOffset ?? 0) + firstLen * (60 / project.tempo);
      }
      const label = 'Cortar clip';
      store.dispatch(
        {
          type: 'batch',
          label,
          commands: [
            {
              type: 'patchClips',
              patches: [{ id: clip.id, length: firstLen, fadeIn: headFadeIn, fadeOut: 0 }],
            },
            { type: 'addClips', clips: [second] },
          ],
        },
        { label },
      );
    },
    [project],
  );

  /**
   * Arranca un arrastre de movimiento con `clipId` como clip agarrado y `ids`
   * como grupo que viaja con él (normalmente la selección).
   */
  const startMove = useCallback(
    (clipId: Id, x: number, ids: readonly Id[]) => {
      const anchor = project.clips[clipId];
      if (!anchor) return;
      const orig = new Map<Id, MoveAnchor>();
      for (const id of ids) {
        const c = project.clips[id];
        if (!c) continue;
        orig.set(id, { start: c.start, trackIndex: trackIndexOf.get(c.playlistTrackId) ?? 0 });
      }
      // El clip agarrado siempre viaja, esté o no en la selección.
      if (!orig.has(clipId)) {
        orig.set(clipId, {
          start: anchor.start,
          trackIndex: trackIndexOf.get(anchor.playlistTrackId) ?? 0,
        });
      }
      drag.current = { mode: 'move', clipId, grabOffset: xToBeat(x) - anchor.start, orig };
    },
    [project, trackIndexOf, xToBeat],
  );

  // ── Interacción en el canvas ──────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      capturePointer(canvas, e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      ensureAudioReady();

      // Regla: loop (mitad superior), seek (mitad inferior) y marcadores.
      if (y < RULER_H) {
        if (e.button === 2) {
          // Clic derecho sobre una bandera: borrar el marcador; si no, quitar loop.
          const m = markerAt(x);
          if (m) {
            store.dispatch(
              { type: 'removeMarker', markerId: m.id },
              { label: `Borrar marcador "${m.name}"` },
            );
          } else {
            clearLoop();
          }
          return;
        }
        if (e.button !== 0) return;
        const beat = quant(xToBeat(x), snapOf(e), true);
        if (y < RULER_H / 2) {
          drag.current = { mode: 'loop', anchor: beat, moved: false };
        } else {
          // Clic sobre una bandera: salto exacto a su marcador.
          const m = markerAt(x);
          drag.current = { mode: 'seek' };
          doSeek(m ? m.time : beat);
        }
        return;
      }

      const hit = clipAt(x, y);

      // Clic central: alternar mute del clip. En una pista con tomas apiladas
      // significa "quiero ESTA toma": suena la elegida y callan las que pisa.
      if (e.button === 1) {
        if (hit) {
          const lanes = laneCount(hit.row.track.id);
          if (lanes > 1) {
            const list = clipsByTrack.get(hit.row.track.id) ?? [];
            const patches = list
              .filter(
                (c) =>
                  c.start < hit.clip.start + hit.clip.length &&
                  c.start + c.length > hit.clip.start,
              )
              .map((c) => ({ id: c.id, muted: c.id !== hit.clip.id }));
            store.dispatch(
              { type: 'patchClips', patches },
              { label: `Elegir toma ${(hit.clip.lane ?? 0) + 1}` },
            );
          } else {
            store.dispatch(
              { type: 'patchClips', patches: [{ id: hit.clip.id, muted: !hit.clip.muted }] },
              { label: hit.clip.muted ? 'Activar clip' : 'Mutear clip' },
            );
          }
        }
        return;
      }

      // Shift+clic: cortar el clip en el beat del cursor (patrón y audio).
      if (e.button === 0 && e.shiftKey && hit && !hit.edge && hit.clip.kind !== 'automation') {
        sliceClip(hit.clip, quant(xToBeat(x), snapOf(e), true));
        return;
      }

      // Clic derecho: borrar. Si el clip está seleccionado, se va el grupo
      // entero — es lo que uno espera después de haber marcado ocho clips.
      if (e.button === 2) {
        if (hit) {
          if (selection.has(hit.clip.id) && selectedIds.length > 1) deleteSelection();
          else {
            store.dispatch(
              { type: 'removeClips', clipIds: [hit.clip.id] },
              { label: `Borrar clip "${clipLabel(hit.clip, project)}"` },
            );
          }
        }
        return;
      }
      if (e.button !== 0) return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Tiradores de fundido: van antes que nada porque están DENTRO del clip
      // y si no, el gesto se lo comería el "mover".
      if (!ctrl && !e.shiftKey) {
        const fade = fadeHandleAt(x, y);
        if (fade) {
          drag.current = { mode: 'fade', clipId: fade.clip.id, which: fade.which };
          return;
        }
      }

      if (hit) {
        if (hit.edge) {
          drag.current = { mode: 'resize', clipId: hit.clip.id };
        } else if (ctrl) {
          // Ctrl sobre un clip hace DOS cosas según lo que venga después:
          // soltar sin moverse lo mete o lo saca de la selección; arrastrar
          // duplica y mueve la copia, como toda la vida.
          drag.current = { mode: 'ctrlpick', clipId: hit.clip.id, x, y };
        } else {
          // Clic normal: si el clip ya estaba marcado, el grupo entero viaja
          // con él; si no, pasa a ser la selección.
          let ids = selectedIds;
          if (!selection.has(hit.clip.id)) {
            ids = [hit.clip.id];
            setSelection(new Set(ids));
          }
          startMove(hit.clip.id, x, ids);
        }
        return;
      }

      // Ctrl en zona vacía: rectángulo de selección (Shift para sumar).
      if (ctrl) {
        drag.current = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
        if (!e.shiftKey) setSelection(new Set());
        return;
      }

      // Zona vacía: pintar el patrón activo (commit único al soltar).
      if (selection.size > 0) setSelection(new Set());
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
    [clipAt, rowAtY, xToBeat, snapOf, doSeek, clearLoop, markerAt, sliceClip, activePattern, patternId, project, draw, laneCount, clipsByTrack, selection, selectedIds, deleteSelection, startMove],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const d = drag.current;

      // Presencia: dónde está nuestro cursor (throttled; no-op sin sesión).
      reportActivity('Playlist', { beat: xToBeat(x) });

      // Fila bajo el ratón: es donde pega Ctrl+V (si el ratón nunca ha entrado,
      // se pega en la fila de la que se copió).
      const hoverRow = y >= RULER_H ? rowAtY(y) : null;
      if (hoverRow) pasteRow.current = trackIndexOf.get(hoverRow.track.id) ?? null;

      if (!d) {
        // Cursor contextual: regla, fundido, mover, redimensionar o pintar.
        const hit = y >= RULER_H ? clipAt(x, y) : null;
        const fade = y >= RULER_H && fadeHandleAt(x, y) !== null;
        canvas.style.cursor =
          y < RULER_H
            ? 'pointer'
            : fade
              ? 'col-resize'
              : hit
                ? hit.edge
                  ? 'ew-resize'
                  : 'move'
                : 'crosshair';
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
        case 'ctrlpick': {
          // Se movió lo bastante: era un duplicado. La copia (o las copias,
          // si había selección) nacen aquí y el resto del gesto las arrastra.
          if (Math.abs(x - d.x) < CTRL_DRAG_PX && Math.abs(y - d.y) < CTRL_DRAG_PX) break;
          const source = selection.has(d.clipId) && selectedIds.length > 1
            ? selectedIds
            : [d.clipId];
          const copies = source
            .map((id) => project.clips[id])
            .filter((c): c is Clip => c !== undefined)
            .map((c) => ({ ...c, id: newId(), points: c.points?.map((p) => ({ ...p })) }));
          if (copies.length === 0) {
            drag.current = null;
            break;
          }
          const twin = copies[source.indexOf(d.clipId)] ?? copies[0]!;
          store.dispatch(
            { type: 'addClips', clips: copies },
            { label: `Duplicar ${copies.length} clip(s)` },
          );
          setSelection(new Set(copies.map((c) => c.id)));
          // Sin pasar por startMove: `project` de este render aún no conoce
          // las copias recién despachadas y las buscaría en vano.
          drag.current = {
            mode: 'move',
            clipId: twin.id,
            grabOffset: d.x / zoom + scrollX - twin.start,
            orig: new Map(
              copies.map((c) => [
                c.id,
                { start: c.start, trackIndex: trackIndexOf.get(c.playlistTrackId) ?? 0 },
              ]),
            ),
          };
          break;
        }
        case 'marquee': {
          d.x1 = x;
          d.y1 = y;
          draw();
          break;
        }
        case 'fade': {
          const clip = project.clips[d.clipId];
          if (!clip) return;
          // Alt manda igual que en todo lo demás: sin snap el fundido es libre.
          const snap = snapOf(e);
          const raw =
            d.which === 'in'
              ? xToBeat(x) - clip.start
              : clip.start + clip.length - xToBeat(x);
          const step = snap ?? 0;
          const value = Math.min(
            clip.length,
            Math.max(0, step > 0 ? Math.round(raw / step) * step : raw),
          );
          const current = (d.which === 'in' ? clip.fadeIn : clip.fadeOut) ?? 0;
          if (Math.abs(value - current) > 1e-6) {
            store.dispatch(
              {
                type: 'patchClips',
                patches: [{ id: clip.id, [d.which === 'in' ? 'fadeIn' : 'fadeOut']: value }],
              },
              {
                label: d.which === 'in' ? 'Fundido de entrada' : 'Fundido de salida',
                mergeKey: `pl:fade:${d.which}:${clip.id}`,
              },
            );
          }
          break;
        }
        case 'move': {
          const origAnchor = d.orig.get(d.clipId);
          if (!origAnchor) return;
          // Todo se calcula como DESPLAZAMIENTO contra la foto del principio:
          // el clip agarrado se pega a la rejilla y los demás conservan su
          // distancia a él (si no, un grupo con distintos offsets se apelmaza
          // sobre la rejilla en cuanto lo mueves un pelo).
          const dBeat = quant(xToBeat(x) - d.grabOffset, snapOf(e), true) - origAnchor.start;
          const row = rowAtY(y);
          const dTrack =
            (row ? trackIndexOf.get(row.track.id) ?? origAnchor.trackIndex : origAnchor.trackIndex) -
            origAnchor.trackIndex;

          // Clamp de GRUPO (selection.ts): el que primero toparía manda por
          // todos.
          const delta = clampGroupMove(
            d.orig.values(),
            { beats: dBeat, tracks: dTrack },
            tracks.length,
          );

          const patches: { id: Id; start: number; playlistTrackId: Id }[] = [];
          for (const [id, a] of d.orig) {
            const clip = project.clips[id];
            if (!clip) continue;
            const start = a.start + delta.beats;
            const trackId = tracks[a.trackIndex + delta.tracks]?.id ?? clip.playlistTrackId;
            if (start !== clip.start || trackId !== clip.playlistTrackId) {
              patches.push({ id, start, playlistTrackId: trackId });
            }
          }
          if (patches.length > 0) {
            store.dispatch(
              { type: 'patchClips', patches },
              {
                label: d.orig.size > 1 ? `Mover ${d.orig.size} clips` : 'Mover clip',
                mergeKey: `pl:move:${d.clipId}`,
              },
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
    [clipAt, rowAtY, xToBeat, snapOf, doSeek, freeAt, project, draw, selection, selectedIds, trackIndexOf, tracks, zoom, scrollX],
  );

  // Doble clic: en la regla crea/renombra marcadores; en un clip de
  // automatización lo abre en su editor.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (y < RULER_H) {
        const m = markerAt(x);
        if (m) {
          setMarkerEdit({ id: m.id, name: m.name });
        } else {
          const count = Object.keys(project.markers).length;
          store.dispatch(
            {
              type: 'addMarker',
              marker: {
                id: newId(),
                time: quant(xToBeat(x), snapOf(e), true),
                name: `Sección ${count + 1}`,
                color: pickColor(count),
              },
            },
            { label: 'Añadir marcador' },
          );
        }
        return;
      }
      // Doble clic en un tirador de fundido: fuera el fundido.
      const fade = fadeHandleAt(x, y);
      if (fade) {
        const key = fade.which === 'in' ? 'fadeIn' : 'fadeOut';
        if ((fade.clip[key] ?? 0) > 0) {
          store.dispatch(
            { type: 'patchClips', patches: [{ id: fade.clip.id, [key]: 0 }] },
            { label: 'Quitar fundido' },
          );
        }
        return;
      }
      const hit = clipAt(x, y);
      if (hit?.clip.kind === 'automation') {
        useUiStore.setState({ automationClipId: hit.clip.id });
        useUiStore.getState().openWindow('automation');
      } else if (hit?.clip.kind === 'audio') {
        useUiStore.setState({ audioClipId: hit.clip.id });
        useUiStore.getState().openWindow('audioEditor');
      }
    },
    [clipAt, markerAt, beatToX, xToBeat, snapOf, project],
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
    } else if (d.mode === 'ctrlpick') {
      // Ctrl+clic sin arrastre: dentro o fuera de la selección.
      setSelection((prev) => {
        const next = new Set(prev);
        if (next.has(d.clipId)) next.delete(d.clipId);
        else next.add(d.clipId);
        return next;
      });
    } else if (d.mode === 'marquee') {
      const b0 = xToBeat(Math.min(d.x0, d.x1));
      const b1 = xToBeat(Math.max(d.x0, d.x1));
      // La banda vertical se compara en coordenadas de la rejilla (sin regla,
      // con el scroll ya sumado), que es donde viven los `top` de las filas.
      const gy0 = Math.min(d.y0, d.y1) - RULER_H + scrollY;
      const gy1 = Math.max(d.y0, d.y1) - RULER_H + scrollY;
      const touched: SelectableClip[] = [];
      rows.forEach((r, i) => {
        if (r.top + r.track.height < gy0 || r.top > gy1) return;
        for (const c of clipsByTrack.get(r.track.id) ?? []) {
          touched.push({ id: c.id, start: c.start, length: c.length, trackIndex: i });
        }
      });
      const hits = clipsInMarquee(touched, {
        fromBeat: b0,
        toBeat: b1,
        fromTrack: 0,
        toTrack: rows.length,
      });
      setSelection((prev) => {
        const next = d.add ? new Set(prev) : new Set<Id>();
        for (const id of hits) next.add(id);
        return next;
      });
      draw();
    }
  }, [project, clearLoop, draw, xToBeat, scrollY, rows, clipsByTrack]);

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
        // Actualización funcional: dos ruedas en el mismo tick (la rueda las
        // agrupa) partían las dos del MISMO scroll y la segunda se perdía.
        setScrollX((s) => Math.max(0, s + (e.deltaY > 0 ? 2 : -2)));
      } else {
        const viewH = (wrapRef.current?.clientHeight ?? 0) - RULER_H;
        const max = Math.max(0, totalH - viewH);
        setScrollY((s) => Math.min(max, Math.max(0, s + e.deltaY)));
      }
    },
    [zoom, totalH, xToBeat],
  );

  /**
   * Teclado de la selección: Ctrl+A todo, Supr borrar, Ctrl+B duplicar, M
   * mutear, Esc soltar.
   *
   * Ctrl+A y Ctrl+B piden el ratón encima (o el foco dentro): el Piano Roll
   * tiene los mismos atajos para SUS notas y los dos editores suelen estar
   * abiertos a la vez. Supr y Esc solo hacen algo si aquí hay selección, así
   * que no le quitan nada a nadie.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }
      const root = rootRef.current;
      const here = hovering.current || (root !== null && root.contains(document.activeElement));

      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyA' && here) {
        e.preventDefault();
        selectAll();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyB' && here) {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (selection.size === 0) return;
      if (e.code === 'Delete' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        deleteSelection();
      } else if (e.code === 'Escape') {
        clearSelection();
      } else if (e.code === 'KeyM' && !e.ctrlKey && !e.shiftKey && !e.altKey && here) {
        e.preventDefault();
        toggleSelectionMuted();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectAll, duplicateSelection, deleteSelection, clearSelection, toggleSelectionMuted, selection]);

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

  /** Nuevo arrangement (con sus pistas base) y salto a él, en un undo. */
  const addArrangement = () => {
    const n = project.arrangementOrder.length + 1;
    const arrangement = { id: newId(), name: `Arrangement ${n}` };
    const label = `Nuevo arrangement "${arrangement.name}"`;
    const baseTracks = Array.from({ length: 6 }, (_, i) => createPlaylistTrack(arrangement.id, i));
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: [
          { type: 'addArrangement', arrangement },
          ...baseTracks.map((track) => ({ type: 'addPlaylistTrack' as const, track })),
          { type: 'setActiveArrangement', arrangementId: arrangement.id },
        ],
      },
      { label },
    );
  };

  const [renamingArr, setRenamingArr] = useState(false);

  /**
   * Izquierda de la caja de edición del marcador, en px de .pl-canvas-wrap.
   * Se recalcula en cada render a partir del beat del marcador, así que la
   * caja va pegada a su bandera aunque se haga scroll o zoom con ella
   * abierta; y se limita al ancho útil porque el contenedor es
   * `overflow: hidden` y la recortaría sin avisar.
   */
  const markerEditX = (() => {
    const marker = markerEdit ? project.markers[markerEdit.id] : undefined;
    if (!marker) return 2;
    const room = Math.max(2, (wrapRef.current?.clientWidth ?? 0) - MARKER_EDIT_W - 4);
    return Math.min(room, Math.max(2, beatToX(marker.time) + 4));
  })();

  return (
    <div
      className="playlist"
      ref={rootRef}
      // Tocar la Playlist le da el turno de edición: a partir de aquí,
      // Ctrl+C/X/V y el menú Editar hablan de SUS clips, no de las notas.
      onPointerDown={() => claimEditFocus('playlist')}
      onPointerEnter={() => {
        hovering.current = true;
      }}
      onPointerLeave={() => {
        hovering.current = false;
      }}
    >
      <div className="pl-toolbar">
        <label className="pl-field">
          Arrangement
          {renamingArr ? (
            <input
              className="pl-name-input"
              defaultValue={project.arrangements[project.activeArrangementId]?.name ?? ''}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') setRenamingArr(false);
              }}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim();
                if (name && name !== project.arrangements[project.activeArrangementId]?.name) {
                  store.dispatch(
                    {
                      type: 'patchArrangement',
                      arrangementId: project.activeArrangementId,
                      patch: { name },
                    },
                    { label: 'Renombrar arrangement' },
                  );
                }
                setRenamingArr(false);
              }}
            />
          ) : (
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
          )}
        </label>
        <button className="pl-add" title="Nuevo arrangement" onClick={addArrangement}>
          +
        </button>
        <button
          className="pl-add"
          title="Renombrar este arrangement"
          onClick={() => setRenamingArr(true)}
        >
          ✎
        </button>
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

        {/* Selección: el botón está a la vista para no depender de saberse el
            atajo, y el chip dice cuántos clips llevas marcados. */}
        <div className="pl-sel-group">
          <button
            className="pl-add"
            onClick={selectAll}
            title="Seleccionar todos los clips del arrangement (Ctrl+A) · Ctrl+clic marca uno a uno · Ctrl+arrastre en zona vacía dibuja un rectángulo"
          >
            Sel. todo
          </button>
          {selectedIds.length > 0 && (
            <>
              <span className="pl-chip pl-sel-chip" title="Clips seleccionados">
                {selectedIds.length} sel.
              </span>
              <button
                className="pl-add"
                onClick={duplicateSelection}
                title="Duplicar la selección a continuación (Ctrl+B)"
              >
                Duplicar
              </button>
              <button
                className="pl-add"
                onClick={toggleSelectionMuted}
                title="Mutear o activar la selección (M)"
              >
                Mute
              </button>
              <button
                className="pl-add"
                onClick={deleteSelection}
                title="Borrar la selección (Supr)"
              >
                Borrar
              </button>
              <button className="pl-add" onClick={clearSelection} title="Soltar la selección (Esc)">
                ✕
              </button>
            </>
          )}
        </div>
      </div>

      <SectionLane
        project={project}
        beatToX={beatToX}
        xToBeat={xToBeat}
        quantize={(beat, altKey) => quant(beat, altKey ? null : snapBeats, true)}
        barLen={barLen}
        onSelectSpan={(from, to) =>
          setSelection(
            new Set(clipsInSpan(project, project.activeArrangementId, from, to).map((c) => c.id)),
          )
        }
      />
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
          {markerEdit && (
            <div
              className="pl-marker-edit popup"
              style={{ left: markerEditX, top: 2 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <input
                className="pl-marker-name"
                autoFocus
                value={markerEdit.name}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setMarkerEdit({ ...markerEdit, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  else if (e.key === 'Escape') setMarkerEdit(null);
                }}
                onBlur={() => {
                  const name = markerEdit.name.trim();
                  if (name && name !== project.markers[markerEdit.id]?.name) {
                    store.dispatch(
                      { type: 'patchMarker', markerId: markerEdit.id, patch: { name } },
                      { label: 'Renombrar marcador' },
                    );
                  }
                }}
              />
              {/* Un marcador puede cambiar el tempo y el compás a partir de
                  aquí: el motor sigue el mapa y la regla dibuja los compases
                  con su medida real. Vacío = sigue lo que venía. */}
              <label className="pl-marker-field">
                BPM
                <input
                  type="number"
                  min={20}
                  max={999}
                  step={0.5}
                  placeholder="—"
                  value={project.markers[markerEdit.id]?.tempo ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const tempo = raw === '' ? undefined : Math.min(999, Math.max(20, Number(raw)));
                    if (raw !== '' && !Number.isFinite(tempo)) return;
                    store.dispatch(
                      { type: 'patchMarker', markerId: markerEdit.id, patch: { tempo } },
                      { label: 'Tempo del marcador', mergeKey: `mk:tempo:${markerEdit.id}` },
                    );
                  }}
                />
              </label>
              <label className="pl-marker-field">
                Compás
                <input
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  placeholder="—"
                  value={project.markers[markerEdit.id]?.timeSigNum ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const num = raw === '' ? undefined : Math.min(16, Math.max(1, Math.round(Number(raw))));
                    if (raw !== '' && !Number.isFinite(num)) return;
                    store.dispatch(
                      { type: 'patchMarker', markerId: markerEdit.id, patch: { timeSigNum: num } },
                      { label: 'Compás del marcador', mergeKey: `mk:sig:${markerEdit.id}` },
                    );
                  }}
                />
              </label>
              <button
                className="pl-marker-close"
                title="Cerrar"
                onClick={() => setMarkerEdit(null)}
              >
                ✕
              </button>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="pl-canvas"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(SOUND_MIME) || hasSystemFiles(e.dataTransfer)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              // Del Explorador del sistema. TODO lo que depende del evento se
              // lee aquí arriba, antes del primer await: el reparto del
              // arrastre (`dataTransfer` se vacía) y el sitio donde se soltó
              // (`currentTarget` se queda en null en cuanto se cede el turno).
              if (hasSystemFiles(e.dataTransfer)) {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const row = rowAtY(e.clientY - rect.top);
                const beat = quant(xToBeat(e.clientX - rect.left), snapBeats, false);
                const triage = triageDrop(e.dataTransfer);
                if (!row) return;
                if (triage.accepted.length > 0) {
                  notifyBanner(`Importando ${triage.accepted.length} archivo(s)…`);
                }
                void importTriaged(triage).then(async ({ entries, avisos }) => {
                  if (entries.length > 0) await addAudioClips(entries, row.track.id, beat);
                  const hecho = entries.length > 0 ? `${entries.length} clip(s) colocados` : '';
                  const dicho = [hecho, ...avisos].filter(Boolean).join(' · ');
                  if (dicho) notifyBanner(dicho);
                });
                return;
              }
              // Soltar sonidos del browser: clips de audio en la pista/beat del
              // cursor, uno detrás de otro si vienen varios.
              const entries = getDragEntries(e.dataTransfer);
              if (entries.length === 0) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const row = rowAtY(e.clientY - rect.top);
              if (!row) return;
              void addAudioClips(
                entries,
                row.track.id,
                quant(xToBeat(e.clientX - rect.left), snapBeats, false),
              );
            }}
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
  // El ancla dice en qué documento se pinta el menú (ventana desacoplada).
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);
  const cancelName = useRef(false);
  /** Arrastre de la altura: alto y cursor al empezar. */
  const resize = useRef<{ y: number; height: number } | null>(null);
  const busy = useBounceStore((s) => s.busy !== null);
  const project = useProject();

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

  // El picker nativo dispara change en ráfaga: mergeKey lo funde en un undo.
  const setColor = (color: string) => {
    store.dispatch(
      { type: 'patchPlaylistTrack', trackId: track.id, patch: { color } },
      { label: 'Color de pista', mergeKey: `pl:color:${track.id}` },
    );
  };

  const clipCount = bounceableClipsOfTrack(track.id).length;
  const frozen = frozenClipOfTrack(track.id) !== undefined;

  return (
    <div
      className={`pl-track${track.muted ? ' muted' : ''}`}
      style={{ height: track.height, borderLeftColor: track.color }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Ni tamaño adivinado ni recorte a mano: MenuPortal lo mide de verdad
        // y lo mete dentro de la ventana que toque.
        setMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget });
      }}
    >
      <button
        className={`pl-led${track.muted ? '' : ' on'}`}
        title="Silenciar pista"
        onClick={toggleMute}
      />
      <label className="pl-swatch" title="Color de pista" style={{ background: track.color }}>
        <input type="color" value={track.color} onChange={(e) => setColor(e.target.value)} />
      </label>
      {track.icon && (
        <span className="pl-track-icon" title={track.icon}>
          <IconTrack kind={track.icon} size={14} />
        </span>
      )}
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
          title="Doble clic para renombrar · clic derecho: menú de pista"
          onDoubleClick={() => setEditing(true)}
        >
          {track.name}
        </button>
      )}
      <div
        className="pl-track-resize"
        title="Arrastra para cambiar la altura de la pista"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          capturePointer(e.currentTarget, e.pointerId);
          resize.current = { y: e.clientY, height: track.height };
        }}
        onPointerMove={(e) => {
          const r = resize.current;
          if (!r) return;
          const height = Math.round(
            Math.min(TRACK_H_MAX, Math.max(TRACK_H_MIN, r.height + (e.clientY - r.y))),
          );
          if (height !== track.height) {
            store.dispatch(
              { type: 'patchPlaylistTrack', trackId: track.id, patch: { height } },
              { label: `Altura de "${track.name}"`, mergeKey: `pl:height:${track.id}` },
            );
          }
        }}
        onPointerUp={() => {
          resize.current = null;
        }}
        // Sin esto, un gesto cancelado dejaba el arrastre vivo y la pista
        // cambiaba de altura con solo pasar el ratón por el tirador.
        onPointerCancel={() => {
          resize.current = null;
        }}
        onDoubleClick={() =>
          store.dispatch(
            { type: 'patchPlaylistTrack', trackId: track.id, patch: { height: TRACK_H_DEFAULT } },
            { label: `Altura de "${track.name}"` },
          )
        }
      />
      {menu && (
        <TrackMenu x={menu.x} y={menu.y} anchor={menu.anchor} onClose={() => setMenu(null)}>
          <div className="pl-menu-icons" title="Icono de la pista">
            {TRACK_ICONS.map((kind) => (
              <button
                key={kind}
                className={`pl-icon-btn${track.icon === kind ? ' on' : ''}`}
                title={kind}
                onClick={() =>
                  store.dispatch(
                    {
                      type: 'patchPlaylistTrack',
                      trackId: track.id,
                      patch: { icon: track.icon === kind ? undefined : kind },
                    },
                    { label: `Icono de "${track.name}"` },
                  )
                }
              >
                <IconTrack kind={kind} size={15} />
              </button>
            ))}
          </div>
          <label
            className="param-menu-item"
            style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }}
            title="Pista de mixer a la que van los clips de AUDIO de este carril (tomas de voz, pistas congeladas)"
          >
            <span style={{ flex: 1 }}>Pista de mixer</span>
            <select
              value={track.mixerTrack ?? 0}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                store.dispatch(
                  {
                    type: 'patchPlaylistTrack',
                    trackId: track.id,
                    patch: { mixerTrack: Number(e.target.value) },
                  },
                  { label: `Pista de mixer de "${track.name}"` },
                )
              }
            >
              {project.mixer.map((m, i) => (
                <option key={m.id} value={i}>
                  {i === 0 ? 'Master' : `${i}. ${m.name}`}
                </option>
              ))}
            </select>
          </label>
          <button
            className="param-menu-item"
            disabled={busy || clipCount === 0}
            title={
              clipCount === 0
                ? 'Esta pista no tiene clips que consolidar'
                : 'Renderiza los clips de la pista (con sus efectos) y los sustituye por un solo clip de audio'
            }
            onClick={() => {
              setMenu(null);
              void bounceTrack(track.id);
            }}
          >
            Consolidar a audio{clipCount > 0 ? ` (${clipCount} clip${clipCount > 1 ? 's' : ''})` : ''}
          </button>
          <button
            className="param-menu-item"
            disabled={busy || (!frozen && clipCount === 0)}
            title={
              frozen
                ? 'Quita el audio congelado y devuelve los clips originales'
                : 'Renderiza la pista a audio SIN borrar nada: los clips originales se quedan muteados debajo'
            }
            onClick={() => {
              setMenu(null);
              if (frozen) unfreezeTrack(track.id);
              else void freezeTrack(track.id);
            }}
          >
            {frozen ? 'Descongelar pista' : 'Congelar pista'}
          </button>
          <button
            className="param-menu-item"
            onClick={() => {
              setMenu(null);
              store.dispatch(
                { type: 'removePlaylistTrack', trackId: track.id },
                { label: `Borrar pista "${track.name}"` },
              );
            }}
          >
            Borrar pista
          </button>
        </TrackMenu>
      )}
    </div>
  );
}

/**
 * Menú flotante de la cabecera de pista.
 *
 * Va por MenuPortal y no por un `position: fixed` a pelo: las cabeceras viven
 * dentro de .pl-headers-inner, que lleva un transform de scroll, y eso lo
 * convierte en el containing block del menú. Colocado contra una columna de
 * 140 px con `overflow: hidden`, el menú se recortaba ENTERO: clic derecho en
 * una cabecera de pista no hacía nada, nunca.
 */
function TrackMenu({
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
    <MenuPortal anchor={anchor} x={x} y={y} onClose={onClose} className="param-menu">
      {children}
    </MenuPortal>
  );
}
