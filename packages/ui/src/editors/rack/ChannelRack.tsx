/**
 * Channel Rack — step sequencer estilo FL Studio.
 *
 * Cabecera: selector de patrón (◀ ▶, punto de color, nombre editable con
 * doble clic, contador, botón +), conmutador del graph editor de velocity y
 * selector de pasos visibles (16/32/64 → length 4/8/16 beats). Debajo, la
 * barra de filtros (Todos · Drums · 808/Bajos · Melódicos · Sampler · Voces)
 * con buscador por nombre: estado de VISTA local, no toca el proyecto.
 *
 * Una fila por canal: LED de mute (Ctrl+clic = solo), perillas mini de
 * volumen/pan, nombre (clic = seleccionar, doble clic = Piano Roll, mantener
 * pulsado = preview), número de pista de mixer y los pasos agrupados de 4 en
 * 4. Un canal con melodía del Piano Roll (notas fuera de rejilla o duration >
 * 1/16) muestra una franja mini-preview EN VEZ de los pasos, que abre el
 * Piano Roll — como hace FL.
 *
 * Bajo las filas, el graph editor de velocity del canal seleccionado
 * (VelocityGraph): una barra por paso, se pinta arrastrando.
 *
 * ▶ en la cabecera reproduce SOLO este patrón (modo PAT desde 0). Clic
 * derecho en el nombre de un canal abre su menú: llenar cada 2/4/todos los
 * pasos, vaciar, randomizar, humanizar, renombrar, color y borrar canal.
 *
 * Toda mutación pasa por store.dispatch (bus de comandos de @orbit/core).
 */

import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  createChannel,
  createPattern,
  gainToDb,
  INSTRUMENT_LABELS,
  newId,
  type Channel,
  type Id,
  type InstrumentKind,
  type Note,
  type Pattern,
} from '@orbit/core';
import { addSamplerChannel, getDragEntry, SOUND_MIME } from '../../browser/sound-actions';
import { reportActivity } from '../../collab/presence';
import {
  engine,
  ensureAudioReady,
  play,
  setActivePattern,
  setPlayMode,
  stopPlayback,
  store,
} from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { Knob } from '../../widgets/Knob';
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

// ─────────────────────────────────────────────────────────────────────────────

export function ChannelRack() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const selectedChannelId = useUiStore((s) => s.pianoRollChannelId);
  const playingPattern = useUiStore((s) => s.playing && s.playMode === 'pattern');

  const [editingName, setEditingName] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const cancelName = useRef(false);
  /** Menú contextual de canal (clic derecho en el nombre): id + posición. */
  const [chanMenu, setChanMenu] = useState<{ id: Id; x: number; y: number } | null>(null);
  /** Canal cuyo nombre se está renombrando (desde el menú contextual). */
  const [renamingId, setRenamingId] = useState<Id | null>(null);
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
  // Se conserva el índice ORIGINAL del canal: engine.previewNote va por
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

  // El graph editor sigue al canal seleccionado; si el filtro lo esconde,
  // cae al primero visible para no quedarse en blanco.
  const graphRow = visibleRows.find((r) => r.id === selectedChannelId) ?? visibleRows[0];

  const goTo = (dir: -1 | 1) => {
    const next = project.patternOrder[patternIndex + dir];
    if (next) setActivePattern(next);
  };

  const addNewPattern = () => {
    const p = createPattern(project.patternOrder.length);
    store.dispatch({ type: 'addPattern', pattern: p }, { label: `Añadir "${p.name}"` });
    setActivePattern(p.id);
  };

  /** Clona el patrón activo (notas incluidas, con ids nuevos) justo después. */
  const clonePattern = () => {
    const notes: Record<Id, Note[]> = {};
    for (const [channelId, list] of Object.entries(pattern.notes)) {
      notes[channelId] = list.map((n) => ({ ...n, id: newId() }));
    }
    const clon: Pattern = {
      id: newId(),
      name: `${pattern.name} (copia)`,
      color: pattern.color,
      length: pattern.length,
      notes,
    };
    store.dispatch(
      { type: 'addPattern', pattern: clon, index: patternIndex + 1 },
      { label: `Clonar "${pattern.name}"` },
    );
    setActivePattern(clon.id);
  };

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
  };

  const setChannelColor = (channelId: Id, color: string) => {
    store.dispatch(
      { type: 'patchChannel', channelId, patch: { color } },
      { label: 'Color de canal', mergeKey: `rack:${channelId}:color` },
    );
  };

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

  const addChannel = (kind: InstrumentKind) => {
    const channel = createChannel(kind, project.channelOrder.length);
    store.dispatch({ type: 'addChannel', channel }, { label: `Añadir canal "${channel.name}"` });
    useUiStore.setState({ pianoRollChannelId: channel.id });
    setAddOpen(false);
  };

  // El menú abre hacia arriba cuando hay filas que lo tapen; hacia abajo si no.
  const menuUp = project.channelOrder.length >= 4;

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
              title="Doble clic para renombrar"
              onDoubleClick={() => setEditingName(true)}
            >
              {pattern.name}
            </span>
          )}
          <span className="rack-pattern-count">
            {patternIndex + 1}/{project.patternOrder.length}
          </span>
          <button className="rack-nav" onClick={addNewPattern} title="Nuevo patrón">
            +
          </button>
          <button
            className="rack-nav clone"
            onClick={clonePattern}
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
        {visibleRows.map(({ id, index, channel }) => (
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
              setChanMenu({
                id,
                x: Math.min(e.clientX, window.innerWidth - 210),
                y: Math.min(e.clientY, window.innerHeight - 340),
              });
            }}
          />
        ))}
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

      {chanMenu && menuChannel && (
        <>
          <div
            className="rack-backdrop"
            onClick={() => setChanMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setChanMenu(null);
            }}
          />
          <div className="popup rack-chan-menu" style={{ left: chanMenu.x, top: chanMenu.y }}>
            <div className="rack-chan-menu-title" style={{ borderLeftColor: menuChannel.color }}>
              {menuChannel.name}
            </div>
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
            <button
              className="menu-item"
              onClick={() => {
                deleteChannel(chanMenu.id);
                setChanMenu(null);
              }}
            >
              Borrar canal
            </button>
          </div>
        </>
      )}

      <div className="rack-addrow">
        <div className="rack-add">
          <button className="rack-add-btn" onClick={() => setAddOpen((v) => !v)}>
            + Añadir canal
          </button>
          {addOpen && (
            <>
              <div className="rack-backdrop" onClick={() => setAddOpen(false)} />
              <div className={`popup rack-add-menu ${menuUp ? 'up' : 'down'}`}>
                {INSTRUMENT_KINDS.map((kind) => (
                  <button key={kind} className="menu-item" onClick={() => addChannel(kind)}>
                    {INSTRUMENT_LABELS[kind]}
                  </button>
                ))}
              </div>
            </>
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
  /** Índice en channelOrder (lo usa engine.previewNote). */
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

  const select = () =>
    useUiStore.setState(
      channel.kind === 'nova'
        ? { pianoRollChannelId: channel.id, novaChannelId: channel.id }
        : { pianoRollChannelId: channel.id },
    );

  const openPianoRoll = () => {
    useUiStore.setState({ pianoRollChannelId: channel.id });
    useUiStore.getState().openWindow('pianoRoll');
  };

  const preview = (on: boolean) => {
    if (on) ensureAudioReady();
    engine.previewNote(channelIndex, key, on);
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
          title={`${channel.name} — clic: seleccionar · doble clic: Piano Roll · mantener: escuchar · clic derecho: menú`}
          onClick={select}
          onDoubleClick={openPianoRoll}
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
