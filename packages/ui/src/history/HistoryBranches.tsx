/**
 * Ramas guardadas: lo que el undo lineal habría borrado.
 *
 * Va debajo del tronco en el panel de historial. Cada rama dice de qué punto
 * sale (con una barra que lo señala sobre el tronco), cuántos cambios tiene, de
 * quién son y cuánto hace que se abandonó; se despliega para verlos uno a uno;
 * y se vuelve a ella con un botón. Volver NO tira lo que tienes ahora: ese
 * camino se archiva a su vez, así que se puede ir y venir.
 *
 * Las que cuelgan de otra rama van indentadas — para llegar a ellas se sacan
 * las dos, y eso lo hace `switchToBranch` solo.
 *
 * El texto y la aritmética viven en `branch-rows.ts` (sin React, con tests).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { store } from '../state/app';
import { useProjectVersion } from '../state/useProject';
import { branchRows, branchesSummary, historyResetNotice, type BranchRow } from './branch-rows';
import './history-branches.css';

export function HistoryBranches() {
  const version = useProjectVersion();
  const tree = useMemo(() => store.historyTree(), [version]);
  const rows = useMemo(() => branchRows(tree), [tree]);
  const summary = branchesSummary(tree);
  const [open, setOpen] = useState<string | null>(null);

  // El aviso de "se reinició el historial" solo tiene sentido la primera vez
  // que se ve un epoch nuevo: en cuanto el usuario vuelve a editar, sobra.
  const seenEpoch = useRef(store.historyEpoch);
  const notice = historyResetNotice(store.historyEpoch, seenEpoch.current, tree.entries.length);
  useEffect(() => {
    if (!notice) seenEpoch.current = store.historyEpoch;
  }, [notice, version]);

  if (rows.length === 0 && !notice) return null;

  return (
    <section className="brs">
      <div className="brs-head">
        <span className="brs-title">{summary.title}</span>
        {summary.detail && <span className="brs-detail">{summary.detail}</span>}
      </div>

      {notice && <p className="brs-notice">{notice}</p>}

      {rows.map((row) => (
        <BranchCard
          key={row.id}
          row={row}
          total={tree.entries.length}
          open={open === row.id}
          onToggle={() => setOpen(open === row.id ? null : row.id)}
        />
      ))}
    </section>
  );
}

function BranchCard({
  row,
  total,
  open,
  onToggle,
}: {
  row: BranchRow;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  // Máximo tres niveles de sangrado: más allá se pierde el ancho del panel y
  // deja de leerse, que era todo el objetivo.
  const indent = Math.min(row.depth, 3) * 14;

  return (
    <div
      className={`brs-card${row.reachable ? '' : ' lost'}${row.atPresent ? ' here' : ''}`}
      style={{ marginLeft: indent }}
    >
      <button
        className="brs-row"
        onClick={onToggle}
        aria-expanded={open}
        title={`${row.title} · ${row.from} · ${row.who}`}
      >
        <span className="brs-fork">⑂</span>
        <span className="brs-text">
          <span className="brs-label">{row.title}</span>
          <span className="brs-from">{row.from}</span>
        </span>
        <span className={`brs-who ${row.kind}`}>{row.who}</span>
        <span className="brs-meta">{row.meta}</span>
      </button>

      {/* Mini-diagrama: el tronco como una barra y un punto donde se bifurca. */}
      {total > 0 && (
        <div className="brs-spine" aria-hidden="true">
          <span className="brs-spine-dot" style={{ left: `${row.forkFraction * 100}%` }} />
        </div>
      )}

      {open && (
        <div className="brs-body">
          <ol className="brs-steps">
            {row.steps.map((s) => (
              <li key={s.id}>
                <span className="brs-step-label">{s.label}</span>
                <span className="brs-step-time">{s.time}</span>
              </li>
            ))}
          </ol>
          <div className="brs-actions">
            <button
              className="brs-btn primary"
              disabled={!row.reachable}
              title={
                row.reachable
                  ? 'Vuelve a esta rama. Lo que tienes ahora se guarda como otra rama: no se pierde.'
                  : 'El punto del que salía ya no está en el historial.'
              }
              onClick={() => store.switchToBranch(row.id)}
            >
              {row.action}
            </button>
            <button
              className="brs-btn"
              title="Tira esta rama (y las que colgaban de ella). No se puede deshacer."
              onClick={() => store.dropBranch(row.id)}
            >
              Olvidar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
