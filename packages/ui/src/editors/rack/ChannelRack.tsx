/**
 * Channel Rack — step sequencer estilo FL Studio.
 *
 * Cabecera: selector de patrón (◀ ▶, punto de color, nombre editable con
 * doble clic y con menú contextual propio —renombrar, color, clonar, borrar—,
 * contador, botón +), conmutador del graph editor de velocity y selector de
 * pasos visibles (16/32/64 → length 4/8/16 beats). Debajo, la barra de filtros
 * (Todos · Drums · 808/Bajos · Melódicos · Sampler · Voces) con buscador por
 * nombre: estado de VISTA local, no toca el proyecto.
 *
 * Una fila por canal: LED de mute (Ctrl+clic = solo), perillas mini de
 * volumen/pan, nombre (clic = seleccionar, doble clic = editor de sonido,
 * mantener pulsado = preview), número de pista de mixer y los pasos agrupados
 * de 4 en 4. Un canal con melodía del Piano Roll (notas fuera de rejilla o
 * duration > 1/16) muestra una franja mini-preview EN VEZ de los pasos, que
 * abre el Piano Roll — como hace FL.
 *
 * Bajo las filas, el graph editor de velocity del canal seleccionado
 * (VelocityGraph): una barra por paso, se pinta arrastrando.
 *
 * ▶ en la cabecera reproduce SOLO este patrón (modo PAT desde 0). Clic
 * derecho en el nombre de un canal abre su menú: editor de sonido, Piano Roll,
 * llenar cada 2/4/todos los pasos, vaciar, randomizar, humanizar, renombrar,
 * color y borrar canal.
 *
 * Todos los menús flotantes van por MenuPortal: un `position: fixed` dentro de
 * una ventana con blur o transform se recorta, y el backdrop a pantalla
 * completa que los cerraba se comía el primer clic en cualquier parte de la
 * app. MenuPortal cierra con el pointerdown de SU ventana y se clampa contra
 * ella, así que el rack desacoplado se comporta igual que el acoplado.
 *
 * Toda mutación pasa por store.dispatch (bus de comandos de @orbit/core).
 */

import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  createChannel,
  gainToDb,
  INSTRUMENT_LABELS,
  newId,
  type Channel,
  type ChannelGroup,
  type Command,
  type Id,
  type InstrumentKind,
  type Note,
} from '@orbit/core';
import { addSamplerChannel, getDragEntry, SOUND_MIME } from '../../browser/sound-actions';
import { reportActivity } from '../../collab/presence';
// Las acciones de patrón viven en un solo sitio a propósito: el guard del
// último patrón, el realineo del patrón activo y el aviso de cuántos clips se
// lleva por delante no pueden divergir entre la paleta, el MenuBar y este menú.
import {
  addPattern,
  canRemovePattern,
  clonePattern,
  patternClipCount,
  removePattern,
  setPatternColor,
} from '../../palette/default-commands';
import {
  ensureAudioReady,
  play,
  setActivePattern,
  setPlayMode,
  stopPlayback,
  store,
} from '../../state/app';
import { previewNote } from '../../state/active-notes';
import { usePluginsStore, type PluginInfo } from '../../state/plugins';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { Knob } from '../../widgets/Knob';
import { MenuPortal } from '../../widgets/MenuPortal';
import {
  DEFAULT_FILTER_ID,
  matchesChannel,
  matchesKind,
  matchesQuery,
  RACK_FILTERS,
} from './filters';
import { humanizeStepsCommand, randomizeStepsCommand } from './step-tools';
import { DEFAULT_VELOCITY, defaultKey, isMelodic, STEP, stepIndexOf } from './steps';
import { VelocityGraph } from './VelocityGraph';
import './rack.css';

const INSTRUMENT_KINDS = Object.keys(INSTRUMENT_LABELS) as InstrumentKind[];

/** Pasos visibles ↔ length del patrón en beats. */
const LENGTH_CHOICES = [
  { steps: 16, beats: 4 },
  { steps: 32, beats: 8 },
  { steps: 64, beats: 16 },
] as const;

