/**
 * Arpegiador del Piano Roll (paridad con el diálogo de FL).
 *
 * Sustituye al botón "Arp" de una sola pasada, que siempre hacía lo mismo
 * (subir, al paso del snap): con las notas ya escritas, separar un acorde para
 * que suene distinto era todo o nada. Aquí están el recorrido, el paso, el
 * gate, las octavas y las rampas, y CADA cambio se oye al momento sobre las
 * notas de verdad — no hay que aceptar para saber cómo suena.
 *
 * El motor es `arpeggiate` (core, puro); aquí solo viven los controles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArpLevels, ArpMode, ArpeggiateOptions } from '@orbit/core';
import { Knob } from '../../widgets/Knob';

const MODES: { id: ArpMode; label: string; hint: string }[] = [
  { id: 'up', label: 'Arriba', hint: 'De la nota grave a la aguda' },
  { id: 'down', label: 'Abajo', hint: 'De la aguda a la grave' },
  { id: 'updown', label: 'Arriba y abajo', hint: 'Sube y baja sin repetir los extremos' },
  { id: 'downup', label: 'Abajo y arriba', hint: 'Baja y sube sin repetir los extremos' },
  {
    id: 'alternate',
    label: 'Alterna',
    hint: 'Salta de un extremo al otro hacia el centro: grave, aguda, 2ª grave…',
  },
  { id: 'random', label: 'Aleatorio', hint: 'Orden al azar (la semilla lo hace repetible)' },
  { id: 'chord', label: 'Acorde', hint: 'No arpegia: repite el acorde entero en cada paso' },
];

/** Paso base. `null` = el que marque el snap de la toolbar. */
const STEPS: { label: string; beats: number | null }[] = [
  { label: 'Rejilla', beats: null },
  { label: '1 beat', beats: 1 },
  { label: '1/2', beats: 0.5 },
  { label: '1/3', beats: 1 / 3 },
  { label: '1/4', beats: 0.25 },
  { label: '1/6', beats: 1 / 6 },
  { label: '1/8', beats: 0.125 },
  { label: '1/16', beats: 0.0625 },
];

export interface ArpSettings {
  mode: ArpMode;
  stepIdx: number;
  timeMul: number;
  octaves: number;
  octaveMode: 'normal' | 'reverse';
  gate: number;
  group: boolean;
  levels: Required<ArpLevels>;
  seed: number;
}

export const ARP_DEFAULTS: ArpSettings = {
  mode: 'up',
  stepIdx: 0,
  timeMul: 1,
  octaves: 1,
  octaveMode: 'normal',
  gate: 1,
  group: false,
  levels: { pitch: 0, velocity: 0, pan: 0 },
  seed: 1,
};

/** Traduce los ajustes del panel a las opciones del motor. */
export function arpOptionsOf(s: ArpSettings, gridStep: number): ArpeggiateOptions {
  return {
    rate: STEPS[s.stepIdx]?.beats ?? gridStep,
    mode: s.mode,
    octaves: s.octaves,
    octaveMode: s.octaveMode,
    timeMul: s.timeMul,
    gate: s.gate,
    group: s.group,
    levels: s.levels,
    seed: s.seed,
  };
}

export interface ArpDialogProps {
  /** Paso de la rejilla activa (para la opción "Rejilla"). */
  gridStep: number;
  /** Cuántas notas se van a arpegiar (0 = no hay nada que hacer). */
  targetCount: number;
  /** Se llama en CADA cambio: aplica el arpegio sobre las notas de verdad. */
  onPreview: (opts: ArpeggiateOptions) => void;
  /** Deja lo previsualizado y cierra. */
  onAccept: () => void;
  /** Devuelve las notas a como estaban y cierra. */
  onCancel: () => void;
}

