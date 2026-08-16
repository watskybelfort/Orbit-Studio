/**
 * Channel Rack — step sequencer estilo FL Studio.
 *
 * Cabecera: selector de patrón (◀ ▶, punto de color, nombre editable con
 * doble clic, contador, botón +) y selector de pasos visibles (16/32/64 →
 * length 4/8/16 beats). Una fila por canal: LED de mute (Ctrl+clic = solo),
 * perillas mini de volumen/pan, nombre (clic = seleccionar, doble clic =
 * Piano Roll, mantener pulsado = preview), número de pista de mixer y los
 * pasos agrupados de 4 en 4. Un canal con melodía del Piano Roll (notas
 * fuera de rejilla o duration > 1/16) muestra una franja mini-preview EN VEZ
 * de los pasos, que abre el Piano Roll — como hace FL.
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
} from '@orbit/core';
import { addSamplerChannel, getDragEntry, SOUND_MIME } from '../../browser/sound-actions';
import { engine, ensureAudioReady, setActivePattern, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { Knob } from '../../widgets/Knob';
import './rack.css';

/** Un paso = 1/16 = 0.25 beats. */
const STEP = 0.25;
const EPS = 1e-6;

const INSTRUMENT_KINDS = Object.keys(INSTRUMENT_LABELS) as InstrumentKind[];

/** Pasos visibles ↔ length del patrón en beats. */
const LENGTH_CHOICES = [
  { steps: 16, beats: 4 },
  { steps: 32, beats: 8 },
  { steps: 64, beats: 16 },
] as const;

/** Altura por defecto al pintar un paso: kick (36) en drums, C5 (60) en el resto. */
function defaultKey(kind: InstrumentKind): number {
  return kind === 'drums' ? 36 : 60;
}

/** Nota que no cabe en el step sequencer (melodía de Piano Roll). */
function isMelodic(n: Note): boolean {
  const rel = n.start / STEP;
  return Math.abs(rel - Math.round(rel)) > 1e-3 || n.duration > STEP + 1e-3;
}

function formatPan(v: number): string {
  if (Math.abs(v) < 0.005) return 'C';
  return v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`;
}

// ─────────────────────────────────────────────────────────────────────────────

export function ChannelRack() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const selectedChannelId = useUiStore((s) => s.pianoRollChannelId);

  const [editingName, setEditingName] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const cancelName = useRef(false);

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

  const goTo = (dir: -1 | 1) => {
    const next = project.patternOrder[patternIndex + dir];
    if (next) setActivePattern(next);
  };

  const addNewPattern = () => {
    const p = createPattern(project.patternOrder.length);
    store.dispatch({ type: 'addPattern', pattern: p }, { label: `Añadir "${p.name}"` });
    setActivePattern(p.id);
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
        </div>
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

      <div className="rack-rows">
        {project.channelOrder.length === 0 && (
          <div className="rack-hint">Sin canales — añade un instrumento abajo.</div>
        )}
        {project.channelOrder.map((id, i) => {
          const channel = project.channels[id];
          if (!channel) return null;
          return (
            <ChannelRow
              key={id}
              channel={channel}
              channelIndex={i}
              patternId={patternId}
              notes={pattern.notes[id] ?? EMPTY_NOTES}
              steps={steps}
              patternLength={pattern.length}
              selected={selectedChannelId === id}
              audible={!channel.mute && (!anySolo || channel.solo)}
              playStep={playStep}
            />
          );
        })}
      </div>

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
}: ChannelRowProps) {
  const [editingMix, setEditingMix] = useState(false);
  const cancelMix = useRef(false);

  const key = defaultKey(channel.kind);
  const melodic = notes.some(isMelodic);

  // Notas por celda (solo en modo steps).
  const cells: Note[][] = Array.from({ length: steps }, () => []);
  if (!melodic) {
    for (const n of notes) {
      const idx = Math.floor(n.start / STEP + EPS);
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

  const select = () => useUiStore.setState({ pianoRollChannelId: channel.id });

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
      velocity: 0.8,
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
      />
      <Knob
        value={channel.pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={22}
        format={formatPan}
        onChange={setPan}
      />
      <button
        className={`rack-name${selected ? ' sel' : ''}`}
        style={{ borderLeftColor: channel.color }}
        title={`${channel.name} — clic: seleccionar · doble clic: Piano Roll · mantener: escuchar`}
        onClick={select}
        onDoubleClick={openPianoRoll}
        onPointerDown={(e) => {
          if (e.button === 0) preview(true);
        }}
        onPointerUp={() => preview(false)}
        onPointerLeave={() => preview(false)}
        onPointerCancel={() => preview(false)}
      >
        {channel.name}
      </button>
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
            const vel = first ? first.velocity : 0.8;
            const opacity = Math.abs(vel - 0.8) < 0.001 ? 1 : Math.max(0.15, Math.min(1, vel));
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