function formatPan(v: number): string {
  if (Math.abs(v) < 0.005) return 'C';
  return v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`;
}

/** Estado de un menú flotante: dónde va y en qué ventana vive (MenuPortal). */
interface MenuAt {
  x: number;
  y: number;
  anchor: Element;
}

/** Posición de menú a partir del evento que lo abre. */
function menuAtEvent(e: ReactMouseEvent<HTMLElement>): MenuAt {
  return { x: e.clientX, y: e.clientY, anchor: e.currentTarget };
}

/**
 * Estado de UI al seleccionar un canal. Nova y Prisma tienen panel propio de
 * presets: hay que apuntarlo también, o "abrir presets" enseñaría el sonido
 * del último canal de ese tipo que se tocara, no el que acabas de elegir.
 */
function selectionFor(
  kind: InstrumentKind,
  id: Id,
): { pianoRollChannelId: Id; novaChannelId?: Id; prismaChannelId?: Id } {
  if (kind === 'nova') return { pianoRollChannelId: id, novaChannelId: id };
  if (kind === 'prisma') return { pianoRollChannelId: id, prismaChannelId: id };
  return { pianoRollChannelId: id };
}

// ─────────────────────────────────────────────────────────────────────────────

export function ChannelRack() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const selectedChannelId = useUiStore((s) => s.pianoRollChannelId);
  const playingPattern = useUiStore((s) => s.playing && s.playMode === 'pattern');

  const [editingName, setEditingName] = useState(false);
  /** Menú de "+ Añadir canal" (desplegable bajo el botón). */
  const [addMenu, setAddMenu] = useState<MenuAt | null>(null);
  const instrumentPlugins = usePluginsStore((s) => s.plugins).filter((p) => p.instrument);
  const cancelName = useRef(false);
  /** Menú contextual de canal (clic derecho en el nombre): id + posición. */
  const [chanMenu, setChanMenu] = useState<(MenuAt & { id: Id }) | null>(null);
  /** Menú contextual del PATRÓN activo (clic derecho en su nombre). */
  const [patMenu, setPatMenu] = useState<MenuAt | null>(null);
  /** Canal cuyo nombre se está renombrando (desde el menú contextual). */
  const [renamingId, setRenamingId] = useState<Id | null>(null);
  /** Carpeta cuyo nombre se está editando en el sitio (recién creada o F2). */
  const [renamingGroupId, setRenamingGroupId] = useState<Id | null>(null);
  /** Graph editor de velocity abierto (vista local, como en FL). */
  const [graphOpen, setGraphOpen] = useState(false);
  /** Filtro de familia de instrumento y buscador por nombre (solo vista). */
  const [filterId, setFilterId] = useState(DEFAULT_FILTER_ID);
  const [query, setQuery] = useState('');

  // Patrón activo (fallback al primero si la UI aún no fijó ninguno).
  const firstPatternId = project.patternOrder[0];
  const patternId =
    activePatternId && project.patterns[activePatternId] ? activePatternId : firstPatternId;
  const pattern = patternId !== undefined ? project.patterns[patternId] : undefined;
  const patternLength = pattern?.length ?? 0;

  // Paso bajo el playhead (solo en modo patrón y reproduciendo); -1 = ninguno.
  const playStep = useUiStore((s) =>
    s.playing && s.playMode === 'pattern' && patternLength > 0
      ? Math.floor((((s.positionBeats % patternLength) + patternLength) % patternLength) / STEP)
      : -1,
  );

  if (!pattern || patternId === undefined) {
    return <div className="rack rack-empty">No hay patrones en el proyecto.</div>;
  }

  const steps = Math.max(1, Math.round(pattern.length / STEP));
  const patternIndex = project.patternOrder.indexOf(patternId);
  const anySolo = project.channelOrder.some((id) => project.channels[id]?.solo === true);

  // ── Vista filtrada ────────────────────────────────────────────────────────
  // Se conserva el índice ORIGINAL del canal: previewNote va por
  // posición en channelOrder, no por posición en la lista visible.
  const visibleRows: { id: Id; index: number; channel: Channel }[] = [];
  project.channelOrder.forEach((id, index) => {
    const channel = project.channels[id];
    if (channel && matchesChannel(channel, filterId, query)) {
      visibleRows.push({ id, index, channel });
    }
  });
  /** Cuántos canales caen en cada filtro con el buscador puesto. */
  const filterCount = (id: string): number =>
    project.channelOrder.reduce((acc, cid) => {
      const ch = project.channels[cid];
      return ch && matchesKind(ch, id) && matchesQuery(ch, query) ? acc + 1 : acc;
    }, 0);

  // ── Carpetas ──────────────────────────────────────────────────────────────
  // Se pintan en su orden y con sus canales dentro; lo que no está en ninguna
  // (o apunta a una que ya no existe) va suelto al final, como siempre.
  const groupedRows = project.channelGroupOrder
    .map((gid) => project.channelGroups[gid])
    .filter((g): g is ChannelGroup => g !== undefined)
    .map((group) => ({
      group,
      rows: visibleRows.filter((r) => r.channel.groupId === group.id),
    }))
    // Con un filtro puesto, una carpeta sin nada que enseñar solo estorba.
    .filter(({ rows }) => rows.length > 0 || (filterId === DEFAULT_FILTER_ID && query === ''));
  const looseRows = visibleRows.filter(
    (r) => !r.channel.groupId || !project.channelGroups[r.channel.groupId],
  );

  // El graph editor sigue al canal seleccionado; si el filtro lo esconde,
  // cae al primero visible para no quedarse en blanco.
  const graphRow = visibleRows.find((r) => r.id === selectedChannelId) ?? visibleRows[0];

  const goTo = (dir: -1 | 1) => {
    const next = project.patternOrder[patternIndex + dir];
    if (next) setActivePattern(next);
  };

  /** Clips de la playlist que viven de este patrón (se van con él al borrarlo). */
  const clipsOfPattern = patternClipCount(patternId);

  /** Play del propio rack: suena SOLO este patrón, desde el principio. */
  const playRack = () => {
    if (playingPattern) {
      stopPlayback();
      return;
    }
    stopPlayback(); // caret a 0
    setActivePattern(patternId);
    setPlayMode('pattern');
    void play();
  };

  // ── Acciones del menú contextual de canal ──────────────────────────────────

  const menuChannel = chanMenu ? project.channels[chanMenu.id] : undefined;

  /** Añade un paso cada `every` celdas (solo en las vacías), como FL. */
  const fillEvery = (channelId: Id, every: number) => {
    const ch = project.channels[channelId];
    if (!ch) return;
    const key = defaultKey(ch.kind);
    const occupied = new Set(
      (pattern.notes[channelId] ?? []).filter((n) => !isMelodic(n)).map(stepIndexOf),
    );
    const notes: Note[] = [];
    for (let i = 0; i < steps; i += every) {
      if (occupied.has(i)) continue;
      notes.push({
        id: newId(),
        start: i * STEP,
        duration: STEP,
        key,
        velocity: DEFAULT_VELOCITY,
        pan: 0,
        slide: false,
      });
    }
    if (notes.length > 0) {
      store.dispatch(
        { type: 'addNotes', patternId, channelId, notes },
        { label: every === 1 ? `Llenar todos los pasos de ${ch.name}` : `Llenar cada ${every} pasos de ${ch.name}` },
      );
    }
  };

  /** Borra todas las notas del canal en el patrón activo. */
  const clearChannel = (channelId: Id) => {
    const ch = project.channels[channelId];
    const list = pattern.notes[channelId] ?? [];
    if (!ch || list.length === 0) return;
    store.dispatch(
      { type: 'removeNotes', patternId, channelId, noteIds: list.map((n) => n.id) },
      { label: `Vaciar ${ch.name} en ${pattern.name}` },
    );
  };

  /**
   * Randomiza los pasos del canal: probabilidad por posición (los pulsos
   * pesan más) y velocity variada, en UN solo undo. Sustituye los pasos que
   * hubiera pero deja intacta la melodía del Piano Roll.
   */
  const randomizeSteps = (channelId: Id) => {
    const ch = project.channels[channelId];
    if (!ch) return;
    const cmd = randomizeStepsCommand({
      patternId,
      channelId,
      kind: ch.kind,
      notes: pattern.notes[channelId] ?? EMPTY_NOTES,
      steps,
      patternLength: pattern.length,
    });
    if (cmd) store.dispatch(cmd, { label: `Randomizar pasos de ${ch.name}` });
  };

  /** Humaniza: timing ligeramente corrido y velocity variada, en un undo. */
  const humanizeSteps = (channelId: Id) => {
    const ch = project.channels[channelId];
    if (!ch) return;
    const cmd = humanizeStepsCommand({
      patternId,
      channelId,
      kind: ch.kind,
      notes: pattern.notes[channelId] ?? EMPTY_NOTES,
      steps,
      patternLength: pattern.length,
    });
    if (cmd) store.dispatch(cmd, { label: `Humanizar ${ch.name}` });
  };

  const deleteChannel = (channelId: Id) => {
    const ch = project.channels[channelId];
    if (!ch) return;
    store.dispatch({ type: 'removeChannel', channelId }, { label: `Borrar canal "${ch.name}"` });
    if (selectedChannelId === channelId) useUiStore.setState({ pianoRollChannelId: null });
    // El editor de sonido se queda apuntando a un canal que ya no existe: se
    // suelta para que muestre su placeholder en vez de un panel fantasma.
    if (useUiStore.getState().channelEditorId === channelId) {
      useUiStore.setState({ channelEditorId: null });
    }
  };

  /** Editor de sonido del canal (lo mismo que el doble clic en su nombre). */
  const openSoundEditor = (channelId: Id) => {
    const ch = project.channels[channelId];
    if (!ch) return;
    useUiStore.setState({ ...selectionFor(ch.kind, channelId), channelEditorId: channelId });
    useUiStore.getState().openWindow('channelEditor');
  };

  /** Piano Roll del canal: sigue a un clic del menú, no lo perdemos. */
  const openPianoRollFor = (channelId: Id) => {
    useUiStore.setState({ pianoRollChannelId: channelId });
    useUiStore.getState().openWindow('pianoRoll');
  };

  const setChannelColor = (channelId: Id, color: string) => {
    store.dispatch(
      { type: 'patchChannel', channelId, patch: { color } },
      { label: 'Color de canal', mergeKey: `rack:${channelId}:color` },
    );
  };

  // ── Carpetas ──────────────────────────────────────────────────────────────

  /** Carpeta nueva, con el canal dado dentro si se pasa uno (un solo undo). */
  const addGroup = (channelId?: Id) => {
    const group: ChannelGroup = {
      id: newId(),
      name: `Carpeta ${project.channelGroupOrder.length + 1}`,
      color: project.channels[channelId ?? '']?.color ?? '#5aa9e6',
      collapsed: false,
    };
    const commands: Command[] = [{ type: 'addChannelGroup', group }];
    if (channelId) {
      commands.push({ type: 'patchChannel', channelId, patch: { groupId: group.id } });
    }
    const label = 'Carpeta nueva';
    store.dispatch(
      commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
      { label },
    );
    setRenamingGroupId(group.id);
  };

  /** Mueve un canal a una carpeta; cadena vacía = sacarlo (ver Channel.groupId). */
  const moveToGroup = (channelId: Id, groupId: Id | '') => {
    const name = groupId ? project.channelGroups[groupId]?.name : null;
    store.dispatch(
      { type: 'patchChannel', channelId, patch: { groupId } },
      { label: name ? `Mover a "${name}"` : 'Sacar de la carpeta' },
    );
  };

  const patchGroup = (groupId: Id, patch: Partial<Omit<ChannelGroup, 'id'>>, label: string) =>
    store.dispatch({ type: 'patchChannelGroup', groupId, patch }, { label, mergeKey: `group:${groupId}:${label}` });

  /** Canales de una carpeta, en el orden del rack. */
  const membersOf = (groupId: Id): Id[] =>
    project.channelOrder.filter((id) => project.channels[id]?.groupId === groupId);

  /** ¿La carpeta entera lleva ese flag? (para encender su botón). */
  const groupFlagOn = (groupId: Id, flag: 'mute' | 'solo'): boolean => {
    const ids = membersOf(groupId);
    return ids.length > 0 && ids.every((id) => project.channels[id]?.[flag] === true);
  };

  /**
   * Mute/solo de la carpeta entera: NO es un bus, así que se le hace a cada
   * canal en un solo paso de undo. Si queda alguno sin marcar, se marcan todos;
   * si ya lo estaban todos, se quitan.
   */
  const toggleGroupFlag = (groupId: Id, flag: 'mute' | 'solo') => {
    const ids = membersOf(groupId);
    if (ids.length === 0) return;
    const next = !ids.every((id) => project.channels[id]?.[flag] === true);
    const group = project.channelGroups[groupId];
    const label = `${next ? 'Activar' : 'Quitar'} ${flag} en "${group?.name ?? 'carpeta'}"`;
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: ids.map((id) => ({
          type: 'patchChannel' as const,
          channelId: id,
          patch: { [flag]: next },
        })),
      },
      { label },
    );
  };

  const dissolveGroup = (groupId: Id) => {
    const group = project.channelGroups[groupId];
    store.dispatch(
      { type: 'removeChannelGroup', groupId },
      { label: `Deshacer carpeta "${group?.name ?? ''}"` },
    );
  };

  /**
   * Una fila de canal. Se saca a función porque ahora se pinta desde dos
   * sitios (dentro de una carpeta y suelta) y la lista de props es larga.
   */
  const renderRow = ({ id, index, channel }: { id: Id; index: number; channel: Channel }) => (
    <ChannelRow
      key={id}
      channel={channel}
      channelIndex={index}
      patternId={patternId}
      notes={pattern.notes[id] ?? EMPTY_NOTES}
      steps={steps}
      patternLength={pattern.length}
      selected={selectedChannelId === id}
      audible={!channel.mute && (!anySolo || channel.solo)}
      playStep={playStep}
      renaming={renamingId === id}
      onRenameDone={() => setRenamingId(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        // Sin clamp a mano: MenuPortal mide el menú y lo mete en la ventana
        // que de verdad lo contiene (también si el rack está desacoplado,
        // donde window.innerWidth era el de la principal).
        setChanMenu({ id, ...menuAtEvent(e) });
      }}
    />
  );

  const commitName = (raw: string) => {
    setEditingName(false);
    if (cancelName.current) {
      cancelName.current = false;
      return;
    }
    const name = raw.trim();
    if (!name || name === pattern.name) return;
    store.dispatch(
      { type: 'patchPattern', patternId, patch: { name } },
      { label: `Renombrar patrón a "${name}"` },
    );
  };

  const setLength = (beats: number) => {
    if (pattern.length === beats) return;
    store.dispatch(
      { type: 'patchPattern', patternId, patch: { length: beats } },
      { label: `Patrón a ${Math.round(beats / STEP)} pasos` },
    );
  };

  /**
   * Canal tocado por un plugin JS de instrumento: el kind interno da igual
   * (el plugin sustituye a la voz), pero se guardan sus perillas declaradas
   * para que el motor se las pase con setParams.
   */
  const addPluginChannel = (plugin: PluginInfo) => {
    const channel = createChannel('synth', project.channelOrder.length, plugin.name);
    channel.instrumentPluginId = plugin.id;
    for (const spec of plugin.params) channel.params[spec.key] = spec.default;
    store.dispatch(
      { type: 'addChannel', channel },
      { label: `Añadir "${plugin.name}" (plugin JS)` },
    );
    setAddMenu(null);
  };

  const addChannel = (kind: InstrumentKind) => {
    const channel = createChannel(kind, project.channelOrder.length);
    store.dispatch({ type: 'addChannel', channel }, { label: `Añadir canal "${channel.name}"` });
    // Nova y Prisma llegan con preset cargado: además de seleccionarlos, se
    // apunta su panel al canal nuevo para que "Presets" abra el suyo y no el
    // del último canal que se tocara.
    useUiStore.setState(selectionFor(channel.kind, channel.id));
    setAddMenu(null);
  };

  return (
    <div
      className="rack"
      onPointerDown={() => reportActivity('Channel Rack')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SOUND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const entry = getDragEntry(e.dataTransfer);
        if (!entry) return;
        e.preventDefault();
        void addSamplerChannel(entry);
      }}
    >
      <div className="rack-head">
        <div className="rack-pattern">
          <button
            className={`rack-play${playingPattern ? ' on' : ''}`}
            onClick={playRack}
            title={playingPattern ? 'Parar' : 'Escuchar este patrón (solo el Channel Rack)'}
          >
            {playingPattern ? '■' : '▶'}
          </button>
          <button
            className="rack-nav"
            onClick={() => goTo(-1)}
            disabled={patternIndex <= 0}
            title="Patrón anterior"
          >
            ◀
          </button>
          <button
            className="rack-nav"
            onClick={() => goTo(1)}
            disabled={patternIndex >= project.patternOrder.length - 1}
            title="Patrón siguiente"
          >
            ▶
          </button>
          <span className="rack-dot" style={{ background: pattern.color }} />
          {editingName ? (
            <input
              className="rack-name-input"
              defaultValue={pattern.name}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') {
                  cancelName.current = true;
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span
              className="rack-pattern-name"
              title="Doble clic: renombrar · clic derecho: menú del patrón (clonar, borrar…)"
              onDoubleClick={() => setEditingName(true)}
              onContextMenu={(e) => {
                e.preventDefault();
                setPatMenu(menuAtEvent(e));
              }}
            >
              {pattern.name}
            </span>
          )}
          <span className="rack-pattern-count">
            {patternIndex + 1}/{project.patternOrder.length}
          </span>
          <button className="rack-nav" onClick={addPattern} title="Nuevo patrón">
            +
          </button>
          <button
            className="rack-nav clone"
            onClick={() => clonePattern(patternId)}
            title="Clonar patrón (notas incluidas)"
          >
            ⧉
          </button>
        </div>
        <div className="rack-head-tools">
          <button
            className={`rack-len wide${graphOpen ? ' active' : ''}`}
            onClick={() => setGraphOpen((v) => !v)}
            title="Graph editor: velocity de los pasos del canal seleccionado"
          >
            Velocity
          </button>
          <div className="rack-lengths" title="Pasos del patrón">
            {LENGTH_CHOICES.map((c) => (
              <button
                key={c.steps}
                className={`rack-len${pattern.length === c.beats ? ' active' : ''}`}
                onClick={() => setLength(c.beats)}
              >
                {c.steps}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rack-filters">
        {RACK_FILTERS.map((f) => {
          const count = filterCount(f.id);
          return (
            <button
              key={f.id}
              className={`rack-filter${filterId === f.id ? ' active' : ''}${count === 0 ? ' empty' : ''}`}
              title={f.title}
              onClick={() => setFilterId(f.id)}
            >
              {f.label}
              <span className="rack-filter-count">{count}</span>
            </button>
          );
        })}
        <div className="rack-search">
          <input
            className="rack-search-input"
            type="search"
            placeholder="Buscar canal…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query !== '' && (
            <button className="rack-search-clear" title="Limpiar búsqueda" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
      </div>

      <div className="rack-rows">
        {project.channelOrder.length === 0 && (
          <div className="rack-hint">Sin canales — añade un instrumento abajo.</div>
        )}
        {project.channelOrder.length > 0 && visibleRows.length === 0 && (
          <div className="rack-hint">
            Ningún canal pasa el filtro.{' '}
            <button
              className="rack-hint-link"
              onClick={() => {
                setFilterId(DEFAULT_FILTER_ID);
                setQuery('');
              }}
            >
              Quitar filtros
            </button>
          </div>
        )}
        {groupedRows.map(({ group, rows }) => (
          <div className="rack-group" key={group.id}>
            <div className="rack-group-head" style={{ borderLeftColor: group.color }}>
              <button
                className="rack-group-fold"
                title={group.collapsed ? 'Desplegar carpeta' : 'Plegar carpeta'}
                onClick={() =>
                  patchGroup(group.id, { collapsed: !group.collapsed }, 'Plegar carpeta')
                }
              >
                {group.collapsed ? '▸' : '▾'}
              </button>
              {renamingGroupId === group.id ? (
                <input
                  className="rack-group-name-input"
                  defaultValue={group.name}
                  autoFocus
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== group.name) patchGroup(group.id, { name }, 'Renombrar carpeta');
                    setRenamingGroupId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setRenamingGroupId(null);
                  }}
                />
              ) : (
                <button
                  className="rack-group-name"
                  title="Doble clic para renombrar"
                  onDoubleClick={() => setRenamingGroupId(group.id)}
                  onClick={() =>
                    patchGroup(group.id, { collapsed: !group.collapsed }, 'Plegar carpeta')
                  }
                >
                  {group.name}
                </button>
              )}
              <span className="rack-group-count">{rows.length}</span>
              <button
                className={`rack-group-btn${groupFlagOn(group.id, 'mute') ? ' on' : ''}`}
                title="Mute de toda la carpeta"
                onClick={() => toggleGroupFlag(group.id, 'mute')}
              >
                M
              </button>
              <button
                className={`rack-group-btn${groupFlagOn(group.id, 'solo') ? ' on' : ''}`}
                title="Solo de toda la carpeta"
                onClick={() => toggleGroupFlag(group.id, 'solo')}
              >
                S
              </button>
              <label className="rack-group-color" title="Color de la carpeta">
                <input
                  type="color"
                  value={group.color}
                  onChange={(e) => patchGroup(group.id, { color: e.target.value }, 'Color de carpeta')}
                />
              </label>
              <button
                className="rack-group-btn"
                title="Deshacer la carpeta (los canales se quedan sueltos)"
                onClick={() => dissolveGroup(group.id)}
              >
                ✕
              </button>
            </div>
            {!group.collapsed && rows.map(renderRow)}
            {!group.collapsed && rows.length === 0 && (
              <div className="rack-group-empty">
                Carpeta vacía — muévele canales desde su menú (clic derecho en el nombre).
              </div>
            )}
          </div>
        ))}
        {looseRows.map(renderRow)}
      </div>

      {graphOpen && graphRow && (
        <VelocityGraph
          channel={graphRow.channel}
          patternId={patternId}
          notes={pattern.notes[graphRow.id] ?? EMPTY_NOTES}
          steps={steps}
          playStep={playStep}
        />
      )}

      {patMenu && (
        <MenuPortal
          anchor={patMenu.anchor}
          x={patMenu.x}
          y={patMenu.y}
          className="rack-pat-menu"
          onClose={() => setPatMenu(null)}
        >
          <div className="rack-chan-menu-title" style={{ borderLeftColor: pattern.color }}>
            {pattern.name}
          </div>
          <button
            className="menu-item"
            onClick={() => {
              setEditingName(true);
              setPatMenu(null);
            }}
          >
            Renombrar…
          </button>
          <label className="menu-item rack-chan-color">
            Cambiar color
            <input
              type="color"
              value={pattern.color}
              onChange={(e) => setPatternColor(patternId, e.target.value)}
            />
          </label>
          <button
            className="menu-item"
            title="Copia el patrón con sus notas justo después de este"
            onClick={() => {
              clonePattern(patternId);
              setPatMenu(null);
            }}
          >
            Clonar patrón
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            // El core LANZA al borrar el último patrón: la opción se apaga
            // antes de que el usuario se coma la excepción.
            disabled={!canRemovePattern()}
            title={
              !canRemovePattern()
                ? 'Siempre tiene que quedar un patrón'
                : clipsOfPattern > 0
                  ? `Se lleva ${clipsOfPattern} clip(s) de la playlist — Ctrl+Z lo devuelve todo`
                  : 'Ctrl+Z lo devuelve'
            }
            onClick={() => {
              removePattern(patternId);
              setPatMenu(null);
            }}
          >
            Borrar patrón
            {clipsOfPattern > 0 && (
              <span className="menu-shortcut">{clipsOfPattern} clip(s)</span>
            )}
          </button>
        </MenuPortal>
      )}

      {chanMenu && menuChannel && (
        <MenuPortal
          anchor={chanMenu.anchor}
          x={chanMenu.x}
          y={chanMenu.y}
          className="rack-chan-menu"
          onClose={() => setChanMenu(null)}
        >
          <div className="rack-chan-menu-title" style={{ borderLeftColor: menuChannel.color }}>
            {menuChannel.name}
          </div>
          <button
            className="menu-item"
            title="Todo lo que se le puede hacer a este sonido: perillas, recorte, efectos propios y mezcla"
            onClick={() => {
              openSoundEditor(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Editor de sonido…
          </button>
          <button
            className="menu-item"
            title="Editar las notas de este canal en el patrón activo"
            onClick={() => {
              openPianoRollFor(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Piano Roll
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              fillEvery(chanMenu.id, 2);
              setChanMenu(null);
            }}
          >
            Llenar cada 2 pasos
          </button>
          <button
            className="menu-item"
            onClick={() => {
              fillEvery(chanMenu.id, 4);
              setChanMenu(null);
            }}
          >
            Llenar cada 4 pasos
          </button>
          <button
            className="menu-item"
            onClick={() => {
              fillEvery(chanMenu.id, 1);
              setChanMenu(null);
            }}
          >
            Llenar todos los pasos
          </button>
          <button
            className="menu-item"
            onClick={() => {
              clearChannel(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Vaciar canal en este patrón
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            title="Reparte pasos al azar (los pulsos pesan más) con velocity variada"
            onClick={() => {
              randomizeSteps(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Randomizar pasos
          </button>
          <button
            className="menu-item"
            disabled={(pattern.notes[chanMenu.id] ?? EMPTY_NOTES).length === 0}
            title="Corre un pelín el timing y varía la velocity de lo que ya hay"
            onClick={() => {
              humanizeSteps(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Humanizar
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setRenamingId(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Renombrar…
          </button>
          <label className="menu-item rack-chan-color">
            Cambiar color
            <input
              type="color"
              value={menuChannel.color}
              onChange={(e) => setChannelColor(chanMenu.id, e.target.value)}
            />
          </label>
          <div className="menu-sep" />
          <div className="rack-add-sep">Carpeta</div>
          {project.channelGroupOrder
            .map((gid) => project.channelGroups[gid])
            .filter((g): g is ChannelGroup => g !== undefined)
            .map((g) => (
              <button
                key={g.id}
                className={`menu-item${menuChannel.groupId === g.id ? ' on' : ''}`}
                onClick={() => {
                  moveToGroup(chanMenu.id, g.id);
                  setChanMenu(null);
                }}
              >
                {g.name}
              </button>
            ))}
          {menuChannel.groupId && (
            <button
              className="menu-item"
              onClick={() => {
                moveToGroup(chanMenu.id, '');
                setChanMenu(null);
              }}
            >
              Sacar de la carpeta
            </button>
          )}
          <button
            className="menu-item"
            onClick={() => {
              addGroup(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Carpeta nueva con este canal…
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              deleteChannel(chanMenu.id);
              setChanMenu(null);
            }}
          >
            Borrar canal
          </button>
        </MenuPortal>
      )}

      <div className="rack-addrow">
        <div className="rack-add">
          <button
            className="rack-add-btn"
            onPointerDown={(e) => {
              // Abre en pointerdown y CORTA la propagación: MenuPortal escucha
              // el cierre en la ventana, así que sin esto el mismo clic que
              // abre el menú lo cerraría acto seguido.
              e.stopPropagation();
              // El elemento se guarda ANTES del updater: React vacía
              // currentTarget en cuanto el manejador vuelve.
              const el = e.currentTarget;
              const r = el.getBoundingClientRect();
              setAddMenu((open) => (open ? null : { x: r.left, y: r.bottom + 4, anchor: el }));
            }}
          >
            + Añadir canal
          </button>
          <button
            className="rack-add-btn"
            title="Agrupa canales para no perderte (no toca el audio)"
            onClick={() => addGroup()}
          >
            + Carpeta
          </button>
          {addMenu && (
            <MenuPortal
              anchor={addMenu.anchor}
              x={addMenu.x}
              y={addMenu.y}
              className="rack-add-menu"
              onClose={() => setAddMenu(null)}
            >
              {INSTRUMENT_KINDS.map((kind) => (
                <button key={kind} className="menu-item" onClick={() => addChannel(kind)}>
                  {INSTRUMENT_LABELS[kind]}
                </button>
              ))}
              {instrumentPlugins.length > 0 && (
                <>
                  <div className="rack-add-sep">Plugins JS</div>
                  {instrumentPlugins.map((plugin) => (
                    <button
                      key={plugin.id}
                      className="menu-item"
                      onClick={() => addPluginChannel(plugin)}
                    >
                      {plugin.name}
                    </button>
                  ))}
                </>
              )}
            </MenuPortal>
          )}
        </div>
      </div>
    </div>
  );
}

const EMPTY_NOTES: readonly Note[] = [];

// ── Fila de canal ────────────────────────────────────────────────────────────

interface ChannelRowProps {
  channel: Channel;
  /** Índice en channelOrder (lo usa previewNote). */
  channelIndex: number;
  patternId: Id;
  notes: readonly Note[];
  steps: number;
  patternLength: number;
  selected: boolean;
  /** Suena ahora mismo (mute/solo resueltos): enciende el LED. */
  audible: boolean;
  playStep: number;
  /** El nombre está en modo edición (lo pide el menú contextual). */
  renaming: boolean;
  onRenameDone: () => void;
  /** Clic derecho en el nombre: abre el menú contextual del canal. */
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

function ChannelRow({
  channel,
  channelIndex,
  patternId,
  notes,
  steps,
  patternLength,
  selected,
  audible,
  playStep,
  renaming,
  onRenameDone,
  onContextMenu,
}: ChannelRowProps) {
  const [editingMix, setEditingMix] = useState(false);
  const cancelMix = useRef(false);
  const cancelRename = useRef(false);

  const commitRename = (raw: string) => {
    onRenameDone();
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const name = raw.trim();
    if (!name || name === channel.name) return;
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: { name } },
      { label: `Renombrar canal a "${name}"` },
    );
  };

  const key = defaultKey(channel.kind);
  const melodic = notes.some(isMelodic);

  // Notas por celda (solo en modo steps).
  const cells: Note[][] = Array.from({ length: steps }, () => []);
  if (!melodic) {
    for (const n of notes) {
      const idx = stepIndexOf(n);
      if (idx >= 0 && idx < steps) cells[idx]?.push(n);
    }
  }

  const toggleMuteSolo = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey) {
      store.dispatch(
        { type: 'patchChannel', channelId: channel.id, patch: { solo: !channel.solo } },
        { label: channel.solo ? `Quitar solo de ${channel.name}` : `Solo de ${channel.name}` },
      );
    } else {
      store.dispatch(
        { type: 'patchChannel', channelId: channel.id, patch: { mute: !channel.mute } },
        { label: channel.mute ? `Activar ${channel.name}` : `Silenciar ${channel.name}` },
      );
    }
  };

  const setVolume = (volume: number) =>
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: { volume } },
      { label: `Volumen de ${channel.name}`, mergeKey: `rack:${channel.id}:vol` },
    );

  const setPan = (pan: number) =>
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: { pan } },
      { label: `Pan de ${channel.name}`, mergeKey: `rack:${channel.id}:pan` },
    );

  const select = () => useUiStore.setState(selectionFor(channel.kind, channel.id));

  const openPianoRoll = () => {
    useUiStore.setState({ pianoRollChannelId: channel.id });
    useUiStore.getState().openWindow('pianoRoll');
  };

  /**
   * Editor de sonido del canal. Es lo que abre el doble clic desde ahora: al
   * hacerlo sobre un sonido lo que se quiere es TOCARLO (bajarle el reverb,
   * acortarlo, invertirlo), no escribir notas — el Piano Roll sigue a un clic
   * en el menú contextual y en la franja de melodía.
   */
  const openSoundEditor = () => {
    useUiStore.setState({
      ...selectionFor(channel.kind, channel.id),
      channelEditorId: channel.id,
    });
    useUiStore.getState().openWindow('channelEditor');
  };

  const preview = (on: boolean) => {
    if (on) ensureAudioReady();
    previewNote(channelIndex, key, on);
  };

  const commitMix = (raw: string) => {
    setEditingMix(false);
    if (cancelMix.current) {
      cancelMix.current = false;
      return;
    }
    const parsed = Math.round(Number(raw));
    if (!Number.isFinite(parsed)) return;
    const mixerTrack = Math.min(25, Math.max(0, parsed));
    if (mixerTrack === channel.mixerTrack) return;
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: { mixerTrack } },
      { label: `${channel.name} → ${mixerTrack === 0 ? 'Master' : `Insert ${mixerTrack}`}` },
    );
  };

  const paint = (i: number) => {
    const note: Note = {
      id: newId(),
      start: i * STEP,
      duration: STEP,
      key,
      velocity: DEFAULT_VELOCITY,
      pan: 0,
      slide: false,
    };
    store.dispatch(
      { type: 'addNotes', patternId, channelId: channel.id, notes: [note] },
      { label: `Paso en ${channel.name}` },
    );
  };

  const erase = (cellNotes: Note[]) => {
    if (cellNotes.length === 0) return;
    store.dispatch(
      {
        type: 'removeNotes',
        patternId,
        channelId: channel.id,
        noteIds: cellNotes.map((n) => n.id),
      },
      { label: `Borrar paso en ${channel.name}` },
    );
  };

  return (
    <div className={`rack-row${selected ? ' sel' : ''}`}>
      <button
        className={`rack-led${audible ? ' on' : ''}${channel.solo ? ' solo' : ''}`}
        title="Silenciar canal (Ctrl+clic: solo)"
        onClick={toggleMuteSolo}
      />
      <Knob
        value={channel.volume}
        min={0}
        max={2}
        defaultValue={0.78}
        size={22}
        format={(v) => `${gainToDb(v).toFixed(1)} dB`}
        onChange={setVolume}
        paramRef={{ kind: 'channelMix', channelId: channel.id, param: 'volume' }}
      />
      <Knob
        value={channel.pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={22}
        format={formatPan}
        onChange={setPan}
        paramRef={{ kind: 'channelMix', channelId: channel.id, param: 'pan' }}
      />
      {renaming ? (
        <input
          className="rack-rename-input"
          defaultValue={channel.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              cancelRename.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className={`rack-name${selected ? ' sel' : ''}`}
          style={{ borderLeftColor: channel.color }}
          title={`${channel.name} — clic: seleccionar · doble clic: editor de sonido · mantener: escuchar · clic derecho: menú (Piano Roll incluido)`}
          onClick={select}
          onDoubleClick={openSoundEditor}
          onContextMenu={onContextMenu}
          onPointerDown={(e) => {
            if (e.button === 0) preview(true);
          }}
          onPointerUp={() => preview(false)}
          onPointerLeave={() => preview(false)}
          onPointerCancel={() => preview(false)}
        >
          {channel.name}
        </button>
      )}
      {editingMix ? (
        <input
          className="rack-mix-input"
          type="number"
          min={0}
          max={25}
          defaultValue={channel.mixerTrack}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitMix(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              cancelMix.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          className="rack-mix"
          title="Pista de mixer (clic para cambiar)"
          onClick={() => setEditingMix(true)}
        >
          {channel.mixerTrack === 0 ? 'M' : channel.mixerTrack}
        </button>
      )}

      {melodic ? (
        <MiniPreview
          notes={notes}
          patternLength={patternLength}
          steps={steps}
          color={channel.color}
          playStep={playStep}
          onOpen={openPianoRoll}
        />
      ) : (
        <div className="rack-steps" onContextMenu={(e) => e.preventDefault()}>
          {cells.map((cellNotes, i) => {
            const occupied = cellNotes.length > 0;
            const first = cellNotes[0];
            const vel = first ? first.velocity : DEFAULT_VELOCITY;
            const opacity =
              Math.abs(vel - DEFAULT_VELOCITY) < 0.001 ? 1 : Math.max(0.15, Math.min(1, vel));
            const cls = [
              'step',
              Math.floor(i / 4) % 2 === 0 ? 'ga' : 'gb',
              i % 4 === 0 && i > 0 ? 'gs' : '',
              i === playStep ? 'ph' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={i}
                className={cls}
                onPointerDown={(e) => {
                  e.preventDefault();
                  if (e.button === 0) {
                    if (occupied) erase(cellNotes);
                    else paint(i);
                  } else if (e.button === 2 && occupied) {
                    erase(cellNotes);
                  }
                }}
                onPointerEnter={(e) => {
                  // Pintar arrastrando (izq: solo celdas vacías; der: borra).
                  if ((e.buttons & 1) !== 0 && !occupied) paint(i);
                  else if ((e.buttons & 2) !== 0 && occupied) erase(cellNotes);
                }}
              >
                {occupied && (
                  <div className="step-fill" style={{ background: channel.color, opacity }} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Mini preview de melodía (no interactivo; el botón abre el Piano Roll) ────

interface MiniPreviewProps {
  notes: readonly Note[];
  patternLength: number;
  steps: number;
  color: string;
  playStep: number;
  onOpen: () => void;
}

function MiniPreview({ notes, patternLength, steps, color, playStep, onOpen }: MiniPreviewProps) {
  let minKey = Infinity;
  let maxKey = -Infinity;
  for (const n of notes) {
    if (n.key < minKey) minKey = n.key;
    if (n.key > maxKey) maxKey = n.key;
  }
  const span = Math.max(1, maxKey - minKey);
  return (
    <button
      className="rack-mini"
      title="Melodía del Piano Roll — clic para editar"
      onClick={onOpen}
    >
      {notes.map((n) => {
        const t = (n.key - minKey) / span;
        return (
          <span
            key={n.id}
            className="rack-mini-note"
            style={{
              left: `${(n.start / patternLength) * 100}%`,
              width: `${Math.max(1, (n.duration / patternLength) * 100)}%`,
              top: `${8 + (1 - t) * 66}%`,
              background: color,
            }}
          />
        );
      })}
      {playStep >= 0 && (
        <span
          className="rack-mini-ph"
          style={{ left: `${(playStep / steps) * 100}%`, width: `${100 / steps}%` }}
        />
      )}
      <span className="rack-mini-hint">Piano Roll ▸</span>
    </button>
  );
}
