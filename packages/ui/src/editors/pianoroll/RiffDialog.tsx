/**
 * Riff machine: panel del Piano Roll que genera un motivo melódico sobre la
 * escala y la tónica activas de la toolbar. El motor es `riff` (core, puro y
 * determinista por semilla); aquí solo viven las opciones y los botones.
 */

import { useState } from 'react';
import { SCALES, riff, type Note, type RiffCharacter } from '@orbit/core';

/** Densidades ofrecidas (notas por compás). */
const DENSITIES = [1, 2, 3, 4, 6, 8, 12, 16];

const CHARACTERS: { id: RiffCharacter; label: string; hint: string }[] = [
  { id: 'sostenido', label: 'Sostenido', hint: 'Notas ligadas llenando la rejilla' },
  { id: 'sincopado', label: 'Sincopado', hint: 'Pie de compás y el resto a contratiempo' },
  { id: 'puntillo', label: 'Puntillo', hint: 'Parejas larga-corta (3:1)' },
];

/** Semilla nueva: el azar solo elige el número, el riff sale de él. */
const rollSeed = () => (Math.random() * 0xffffffff) >>> 0;

export interface RiffDialogProps {
  /** Tónica activa de la toolbar (semitonos 0..11). */
  root: number;
  /** Nombre de la escala activa (clave de SCALES). */
  scaleName: string;
  /** Pulsos por compás del proyecto. */
  beatsPerBar: number;
  /** Compases que dura el patrón ahora (valor de partida). */
  patternBars: number;
  /** Genera en el canal y patrón activos, en un solo undo. */
  onGenerate: (notes: Note[], replace: boolean) => void;
  onClose: () => void;
}

export function RiffDialog({
  root,
  scaleName,
  beatsPerBar,
  patternBars,
  onGenerate,
  onClose,
}: RiffDialogProps) {
  const [seed, setSeed] = useState(rollSeed);
  const [density, setDensity] = useState(4);
  const [bars, setBars] = useState(Math.min(8, Math.max(1, patternBars)));
  const [octaveLow, setOctaveLow] = useState(4);
  const [octaves, setOctaves] = useState(2);
  const [character, setCharacter] = useState<RiffCharacter>('sostenido');
  const [replace, setReplace] = useState(false);

  const generate = (withSeed: number) => {
    setSeed(withSeed);
    onGenerate(
      riff({
        seed: withSeed,
        root,
        scale: SCALES[scaleName] ?? SCALES['Menor natural']!,
        bars,
        beatsPerBar,
        density,
        octaveLow,
        octaves,
        character,
      }),
      replace,
    );
  };

  return (
    <div className="pr-riff" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pr-riff-head">
        <span className="pr-riff-title">Riff machine</span>
        <button className="tbtn" onClick={onClose} title="Cerrar (Alt+G)">
          ✕
        </button>
      </div>

      <p className="pr-riff-scale">
        Sobre la escala de la toolbar: {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][root]}{' '}
        {scaleName.toLowerCase()}
      </p>

      <div className="pr-riff-grid">
        <label className="pr-field">
          Densidad
          <select value={density} onChange={(e) => setDensity(Number(e.target.value))}>
            {DENSITIES.map((d) => (
              <option key={d} value={d}>
                {d}/compás
              </option>
            ))}
          </select>
        </label>
        <label className="pr-field">
          Compases
          <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 8, 12, 16].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="pr-field" title="Octava más grave del riff (convención FL: C5 = 60)">
          Octava
          <select value={octaveLow} onChange={(e) => setOctaveLow(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7].map((o) => (
              <option key={o} value={o}>
                C{o}
              </option>
            ))}
          </select>
        </label>
        <label className="pr-field" title="Cuántas octavas puede recorrer el motivo">
          Rango
          <select value={octaves} onChange={(e) => setOctaves(Number(e.target.value))}>
            {[1, 2, 3, 4].map((o) => (
              <option key={o} value={o}>
                {o} 8va
              </option>
            ))}
          </select>
        </label>
        <label
          className="pr-field pr-riff-wide"
          title={CHARACTERS.find((c) => c.id === character)?.hint}
        >
          Carácter
          <select
            value={character}
            onChange={(e) => setCharacter(e.target.value as RiffCharacter)}
          >
            {CHARACTERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pr-field pr-riff-wide" title="La misma semilla da siempre el mismo riff">
          Semilla
          <input
            type="number"
            value={seed}
            min={0}
            onChange={(e) => setSeed(Math.max(0, Number(e.target.value) >>> 0))}
          />
        </label>
      </div>

      <label className="pr-riff-check" title="Borra las notas del canal antes de generar">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
        Reemplazar lo que hay
      </label>

      <div className="pr-riff-actions">
        <button className="tbtn" onClick={() => generate(seed)} title="Generar con esta semilla">
          Generar
        </button>
        <button
          className="tbtn active"
          onClick={() => generate(rollSeed())}
          title="Semilla nueva y a generar otra vez"
        >
          Otro riff
        </button>
      </div>
    </div>
  );
}
