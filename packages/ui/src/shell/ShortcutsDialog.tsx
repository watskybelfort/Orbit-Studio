/**
 * "Atajos de teclado" (Ayuda o F1).
 *
 * Los atajos existían solo en `docs/FEATURES.md`: para recordar que Alt+G abre
 * la riff machine había que salir de la app y abrir un markdown. Aquí están
 * dentro, agrupados y con buscador —se escribe "pegar" o "ctrl+v" y sale la
 * fila—, que es como se usa una chuleta de verdad.
 */

import { useEffect, useMemo, useState } from 'react';
import { SHORTCUTS, type ShortcutRow } from './shortcuts-catalog';
import { useUiStore } from '../state/ui';
import './shortcuts.css';

/** Minúsculas y sin acentos, igual que el Browser y la paleta. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Grupos con solo las filas que casan; los que se quedan vacíos no se pintan. */
function filterGroups(query: string) {
  const q = normalize(query.trim());
  if (q === '') return SHORTCUTS;
  return SHORTCUTS.map((g) => ({
    title: g.title,
    rows: g.rows.filter((r: ShortcutRow) =>
      normalize(`${r.keys} ${r.what} ${r.where ?? ''} ${g.title}`).includes(q),
    ),
  })).filter((g) => g.rows.length > 0);
}

/**
 * Parte la combinación en teclas sueltas para pintarlas como teclas.
 *
 * Primero por " · ", que separa ALTERNATIVAS ("Ctrl+Y · Ctrl+Shift+Z" son dos
 * formas de rehacer), y solo después por "+". Partiendo solo por "+" salía una
 * tecla llamada "Y · Ctrl", que no existe.
 */
function keyCombos(keys: string): string[][] {
  return keys.split(' · ').map((combo) => combo.split('+'));
}

export function ShortcutsDialog() {
  const [query, setQuery] = useState('');
  const close = () => useUiStore.setState({ shortcutsOpen: false });
  const groups = useMemo(() => filterGroups(query), [query]);

  // Esc cierra, como cualquier diálogo de la app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        useUiStore.setState({ shortcutsOpen: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="sc-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sc popup" role="dialog" aria-label="Atajos de teclado">
        <div className="sc-head">
          <span className="sc-title">Atajos de teclado</span>
          <input
            className="sc-search"
            type="text"
            autoFocus
            spellCheck={false}
            placeholder="Buscar (pegar, ctrl+v, piano…)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="sc-close" onClick={close} aria-label="Cerrar">
            ✕
          </button>
        </div>

        <div className="sc-body">
          {groups.map((g) => (
            <section key={g.title} className="sc-group">
              <h3 className="sc-group-title">{g.title}</h3>
              {g.rows.map((r) => (
                <div key={`${g.title}:${r.keys}:${r.what}`} className="sc-row">
                  <span className="sc-keys">
                    {keyCombos(r.keys).map((combo, c) => (
                      <span key={c} className="sc-combo">
                        {c > 0 && <span className="sc-or">o</span>}
                        {combo.map((part, i) => (
                          <span key={i}>
                            {i > 0 && <span className="sc-plus">+</span>}
                            <kbd>{part}</kbd>
                          </span>
                        ))}
                      </span>
                    ))}
                  </span>
                  <span className="sc-what">
                    {r.what}
                    {r.where && <span className="sc-where">{r.where}</span>}
                  </span>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && <div className="sc-empty">Ningún atajo casa con eso.</div>}
        </div>
      </div>
    </div>
  );
}
