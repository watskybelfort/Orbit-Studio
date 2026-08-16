/**
 * Ventana interna (como las de FL): movible, redimensionable, con foco/z-order.
 * En tema acrílico usa la clase .popup (único sitio permitido para blur).
 */

import { useCallback, useRef, type ReactNode } from 'react';
import { useDetachedStore } from '../state/detached';
import { useUiStore, type WindowId } from '../state/ui';
import { capturePointer } from '../widgets/pointer';
import { DetachedWindow } from './DetachedWindow';
import './shell.css';

export interface InternalWindowProps {
  id: WindowId;
  title: string;
  children: ReactNode;
  minW?: number;
  minH?: number;
}

export function InternalWindow({ id, title, children, minW = 320, minH = 200 }: InternalWindowProps) {
  const win = useUiStore((s) => s.windows[id]);
  const focusWindow = useUiStore((s) => s.focusWindow);
  const closeWindow = useUiStore((s) => s.closeWindow);
  const moveWindow = useUiStore((s) => s.moveWindow);
  const resizeWindow = useUiStore((s) => s.resizeWindow);
  const isDetached = useDetachedStore((s) => s.detached[id] === true);
  const detach = useDetachedStore((s) => s.detach);
  const attach = useDetachedStore((s) => s.attach);

  const drag = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; x: number; y: number; w: number; h: number } | null>(null);

  const onTitlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('.iw-close, .iw-detach')) return;
      capturePointer(e.currentTarget as HTMLElement, e.pointerId);
      drag.current = { mode: 'move', startX: e.clientX, startY: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
    },
    [win.x, win.y, win.w, win.h],
  );

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      capturePointer(e.currentTarget as HTMLElement, e.pointerId);
      drag.current = { mode: 'resize', startX: e.clientX, startY: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
    },
    [win.x, win.y, win.w, win.h],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === 'move') {
        moveWindow(id, Math.max(0, d.x + dx), Math.max(0, d.y + dy));
      } else {
        resizeWindow(id, Math.max(minW, d.w + dx), Math.max(minH, d.h + dy));
      }
    },
    [id, moveWindow, resizeWindow, minW, minH],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  if (!win.open) return null;

  // Desacoplada: el editor vive en una ventana NATIVA aparte; la X nativa
  // (o el botón de re-acoplar de aquí no existe: es el cierre) lo devuelve.
  if (isDetached) {
    return (
      <DetachedWindow
        name={id}
        title={title}
        width={win.w}
        height={win.h}
        onClose={() => attach(id)}
      >
        {children}
      </DetachedWindow>
    );
  }

  return (
    <section
      className="iw popup"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDown={() => focusWindow(id)}
    >
      <header
        className="iw-title"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="iw-title-text">{title}</span>
        <button
          className="iw-detach"
          title="Sacar a una ventana aparte (la X nativa la devuelve aquí)"
          onClick={() => detach(id)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M3.5 1 H9 V6.5 M9 1 L4.5 5.5 M1 3.5 V9 H6.5"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
            />
          </svg>
        </button>
        <button
          className="iw-close"
          title="Cerrar"
          onClick={() => closeWindow(id)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </header>
      <div className="iw-body">{children}</div>
      <div
        className="iw-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </section>
  );
}
