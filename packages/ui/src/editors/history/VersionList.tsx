/**
 * Versiones del proyecto, debajo del historial de cambios.
 *
 * El historial de arriba es lo de esta sesión (y se pierde al cerrar); esto es
 * el proyecto guardado entero, con su hora. Cada fila se despliega con el
 * **diff musical**: qué notas entraron en qué patrón y canal, qué se movió,
 * qué canal es nuevo, cuánto subió un fader. Y desde ahí se restaura — pero
 * antes de restaurar se guarda el estado de ahora, que volver atrás no puede
 * ser una puerta de un solo sentido.
 */

import { useEffect, useState } from 'react';
import { describeDiff } from '@orbit/core';
import {
  openVersionDiff,
  refreshVersions,
  removeVersion,
  restoreVersion,
  saveVersion,
  summarize,
  useVersions,
} from '../../state/versions';

export function VersionList() {
  const entries = useVersions((s) => s.entries);
  const openFile = useVersions((s) => s.openFile);
  const diff = useVersions((s) => s.diff);
  const busy = useVersions((s) => s.busy);
  const notice = useVersions((s) => s.notice);
  const [label, setLabel] = useState('');

  useEffect(() => {
    void refreshVersions();
  }, []);

  const save = () => {
    void saveVersion(label.trim());
    setLabel('');
  };

  return (
    <section className="ver">
      <div className="ver-head">
        <span className="ver-title">Versiones guardadas</span>
        <input
          className="ver-input"
          value={label}
          placeholder="Nombre (p. ej. «antes del drop»)"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <button className="ver-btn" disabled={busy} onClick={save} title="Guarda el proyecto tal y como está ahora">
          Guardar
        </button>
      </div>

      {notice && <p className="ver-notice">{notice}</p>}

      {entries.length === 0 && (
        <p className="ver-empty">
          Aún no hay ninguna. Se guarda una sola cada vez que guardas el proyecto
          (Ctrl+S) y las que pidas aquí; luego podrás ver qué cambió desde
          entonces —en notas, canales y faders— y volver si hace falta.
        </p>
      )}

      {entries.map((entry) => {
        const open = openFile === entry.file;
        return (
          <div key={entry.file} className={`ver-row${open ? ' open' : ''}`}>
            <button
              className="ver-main"
              title="Ver qué ha cambiado desde esta versión"
              onClick={() => void openVersionDiff(entry.file)}
            >
              <span className="ver-caret">{open ? '▾' : '▸'}</span>
              <span className="ver-label">{entry.label}</span>
              <span className="ver-when">{when(entry.at)}</span>
            </button>
            <button
              className="ver-btn small"
              title="Volver a esta versión (se guarda antes la de ahora)"
              disabled={busy}
              onClick={() => void restoreVersion(entry.file)}
            >
              Restaurar
            </button>
            <button
              className="ver-btn small"
              title="Borrar esta versión"
              onClick={() => void removeVersion(entry.file)}
            >
              ✕
            </button>

            {open && diff && (
              <div className="ver-diff">
                <div className="ver-diff-sum">{summarize(diff)}</div>
                {describeDiff(diff).map((line, i) => (
                  <div key={i} className="ver-diff-line">
                    {line}
                  </div>
                ))}
                {describeDiff(diff).length === 0 && (
                  <div className="ver-diff-line">Nada ha cambiado desde entonces.</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Hoy → la hora; otro día → día y hora. */
function when(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleString('es-ES', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}
