/**
 * Asa vertical para redimensionar los paneles laterales.
 *
 * Va DENTRO del `<aside>` y flotando sobre su borde interior (`right:-4px` en
 * la biblioteca, `left:-4px` en Claude) para no gastar ni un píxel del
 * workspace: el ancho útil del editor sigue siendo el que era. El lado decide
 * qué significa arrastrar: en el panel izquierdo crecer es moverse a la
 * derecha; en el derecho, moverse a la izquierda.
 *
 * El gesto usa `capturePointer` como el resto del repo. Si la captura no cuaja
 * (punteros sintéticos del QA, un dedo que ya se levantó), se sigue en el
 * documento, o el asa moriría al primer píxel fuera de sus 8 px. El cierre
 * escucha `pointercancel` y `lostpointercapture`: Alt+Tab o un menú nativo no
 * mandan `pointerup` y el panel se quedaba pegado al ratón.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { capturePointer } from '../widgets/pointer';
import {
  flushPanelWidths,
  getPanelWidths,
  PANEL_WIDTH_LIMITS,
  resetPanelWidth,
  setPanelWidth,
  subscribePanelWidths,
  type PanelSide,
} from '../state/panel-widths';

interface PanelSplitterProps {
  side: PanelSide;
}

/** Píxeles por flecha; con Shift, el ajuste fino. */
const KEY_STEP = 16;
const KEY_FINE_STEP = 4;

const LABELS: Record<PanelSide, string> = {
  browser: 'Ajustar el ancho de la Biblioteca de sonidos',
  claude: 'Ajustar el ancho del panel de Claude',
};

export function PanelSplitter({ side }: PanelSplitterProps) {
  const width = useSyncExternalStore(subscribePanelWidths, () => getPanelWidths()[side]);
  const limits = PANEL_WIDTH_LIMITS[side];
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const releaseDoc = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Lleva el ancho al puntero. Positivo = crecer el panel, en su dirección. */
  const moveTo = (clientX: number) => {
    const current = drag.current;
    if (!current) return;
    const moved = clientX - current.startX;
    const delta = side === 'browser' ? moved : -moved;
    setPanelWidth(side, current.startWidth + delta);
  };

  /**
   * Fin del gesto. Idempotente: `pointerup` suele venir seguido de
   * `lostpointercapture`, y los dos tienen que poder llamarlo. `flush` escribe
   * el settings.json en el acto (sin los 400 ms del debounce): soltar es el
   * momento en que el ancho dejó de moverse.
   */
  const finish = useCallback(() => {
    const wasDragging = drag.current !== null;
    drag.current = null;
    releaseDoc.current?.();
    releaseDoc.current = null;
    setDragging(false);
    if (wasDragging) flushPanelWidths();
  }, []);

  // Si el panel se desmonta a mitad de arrastre (modo compacto), los listeners
  // del documento se quedarían vivos y el asa fantasma seguiría cambiando el
  // ancho. Mismo cierre que `InternalWindow`.
  useEffect(() => () => releaseDoc.current?.(), []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Sin el preventDefault el navegador inicia selección de texto al mover; el
    // foco se pide a mano porque precisamente ese preventDefault se lo quita.
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { startX: event.clientX, startWidth: getPanelWidths()[side] };
    setDragging(true);
    if (capturePointer(event.currentTarget, event.pointerId)) return;
    // Sin captura el gesto solo vive mientras el puntero esté encima del asa.
    const doc = event.currentTarget.ownerDocument;
    const move = (ev: PointerEvent) => moveTo(ev.clientX);
    const up = () => finish();
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', up);
    releaseDoc.current = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('pointercancel', up);
    };
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? KEY_FINE_STEP : KEY_STEP;
    const pressed = event.key === 'ArrowRight' ? 1 : -1;
    // Las flechas mueven el asa en la pantalla: en Claude, izquierda ensancha.
    const delta = side === 'browser' ? pressed : -pressed;
    setPanelWidth(side, getPanelWidths()[side] + delta * step);
  };

  return (
    <div
      className={`panel-splitter panel-splitter--${side}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={LABELS[side]}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      aria-valuetext={`${width} píxeles`}
      title="Arrastra para cambiar el ancho · doble clic para el de fábrica · flechas para ajustar"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (drag.current) moveTo(event.clientX);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={() => resetPanelWidth(side)}
      onKeyDown={onKeyDown}
    />
  );
}
