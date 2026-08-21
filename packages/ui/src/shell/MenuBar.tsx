/** Barra de menús minimalista. Los dropdowns usan .popup (regla del acrílico). */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  IconAutomation,
  IconBrowser,
  IconChannelRack,
  IconClaude,
  IconClose,
  IconCollab,
  IconExport,
  IconLfo,
  IconLive,
  IconMidi,
  IconMixer,
  IconNew,
  IconOpen,
  IconPattern,
  IconPianoRoll,
  IconPlaylist,
  IconSave,
  IconSettings,
  IconTrack,
  IconGraph,
  IconWave,
} from '../icons';
import { PROJECT_TEMPLATES } from '@orbit/core';
import { repeatLastExport } from '../export';
import { store } from '../state/app';
import { clipboardKind } from '../state/clipboard';
import { activeEditActions } from '../state/edit-focus';
import {
  activePattern,
  addPattern,
  canRemovePattern,
  clonePattern,
  patternClipsHint,
  removeActivePattern,
  renamePattern,
} from '../palette/default-commands';
import {
  clearRecents,
  importMidi,
  newProject,
  newProjectFromTemplate,
  openProject,
  openRecentProject,
  saveProject,
  useRecentProjects,
} from '../state/project-file';
import { LAYOUT_PRESETS, applyPreset, saveLayout } from '../state/layouts';
import { usePaletteStore } from '../palette';
import { useUiStore } from '../state/ui';
import './shell.css';

/** Orden de los menús de la barra (también el que recorren ← y →). */
const MENU_ORDER = ['Archivo', 'Editar', 'Patrón', 'Ver', 'Ayuda'];

interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  separator?: boolean;
  /**
   * Marca de estado a la izquierda. Los menús que ALTERNAN algo (ventanas,
   * paneles) tienen que decir cómo está eso ahora: sin la marca, "Mixer" no
   * distingue entre abrirlo y cerrarlo hasta que lo pulsas.
   */
  checked?: boolean;
  /** Submenú: sus entradas salen a la derecha en vez de alargar el desplegable. */
  submenu?: MenuItem[];
  /** Cabecera de grupo: no se pulsa, solo dice de qué va el bloque de abajo. */
  heading?: boolean;
}

// ── Etiquetas de deshacer/rehacer ────────────────────────────────────────────
//
// El bus lleva undo POR ORIGEN: un Ctrl+Z deshace lo TUYO, no lo que acabe de
// hacer un colaborador ni Claude. Las etiquetas del menú tienen que buscar con
// esa misma regla o dirían un nombre y desharían otro.

function nextUndoLabel(): string | null {
  const entries = store.history;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.origin === 'local') return entries[i]!.label;
  }
  return null;
}

function nextRedoLabel(): string | null {
  const { entries, present } = store.historyView();
  // A partir del presente va el futuro, ya en el orden en que se rehará.
  for (let i = present; i < entries.length; i++) {
    if (entries[i]!.origin === 'local') return entries[i]!.label;
  }
  return null;
}

// ── Teclado de los desplegables ──────────────────────────────────────────────
//
// El recorrido se hace sobre el DOM y con el foco DE VERDAD, no con un índice
// en un estado: así el lector de pantalla sigue al usuario, Enter y Espacio ya
// los sirve el <button> nativo, y no hay dos ideas distintas de "cuál está
// señalado" (la del ratón y la del teclado) que se puedan desincronizar.

/** Botones activables de ESTA lista; los del submenú abierto no cuentan. */
function itemsOf(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>(':scope > .menu-row > .menu-item')].filter(
    (b) => !b.disabled,
  );
}

/** Mueve el foco `delta` posiciones dentro de la lista, dando la vuelta. */
function moveFocus(list: HTMLElement, delta: number): void {
  const items = itemsOf(list);
  if (items.length === 0) return;
  const from = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = from < 0 ? (delta > 0 ? 0 : items.length - 1) : (from + delta + items.length) % items.length;
  items[next]?.focus();
}

/** Salta a la siguiente entrada que empiece por esa letra (como en Windows). */
function focusByLetter(list: HTMLElement, letter: string): boolean {
  const items = itemsOf(list);
  if (items.length === 0) return false;
  const from = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
  for (let n = 1; n <= items.length; n++) {
    const candidate = items[(from + n) % items.length]!;
    if ((candidate.dataset['letter'] ?? '') === letter) {
      candidate.focus();
      return true;
    }
  }
  return false;
}

