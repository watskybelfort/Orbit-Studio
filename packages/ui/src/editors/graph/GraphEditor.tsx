/**
 * Graph editor: el enrutado entero como nodos y cables, y recableable a mano.
 *
 * A la izquierda las fuentes (canales del rack y carriles con audio), luego
 * las pistas de mixer repartidas por columnas según lo lejos que estén del
 * master. Tres clases de cable: la entrada de una fuente, la SALIDA de una
 * pista (línea llena) y sus ENVÍOS (línea de puntos con su nivel).
 *
 * Recablear es arrastrar del puerto de un nodo a otro nodo:
 *  - puerto de un canal/carril → pista: cambia su pista de mixer;
 *  - puerto ▸ de una pista → otra pista: cambia a dónde desemboca;
 *  - puerto ⇢ de una pista → otra pista: le añade un envío.
 * Un cable que cerraría un bucle se pinta en rojo y no se guarda: el
 * compilador tolera los ciclos, pero lo que suena entonces no es lo que nadie
 * quería (ver `wouldLoop` en @orbit/core).
 *
 * La geometría vive aparte, en layout.ts, que es puro y está probado. Aquí
 * solo queda el pintado y el gesto.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { wouldLoop, type Id } from '@orbit/core';
import { store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { capturePointer } from '../../widgets/pointer';
import { layoutGraph, type GraphLink, type GraphNode } from './layout';
import './graph.css';

/** Nivel con el que nace un envío nuevo (el mismo que el menú del mixer). */
const SEND_DEFAULT = 0.7;
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.8;

interface Cable {
  /** Nodo del que sale. */
  from: GraphNode;
  /** 'route' desde el puerto de salida, 'send' desde el de envío. */
  kind: 'route' | 'send';
  /** Punta del cable, en coordenadas del lienzo. */
  x: number;
  y: number;
  /** Nodo bajo la punta, si lo hay. */
  over: GraphNode | null;
  /** El destino de debajo cerraría un bucle. */
  invalid: boolean;
}

