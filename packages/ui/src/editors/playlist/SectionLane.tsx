/**
 * Franja de secciones de la Playlist: la forma del tema, encima de la rejilla.
 *
 * Intro, build, drop, vuelta, outro. Dibujar la estructura no es decorar: las
 * operaciones se llevan lo que hay dentro (duplicar un drop copia sus clips y
 * empuja lo de detrás), y eso vive en `@orbit/core/arrangement`, puro y con
 * tests. Aquí solo están el lienzo y los gestos.
 *
 * Canvas propio y no una banda dentro del de la playlist: el lienzo grande
 * tiene toda su geometría colgada de RULER_H, y meterle una franja arriba
 * obligaba a repasar cada hit-test del archivo. Comparte zoom y scroll por
 * props, que es lo único que necesitan para estar alineados.
 *
 * Los arrastres NO usan los helpers de core. Los helpers calculan el
 * desplazamiento contra el proyecto de AHORA, que es lo correcto para una
 * acción de menú pero se acumularía a sesenta dispatch por segundo; aquí se
 * ancla el estado al empezar el gesto y cada paso manda posiciones ABSOLUTAS,
 * que es lo que permite fundirlos con mergeKey en un solo undo (la misma regla
 * que el arrastre de clips: ver `d.orig` en Playlist.tsx).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  duplicateSectionCommands,
  newId,
  removeSectionCommands,
  sectionsFromShape,
  sectionsOf,
  type ArrangementSection,
  type Command,
  type Id,
  type Project,
} from '@orbit/core';
import { SHAPE_COUNT, planSections } from '@orbit/sound-library';
import { store } from '../../state/app';
import { SECTION_COLOR_DEFAULT, SECTION_COLORS } from '../../theme/palette';
import { useThemeVersion } from '../../theme/useThemeVersion';
import { capturePointer } from '../../widgets/pointer';
import { MenuPortal } from '../../widgets/MenuPortal';

/** Alto de la franja. Se aplica en línea para que el CSS no pueda desviarse. */
const SECTION_LANE_H = 22;
/** Tolerancia del tirador del borde derecho. */
const EDGE_PX = 6;
/** Colores por papel; una sección dibujada a mano nace con el neutro.
 *  Los valores viven en theme/palette.ts (regla 4 de CLAUDE.md). */
const KIND_COLORS = SECTION_COLORS;
const DEFAULT_COLOR = SECTION_COLOR_DEFAULT;

/** Nombre visible de cada papel (el modelo guarda el papel, no la etiqueta). */
const KIND_LABELS: Record<string, string> = {
  intro: 'Intro',
  build: 'Subida',
  drop: 'Drop',
  break: 'Vuelta',
  outro: 'Outro',
};

/**
 * Las formas que reparte el generador de beats, tal cual.
 *
 * Se leen de `@orbit/sound-library` y no se copian aquí: el generador ya sabe
 * qué es un tema bien montado —toda intro presenta, todo drop tiene algo que lo
 * anuncia, todo final deja ir— y tener dos catálogos acabaría con dos ideas
 * distintas de qué es un drop.
 */
const SHAPE_LABELS = ['De manual', 'Con vuelta larga', 'Al grano'];

/** Convierte una forma del generador en secciones con nombre y sin repetidos. */
function shapeToSpec(index: number): { kind: ArrangementSection['kind']; name: string; bars: number }[] {
  const seen = new Map<string, number>();
  return planSections(index).map((s) => {
    const n = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, n);
    const label = KIND_LABELS[s.kind] ?? s.kind;
    // El segundo drop se llama "Drop 2": sin numerar, la lista de secciones de
    // un tema con dos drops no dice nada.
    const total = planSections(index).filter((o) => o.kind === s.kind).length;
    return {
      kind: s.kind as ArrangementSection['kind'],
      name: total > 1 ? `${label} ${n}` : label,
      bars: s.bars,
    };
  });
}

/** Lo que hay que recordar al empezar un arrastre para poder mandar absolutos. */
interface MoveAnchor {
  kind: 'move';
  sectionId: Id;
  /** Beat donde se agarró, relativo al inicio de la sección. */
  grab: number;
  start0: number;
  clips: { id: Id; start: number }[];
}

interface ResizeAnchor {
  kind: 'resize';
  sectionId: Id;
  length0: number;
  /** Lo que hay detrás, para estirar el hueco con la sección. */
  clips: { id: Id; start: number }[];
  sections: { id: Id; start: number }[];
  markers: { id: Id; time: number }[];
}

interface CreateAnchor {
  kind: 'create';
  from: number;
  to: number;
}

type Drag = MoveAnchor | ResizeAnchor | CreateAnchor;

