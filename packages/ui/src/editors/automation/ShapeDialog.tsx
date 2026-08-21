/**
 * Generador de formas del editor de automatización (la "herramienta LFO").
 *
 * Rellena un tramo del clip con una onda: seno, triángulo, sierra, cuadrada o
 * aleatoria, con sus ciclos, su recorrido y su fase. Es lo que convierte un
 * tremolo, un pan que se mueve o un filtro que respira en cuatro campos, en vez
 * de en cincuenta puntos puestos a mano.
 *
 * La previsualización se DIBUJA, no se despacha. El arpegiador del Piano Roll
 * escribe de verdad en cada cambio de perilla porque hay que oírlo; aquí no
 * hace falta —una curva se ve— y despachar en cada tecleo obligaría a la danza
 * de deshacer-la-pasada-anterior, que es justo de donde salen los undos que
 * dejan dos versiones encima. Aquí el proyecto no se toca hasta "Aplicar".
 *
 * El motor es `shapePoints` (puro, con tests); aquí solo viven los controles.
 */

import { useEffect, useState } from 'react';
import { NumberScrubber } from '../../widgets/NumberScrubber';
import { SHAPE_LABELS, shapePoints, type CurveShape } from './curve-tools';
import type { AutomationPoint } from '@orbit/core';

export interface ShapeDialogProps {
  /** Longitud del clip en beats: el tramo por defecto es el clip entero. */
  clipLength: number;
  /** Texto del valor real (dB, Hz…) para una posición 0..1 del recorrido. */
  formatValue: (norm: number) => string;
  /** Se llama en cada cambio con la curva candidata (o null al cerrarse). */
  onPreview: (points: AutomationPoint[] | null) => void;
  onApply: (points: AutomationPoint[], from: number, to: number) => void;
  onClose: () => void;
}

const SHAPES: CurveShape[] = ['sine', 'triangle', 'sawUp', 'sawDown', 'square', 'random'];

export function ShapeDialog({
  clipLength,
  formatValue,
  onPreview,
  onApply,
  onClose,
}: ShapeDialogProps) {
  const [shape, setShape] = useState<CurveShape>('sine');
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(clipLength);
  const [cycles, setCycles] = useState(4);
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(100);
  const [phase, setPhase] = useState(0);
  const [resolution, setResolution] = useState(12);
  const [seed, setSeed] = useState(1);

  const points = shapePoints({
    shape,
    from,
    to: Math.min(to, clipLength),
    cycles,
    min: min / 100,
    max: max / 100,
    phase: phase / 100,
    resolution,
    seed,
  });

  // La previsualización se recalcula en cada cambio y se limpia al desmontar:
  // si el panel se cierra sin aplicar, el lienzo no puede quedarse con una
  // curva fantasma dibujada encima de la de verdad.
  useEffect(() => {
    onPreview(points.length > 0 ? points : null);
  });
  useEffect(() => () => onPreview(null), [onPreview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="au-shape" onPointerDown={(e) => e.stopPropagation()}>
      <div className="au-shape-head">
        <span className="au-shape-title">Forma</span>
        <button className="tbtn" onClick={onClose} title="Cerrar sin tocar la curva (Esc)">
          ✕
        </button>
      </div>

      <div className="au-shape-rows">
        <label className="au-field au-shape-wide">
          Onda
          <select
            value={shape}
            onChange={(e) => setShape(e.target.value as CurveShape)}
          >
            {SHAPES.map((s) => (
              <option key={s} value={s}>
                {SHAPE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="au-field" title="Cuántas ondas completas caben en el tramo">
          Ciclos
          <NumberScrubber
            value={cycles}
            min={0.25}
            max={64}
            step={0.25}
            decimals={2}
            onChange={setCycles}
          />
        </label>

        <label className="au-field" title="Dónde empieza el tramo que se rellena">
          Desde
          <NumberScrubber
            value={from}
            min={0}
            max={clipLength}
            step={0.25}
            decimals={2}
            suffix="b"
            onChange={setFrom}
          />
        </label>

        <label className="au-field" title="Dónde acaba el tramo que se rellena">
          Hasta
          <NumberScrubber
            value={to}
            min={0}
            max={clipLength}
            step={0.25}
            decimals={2}
            suffix="b"
            onChange={setTo}
          />
        </label>

        {/* Invertir mínimo y máximo da la forma del revés: es lo que se quiere
            para un filtro que baja en vez de subir, así que no se ordenan. */}
        <label className="au-field" title={`Extremo bajo: ${formatValue(min / 100)}`}>
          Mín
          <NumberScrubber
            value={min}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={setMin}
          />
        </label>

        <label className="au-field" title={`Extremo alto: ${formatValue(max / 100)}`}>
          Máx
          <NumberScrubber
            value={max}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={setMax}
          />
        </label>

        <label className="au-field" title="Desplaza la onda dentro de su ciclo">
          Fase
          <NumberScrubber
            value={phase}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={setPhase}
          />
        </label>

        {shape === 'sine' && (
          <label className="au-field" title="Puntos por ciclo: más suave, más breakpoints">
            Puntos/ciclo
            <NumberScrubber
              value={resolution}
              min={4}
              max={32}
              step={1}
              decimals={0}
              onChange={setResolution}
            />
          </label>
        )}

        {shape === 'random' && (
          <label className="au-field" title="La misma semilla da siempre la misma aleatoria">
            Semilla
            <NumberScrubber
              value={seed}
              min={1}
              max={9999}
              step={1}
              decimals={0}
              onChange={setSeed}
            />
          </label>
        )}
      </div>

      <div className="au-shape-actions">
        <span className="au-shape-count">{points.length} puntos</span>
        <button className="tbtn" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="tbtn active"
          disabled={points.length === 0}
          onClick={() => onApply(points, Math.min(from, to), Math.max(from, to))}
          title="Escribir la forma en el clip"
        >
          Aplicar
        </button>
      </div>
    </div>
  );
}
