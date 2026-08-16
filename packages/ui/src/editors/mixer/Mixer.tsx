/**
 * Mixer estilo FL Studio.
 *
 * Izquierda: fila horizontal scrolleable de strips (índice 0 = Master).
 * Derecha: panel fijo (300px) con la cadena de 10 slots de efectos de la
 * pista seleccionada.
 *
 * Interacciones:
 * - Clic en un strip: seleccionar. Doble clic en el nombre: renombrar.
 * - Ctrl+clic en otro strip: alterna un SEND de la pista seleccionada (0.7).
 * - Clic derecho en otro strip: menú "Enrutar aquí" (cambia routeTo).
 * - Cadena: "+" inserta efecto; clic en el nombre expande su editor inline
 *   con perillas generadas desde EFFECT_PARAMS.
 *
 * Toda mutación pasa por store.dispatch (bus de comandos); las ráfagas de
 * perilla/fader se funden en un solo undo vía mergeKey.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  EFFECT_LABELS,
  EFFECT_PARAMS,
  MIXER_SLOTS,
  defaultEffectParams,
  gainToDb,
  newId,
  type EffectKind,
  type EffectSlot,
  type MixerTrack,
  type ParamSpec,
} from '@orbit/core';
import { reportActivity } from '../../collab/presence';
import { store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { Fader } from '../../widgets/Fader';
import { Knob } from '../../widgets/Knob';
import { LevelMeter } from '../../widgets/LevelMeter';
import './mixer.css';

const EFFECT_KINDS = Object.keys(EFFECT_LABELS) as EffectKind[];
const FADER_H = 140;
const SEND_DEFAULT = 0.7;

// ── Helpers de formato ───────────────────────────────────────────────────────

function formatPan(v: number): string {
  const p = Math.round(v * 100);
  if (p === 0) return 'C';
  return p < 0 ? `${-p}L` : `${p}R`;
}

function formatParam(spec: ParamSpec, v: number): string {
  if (spec.options) {
    const i = Math.min(spec.options.length - 1, Math.max(0, Math.round(v)));
    return spec.options[i] ?? '';
  }
  if (spec.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (spec.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (spec.unit === 'dB') return `${v.toFixed(1)} dB`;
  if (spec.unit === 'st') return `${v.toFixed(1)} st`;
  const r = Math.round(v * 100) / 100;
  return spec.unit ? `${r} ${spec.unit}` : `${r}`;
}

function trackLabel(index: number, mixer: MixerTrack[]): string {
  if (index === 0) return 'Master';
  return mixer[index]?.name ?? `#${index}`;
}

// ── Menú flotante (efectos / routing) ────────────────────────────────────────

function FloatingMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    window.addEventListener('pointerdown', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      className="popup mixer-menu"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

// ── Strip ────────────────────────────────────────────────────────────────────

/** Medidor aislado: solo él re-renderiza a ~20 fps con los peaks del kernel. */
function StripMeter({ index }: { index: number }) {
  const peak = useUiStore((s) => (s.trackPeaks ? (s.trackPeaks[index] ?? 0) : 0));
  // El master lleva además la línea de RMS (el kernel solo lo mide ahí).
  const rms = useUiStore((s) => (index === 0 ? s.masterRms : undefined));
  return <LevelMeter peak={peak} rms={rms} height={FADER_H} />;
}

function StripName({ index, name }: { index: number; name: string }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  if (!editing) {
    return (
      <div
        className="strip-name"
        title={`${name} (doble clic: renombrar)`}
        onDoubleClick={() => {
          cancelled.current = false;
          setEditing(true);
        }}
      >
        {name}
      </div>
    );
  }
  return (
    <input
      className="strip-name-input"
      autoFocus
      defaultValue={name}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          setEditing(false);
        }
      }}
      onBlur={(e) => {
        if (cancelled.current) return;
        setEditing(false);
        const trimmed = e.currentTarget.value.trim();
        if (trimmed && trimmed !== name) {
          store.dispatch(
            { type: 'patchMixerTrack', trackIndex: index, patch: { name: trimmed } },
            { label: `Renombrar pista → "${trimmed}"` },
          );
        }
      }}
    />
  );
}

