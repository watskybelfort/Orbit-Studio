/**
 * Graph editor de velocity del Channel Rack (el de FL, pero dentro del rack).
 *
 * Franja bajo los pasos: una barra por paso del canal elegido, con la altura
 * de su velocity. Arrastrar pinta varias seguidas; el botón derecho devuelve
 * los pasos que toca al valor normal (0.8). NUNCA crea notas: si la celda está
 * vacía, el arrastre pasa de largo.
 *
 * Undo: todo el arrastre es UNA entrada. Se dispara un `patchNotes` por
 * movimiento (para verlo y oírlo al vuelo) con el mismo `mergeKey`, y cada
 * dispatch lleva TODOS los pasos del canal —no solo el que se acaba de tocar—
 * porque el store fusiona la ráfaga conservando el inverso del PRIMER comando:
 * si ese inverso no cubriera todos los pasos, deshacer dejaría a medias los
 * que se pintaron después.
 */

import { useRef } from 'react';
import type { Channel, Id, Note, NotePatch } from '@orbit/core';
import { store } from '../../state/app';
import { capturePointer } from '../../widgets/pointer';
import { DEFAULT_VELOCITY, isMelodic, stepIndexOf } from './steps';

/** Velocity mínima editable (0 = nota muda; mejor dejar un hilo de señal). */
const MIN_VELOCITY = 0.05;
/** Cambio por debajo del cual no merece la pena despachar. */
const VELOCITY_EPS = 0.004;

export interface VelocityGraphProps {
  channel: Channel;
  patternId: Id;
  notes: readonly Note[];
  steps: number;
  /** Paso bajo el playhead, o -1. */
  playStep: number;
}

/** Columna bajo el puntero; si cae en un hueco, la más cercana. */
function columnAt(container: HTMLElement, clientX: number): number {
  const kids = container.children;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < kids.length; i++) {
    const rect = kids[i]!.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right) return i;
    const dist = clientX < rect.left ? rect.left - clientX : clientX - rect.right;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function VelocityGraph({ channel, patternId, notes, steps, playStep }: VelocityGraphProps) {
  const barsRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  /** mergeKey del arrastre en curso (uno nuevo por gesto). */
  const gesture = useRef('');
  /** Velocities ya aplicadas en este gesto: sobreviven a renders a medio camino. */
  const touched = useRef(new Map<string, number>());

  // La fila del canal enseña mini-preview cuando hay melodía: aquí, coherencia.
  const melodic = notes.some(isMelodic);

  const cells: Note[][] = Array.from({ length: steps }, () => []);
  if (!melodic) {
    for (const n of notes) {
      const i = stepIndexOf(n);
      if (i >= 0 && i < steps) cells[i]?.push(n);
    }
  }
  const stepNotes = cells.flat();

  const applyAt = (clientX: number, clientY: number, reset: boolean) => {
    const el = barsRef.current;
    if (!el) return;
    const index = columnAt(el, clientX);
    const cell = index >= 0 ? cells[index] : undefined;
    if (!cell || cell.length === 0) return; // celda vacía: no se inventan notas

    const rect = el.getBoundingClientRect();
    const raw = (rect.bottom - clientY) / Math.max(1, rect.height);
    const velocity = reset ? DEFAULT_VELOCITY : Math.min(1, Math.max(MIN_VELOCITY, raw));

    const changed = cell.some(
      (n) => Math.abs((touched.current.get(n.id) ?? n.velocity) - velocity) > VELOCITY_EPS,
    );
    if (!changed) return;
    for (const n of cell) touched.current.set(n.id, velocity);

    const patches: NotePatch[] = stepNotes.map((n) => ({
      id: n.id,
      velocity: touched.current.get(n.id) ?? n.velocity,
    }));
    store.dispatch(
      { type: 'patchNotes', patternId, channelId: channel.id, patches },
      { label: `Velocity de ${channel.name}`, mergeKey: gesture.current },
    );
  };

  const endDrag = () => {
    dragging.current = false;
    touched.current.clear();
  };

  return (
    <div className="rack-graph">
      <div className="rack-graph-lead">
        <span className="rack-graph-name" style={{ borderLeftColor: channel.color }}>
          {channel.name}
        </span>
        <span className="rack-graph-hint">velocity</span>
      </div>
      {melodic ? (
        <div className="rack-graph-melodic">
          Este canal lleva melodía — sus velocities se editan en el Piano Roll.
        </div>
      ) : (
        <div
          className="rack-graph-bars"
          ref={barsRef}
          title="Arrastrar: pintar velocity · clic derecho: volver a 0.8"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 2) return;
            e.preventDefault();
            capturePointer(e.currentTarget, e.pointerId);
            dragging.current = true;
            touched.current = new Map();
            gesture.current = `rack:vel:${channel.id}:${Date.now()}`;
            applyAt(e.clientX, e.clientY, e.button === 2);
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            applyAt(e.clientX, e.clientY, (e.buttons & 2) !== 0);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          {cells.map((cell, i) => {
            const note = cell[0];
            const cls = [
              'rack-gcell',
              Math.floor(i / 4) % 2 === 0 ? 'ga' : 'gb',
              i % 4 === 0 && i > 0 ? 'gs' : '',
              i === playStep ? 'ph' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={i}
                className={cls}
                title={
                  note
                    ? `Paso ${i + 1} · velocity ${Math.round(note.velocity * 100)}%`
                    : `Paso ${i + 1} · vacío`
                }
              >
                {note && (
                  <div
                    className="rack-gbar"
                    style={{
                      height: `${Math.max(4, note.velocity * 100)}%`,
                      background: channel.color,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