/**
 * "3 clips" pero "1 clip". Los nombres del editor vienen en plural y aquí se
 * les quita la ese: vale para clips y para notas, que es todo lo que hay.
 */
function count(n: number, plural: string): string {
  return `${n} ${n === 1 ? plural.slice(0, -1) : plural}`;
}

/**
 * Primera letra del label, sin acentos y en minúscula: se busca "a" y sale
 * "Ajustes" igual que "Automatización" (igual que el buscador del Browser).
 */
function firstLetter(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .charAt(0)
    .toLowerCase();
}

interface MenuListProps {
  items: MenuItem[];
  /** Cierra el menú entero (tras ejecutar algo). */
  onRun: () => void;
  /** Cierra SOLO esta lista y devuelve el foco a quien la abrió (← y Esc). */
  onClose?: () => void;
  /** Al abrirse por teclado, el foco entra directo en la primera entrada. */
  autoFocus?: boolean;
}

function MenuList({ items, onRun, onClose, autoFocus }: MenuListProps) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** El submenú que se acaba de abrir con el teclado tiene que recibir el foco. */
  const focusSub = useRef(false);

  useEffect(() => {
    if (autoFocus && listRef.current) itemsOf(listRef.current)[0]?.focus();
  }, [autoFocus]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) return;
    // Con un submenú abierto hay dos listas escuchando por burbujeo: solo
    // atiende la MÁS INTERNA, o una flecha saltaría dos posiciones.
    if ((e.target as HTMLElement).closest('.menu-dropdown') !== list) return;

    const focused = document.activeElement as HTMLButtonElement | null;
    const index = focused ? Number(focused.dataset['index'] ?? -1) : -1;
    const item = index >= 0 ? items[index] : undefined;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(list, 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(list, -1);
        return;
      case 'Home':
        e.preventDefault();
        itemsOf(list)[0]?.focus();
        return;
      case 'End': {
        e.preventDefault();
        const all = itemsOf(list);
        all[all.length - 1]?.focus();
        return;
      }
      case 'ArrowRight':
        // Solo se queda la tecla si hay submenú que abrir; si no, sube y la
        // barra la usa para pasar al menú de al lado.
        if (item?.submenu) {
          e.preventDefault();
          e.stopPropagation();
          focusSub.current = true;
          setOpenSub(index);
        }
        return;
      case 'ArrowLeft':
        if (onClose) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (onClose) onClose();
        else onRun();
        return;
      default:
        break;
    }
    // Letra suelta: salta a la entrada que empieza por ella.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (focusByLetter(list, e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  return (
    <div className="menu-dropdown popup" role="menu" ref={listRef} onKeyDown={onKeyDown}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="menu-sep" role="separator" />
        ) : item.heading ? (
          <div key={`head-${i}`} className="menu-heading" role="presentation">
            {item.label}
          </div>
        ) : (
          <div
            key={`${item.label}-${i}`}
            className="menu-row"
            // El submenú se pinta DENTRO de la fila: al moverse hacia él, el
            // puntero no sale de la fila y no hay parpadeo al cruzar el hueco.
            onPointerEnter={() => setOpenSub(item.submenu ? i : null)}
          >
            <button
              className={`menu-item${item.checked ? ' checked' : ''}`}
              role="menuitem"
              data-index={i}
              data-letter={firstLetter(item.label)}
              {...(item.checked !== undefined ? { 'aria-checked': item.checked } : null)}
              {...(item.submenu
                ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': openSub === i }
                : null)}
              disabled={item.disabled}
              onClick={() => {
                if (item.submenu) {
                  focusSub.current = false;
                  setOpenSub(openSub === i ? null : i);
                  return;
                }
                onRun();
                item.action?.();
              }}
            >
              <span className="menu-item-label">
                <span className="menu-check">{item.checked ? '✓' : ''}</span>
                <span className="menu-icon">{item.icon}</span>
                {item.label}
              </span>
              {item.submenu ? (
                <span className="menu-arrow">›</span>
              ) : (
                item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>
              )}
            </button>
            {item.submenu && openSub === i && (
              <div className="menu-sub">
                <MenuList
                  items={item.submenu}
                  onRun={onRun}
                  autoFocus={focusSub.current}
                  onClose={() => {
                    setOpenSub(null);
                    // El foco vuelve a la entrada que lo abrió: sin esto se
                    // queda en un botón que acaba de desaparecer y el teclado
                    // deja de mover nada.
                    listRef.current
                      ?.querySelector<HTMLButtonElement>(`.menu-item[data-index="${i}"]`)
                      ?.focus();
                  }}
                />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  /** El menú abierto con el teclado entra con el foco puesto; con el ratón, no. */
  const [keyboard, setKeyboard] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toggleWindow = useUiStore((s) => s.toggleWindow);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  /*
   * Alt a secas abre la barra, como en cualquier app de Windows.
   *
   * "A secas" es la parte importante: se mira en el keyUP y solo si entremedias
   * no se ha pulsado nada más. Sin eso, Alt+A (arpegiador), Alt+C (acorde) o
   * Alt+arrastre (sin snap en la playlist) abrirían el menú de propina.
   */
  useEffect(() => {
    let bare = false;
    const onDown = (e: KeyboardEvent) => {
      bare = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey && !e.repeat;
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !bare) return;
      bare = false;
      e.preventDefault();
      setKeyboard(true);
      setOpen((current) => (current === null ? MENU_ORDER[0]! : null));
    };
    const cancel = () => {
      bare = false;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('pointerdown', cancel);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('pointerdown', cancel);
    };
  }, []);

  /** Cierra, y devuelve el foco al botón del menú (si se venía del teclado). */
  const closeMenu = (name?: string) => {
    setOpen(null);
    setKeyboard(false);
    if (name === undefined) return;
    ref.current?.querySelector<HTMLButtonElement>(`.menu-btn[data-menu="${name}"]`)?.focus();
  };

  /** ← y → saltan al menú de al lado; si había uno abierto, el nuevo se abre. */
  const stepMenu = (name: string, delta: number) => {
    const at = MENU_ORDER.indexOf(name);
    const next = MENU_ORDER[(at + delta + MENU_ORDER.length) % MENU_ORDER.length]!;
    setKeyboard(true);
    setOpen(next);
    ref.current?.querySelector<HTMLButtonElement>(`.menu-btn[data-menu="${next}"]`)?.focus();
  };

  // Los menús se construyen en el mismo render que los abre (el clic cambia
  // `open`), así que leer los stores con getState() sale siempre fresco y no
  // hace falta suscribirse: suscribirse a `windows` repintaría esta barra a 60
  // fps mientras se arrastra una ventana, solo para poner un ✓.
  const pattern = activePattern();
  const canRemove = canRemovePattern();
  const ui = useUiStore.getState();
  const recents = useRecentProjects.getState().list;
  const edit = activeEditActions();
  const undoLabel = nextUndoLabel();
  const redoLabel = nextRedoLabel();

  /** Entrada de "Ver" que abre/cierra una ventana, con su ✓ si está abierta. */
  const windowItem = (
    id: Parameters<typeof toggleWindow>[0],
    label: string,
    icon: ReactNode,
    shortcut?: string,
  ): MenuItem => ({
    label,
    icon,
    ...(shortcut ? { shortcut } : null),
    checked: ui.windows[id].open,
    action: () => toggleWindow(id),
  });

  const menus: Record<string, MenuItem[]> = {
    Archivo: [
      { label: 'Nuevo proyecto', icon: <IconNew />, shortcut: 'Ctrl+N', action: () => newProject() },
      {
        // Las plantillas eran una entrada suelta CADA UNA en el primer nivel:
        // el menú Archivo medía catorce líneas y "Abrir" quedaba enterrado.
        label: 'Nuevo desde plantilla',
        icon: <IconNew />,
        submenu: PROJECT_TEMPLATES.map((t) => ({
          label: t.name,
          action: () => newProjectFromTemplate(t.id),
        })),
      },
      { label: 'Abrir…', icon: <IconOpen />, shortcut: 'Ctrl+O', action: () => void openProject() },
      {
        label: 'Abrir reciente',
        icon: <IconOpen />,
        disabled: recents.length === 0,
        submenu: [
          ...recents.map((r) => ({
            // Un reciente que ya no está sale deshabilitado en vez de
            // desaparecer: enterarse de que el archivo se movió vale más que
            // una lista corta.
            label: r.exists ? r.name : `${r.name} (no está)`,
            disabled: !r.exists,
            action: () => void openRecentProject(r.path),
          })),
          { label: '', separator: true },
          { label: 'Vaciar la lista', action: () => void clearRecents() },
        ],
      },
      { label: '', separator: true },
      { label: 'Guardar', icon: <IconSave />, shortcut: 'Ctrl+S', action: () => void saveProject() },
      { label: 'Guardar como…', shortcut: 'Ctrl+Shift+S', action: () => void saveProject(true) },
      { label: '', separator: true },
      { label: 'Info del proyecto…', action: () => toggleWindow('projectInfo') },
      { label: '', separator: true },
      { label: 'Importar MIDI…', icon: <IconMidi />, action: () => void importMidi() },
      { label: 'Exportar…', icon: <IconExport />, action: () => toggleWindow('export') },
      {
        label: 'Repetir el último export',
        shortcut: 'Ctrl+E',
        action: () => void repeatLastExport(),
      },
      { label: '', separator: true },
      { label: 'Salir', icon: <IconClose />, action: () => void window.orbit?.window.close() },
    ],
    Editar: [
      // El menú dice QUÉ deshace. "Deshacer" a secas obliga a probar y mirar.
      {
        label: undoLabel ? `Deshacer «${undoLabel}»` : 'Deshacer',
        shortcut: 'Ctrl+Z',
        disabled: undoLabel === null,
        action: () => store.undo(),
      },
      {
        label: redoLabel ? `Rehacer «${redoLabel}»` : 'Rehacer',
        shortcut: 'Ctrl+Y',
        disabled: redoLabel === null,
        action: () => store.redo(),
      },
      { label: '', separator: true },
      /*
       * Estas seis van contra el editor que tenga el TURNO (el último que se
       * tocó: Piano Roll o Playlist). El nombre de lo que van a tocar sale en
       * la propia entrada — "Copiar 3 notas" — porque con dos editores abiertos
       * "Copiar" a secas no dice de qué habla.
       */
      {
        label: edit ? `Cortar ${count(edit.selectionCount, edit.noun)}` : 'Cortar',
        shortcut: 'Ctrl+X',
        disabled: !edit || edit.selectionCount === 0,
        action: () => edit?.cut(),
      },
      {
        label: edit ? `Copiar ${count(edit.selectionCount, edit.noun)}` : 'Copiar',
        shortcut: 'Ctrl+C',
        disabled: !edit || edit.selectionCount === 0,
        action: () => edit?.copy(),
      },
      {
        label: 'Pegar',
        shortcut: 'Ctrl+V',
        // Pegar notas en la Playlist no significa nada: si lo guardado no es de
        // su tipo, la entrada se queda gris en vez de no hacer nada al pulsar.
        disabled: !edit || clipboardKind() !== edit.accepts,
        action: () => edit?.paste(),
      },
      {
        label: 'Duplicar',
        shortcut: 'Ctrl+B',
        disabled: !edit || edit.selectionCount === 0,
        action: () => edit?.duplicate(),
      },
      {
        label: 'Seleccionar todo',
        shortcut: 'Ctrl+A',
        disabled: !edit,
        action: () => edit?.selectAll(),
      },
      {
        label: 'Borrar la selección',
        icon: <IconClose />,
        shortcut: 'Supr',
        disabled: !edit || edit.selectionCount === 0,
        action: () => edit?.remove(),
      },
      { label: '', separator: true },
      { label: 'Historial…', action: () => toggleWindow('history') },
    ],
    Patrón: [
      { label: 'Nuevo patrón', icon: <IconPattern />, action: () => addPattern() },
      {
        label: pattern ? `Clonar "${pattern.name}"` : 'Clonar patrón',
        icon: <IconPattern />,
        disabled: !pattern,
        action: () => clonePattern(),
      },
      {
        label: pattern ? `Renombrar "${pattern.name}"…` : 'Renombrar patrón…',
        disabled: !pattern,
        action: () => renamePattern(),
      },
      { label: '', separator: true },
      {
        // Deshabilitado con un solo patrón: core lanza en vez de dejar el
        // proyecto sin ninguno, así que ni se ofrece.
        label: pattern
          ? `Borrar "${pattern.name}"${patternClipsHint(pattern.id)}`
          : 'Borrar el patrón activo',
        icon: <IconClose />,
        shortcut: 'Ctrl+Shift+Supr',
        disabled: !pattern || !canRemove,
        action: () => removeActivePattern(),
      },
    ],
    /*
     * Ver era un volcado de veinte líneas seguidas: los editores grandes, los
     * instrumentos, los paneles laterales y los ajustes pesaban lo mismo y
     * había que leerlo entero para encontrar nada. Ahora va por bloques con su
     * cabecera, en el orden en que se usan.
     */
    Ver: [
      { label: 'Editores', heading: true },
      windowItem('playlist', 'Playlist', <IconPlaylist />, 'F5'),
      windowItem('channelRack', 'Channel Rack', <IconChannelRack />, 'F6'),
      windowItem('pianoRoll', 'Piano Roll', <IconPianoRoll />, 'F7'),
      windowItem('liveView', 'Vista Live', <IconLive />, 'F8'),
      windowItem('mixer', 'Mixer', <IconMixer />, 'F9'),
      { label: 'Sonido', heading: true },
      windowItem('nova', 'Orbit Nova', <IconTrack kind="keys" />),
      windowItem('prisma', 'Orbit Prisma', <IconTrack kind="synth" />),
      windowItem('channelEditor', 'Editor de sonido', <IconTrack kind="fx" />),
      windowItem('scope', 'Orbit Scope', <IconWave />),
      { label: 'Movimiento y rutas', heading: true },
      windowItem('automation', 'Automatización', <IconAutomation />),
      windowItem('lfo', 'LFOs', <IconLfo />),
      windowItem('graph', 'Enrutado (nodos)', <IconGraph />),
      windowItem('history', 'Historial', undefined),
      { label: 'Paneles', heading: true },
      {
        label: 'Browser',
        icon: <IconBrowser />,
        checked: ui.browserOpen,
        action: () => useUiStore.setState((s) => ({ browserOpen: !s.browserOpen })),
      },
      {
        label: 'Panel de Claude',
        icon: <IconClaude />,
        checked: ui.claudePanelOpen,
        action: () => useUiStore.setState((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
      },
      {
        label: 'Modo Zen (oculta los paneles)',
        checked: ui.compact,
        action: () => useUiStore.setState((s) => ({ compact: !s.compact })),
      },
      windowItem('collab', 'Colaboración…', <IconCollab />),
      { label: 'El escritorio', heading: true },
      {
        label: 'Layouts',
        submenu: [
          ...LAYOUT_PRESETS.map((preset) => ({
            label: preset.name,
            action: () => applyPreset(preset.id),
          })),
          { label: '', separator: true },
          {
            label: 'Guardar el layout actual…',
            action: () => {
              const name = window.prompt('Nombre del layout', 'Mi layout');
              if (name) saveLayout(name.trim());
            },
          },
        ],
      },
      windowItem('settings', 'Ajustes', <IconSettings />, 'F10'),
    ],
    Ayuda: [
      {
        label: 'Atajos de teclado…',
        shortcut: 'F1',
        action: () => useUiStore.setState({ shortcutsOpen: true }),
      },
      {
        label: 'Paleta de comandos…',
        shortcut: 'Ctrl+K',
        action: () => usePaletteStore.getState().togglePalette(),
      },
      { label: '', separator: true },
      {
        label: 'Acerca de Orbit Studio…',
        action: () => useUiStore.setState({ aboutOpen: true }),
      },
    ],
  };

  return (
    <div className="menubar" ref={ref} role="menubar">
      {MENU_ORDER.map((name) => (
        <div
          key={name}
          className="menu"
          /*
           * ← y → van AQUÍ y no en el botón: así valen igual con el foco en el
           * botón que dentro del desplegable, que es donde el usuario está la
           * mayor parte del tiempo. Un submenú que ya las ha usado (abrir /
           * cerrar) corta la propagación y no llega nada.
           */
          onKeyDown={(e) => {
            if (e.defaultPrevented) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              stepMenu(name, e.key === 'ArrowRight' ? 1 : -1);
            }
          }}
        >
          <button
            className={`menu-btn${open === name ? ' open' : ''}`}
            data-menu={name}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === name}
            onClick={() => {
              setKeyboard(false);
              setOpen(open === name ? null : name);
            }}
            onPointerEnter={() => {
              if (open && open !== name) {
                setKeyboard(false);
                setOpen(name);
              }
            }}
            onKeyDown={(e) => {
              // Enter y Espacio ya abren por el onClick del <button>; lo que
              // añade esto es entrar con el FOCO en la primera entrada.
              if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setKeyboard(true);
                setOpen(name);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeMenu();
              }
            }}
          >
            {name}
          </button>
          {open === name && (
            <MenuList items={menus[name]!} autoFocus={keyboard} onRun={() => closeMenu(name)} />
          )}
        </div>
      ))}
    </div>
  );
}