interface StripProps {
  index: number;
  track: MixerTrack;
  selected: boolean;
  /** Muestra el puntito de send (hay otra pista seleccionada que puede enviar aquí). */
  showDot: boolean;
  sendActive: boolean;
  /** Esta pista es el routeTo de la seleccionada. */
  isRouteTarget: boolean;
  onSelect: (index: number) => void;
  onToggleSend: (index: number) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, index: number) => void;
}

function Strip({
  index,
  track,
  selected,
  showDot,
  sendActive,
  isRouteTarget,
  onSelect,
  onToggleSend,
  onContextMenu,
}: StripProps) {
  const setVolume = useCallback(
    (volume: number) => {
      store.dispatch(
        { type: 'patchMixerTrack', trackIndex: index, patch: { volume } },
        { mergeKey: `mixer:${index}:vol`, label: 'Volumen' },
      );
    },
    [index],
  );

  const setPan = useCallback(
    (pan: number) => {
      store.dispatch(
        { type: 'patchMixerTrack', trackIndex: index, patch: { pan } },
        { mergeKey: `mixer:${index}:pan`, label: 'Pan' },
      );
    },
    [index],
  );

  const db = gainToDb(track.volume);

  return (
    <div
      className={`strip${selected ? ' selected' : ''}${index === 0 ? ' master' : ''}`}
      onClick={(e) => {
        if ((e.ctrlKey || e.metaKey) && showDot) onToggleSend(index);
        else onSelect(index);
      }}
      onContextMenu={(e) => onContextMenu(e, index)}
    >
      <div className="strip-color" style={{ background: track.color }} />
      <div className="strip-num">{index === 0 ? 'M' : index}</div>
      <StripName index={index} name={track.name} />
      <Knob
        value={track.pan}
        min={-1}
        max={1}
        defaultValue={0}
        size={22}
        format={formatPan}
        onChange={setPan}
      />
      <div className="strip-fader-row">
        <StripMeter index={index} />
        <Fader value={track.volume} height={FADER_H} onChange={setVolume} />
      </div>
      <div className="strip-db">{db <= -96 ? '-∞' : db.toFixed(1)}</div>
      <div className="strip-ms">
        <button
          className={`strip-btn${track.mute ? ' on-mute' : ''}`}
          title="Mute"
          onClick={(e) => {
            e.stopPropagation();
            store.dispatch(
              { type: 'patchMixerTrack', trackIndex: index, patch: { mute: !track.mute } },
              { label: track.mute ? 'Quitar mute' : 'Mute' },
            );
          }}
        >
          M
        </button>
        <button
          className={`strip-btn${track.solo ? ' on-solo' : ''}`}
          title="Solo"
          onClick={(e) => {
            e.stopPropagation();
            store.dispatch(
              { type: 'patchMixerTrack', trackIndex: index, patch: { solo: !track.solo } },
              { label: track.solo ? 'Quitar solo' : 'Solo' },
            );
          }}
        >
          S
        </button>
      </div>
      <div className="strip-route">
        {isRouteTarget ? (
          <span className="strip-route-arrow" title="La pista seleccionada desemboca aquí">
            ▶
          </span>
        ) : showDot ? (
          <span
            className={`strip-route-dot${sendActive ? ' active' : ''}`}
            title="Ctrl+clic: alternar send desde la pista seleccionada"
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Editor de un efecto (perillas desde EFFECT_PARAMS) ───────────────────────

function EffectEditor({
  trackIndex,
  slotIndex,
  slot,
  mixer,
}: {
  trackIndex: number;
  slotIndex: number;
  slot: EffectSlot;
  mixer: MixerTrack[];
}) {
  const specs = EFFECT_PARAMS[slot.kind];

  return (
    <div className="fx-editor">
      {specs.length === 0 && slot.kind !== 'compressor' && (
        <div className="fx-empty">Sin parámetros.</div>
      )}
      {specs.map((spec) =>
        spec.options ? (
          <div className="fx-opt" key={spec.key}>
            <select
              className="mixer-select"
              value={Math.min(
                spec.options.length - 1,
                Math.max(0, Math.round(slot.params[spec.key] ?? spec.default)),
              )}
              onChange={(e) =>
                store.dispatch(
                  {
                    type: 'setEffectParam',
                    trackIndex,
                    slotIndex,
                    key: spec.key,
                    value: Number(e.target.value),
                  },
                  { label: `Efecto: ${spec.label}` },
                )
              }
            >
              {spec.options.map((opt, oi) => (
                <option key={opt} value={oi}>
                  {opt}
                </option>
              ))}
            </select>
            <span className="knob-label">{spec.label}</span>
          </div>
        ) : (
          <Knob
            key={spec.key}
            value={slot.params[spec.key] ?? spec.default}
            min={spec.min}
            max={spec.max}
            defaultValue={spec.default}
            curve={spec.curve}
            label={spec.label}
            size={30}
            format={(v) => formatParam(spec, v)}
            onChange={(v) =>
              store.dispatch(
                { type: 'setEffectParam', trackIndex, slotIndex, key: spec.key, value: v },
                { mergeKey: `fx:${trackIndex}:${slotIndex}:${spec.key}`, label: spec.label },
              )
            }
          />
        ),
      )}
      {slot.kind === 'compressor' && (
        <label className="fx-side">
          <span>Sidechain</span>
          <select
            className="mixer-select"
            value={slot.sidechainSource ?? -1}
            onChange={(e) => {
              const v = Number(e.target.value);
              store.dispatch(
                {
                  type: 'patchEffect',
                  trackIndex,
                  slotIndex,
                  patch: { sidechainSource: v < 0 ? undefined : v },
                },
                { label: 'Sidechain' },
              );
            }}
          >
            <option value={-1}>Ninguno</option>
            {mixer.map((t, ti) =>
              ti === 0 ? null : (
                <option key={t.id} value={ti}>
                  {ti} — {t.name}
                </option>
              ),
            )}
          </select>
        </label>
      )}
    </div>
  );
}

// ── Panel de cadena (pista seleccionada) ─────────────────────────────────────

function ChainPanel({
  trackIndex,
  track,
  mixer,
}: {
  trackIndex: number;
  track: MixerTrack;
  mixer: MixerTrack[];
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fxMenu, setFxMenu] = useState<{ slot: number; x: number; y: number } | null>(null);

  // Cambiar de pista cierra editor y menú (los slots son de otra cadena).
  useEffect(() => {
    setExpanded(null);
    setFxMenu(null);
  }, [trackIndex]);

  const insert = useCallback(
    (slotIndex: number, kind: EffectKind) => {
      const slot: EffectSlot = {
        id: newId(),
        kind,
        enabled: true,
        mix: 1,
        params: defaultEffectParams(kind),
      };
      store.dispatch(
        { type: 'setEffect', trackIndex, slotIndex, slot },
        { label: `Insertar ${EFFECT_LABELS[kind]}` },
      );
      setExpanded(slotIndex);
    },
    [trackIndex],
  );

  // La cadena vocal de Orbit: EQ que limpia y da presencia, compresor que
  // sujeta, saturación suave, slap 1/4 y cola corta — la voz por encima.
  const freeSlots = track.slots.filter((s) => !s).length;
  const applyVocalChain = useCallback(() => {
    const free: number[] = [];
    for (let i = 0; i < MIXER_SLOTS && free.length < 5; i++) {
      if (!track.slots[i]) free.push(i);
    }
    if (free.length < 5) return;
    const mk = (kind: EffectKind, overrides: Record<string, number>, mix = 1): EffectSlot => ({
      id: newId(),
      kind,
      enabled: true,
      mix,
      params: { ...defaultEffectParams(kind), ...overrides },
    });
    const chain: [number, EffectSlot][] = [
      [free[0]!, mk('eq', { hpFreq: 90, lowGain: -2, lowFreq: 250, midGain: 2.5, midFreq: 3200, midQ: 0.9, highGain: 2, highFreq: 11000 })],
      [free[1]!, mk('compressor', { threshold: -18, ratio: 3, attack: 0.008, release: 0.12, makeup: 4 })],
      [free[2]!, mk('distortion', { drive: 0.18, tone: 5500, mode: 0, output: 1 }, 0.22)],
      [free[3]!, mk('delay', { time: 5, feedback: 0.28, pingpong: 1, filter: 3000 }, 0.15)],
      [free[4]!, mk('reverb', { size: 0.55, damp: 0.5, predelay: 0.03 }, 0.16)],
    ];
    const label = `Cadena vocal en "${track.name}"`;
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: chain.map(([slotIndex, slot]) => ({
          type: 'setEffect' as const,
          trackIndex,
          slotIndex,
          slot,
        })),
      },
      { label },
    );
  }, [track, trackIndex]);

  return (
    <div className="mixer-chain">
      <div className="mixer-chain-header">
        <div className="mixer-chain-title" title={track.name}>
          {trackIndex === 0 ? 'M' : trackIndex} · {track.name}
        </div>
        <div className="mixer-chain-route">
          {track.routeTo === null ? 'Salida final' : `→ ${trackLabel(track.routeTo, mixer)}`}
          {track.sends.length > 0 &&
            ` · ${track.sends.length} send${track.sends.length > 1 ? 's' : ''}`}
        </div>
        <button
          className="vocal-chain-btn"
          title="Monta la cadena vocal de Orbit (EQ + compresor + saturación + delay 1/4 + reverb) en 5 slots libres"
          disabled={freeSlots < 5}
          onClick={applyVocalChain}
        >
          Cadena vocal
        </button>
      </div>
      {track.sends.length > 0 && (
        <div className="mixer-sends">
          {track.sends.map((s) => (
            <div key={s.target} className="send-row">
              <span className="send-label" title={`Send hacia ${trackLabel(s.target, mixer)}`}>
                → {trackLabel(s.target, mixer)}
              </span>
              <Knob
                value={s.level}
                min={0}
                max={2}
                defaultValue={0.7}
                size={18}
                format={(v) => `Send ${Math.round(v * 100)}%`}
                onChange={(v) =>
                  store.dispatch(
                    { type: 'setSend', trackIndex, target: s.target, level: v },
                    { label: 'Nivel de send', mergeKey: `mx:send:${trackIndex}:${s.target}` },
                  )
                }
              />
              <button
                className="send-del"
                title="Quitar send"
                onClick={() =>
                  store.dispatch(
                    { type: 'setSend', trackIndex, target: s.target, level: null },
                    { label: 'Quitar send' },
                  )
                }
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mixer-chain-slots">
        {Array.from({ length: MIXER_SLOTS }, (_, i) => {
          const slot = track.slots[i] ?? null;
          if (!slot) {
            return (
              <div key={`empty-${i}`} className="fx-slot empty">
                <button
                  className="fx-add"
                  title="Insertar efecto"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setFxMenu({
                      slot: i,
                      x: Math.min(r.left, window.innerWidth - 190),
                      y: Math.min(r.bottom + 2, window.innerHeight - 330),
                    });
                  }}
                >
                  +
                </button>
              </div>
            );
          }
          return (
            <div key={slot.id} className="fx-slot">
              <div className={`fx-row${slot.enabled ? '' : ' off'}`}>
                <button
                  className={`fx-led${slot.enabled ? ' on' : ''}`}
                  title={slot.enabled ? 'Apagar' : 'Encender'}
                  onClick={() =>
                    store.dispatch(
                      {
                        type: 'patchEffect',
                        trackIndex,
                        slotIndex: i,
                        patch: { enabled: !slot.enabled },
                      },
                      {
                        label: `${slot.enabled ? 'Apagar' : 'Encender'} ${EFFECT_LABELS[slot.kind]}`,
                      },
                    )
                  }
                />
                <button
                  className="fx-name"
                  title="Editar parámetros"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  {EFFECT_LABELS[slot.kind]}
                </button>
                <Knob
                  value={slot.mix}
                  min={0}
                  max={1}
                  defaultValue={1}
                  size={18}
                  format={(v) => `Mix ${Math.round(v * 100)}%`}
                  onChange={(v) =>
                    store.dispatch(
                      { type: 'patchEffect', trackIndex, slotIndex: i, patch: { mix: v } },
                      { mergeKey: `fx:${trackIndex}:${i}:mix`, label: 'Mix' },
                    )
                  }
                />
                <button
                  className="fx-del"
                  title="Quitar efecto"
                  onClick={() => {
                    store.dispatch(
                      { type: 'setEffect', trackIndex, slotIndex: i, slot: null },
                      { label: `Quitar ${EFFECT_LABELS[slot.kind]}` },
                    );
                    if (expanded === i) setExpanded(null);
                  }}
                >
                  ×
                </button>
              </div>
              {expanded === i && (
                <EffectEditor trackIndex={trackIndex} slotIndex={i} slot={slot} mixer={mixer} />
              )}
            </div>
          );
        })}
      </div>
      {fxMenu && (
        <FloatingMenu x={fxMenu.x} y={fxMenu.y} onClose={() => setFxMenu(null)}>
          {EFFECT_KINDS.map((kind) => (
            <button
              key={kind}
              className="menu-item"
              onClick={() => {
                insert(fxMenu.slot, kind);
                setFxMenu(null);
              }}
            >
              {EFFECT_LABELS[kind]}
            </button>
          ))}
        </FloatingMenu>
      )}
    </div>
  );
}

// ── Mixer ────────────────────────────────────────────────────────────────────

export function Mixer() {
  const project = useProject();
  const selectedRaw = useUiStore((s) => s.selectedMixerTrack);
  const [routeMenu, setRouteMenu] = useState<{ target: number; x: number; y: number } | null>(
    null,
  );

  const mixer = project.mixer;
  const selIndex = selectedRaw >= 0 && selectedRaw < mixer.length ? selectedRaw : 0;
  const selTrack = mixer[selIndex];

  const onSelect = useCallback(
    (i: number) => {
      useUiStore.setState({ selectedMixerTrack: i });
      reportActivity('Mixer', { detail: mixer[i]?.name });
    },
    [mixer],
  );

  const onToggleSend = useCallback(
    (target: number) => {
      const t = store.project.mixer[selIndex];
      if (!t || selIndex === 0 || target === selIndex) return;
      const has = t.sends.some((s) => s.target === target);
      store.dispatch(
        { type: 'setSend', trackIndex: selIndex, target, level: has ? null : SEND_DEFAULT },
        { label: has ? `Quitar send ${selIndex} → ${target}` : `Send ${selIndex} → ${target}` },
      );
    },
    [selIndex],
  );

  const onStripContext = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, i: number) => {
      e.preventDefault();
      // El master no se re-enruta; y una pista no puede enrutarse a sí misma.
      if (i === selIndex || selIndex === 0) return;
      setRouteMenu({
        target: i,
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 70),
      });
    },
    [selIndex],
  );

  if (!selTrack) return null;

  return (
    <div className="mixer">
      <div className="mixer-strips">
        {mixer.map((t, i) => (
          <Strip
            key={t.id}
            index={i}
            track={t}
            selected={i === selIndex}
            showDot={i !== selIndex && selIndex !== 0}
            sendActive={i !== selIndex && selTrack.sends.some((s) => s.target === i)}
            isRouteTarget={i !== selIndex && selTrack.routeTo === i}
            onSelect={onSelect}
            onToggleSend={onToggleSend}
            onContextMenu={onStripContext}
          />
        ))}
      </div>
      <ChainPanel trackIndex={selIndex} track={selTrack} mixer={mixer} />
      {routeMenu && (
        <FloatingMenu x={routeMenu.x} y={routeMenu.y} onClose={() => setRouteMenu(null)}>
          <button
            className="menu-item"
            onClick={() => {
              store.dispatch(
                { type: 'setRoute', trackIndex: selIndex, routeTo: routeMenu.target },
                { label: `Enrutar ${trackLabel(selIndex, mixer)} → ${trackLabel(routeMenu.target, mixer)}` },
              );
              setRouteMenu(null);
            }}
          >
            Enrutar aquí ({trackLabel(routeMenu.target, mixer)})
          </button>
        </FloatingMenu>
      )}
    </div>
  );
}
