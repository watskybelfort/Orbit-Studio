/**
 * Panel de historial: la lista de todo lo que ha pasado en el proyecto y un
 * clic para volver a cualquier punto.
 *
 * Lo de arriba es lo más viejo. Las entradas por encima del presente (en gris,
 * tachadas) son el futuro: siguen ahí y se recuperan volviendo a bajar. El
 * salto respeta el origen — mueve TUS cambios, nunca los de Claude ni los de
 * quien esté en la sala — así que una fila de otro color puede quedarse
 * aplicada por encima de tu presente; es lo correcto, no un despiste.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { HistoryItem } from '@orbit/core';
import { HistoryBranches } from '../../history';
import { store } from '../../state/app';
import { useProjectVersion } from '../../state/useProject';
import { VersionList } from './VersionList';
import './history.css';

export function HistoryPanel() {
  const version = useProjectVersion();
  const view = useMemo(() => store.historyView(), [version]);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Al saltar (o al deshacer con Ctrl+Z) el presente puede irse fuera de la
  // vista: se le sigue la pista moviendo SOLO el scroll de esta lista.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('.hist-row.now');
    if (!list || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - list.clientHeight / 2 + el.offsetHeight / 2;
    }
  }, [view.present, view.entries.length]);

  const pending = view.entries.length - view.present;

  return (
    <div className="hist">
      <div className="hist-head">
        <span className="hist-count">
          {view.entries.length === 0
            ? 'Sin cambios todavía'
            : `${view.present} cambio${view.present === 1 ? '' : 's'} aplicado${
                view.present === 1 ? '' : 's'
              }`}
        </span>
        {pending > 0 && <span className="hist-pending">{pending} por rehacer</span>}
        <span className="hist-hint">Clic en un cambio = volver ahí</span>
      </div>

      <div className="hist-list" ref={listRef}>
        <button
          className={`hist-row hist-start${view.present === 0 ? ' now' : ''}`}
          title="Volver al proyecto tal como estaba antes de tus cambios"
          onClick={() => store.jumpTo(null)}
        >
          <span className="hist-dot start" />
          <span className="hist-label">Estado inicial</span>
          <span className="hist-who">—</span>
          <span className="hist-time" />
        </button>

        {view.entries.map((item, i) => (
          <Row key={item.id} item={item} isNow={i === view.present - 1} />
        ))}
      </div>

      {/*
        Las ramas van DEBAJO del tronco y ENCIMA de las versiones guardadas, que
        es su orden por duración: el tronco es lo que estás haciendo, las ramas
        son lo que dejaste a medias en esta sesión, y las versiones son lo que
        decidiste guardar para mañana.
      */}
      <HistoryBranches />

      <VersionList />

      {view.entries.length === 0 && (
        <p className="hist-empty">
          Cada cosa que hagas (mover notas, tocar una perilla, añadir un canal)
          se apunta aquí con su hora y quién la hizo. Podrás volver a cualquier
          punto sin perder lo de después: sigue en la lista hasta que edites
          desde ahí.
        </p>
      )}
    </div>
  );
}

function Row({ item, isNow }: { item: HistoryItem; isNow: boolean }) {
  const kind = originKind(item.origin);
  return (
    <button
      className={`hist-row${item.done ? '' : ' undone'}${isNow ? ' now' : ''}`}
      title={`${item.label} · ${originName(item.origin)} · ${fullTime(item.at)}`}
      onClick={() => store.jumpTo(item.id)}
    >
      <span className={`hist-dot ${kind}`} />
      <span className="hist-label">{item.label}</span>
      <span className={`hist-who ${kind}`}>{originName(item.origin)}</span>
      <span className="hist-time">{shortTime(item.at)}</span>
    </button>
  );
}

/** Familia del origen (decide el color de la fila). */
function originKind(origin: string): 'local' | 'claude' | 'remote' {
  if (origin === 'local') return 'local';
  if (origin === 'claude') return 'claude';
  return 'remote';
}

/** 'local' → Tú · 'claude' → Claude · 'remote:ana' → ana. */
function originName(origin: string): string {
  if (origin === 'local') return 'Tú';
  if (origin === 'claude') return 'Claude';
  if (origin.startsWith('remote:')) return origin.slice('remote:'.length) || 'Remoto';
  return origin;
}

function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fullTime(at: number): string {
  return new Date(at).toLocaleTimeString('es-ES', { hour12: false });
}
