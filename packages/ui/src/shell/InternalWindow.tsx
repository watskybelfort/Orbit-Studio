/**
 * Ventana interna (como las de FL): movible, redimensionable, con foco/z-order.
 * En tema acrílico usa la clase .popup (único sitio permitido para blur).
 *
 * Ergonomía de escritorio: maximizar/restaurar (botón, doble clic y atajos) y
 * acople a mitad de pantalla al arrastrar contra un borde. La geometría pura
 * vive en `window-bounds.ts`, las acciones en `state/window-actions.ts`; aquí
 * solo quedan los gestos y el dibujo.
 */

import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDetachedStore } from '../state/detached';
import { useUiStore, type WindowId } from '../state/ui';
import { registerWindowMinimum } from '../state/window-minimums';
import { isMarkedMaximized } from '../state/window-restore';
import {
  maximizeWindow,
  refreshMaximizedWindow,
  tileWindow,
  toggleMaximizeWindow,
} from '../state/window-actions';
import { capturePointer } from '../widgets/pointer';
import { DetachedWindow } from './DetachedWindow';
import { WorkspaceAreaContext } from './WorkspaceArea';
import {
  clampResize,
  fitWindowToWorkspace,
  isMaximizedBox,
  maximizeBox,
  snapZoneAt,
  tileBox,
  type SnapZone,
} from './window-bounds';
import { EDITOR_GUIDES } from './editor-guides';
import './studio-guide.css';
import './shell.css';
import './window-ergonomics.css';

export interface InternalWindowProps {
  id: WindowId;
  title: string;
  children: ReactNode;
  minW?: number;
  minH?: number;
}

/** Recto del escritorio en coordenadas de viewport (las de `clientX/clientY`). */
interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Previsualización de acople ya resuelta a coordenadas de pantalla. */
interface SnapPreview extends ViewportRect {
  side: SnapZone;
}

interface DragState {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Escritorio medido al empezar; solo en un arrastre acoplable. */
  workspace: ViewportRect | null;
}

/**
 * Separación máxima entre los dos clics de un doble clic, en px. El navegador
 * ya trae su propio umbral, pero además comprobamos la posición del último
 * `pointerdown`: un arrastre que termina encima de la cabecera puede disparar
 * `dblclick` y maximizar sin que el usuario lo haya pedido.
 */
const DOUBLE_CLICK_SLOP = 4;

/**
 * Movimiento mínimo para considerar que hubo arrastre. Sin esto, un clic seco
 * en la cabecera de una ventana pegada al borde superior ya caía dentro de la
 * franja de acople y maximizaba sin que el usuario hubiera movido el ratón.
 */
const SNAP_SLOP = 4;

