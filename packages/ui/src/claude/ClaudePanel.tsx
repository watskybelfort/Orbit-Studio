/**
 * Panel de Claude: estado de conexión del puente MCP y actividad en vivo
 * (cada tool call con su resultado). Claude trabaja por el bus de comandos con
 * origin 'claude', así que todo lo que aparece aquí es deshacible desde su
 * propia pila de undo (tool `undo`) sin tocar los cambios del usuario.
 */

import { useEffect, useRef } from 'react';
import { useClaudeStore } from '../state/claude';
import './claude.css';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('es', { hour12: false });
}

export function ClaudePanel() {
  const available = useClaudeStore((s) => s.available);
  const connected = useClaudeStore((s) => s.connected);
  const entries = useClaudeStore((s) => s.entries);
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll al fondo cuando entra actividad nueva.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="claude">
      <div className="claude-status">
        <span className={`claude-dot${connected ? ' on' : ''}`} />
        <span className="claude-status-text">
          {!available
            ? 'Puente no disponible (fuera de Electron)'
            : connected
              ? 'Claude Code conectado'
              : 'Esperando conexión…'}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="claude-hint">
          <p>
            Abre <strong>Claude Code</strong> en la carpeta del proyecto: el
            servidor MCP de Orbit Studio ya está declarado en{' '}
            <code>.mcp.json</code>.
          </p>
          <p>
            Pídele un beat, una mezcla o correcciones — cada acción aparecerá
            aquí y en el proyecto en tiempo real, y siempre podrás deshacerla.
          </p>
        </div>
      ) : (
        <div className="claude-feed" ref={feedRef}>
          {entries.map((e) => (
            <div key={e.id} className={`claude-entry${e.ok ? '' : ' error'}`}>
              <span className="claude-entry-icon">
                {e.running ? <span className="claude-spinner" /> : e.ok ? '✓' : '✕'}
              </span>
              <div className="claude-entry-body">
                <div className="claude-entry-head">
                  <span className="claude-entry-tool">{e.tool}</span>
                  <span className="claude-entry-time">{formatTime(e.at)}</span>
                </div>
                {e.summary && <div className="claude-entry-summary">{e.summary}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
