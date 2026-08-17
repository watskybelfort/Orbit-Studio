/**
 * Ventana interna (como las de FL): movible, redimensionable, con foco/z-order.
 * En tema acrílico usa la clase .popup (único sitio permitido para blur).
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
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
  /** Suelta los listeners del documento cuando el gesto va sin captura. */
  const release = useRef<(() => void) | null>(null);

  /** Aplica el gesto en curso a partir de unas coordenadas de puntero. */
  const applyDrag = useCallback(
    (clientX: number, clientY: number) => {
      const d = drag.current;
      if (!d) return;
      const dx = clientX - d.startX;
      const dy = clientY - d.startY;
      if (d.mode === 'move') {
        moveWindow(id, Math.max(0, d.x + dx), Math.max(0, d.y + dy));
      } else {
        resizeWindow(id, Math.max(minW, d.w + dx), Math.max(minH, d.h + dy));
      }
    },
    [id, moveWindow, resizeWindow, minW, minH],
  );

  /**
   * Fin del gesto. Se cuelga también de `pointercancel` y
   * `lostpointercapture`: si el sistema se lleva el puntero (gesto táctil,
   * Alt+Tab, un menú nativo) no llega ningún `pointerup`, y la ventana se
   * quedaba enganchada al ratón — moverlo la seguía arrastrando sin tener
   * ningún botón pulsado. Es idempotente, así que el pointerup normal seguido
   * del lostpointercapture no molesta.
   */
  const onPointerUp = useCallback(() => {
    drag.current = null;
    release.current?.();
    release.current = null;
  }, []);

  /**
   * Arranca un gesto. Si `setPointerCapture` no cuaja (punteros sintéticos del
   * QA, dedos que ya se levantaron), el elemento deja de recibir eventos en
   * cuanto el ratón sale de sus 30 px de cabecera y la ventana se quedaba a
   * medio camino: por eso, y SOLO en ese caso, se sigue el gesto en el
   * documento.
   */
  const beginDrag = useCallback(
    (e: React.PointerEvent, mode: 'move' | 'resize') => {
      drag.current = { mode, startX: e.clientX, startY: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
      release.current?.();
      release.current = null;
      if (capturePointer(e.currentTarget, e.pointerId)) return;
      const doc = e.currentTarget.ownerDocument;
      const move = (ev: PointerEvent) => applyDrag(ev.clientX, ev.clientY);
      const up = () => onPointerUp();
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', up);
      doc.addEventListener('pointercancel', up);
      release.current = () => {
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerup', up);
        doc.removeEventListener('pointercancel', up);
      };
    },
    [win.x, win.y, win.w, win.h, applyDrag, onPointerUp],
  );

  const onTitlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('.iw-close, .iw-detach')) return;
      beginDrag(e, 'move');
    },
    [beginDrag],
  );

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      beginDrag(e, 'resize');
    },
    [beginDrag],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => applyDrag(e.clientX, e.clientY),
    [applyDrag],
  );

  // La ventana se desmonta (cerrar, desacoplar) a mitad de arrastre: los
  // listeners del documento no pueden quedarse sueltos.
  useEffect(() => () => release.current?.(), []);

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
      // En CADA pointerdown, y sale barato: si la ventana ya está arriba el
      // store devuelve el MISMO objeto de estado y zustand ni avisa a los
      // suscriptores (comprobación `Object.is`), así que no se repinta nada.
      onPointerDown={() => focusWindow(id)}
    >
      <header
        className="iw-title"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
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
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      />
    </section>
  );
}
