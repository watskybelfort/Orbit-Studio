/**
 * Paleta de comandos (Ctrl+K): overlay centrado arriba con búsqueda
 * instantánea sobre los comandos registrados en registry.ts.
 * Se monta SIEMPRE; con la paleta cerrada no renderiza nada. La caja
 * interior se remonta en cada apertura: comandos frescos y estado limpio.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  getPaletteCommands,
  recentCommands,
  rememberCommand,
  usePaletteStore,
  type PaletteCommand,
} from './registry';
import { searchCommands } from './search';
import './palette.css';

/** Máximo de resultados pintados (se recorta antes de agrupar). */
const MAX_RESULTS = 40;

/** Grupo visible; cada item conserva su índice plano para la selección con teclado. */
interface ResultGroup {
  group: string;
  items: { cmd: PaletteCommand; index: number }[];
}

/** Agrupa los resultados por `group` en orden de primera aparición. */
function groupResults(results: PaletteCommand[]): ResultGroup[] {
  const out: ResultGroup[] = [];
  const byName = new Map<string, ResultGroup>();
  results.forEach((cmd, index) => {
    let g = byName.get(cmd.group);
    if (g === undefined) {
      g = { group: cmd.group, items: [] };
      byName.set(cmd.group, g);
      out.push(g);
    }
    g.items.push({ cmd, index });
  });
  return out;
}

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  if (!open) return null;
  return <PaletteBox />;
}

/** Caja interior: vive solo mientras la paleta está abierta. */
function PaletteBox() {
  const closePalette = usePaletteStore((s) => s.closePalette);
  const listRef = useRef<HTMLDivElement>(null);

  // Proveedores evaluados UNA vez por apertura (el componente se remonta al abrir).
  const [commands] = useState<PaletteCommand[]>(getPaletteCommands);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  // Los recientes se congelan al abrir: releerlos en cada tecla reordenaría la
  // lista bajo el dedo justo después de ejecutar algo.
  const [recent] = useState(() => [...recentCommands()]);
  const results = useMemo(
    () => searchCommands(commands, query, { recent, limit: MAX_RESULTS }),
    [commands, query, recent],
  );
  const groups = useMemo(() => groupResults(results), [results]);

  const runCommand = (cmd: PaletteCommand) => {
    closePalette();
    rememberCommand(cmd.id);
    cmd.run();
  };

  // Mantiene el item seleccionado a la vista al navegar con el teclado.
  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected, results]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      // Navegación circular: del último salta al primero y viceversa.
      setSelected((i) => (i + delta + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[selected];
      if (cmd !== undefined) runCommand(cmd);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  };

  return (
    <div
      className="palette-overlay"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        // Clic en el velo (fuera de la caja): cerrar sin ejecutar nada.
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div className="palette popup">
        <input
          className="palette-input"
          type="text"
          autoFocus
          spellCheck={false}
          placeholder="Escribe un comando…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0); // La selección vuelve arriba con cada búsqueda.
          }}
        />
        <div className="palette-list" ref={listRef}>
          {groups.map((g) => (
            <div key={g.group} className="palette-group">
              <div className="palette-group-label">{g.group}</div>
              {g.items.map(({ cmd, index }) => (
                <button
                  key={cmd.id}
                  className={`palette-item${index === selected ? ' selected' : ''}`}
                  onPointerEnter={() => setSelected(index)}
                  onClick={() => runCommand(cmd)}
                >
                  <span className="palette-item-title">{cmd.title}</span>
                  {cmd.shortcut !== undefined && (
                    <span className="palette-shortcut">{cmd.shortcut}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {results.length === 0 && <div className="palette-empty">Sin resultados</div>}
        </div>
      </div>
    </div>
  );
}