export function ArpDialog({
  gridStep,
  targetCount,
  onPreview,
  onAccept,
  onCancel,
}: ArpDialogProps) {
  const [settings, setSettings] = useState<ArpSettings>(ARP_DEFAULTS);
  /** El primer render ya previsualiza: el panel nunca se ve "sin efecto". */
  const first = useRef(true);

  const preview = useCallback(
    (next: ArpSettings) => {
      setSettings(next);
      onPreview(arpOptionsOf(next, gridStep));
    },
    [onPreview, gridStep],
  );

  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    onPreview(arpOptionsOf(ARP_DEFAULTS, gridStep));
    // Solo al montar: las previsualizaciones siguientes las dispara el usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (part: Partial<ArpSettings>) => preview({ ...settings, ...part });
  const level = (part: Partial<Required<ArpLevels>>) =>
    preview({ ...settings, levels: { ...settings.levels, ...part } });

  const modeHint = MODES.find((m) => m.id === settings.mode)?.hint;

  return (
    <div className="pr-arp" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pr-riff-head">
        <span className="pr-riff-title">Arpegiador</span>
        <button className="tbtn" onClick={onCancel} title="Cancelar y dejarlo como estaba (Esc)">
          ✕
        </button>
      </div>

      <p className="pr-riff-scale">
        {targetCount === 0
          ? 'No hay notas que arpegiar.'
          : `Sobre ${targetCount} nota(s) · se oye al momento, sin aceptar`}
      </p>

      <div className="pr-arp-rows">
        <label className="pr-field pr-arp-wide" title={modeHint}>
          Patrón
          <select
            value={settings.mode}
            onChange={(e) => patch({ mode: e.target.value as ArpMode })}
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="pr-field" title="Cada cuánto cae una nota del arpegio">
          Paso
          <select value={settings.stepIdx} onChange={(e) => patch({ stepIdx: Number(e.target.value) })}>
            {STEPS.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="pr-field" title="Octavas que recorre el ciclo por encima del acorde">
          Rango
          <select value={settings.octaves} onChange={(e) => patch({ octaves: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((o) => (
              <option key={o} value={o}>
                {o} 8va
              </option>
            ))}
          </select>
          <select
            value={settings.octaveMode}
            title="Normal empieza abajo; invertido empieza por la octava de arriba"
            onChange={(e) => patch({ octaveMode: e.target.value as 'normal' | 'reverse' })}
          >
            <option value="normal">Normal</option>
            <option value="reverse">Invertido</option>
          </select>
        </label>
      </div>

      <div className="pr-arp-knobs">
        <Knob
          value={settings.timeMul}
          min={0.25}
          max={4}
          defaultValue={1}
          curve="exp"
          label="Time mul"
          size={34}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => patch({ timeMul: v })}
        />
        <Knob
          value={settings.gate}
          min={0.05}
          max={2}
          defaultValue={1}
          label="Gate"
          size={34}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ gate: v })}
        />
      </div>

      {/* Los "Levels" de FL, con los que existen de verdad en una nota de
          Orbit. REL y los MOD X/Y no salen: aquí no hay esos parámetros por
          nota y una perilla que no hace nada es peor que no tenerla. */}
      <div className="pr-arp-levels">
        <span className="pr-arp-legend">Levels</span>
        <div className="pr-arp-knobs">
          <Knob
            value={settings.levels.pan}
            min={-1}
            max={1}
            defaultValue={0}
            label="Pan"
            size={30}
            format={(v) => (v === 0 ? 'centro' : `${v > 0 ? 'D' : 'I'} ${Math.round(Math.abs(v) * 100)}`)}
            onChange={(v) => level({ pan: v })}
          />
          <Knob
            value={settings.levels.velocity}
            min={-0.8}
            max={0.8}
            defaultValue={0}
            label="Vel"
            size={30}
            format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`}
            onChange={(v) => level({ velocity: v })}
          />
          <Knob
            value={settings.levels.pitch}
            min={-24}
            max={24}
            defaultValue={0}
            label="Tono"
            size={30}
            format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)} st`}
            onChange={(v) => level({ pitch: Math.round(v) })}
          />
        </div>
      </div>

      <label
        className="pr-riff-check"
        title="Trata TODAS las notas como un solo acorde aunque estén separadas: el arpegio no se corta entre ellas"
      >
        <input
          type="checkbox"
          checked={settings.group}
          onChange={(e) => patch({ group: e.target.checked })}
        />
        Agrupar las notas
      </label>

      {settings.mode === 'random' && (
        <button
          className="tbtn"
          onClick={() => patch({ seed: (Math.random() * 0xffffffff) >>> 0 })}
          title="Otro orden al azar (la semilla lo hace repetible)"
        >
          Otra tirada
        </button>
      )}

      <div className="pr-riff-actions">
        <button
          className="tbtn"
          onClick={() => preview(ARP_DEFAULTS)}
          title="Volver a los valores de fábrica"
        >
          Restablecer
        </button>
        <button className="tbtn" onClick={onCancel} title="Dejar las notas como estaban">
          Cancelar
        </button>
        <button className="tbtn active" onClick={onAccept} title="Quedarse con el arpegio">
          Aceptar
        </button>
      </div>
    </div>
  );
}