export interface SectionLaneProps {
  project: Project;
  /** beat → px dentro del lienzo (la misma de la playlist). */
  beatToX: (beat: number) => number;
  xToBeat: (x: number) => number;
  /** Cuantiza un beat con el snap vigente (Alt lo desactiva). */
  quantize: (beat: number, altKey: boolean) => number;
  /** Beats por compás, para la longitud por defecto de una sección nueva. */
  barLen: number;
  /** Selecciona los clips que empiezan dentro de un tramo. */
  onSelectSpan: (from: number, to: number) => void;
}

export function SectionLane({
  project,
  beatToX,
  xToBeat,
  quantize,
  barLen,
  onSelectSpan,
}: SectionLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; sectionId: Id } | null>(null);
  const [shapeMenu, setShapeMenu] = useState<{ x: number; y: number } | null>(null);
  const themeVersion = useThemeVersion();

  const arrangementId = project.activeArrangementId;
  const sections = sectionsOf(project, arrangementId);

  /** Sección bajo esa x, y si el puntero está sobre su borde derecho. */
  const sectionAt = useCallback(
    (x: number): { section: ArrangementSection; edge: boolean } | null => {
      // Del final al principio: si dos se solapan manda la de encima.
      for (let i = sections.length - 1; i >= 0; i--) {
        const s = sections[i]!;
        const x0 = beatToX(s.start);
        const x1 = beatToX(s.start + s.length);
        if (x >= x0 && x <= x1) return { section: s, edge: x >= x1 - EDGE_PX };
      }
      return null;
    },
    [sections, beatToX],
  );

  // ── Dibujo ────────────────────────────────────────────────────────────────

  const draw = useCallback(() => {
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

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = col('--pl-ruler-bg');
    ctx.fillRect(0, 0, w, h);

    ctx.font = `10px ${css.fontFamily}`;
    ctx.textBaseline = 'middle';
    for (const s of sections) {
      const x0 = beatToX(s.start);
      const x1 = beatToX(s.start + s.length);
      if (x1 < 0 || x0 > w) continue;
      const color = s.color ?? (s.kind ? KIND_COLORS[s.kind] ?? DEFAULT_COLOR : DEFAULT_COLOR);
      const left = Math.max(0, x0);
      const width = Math.min(w, x1) - left;
      if (width <= 0) continue;

      ctx.globalAlpha = 0.3;
      ctx.fillStyle = color;
      ctx.fillRect(left, 1, width, h - 2);
      ctx.globalAlpha = 1;
      // Cantos: el izquierdo marca dónde empieza (es lo que se busca al leer
      // la forma de un vistazo) y el derecho es además el tirador.
      ctx.fillStyle = color;
      ctx.fillRect(left, 1, 2, h - 2);
      ctx.fillRect(Math.min(w, x1) - 2, 1, 2, h - 2);

      if (width > 26) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, 0, width - 4, h);
        ctx.clip();
        ctx.fillStyle = col('--pl-ruler-text');
        ctx.fillText(s.name, left + 6, h / 2 + 0.5);
        ctx.restore();
      }
    }

    // Lo que se está creando con el arrastre.
    const d = drag.current;
    if (d?.kind === 'create') {
      const x0 = beatToX(Math.min(d.from, d.to));
      const x1 = beatToX(Math.max(d.from, d.to));
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = col('--accent');
      ctx.fillRect(x0, 1, Math.max(1, x1 - x0), h - 2);
      ctx.globalAlpha = 1;
    }
  }, [sections, beatToX, themeVersion]);

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

  // ── Mutaciones ────────────────────────────────────────────────────────────

  const run = useCallback((commands: Command[], label: string) => {
    if (commands.length === 0) return;
    store.dispatch({ type: 'batch', label, commands }, { label });
  }, []);

  const rename = useCallback(
    (section: ArrangementSection) => {
      const raw = window.prompt('Nombre de la sección', section.name);
      if (raw === null) return;
      const name = raw.trim();
      if (!name || name === section.name) return;
      store.dispatch(
        { type: 'patchSections', patches: [{ id: section.id, name }] },
        { label: `Renombrar sección a "${name}"` },
      );
    },
    [],
  );

  // ── Gestos ────────────────────────────────────────────────────────────────

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const hit = sectionAt(x);

      if (e.button === 2) {
        if (hit) setMenu({ x: e.clientX, y: e.clientY, sectionId: hit.section.id });
        return;
      }
      if (e.button !== 0) return;
      capturePointer(canvas, e.pointerId);

      if (hit && hit.edge) {
        const s = hit.section;
        const end = s.start + s.length;
        const tracks = new Set(
          Object.values(project.playlistTracks)
            .filter((t) => t.arrangementId === arrangementId)
            .map((t) => t.id),
        );
        drag.current = {
          kind: 'resize',
          sectionId: s.id,
          length0: s.length,
          clips: Object.values(project.clips)
            .filter((c) => tracks.has(c.playlistTrackId) && c.start >= end - 1e-6)
            .map((c) => ({ id: c.id, start: c.start })),
          sections: sections
            .filter((o) => o.id !== s.id && o.start >= end - 1e-6)
            .map((o) => ({ id: o.id, start: o.start })),
          markers: Object.values(project.markers)
            .filter((m) => m.time >= end - 1e-6)
            .map((m) => ({ id: m.id, time: m.time })),
        };
        return;
      }
      if (hit) {
        const s = hit.section;
        const tracks = new Set(
          Object.values(project.playlistTracks)
            .filter((t) => t.arrangementId === arrangementId)
            .map((t) => t.id),
        );
        drag.current = {
          kind: 'move',
          sectionId: s.id,
          grab: xToBeat(x) - s.start,
          start0: s.start,
          clips: Object.values(project.clips)
            .filter(
              (c) =>
                tracks.has(c.playlistTrackId) &&
                c.start >= s.start - 1e-6 &&
                c.start < s.start + s.length - 1e-6,
            )
            .map((c) => ({ id: c.id, start: c.start })),
        };
        return;
      }
      const at = quantize(Math.max(0, xToBeat(x)), e.altKey);
      drag.current = { kind: 'create', from: at, to: at };
      draw();
    },
    [sectionAt, project, arrangementId, sections, xToBeat, quantize, draw],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const d = drag.current;

      if (!d) {
        const hit = sectionAt(x);
        canvas.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'crosshair';
        return;
      }

      if (d.kind === 'create') {
        drag.current = { ...d, to: quantize(Math.max(0, xToBeat(x)), e.altKey) };
        draw();
        return;
      }

      if (d.kind === 'move') {
        const start = Math.max(0, quantize(Math.max(0, xToBeat(x) - d.grab), e.altKey));
        const delta = start - d.start0;
        run(
          [
            { type: 'patchSections', patches: [{ id: d.sectionId, start }] },
            ...(d.clips.length > 0
              ? [
                  {
                    type: 'patchClips' as const,
                    patches: d.clips.map((c) => ({ id: c.id, start: Math.max(0, c.start + delta) })),
                  },
                ]
              : []),
          ],
          'Mover sección',
        );
        return;
      }

      // Resize: la sección crece y lo de detrás se va con ella.
      const s = project.sections[d.sectionId];
      if (!s) return;
      const end = quantize(Math.max(s.start + 0.25, xToBeat(x)), e.altKey);
      const length = Math.max(0.25, end - s.start);
      const delta = length - d.length0;
      run(
        [
          { type: 'patchSections', patches: [{ id: d.sectionId, length }] },
          ...(d.clips.length > 0
            ? [
                {
                  type: 'patchClips' as const,
                  patches: d.clips.map((c) => ({ id: c.id, start: Math.max(0, c.start + delta) })),
                },
              ]
            : []),
          ...(d.sections.length > 0
            ? [
                {
                  type: 'patchSections' as const,
                  patches: d.sections.map((o) => ({ id: o.id, start: Math.max(0, o.start + delta) })),
                },
              ]
            : []),
          ...d.markers.map((m) => ({
            type: 'patchMarker' as const,
            markerId: m.id,
            patch: { time: Math.max(0, m.time + delta) },
          })),
        ],
        'Estirar sección',
      );
    },
    [sectionAt, xToBeat, quantize, draw, run, project],
  );

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'create') {
      const from = Math.min(d.from, d.to);
      const to = Math.max(d.from, d.to);
      // Un clic suelto crea una sección de un compás: crear con arrastre milimé-
      // trico dejaría secciones de medio beat imposibles de agarrar después.
      const length = to - from < 0.25 ? barLen : to - from;
      const section: ArrangementSection = {
        id: newId(),
        arrangementId,
        name: `Sección ${sections.length + 1}`,
        start: from,
        length,
      };
      store.dispatch(
        { type: 'addSections', sections: [section] },
        { label: `Sección "${section.name}"` },
      );
    }
    draw();
  }, [arrangementId, sections.length, barLen, draw]);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const hit = sectionAt(e.clientX - canvas.getBoundingClientRect().left);
      if (hit) rename(hit.section);
    },
    [sectionAt, rename],
  );

  /**
   * Escribe una forma entera del generador. Si ya hay secciones dibujadas, se
   * pregunta: rellenar la estructura de un tema empezado se lleva por delante
   * la que ya estaba, y eso no se adivina desde un botón.
   */
  const applyShape = useCallback(
    (index: number) => {
      if (
        sections.length > 0 &&
        !window.confirm(
          `Ya hay ${sections.length} sección(es) dibujadas. ¿Sustituirlas por la forma "${SHAPE_LABELS[index] ?? index + 1}"?`,
        )
      ) {
        return;
      }
      const fresh = sectionsFromShape(arrangementId, shapeToSpec(index), barLen);
      run(
        [
          ...(sections.length > 0
            ? [{ type: 'removeSections' as const, sectionIds: sections.map((s) => s.id) }]
            : []),
          { type: 'addSections', sections: fresh },
        ],
        `Estructura "${SHAPE_LABELS[index] ?? index + 1}"`,
      );
      setShapeMenu(null);
    },
    [sections, arrangementId, barLen, run],
  );

  const menuSection = menu ? project.sections[menu.sectionId] : undefined;

  return (
    <div className="pl-sections">
      <button
        className="pl-sections-corner"
        style={{ height: SECTION_LANE_H }}
        title="La forma del tema: arrastra en la franja para crear una sección, o elige una estructura hecha"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setShapeMenu({ x: r.left, y: r.bottom });
        }}
      >
        Secciones ▾
      </button>
      <div className="pl-sections-wrap" ref={wrapRef} style={{ height: SECTION_LANE_H }}>
        <canvas
          ref={canvasRef}
          className="pl-sections-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      {shapeMenu && (
        <MenuPortal
          anchor={wrapRef.current}
          x={shapeMenu.x}
          y={shapeMenu.y}
          onClose={() => setShapeMenu(null)}
          className="param-menu"
        >
          {Array.from({ length: SHAPE_COUNT }, (_, i) => (
            <SectionMenuItem
              key={i}
              label={`Estructura: ${SHAPE_LABELS[i] ?? `Forma ${i + 1}`}`}
              hint={shapeToSpec(i)
                .map((x) => `${x.name} (${x.bars})`)
                .join(' · ')}
              onRun={() => applyShape(i)}
            />
          ))}
          {sections.length > 0 && (
            <>
              <div className="menu-sep" />
              <SectionMenuItem
                label="Quitar todas las secciones"
                hint="Solo las etiquetas: los clips se quedan donde están"
                onRun={() => {
                  run(
                    [{ type: 'removeSections', sectionIds: sections.map((x) => x.id) }],
                    'Quitar las secciones',
                  );
                  setShapeMenu(null);
                }}
              />
            </>
          )}
        </MenuPortal>
      )}
      {menu && menuSection && (
        <MenuPortal
          anchor={canvasRef.current}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          className="param-menu"
        >
          <SectionMenuItem
            label="Duplicar con sus clips"
            hint="Copia la sección detrás de sí misma y empuja lo que venía después"
            onRun={() => {
              run(
                duplicateSectionCommands(project, menuSection.id),
                `Duplicar "${menuSection.name}"`,
              );
              setMenu(null);
            }}
          />
          <SectionMenuItem
            label="Seleccionar sus clips"
            onRun={() => {
              onSelectSpan(menuSection.start, menuSection.start + menuSection.length);
              setMenu(null);
            }}
          />
          <SectionMenuItem
            label="Renombrar…"
            onRun={() => {
              rename(menuSection);
              setMenu(null);
            }}
          />
          <label className="param-menu-item pl-section-color">
            Color
            <input
              type="color"
              value={
                menuSection.color ??
                (menuSection.kind ? KIND_COLORS[menuSection.kind] ?? DEFAULT_COLOR : DEFAULT_COLOR)
              }
              onChange={(e) =>
                store.dispatch(
                  { type: 'patchSections', patches: [{ id: menuSection.id, color: e.target.value }] },
                  { label: 'Color de sección', mergeKey: `sec:color:${menuSection.id}` },
                )
              }
            />
          </label>
          <div className="menu-sep" />
          <SectionMenuItem
            label="Quitar la sección"
            hint="Solo la etiqueta: los clips se quedan donde están"
            onRun={() => {
              run(
                removeSectionCommands(project, menuSection.id),
                `Quitar sección "${menuSection.name}"`,
              );
              setMenu(null);
            }}
          />
          <SectionMenuItem
            label="Borrar con sus clips"
            onRun={() => {
              run(
                removeSectionCommands(project, menuSection.id, { withClips: true }),
                `Borrar "${menuSection.name}" con sus clips`,
              );
              setMenu(null);
            }}
          />
          <SectionMenuItem
            label="Borrar y cerrar el hueco"
            hint="Se lleva los clips y tira de todo lo que venía detrás"
            onRun={() => {
              run(
                removeSectionCommands(project, menuSection.id, { withClips: true, ripple: true }),
                `Borrar "${menuSection.name}" y cerrar`,
              );
              setMenu(null);
            }}
          />
        </MenuPortal>
      )}
    </div>
  );
}

function SectionMenuItem({
  label,
  hint,
  onRun,
}: {
  label: string;
  hint?: string;
  onRun: () => void;
}): ReactNode {
  return (
    <button className="param-menu-item" title={hint} onClick={onRun}>
      {label}
    </button>
  );
}