function viewportRectOf(element: Element): ViewportRect | null {
  const workspace = element.closest('.workspace');
  if (!(workspace instanceof HTMLElement)) return null;
  const rect = workspace.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function InternalWindow({ id, title, children, minW = 320, minH = 200 }: InternalWindowProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [preview, setPreview] = useState<SnapPreview | null>(null);
  const win = useUiStore((s) => s.windows[id]);
  const focusWindow = useUiStore((s) => s.focusWindow);
  const closeWindow = useUiStore((s) => s.closeWindow);
  const moveWindow = useUiStore((s) => s.moveWindow);
  const resizeWindow = useUiStore((s) => s.resizeWindow);
  const isDetached = useDetachedStore((s) => s.detached[id] === true);
  const detach = useDetachedStore((s) => s.detach);
  const attach = useDetachedStore((s) => s.attach);
  const area = useContext(WorkspaceAreaContext);
  const minimum = { w: minW, h: minH };
  // El mínimo real de este editor queda disponible para los atajos y el
  // acople. La tabla vive en Workspace.tsx; registrarla aquí evita duplicarla
  // (y que un editor nuevo se olvide de apuntarla en dos sitios).
  useEffect(() => {
    registerWindowMinimum(id, { w: minW, h: minH });
  }, [id, minW, minH]);
  // El área útil cambió (panel abierto/cerrado, asa de un panel, escala): una
  // ventana maximizada tiene que seguir cubriéndola. Refrescar escribe el
  // store, no el área, así que este efecto no se vuelve a disparar solo.
  useEffect(() => {
    if (!area || isDetached) return;
    refreshMaximizedWindow(id, area, { w: minW, h: minH });
  }, [area, id, minW, minH, isDetached]);
  // Una caja que coincide con el área NO es una ventana maximizada: puede venir
  // de un layout o de workspace-memory guardando una geometría grande, y sin
  // marca no hay caja de vuelta. Con el fallback geométrico el botón diría
  // «Restaurar» sin hacer nada y el asa no se pintaría, dejando el editor
  // clavado ocupando el escritorio. La marca es la única fuente de verdad de la
  // UI; la comparación geométrica sigue en `window-actions` como dato, pero no
  // decide gestos ni botones.
  const maximized = !isDetached && isMarkedMaximized(id);
  // La ventana nativa tiene su propio monitor y tamaño: solo acotamos internas.
  const box = maximized && area
    ? maximizeBox(area, minimum)
    : fitWindowToWorkspace(win, isDetached ? null : area, minimum);
  // Ocupa el escritorio SIN marca: la memoria de una versión anterior guardó la
  // geometría maximizada y la marca no sobrevive al reinicio. «Maximizar» no
  // tendría nada que hacer ahí, así que el botón se deshabilita con el porqué en
  // el título en vez de quedarse como un control que no responde. La ventana
  // sigue viva, pero moverse no puede: una caja que llena el área no tiene adónde
  // desplazarse (`fitWindowToWorkspace` la devuelve a 0,0); el asa sí la achica,
  // y eso es lo que la saca del estado. `workspace-memory` ya no vuelve a crear
  // este caso: guarda la caja de descanso de una maximizada.
  const fillsWorkspace = !isDetached && !maximized && area !== null && isMaximizedBox(box, area);

  const drag = useRef<DragState | null>(null);
  /** Última zona bajo el puntero; el `pointerup` la aplica si sigue vigente. */
  const snapSide = useRef<SnapZone | null>(null);
  /** Posición del último pointerdown en la cabecera, para filtrar el doble clic. */
  const lastTitleDown = useRef<{ x: number; y: number } | null>(null);
  /** Suelta los listeners del documento cuando el gesto va sin captura. */
  const release = useRef<(() => void) | null>(null);

  /**
   * Muestra (o quita) la previsualización de acople. El setter compara contra
   * la anterior: mover el ratón dentro de la misma franja no repinta nada.
   */
  const showPreview = useCallback(
    (side: SnapZone | null, workspace: ViewportRect) => {
      snapSide.current = side;
      setPreview((previous) => {
        if (side === null) return previous === null ? previous : null;
        const local = tileBox({ w: workspace.width, h: workspace.height }, side, { w: minW, h: minH });
        const next: SnapPreview = {
          side,
          left: workspace.left + local.x,
          top: workspace.top + local.y,
          width: local.w,
          height: local.h,
        };
        if (
          previous
          && previous.side === next.side
          && previous.left === next.left
          && previous.top === next.top
          && previous.width === next.width
          && previous.height === next.height
        ) return previous;
        return next;
      });
    },
    // `minW`/`minH` son números sueltos a propósito: dos props equivalentes al
    // objeto `minimum` pero con identidad estable entre renders, así el gesto
    // no reinicia sus listeners cada vez que se repinta la ventana.
    [minW, minH],
  );

  /** Aplica el gesto en curso a partir de unas coordenadas de puntero. */
  const applyDrag = useCallback(
    (clientX: number, clientY: number) => {
      const d = drag.current;
      if (!d) return;
      const dx = clientX - d.startX;
      const dy = clientY - d.startY;
      if (d.mode === 'move') {
        moveWindow(id, Math.max(0, d.x + dx), Math.max(0, d.y + dy));
        // En desacoplada no hay acople: `workspace` solo se mide si es interna.
        if (d.workspace) {
          // Un clic seco no acopla: la cabecera de una ventana pegada al borde
          // superior cae dentro de la franja y maximizaba sin mover el ratón.
          const dragged = Math.abs(dx) > SNAP_SLOP || Math.abs(dy) > SNAP_SLOP;
          const zone = dragged
            ? snapZoneAt(
              { x: clientX, y: clientY },
              { x: d.workspace.left, y: d.workspace.top, w: d.workspace.width, h: d.workspace.height },
            )
            : null;
          showPreview(zone, d.workspace);
        }
      } else {
        const next = clampResize(
          { x: d.x, y: d.y, w: d.w + dx, h: d.h + dy },
          isDetached ? null : area,
          { w: minW, h: minH },
        );
        resizeWindow(id, next.w, next.h);
      }
    },
    [id, moveWindow, resizeWindow, minW, minH, area, isDetached, showPreview],
  );

  /** Descarta el gesto sin aplicar acople (cancelación del sistema). */
  const cancelGesture = useCallback(() => {
    drag.current = null;
    snapSide.current = null;
    release.current?.();
    release.current = null;
    setPreview(null);
  }, []);

  /**
   * Fin normal del gesto: si el arrastre terminó en una franja de acople,
   * acopla o maximiza. Se recalcula con las coordenadas del `pointerup` porque
   * el último `pointermove` puede haber quedado unos píxeles atrás.
   */
  const endGesture = useCallback(
    (clientX?: number, clientY?: number) => {
      const d = drag.current;
      if (!d) {
        // `lostpointercapture` llega después del `pointerup`: idempotente.
        snapSide.current = null;
        setPreview((previous) => (previous === null ? previous : null));
        return;
      }
      let side = snapSide.current;
      if (d.mode === 'move' && d.workspace && clientX !== undefined && clientY !== undefined) {
        // Mismo umbral que en el movimiento: soltar sin haber arrastrado no
        // acopla, aunque el puntero esté en la franja.
        const dragged = Math.abs(clientX - d.startX) > SNAP_SLOP || Math.abs(clientY - d.startY) > SNAP_SLOP;
        side = dragged
          ? snapZoneAt(
            { x: clientX, y: clientY },
            { x: d.workspace.left, y: d.workspace.top, w: d.workspace.width, h: d.workspace.height },
          )
          : null;
      }
      drag.current = null;
      snapSide.current = null;
      release.current?.();
      release.current = null;
      setPreview((previous) => (previous === null ? previous : null));
      if (d.mode === 'move' && side !== null && area) {
        if (side === 'top') maximizeWindow(id, area, { w: minW, h: minH });
        else tileWindow(id, side, area, { w: minW, h: minH });
      }
    },
    [id, area, minW, minH],
  );

  /**
   * Arranca un gesto. Si `setPointerCapture` no cuaja (punteros sintéticos del
   * QA, dedos que ya se levantaron), el elemento deja de recibir eventos en
   * cuanto el ratón sale de sus 30 px de cabecera y la ventana se quedaba a
   * medio camino: por eso, y SOLO en ese caso, se sigue el gesto en el
   * documento.
   */
  const beginDrag = useCallback(
    (e: React.PointerEvent, mode: 'move' | 'resize') => {
      drag.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        // Se mide una vez al empezar: el escritorio no se mueve durante el
        // gesto, y leer el rect en cada pointermove forzaría layout.
        workspace: mode === 'move' && !isDetached ? viewportRectOf(e.currentTarget) : null,
      };
      release.current?.();
      release.current = null;
      if (capturePointer(e.currentTarget, e.pointerId)) return;
      const doc = e.currentTarget.ownerDocument;
      const move = (ev: PointerEvent) => applyDrag(ev.clientX, ev.clientY);
      const up = (ev: PointerEvent) => endGesture(ev.clientX, ev.clientY);
      const cancel = () => cancelGesture();
      doc.addEventListener('pointermove', move);
      doc.addEventListener('pointerup', up);
      doc.addEventListener('pointercancel', cancel);
      release.current = () => {
        doc.removeEventListener('pointermove', move);
        doc.removeEventListener('pointerup', up);
        doc.removeEventListener('pointercancel', cancel);
      };
    },
    [box.x, box.y, box.w, box.h, applyDrag, endGesture, cancelGesture, isDetached],
  );

  const onTitlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) {
        lastTitleDown.current = null;
        return;
      }
      lastTitleDown.current = { x: e.clientX, y: e.clientY };
      // Maximizada no se arrastra: ya ocupa el escritorio y sacarla de ahí
      // dejaría una caja que el siguiente render recorta a la fuerza.
      if (maximized) return;
      beginDrag(e, 'move');
    },
    [beginDrag, maximized],
  );

  const onTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const down = lastTitleDown.current;
      lastTitleDown.current = null;
      // Sin pointerdown previo (doble clic sintético) o con el puntero movido:
      // no es un doble clic sobre la misma cabecera.
      if (!down) return;
      if (Math.abs(e.clientX - down.x) > DOUBLE_CLICK_SLOP || Math.abs(e.clientY - down.y) > DOUBLE_CLICK_SLOP) {
        return;
      }
      if (!area) return;
      toggleMaximizeWindow(id, area, { w: minW, h: minH });
    },
    [id, area, minW, minH],
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

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => endGesture(e.clientX, e.clientY),
    [endGesture],
  );

  // La ventana se desmonta (cerrar, desacoplar) a mitad de arrastre: los
  // listeners del documento no pueden quedarse sueltos. La previsualización se
  // va con el portal, pero el ref del gesto también se limpia.
  useEffect(() => () => {
    drag.current = null;
    release.current?.();
    release.current = null;
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
      className={`iw popup${maximized ? ' iw-is-max' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: win.z }}
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
        onDoubleClick={onTitleDoubleClick}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={cancelGesture}
      >
        <span className="iw-title-text">{title}</span>
        <button className="iw-help" aria-label={`Ayuda de ${title}`} aria-expanded={helpOpen} aria-controls={`editor-guide-${id}`} onClick={() => setHelpOpen(!helpOpen)}>?</button>
        <button
          className="iw-max"
          disabled={fillsWorkspace}
          aria-label={
            fillsWorkspace
              ? `${title} ya ocupa todo el escritorio`
              : maximized
                ? `Restaurar ${title}`
                : `Maximizar ${title}`
          }
          title={
            fillsWorkspace
              ? 'Ya ocupa todo el escritorio: achícala con el asa para moverla'
              : maximized
                ? 'Restaurar el tamaño anterior (doble clic en la cabecera)'
                : 'Maximizar (doble clic en la cabecera)'
          }
          onClick={() => {
            if (area) toggleMaximizeWindow(id, area, minimum);
          }}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="3" y="1" width="6" height="6" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <path d="M1 3 V9 H7 V3" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          )}
        </button>
        <button
          className="iw-detach"
          aria-label={`Sacar ${title} a una ventana aparte`}
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
          aria-label={`Cerrar ${title}`}
          title="Cerrar"
          onClick={() => closeWindow(id)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </header>
      {helpOpen && (
        <aside className="iw-guide" id={`editor-guide-${id}`} aria-label={`Cómo usar ${title}`}>
          <p>{EDITOR_GUIDES[id].purpose}</p>
          <ol>{EDITOR_GUIDES[id].steps.map((step) => <li key={step}>{step}</li>)}</ol>
        </aside>
      )}
      <div className="iw-body">{children}</div>
      {/* Maximizada: el asa no tiene nada que redimensionar y engaña al ratón. */}
      {!maximized && (
        <div
          className="iw-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={cancelGesture}
        />
      )}
      {preview && createPortal(
        <div
          className="iw-snap-preview"
          style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }}
          data-side={preview.side}
          aria-hidden="true"
        />,
        document.body,
      )}
    </section>
  );
}
