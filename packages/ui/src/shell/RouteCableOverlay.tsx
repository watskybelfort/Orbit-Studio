/**
 * Dibuja el cable de enrutado mientras se arrastra (ver `state/route-cable.ts`).
 *
 * Es una capa SVG a pantalla completa que no recibe eventos: el gesto lo lleva
 * el conector de la pista (con el puntero capturado), y así
 * `elementFromPoint` encuentra el canal del Mixer que hay debajo. Esc cancela.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useProject } from '../state/useProject';
import { cablePath, cancelCableDrag, mixerTargetLabel, useRouteCable } from '../state/route-cable';

export function RouteCableOverlay() {
  const drag = useRouteCable((s) => s.drag);
  const project = useProject();
  const active = drag !== null;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelCableDrag();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  if (!drag) return null;
  const target =
    drag.hover !== null ? mixerTargetLabel(drag.hover, project.mixer[drag.hover]?.name) : null;
  return createPortal(
    <div className="route-cable" aria-live="polite">
      <svg className="route-cable__svg" width="100%" height="100%">
        <path className="route-cable__shadow" d={cablePath(drag.x0, drag.y0, drag.x, drag.y)} />
        <path
          className="route-cable__wire"
          d={cablePath(drag.x0, drag.y0, drag.x, drag.y)}
          style={{ stroke: drag.color }}
        />
        <circle className="route-cable__jack" cx={drag.x0} cy={drag.y0} r={5} style={{ fill: drag.color }} />
        <circle
          className={`route-cable__plug${target ? ' is-over' : ''}`}
          cx={drag.x}
          cy={drag.y}
          r={7}
          style={{ stroke: drag.color }}
        />
      </svg>
      <div className="route-cable__label popup" style={{ left: drag.x + 14, top: drag.y + 12 }}>
        {target ? `«${drag.trackName}» → ${target}` : `Suelta sobre un canal del Mixer · Esc cancela`}
      </div>
    </div>,
    document.body,
  );
}
