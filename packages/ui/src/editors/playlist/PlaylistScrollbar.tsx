/**
 * Barra de scroll arrastrable para el lienzo de la Playlist (ver `scrollbar.ts`).
 *
 * - Arrastrar el pulgar desplaza la vista.
 * - Clic en el carril centra el pulgar ahí y el gesto sigue: se puede saltar y
 *   seguir arrastrando sin soltar.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { capturePointer } from '../../widgets/pointer';
import { scrollForOffset, thumbGeometry } from './scrollbar';

interface Props {
  orientation: 'v' | 'h';
  viewport: number;
  content: number;
  scroll: number;
  onScroll: (value: number) => void;
  label: string;
}

export function PlaylistScrollbar({ orientation, viewport, content, scroll, onScroll, label }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const grab = useRef<{ pointer: number; offset: number } | null>(null);
  const [trackLen, setTrackLen] = useState(0);
  const vertical = orientation === 'v';

  const scrollable = content > viewport + 1e-6;

  const measure = () => {
    const el = trackRef.current;
    return el ? (vertical ? el.clientHeight : el.clientWidth) : 0;
  };
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setTrackLen(vertical ? el.clientHeight : el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vertical, scrollable]);

  if (!scrollable) return null;
  const geo = thumbGeometry(viewport, content, scroll, trackLen);

  const pos = (e: ReactPointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect();
    return vertical ? e.clientY - r.top : e.clientX - r.left;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const track = measure();
    const at = pos(e);
    const now = thumbGeometry(viewport, content, scroll, track);
    let offset = now.offset;
    // Fuera del pulgar: salta para dejarlo centrado bajo el cursor.
    if (at < now.offset || at > now.offset + now.size) {
      offset = at - now.size / 2;
      onScroll(scrollForOffset(offset, viewport, content, track));
    }
    grab.current = { pointer: at, offset };
    capturePointer(e.currentTarget, e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g) return;
    onScroll(scrollForOffset(g.offset + (pos(e) - g.pointer), viewport, content, measure()));
  };

  const end = () => {
    grab.current = null;
  };

  return (
    <div
      ref={trackRef}
      className={`pl-scroll pl-scroll--${orientation}`}
      role="scrollbar"
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuemin={0}
      aria-valuemax={Math.round(geo.maxScroll)}
      aria-valuenow={Math.round(Math.min(geo.maxScroll, Math.max(0, scroll)))}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className="pl-scroll__thumb"
        style={vertical ? { top: geo.offset, height: geo.size } : { left: geo.offset, width: geo.size }}
      />
    </div>
  );
}
