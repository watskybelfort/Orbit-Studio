/**
 * Contenedor de menús flotantes (contextuales y desplegables).
 *
 * Existe porque los menús "que a veces no funcionan" casi nunca están rotos:
 * están PINTADOS DONDE NO SE VEN. Un `position: fixed` deja de referirse al
 * viewport en cuanto un ancestro tiene `transform`, `will-change` o
 * `backdrop-filter` — y la app tiene los tres: las ventanas internas llevan
 * blur en tema acrílico, las cabeceras de la playlist llevan transform de
 * scroll. Con el ancestro convertido en contenedor, el menú se coloca contra
 * una caja de 140 px y su `overflow: hidden` lo recorta entero.
 *
 * Este componente lo saca de ahí:
 * - lo lleva por portal al `body` del documento del ancla, así que también
 *   funciona dentro de una ventana desacoplada;
 * - lo coloca midiéndolo de verdad y lo mete dentro de ESA ventana (no de la
 *   principal, que es lo que hacía que en una ventana desacoplada saliera
 *   fuera de pantalla);
 * - escucha el cierre en el `window` correcto.
 *
 * No cierra por `blur`: perder el foco no es motivo para cerrar un menú, y ese
 * listener hacía desaparecer el menú al abrir un selector de color nativo.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Los menús van por encima de todo lo demás de la app. */
export const MENU_Z = 4000;

export interface MenuPortalProps {
  /**
   * Cualquier elemento del editor que abre el menú: solo se usa para saber en
   * qué documento hay que pintarlo. Null = ventana principal.
   */
  anchor?: Element | null;
  /** Posición deseada en coordenadas de viewport (clientX/clientY). */
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}

export function MenuPortal({
  anchor,
  x,
  y,
  onClose,
  className = '',
  children,
}: MenuPortalProps) {
  const doc = anchor?.ownerDocument ?? document;
  const view = doc.defaultView ?? window;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const [measured, setMeasured] = useState(false);

  // Colocar midiendo: el alto de un menú depende de cuántas opciones tenga, y
  // adivinarlo con una constante es justo lo que dejaba media lista fuera.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const maxX = Math.max(4, view.innerWidth - w - 4);
    const maxY = Math.max(4, view.innerHeight - h - 4);
    setPos({ x: Math.max(4, Math.min(x, maxX)), y: Math.max(4, Math.min(y, maxY)) });
    setMeasured(true);
  }, [x, y, view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    view.addEventListener('pointerdown', onClose);
    view.addEventListener('keydown', onKey);
    view.addEventListener('resize', onClose);
    return () => {
      view.removeEventListener('pointerdown', onClose);
      view.removeEventListener('keydown', onKey);
      view.removeEventListener('resize', onClose);
    };
  }, [onClose, view]);

  return createPortal(
    <div
      ref={ref}
      className={`popup menu-portal ${className}`.trim()}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: MENU_Z,
        // Hasta medirlo se pinta invisible: si no, se ve saltar de sitio.
        visibility: measured ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    doc.body,
  );
}