/** Curva de Bézier horizontal entre dos puntos. */
function path(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

const outPort = (n: GraphNode): { x: number; y: number } => ({ x: n.x + n.w, y: n.y + n.h / 2 });
const inPort = (n: GraphNode): { x: number; y: number } => ({ x: n.x, y: n.y + n.h / 2 });
/** El envío sale por debajo de la salida para que los cables no se pisen. */
const sendPort = (n: GraphNode): { x: number; y: number } => ({ x: n.x + n.w, y: n.y + n.h - 12 });

function gainDb(level: number): string {
  if (level <= 0.0001) return '-inf';
  return `${(20 * Math.log10(level)).toFixed(1)}`;
}

export function GraphEditor() {
  const project = useProject();
  const selectedTrack = useUiStore((s) => s.selectedMixerTrack);
  const [showAllTracks, setShowAllTracks] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [cable, setCable] = useState<Cable | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const sendDrag = useRef<{ from: number; to: number; y: number; level: number } | null>(null);

  const layout = useMemo(() => layoutGraph(project, { showAllTracks }), [project, showAllTracks]);

  /** Coordenadas del lienzo a partir de un evento de puntero. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - view.x) / view.scale,
        y: (clientY - rect.top - view.y) / view.scale,
      };
    },
    [view],
  );

  /** Nodo que hay bajo un punto del lienzo (las cajas no se solapan). */
  const nodeAt = useCallback(
    (x: number, y: number): GraphNode | null =>
      layout.nodes.find((n) => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) ?? null,
    [layout],
  );

  // ── Recablear ─────────────────────────────────────────────────────────────

  /** ¿Vale este destino para el cable en curso? */
  const invalidFor = (from: GraphNode, kind: 'route' | 'send', target: GraphNode): boolean => {
    if (target.kind !== 'track') return true;
    if (from.kind !== 'track') return false; // una fuente puede ir a cualquier pista
    return wouldLoop(project.mixer, from.ref as number, target.ref as number);
  };

  const startCable = (e: React.PointerEvent, from: GraphNode, kind: 'route' | 'send') => {
    e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    const at = toCanvas(e.clientX, e.clientY);
    setCable({ from, kind, x: at.x, y: at.y, over: null, invalid: false });
  };

  const moveCable = (e: React.PointerEvent) => {
    if (!cable) return;
    const at = toCanvas(e.clientX, e.clientY);
    const over = nodeAt(at.x, at.y);
    const target = over && over.key !== cable.from.key ? over : null;
    setCable({
      ...cable,
      x: at.x,
      y: at.y,
      over: target,
      invalid: target !== null && invalidFor(cable.from, cable.kind, target),
    });
  };

  const dropCable = () => {
    if (!cable) return;
    const { from, kind, over, invalid } = cable;
    setCable(null);
    if (!over || invalid || over.kind !== 'track' || over.key === from.key) return;
    const target = over.ref as number;
    const targetName = project.mixer[target]?.name ?? `Insert ${target}`;

    if (from.kind === 'channel') {
      const channel = project.channels[from.ref as Id];
      if (!channel || channel.mixerTrack === target) return;
      store.dispatch(
        { type: 'patchChannel', channelId: from.ref as Id, patch: { mixerTrack: target } },
        { label: `${channel.name} → ${targetName}` },
      );
      return;
    }
    if (from.kind === 'lane') {
      const lane = project.playlistTracks[from.ref as Id];
      if (!lane || (lane.mixerTrack ?? 0) === target) return;
      store.dispatch(
        { type: 'patchPlaylistTrack', trackId: from.ref as Id, patch: { mixerTrack: target } },
        { label: `${lane.name} → ${targetName}` },
      );
      return;
    }
    const index = from.ref as number;
    if (kind === 'route') {
      if (project.mixer[index]?.routeTo === target) return;
      store.dispatch(
        { type: 'setRoute', trackIndex: index, routeTo: target },
        { label: `${from.label} → ${targetName}` },
      );
    } else {
      if (project.mixer[index]?.sends.some((s) => s.target === target)) return;
      store.dispatch(
        { type: 'setSend', trackIndex: index, target, level: SEND_DEFAULT },
        { label: `Envío de ${from.label} a ${targetName}` },
      );
    }
  };

  /** Quita un cable: el envío desaparece, la salida vuelve al master. */
  const cutLink = (link: GraphLink) => {
    if (link.kind === 'send') {
      store.dispatch(
        { type: 'setSend', trackIndex: link.from.ref as number, target: link.to.ref as number, level: null },
        { label: `Quitar envío de ${link.from.label}` },
      );
      return;
    }
    if (link.kind === 'route') {
      const index = link.from.ref as number;
      if (index === 0 || project.mixer[index]?.routeTo === 0) return;
      store.dispatch(
        { type: 'setRoute', trackIndex: index, routeTo: 0 },
        { label: `${link.from.label} → Master` },
      );
      return;
    }
    if (link.kind === 'channel') {
      const channel = project.channels[link.from.ref as Id];
      if (!channel || channel.mixerTrack === 0) return;
      store.dispatch(
        { type: 'patchChannel', channelId: link.from.ref as Id, patch: { mixerTrack: 0 } },
        { label: `${channel.name} → Master` },
      );
      return;
    }
    const lane = project.playlistTracks[link.from.ref as Id];
    if (!lane || (lane.mixerTrack ?? 0) === 0) return;
    store.dispatch(
      { type: 'patchPlaylistTrack', trackId: link.from.ref as Id, patch: { mixerTrack: 0 } },
      { label: `${lane.name} → Master` },
    );
  };

  // ── Nivel de un envío: arrastrar su chapa arriba/abajo ────────────────────

  const startSendDrag = (e: React.PointerEvent, link: GraphLink) => {
    e.stopPropagation();
    capturePointer(e.currentTarget, e.pointerId);
    sendDrag.current = {
      from: link.from.ref as number,
      to: link.to.ref as number,
      y: e.clientY,
      level: link.level ?? SEND_DEFAULT,
    };
  };

  const moveSendDrag = (e: React.PointerEvent) => {
    const drag = sendDrag.current;
    if (!drag) return;
    const level = Math.min(2, Math.max(0, drag.level + (drag.y - e.clientY) / 200));
    store.dispatch(
      { type: 'setSend', trackIndex: drag.from, target: drag.to, level },
      { label: 'Nivel de envío', mergeKey: `graph:send:${drag.from}:${drag.to}` },
    );
  };

  // ── Vista: pan con el fondo, zoom con la rueda ────────────────────────────

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    capturePointer(e.currentTarget, e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (cable) moveCable(e);
    else if (sendDrag.current) moveSendDrag(e);
    else if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, x: p.viewX + (e.clientX - p.x), y: p.viewY + (e.clientY - p.y) }));
    }
  };

  const onPointerUp = () => {
    if (cable) dropCable();
    sendDrag.current = null;
    pan.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      // El punto bajo el ratón se queda donde está.
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, scale };
    });
  };

  /** Encaja el grafo entero en la ventana. */
  const fit = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || layout.width === 0 || layout.height === 0) return;
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(rect.width / layout.width, rect.height / layout.height)),
    );
    setView({
      x: (rect.width - layout.width * scale) / 2,
      y: (rect.height - layout.height * scale) / 2,
      scale,
    });
  }, [layout.width, layout.height]);

  // Al abrir la ventana se encaja solo: si no, el master —que vive a la
  // derecha del todo— cae fuera y parece que el grafo se corta.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    fitted.current = true;
    fit();
  }, [fit]);

  const openNode = (node: GraphNode) => {
    const ui = useUiStore.getState();
    if (node.kind === 'track') {
      useUiStore.setState({ selectedMixerTrack: node.ref as number });
      ui.openWindow('mixer');
      return;
    }
    if (node.kind === 'channel') {
      useUiStore.setState({ channelEditorId: node.ref as Id, pianoRollChannelId: node.ref as Id });
      ui.openWindow('channelEditor');
      return;
    }
    ui.openWindow('playlist');
  };

  const selectNode = (node: GraphNode) => {
    if (node.kind === 'track') useUiStore.setState({ selectedMixerTrack: node.ref as number });
    else if (node.kind === 'channel') useUiStore.setState({ pianoRollChannelId: node.ref as Id });
  };

  return (
    <div className="graph">
      <div className="graph-bar">
        <button
          className={`graph-btn${showAllTracks ? ' on' : ''}`}
          title="Enseñar también los inserts que no usa nadie"
          onClick={() => setShowAllTracks((v) => !v)}
        >
          Ver todas
        </button>
        <button className="graph-btn" title="Encajar el grafo en la ventana" onClick={fit}>
          Ajustar
        </button>
        <span className="graph-zoom">{Math.round(view.scale * 100)}%</span>
        <span className="graph-hint">
          Arrastra del puerto de un nodo a otra pista para recablear · ▸ salida · ⇢ envío ·
          doble clic en un cable lo devuelve al master
        </span>
      </div>

      <div
        className="graph-view"
        ref={viewportRef}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="graph-canvas"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            width: layout.width,
            height: layout.height,
          }}
        >
          <svg className="graph-wires" width={layout.width} height={layout.height}>
            {layout.links.map((link) => {
              const a = link.kind === 'send' ? sendPort(link.from) : outPort(link.from);
              const b = inPort(link.to);
              const d = path(a.x, a.y, b.x, b.y);
              return (
                <g key={link.key} className={`graph-wire ${link.kind}`}>
                  <path className="wire-line" d={d} />
                  {/* Franja ancha e invisible: agarrar una curva de 2 px es imposible. */}
                  <path className="wire-hit" d={d} onDoubleClick={() => cutLink(link)} />
                </g>
              );
            })}
            {cable && (
              <path
                className={`graph-wire-temp${cable.invalid ? ' invalid' : ''}`}
                d={path(
                  (cable.kind === 'send' ? sendPort(cable.from) : outPort(cable.from)).x,
                  (cable.kind === 'send' ? sendPort(cable.from) : outPort(cable.from)).y,
                  cable.x,
                  cable.y,
                )}
              />
            )}
          </svg>

          {layout.links
            .filter((l) => l.kind === 'send')
            .map((link) => {
              const a = sendPort(link.from);
              const b = inPort(link.to);
              return (
                <button
                  key={`lvl:${link.key}`}
                  className="graph-send-level"
                  style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}
                  title="Arrastra arriba/abajo para el nivel · doble clic quita el envío"
                  onPointerDown={(e) => startSendDrag(e, link)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onDoubleClick={() => cutLink(link)}
                >
                  {gainDb(link.level ?? 0)}
                </button>
              );
            })}

          {layout.nodes.map((node) => {
            const isTrack = node.kind === 'track';
            const selected = isTrack && node.ref === selectedTrack;
            const target = cable?.over?.key === node.key;
            return (
              <div
                key={node.key}
                className={`graph-node ${node.kind}${selected ? ' sel' : ''}${
                  target ? (cable?.invalid ? ' bad-target' : ' target') : ''
                }`}
                style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  selectNode(node);
                }}
                onDoubleClick={() => openNode(node)}
              >
                <span className="graph-node-color" style={{ background: node.color }} />
                <span className="graph-node-label" title={node.label}>
                  {node.label}
                </span>
                {node.detail && <span className="graph-node-detail">{node.detail}</span>}
                {/* El master no sale a ningún sitio: no lleva puertos. */}
                {!(isTrack && node.ref === 0) && (
                  <span
                    className="graph-port out"
                    title={isTrack ? 'Salida: arrástrala a otra pista' : 'Arrástralo a su pista de mixer'}
                    onPointerDown={(e) => startCable(e, node, 'route')}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                  >
                    ▸
                  </span>
                )}
                {isTrack && node.ref !== 0 && (
                  <span
                    className="graph-port send"
                    title="Envío: arrástralo a la pista que lo recibe"
                    onPointerDown={(e) => startCable(e, node, 'send')}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                  >
                    ⇢
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
