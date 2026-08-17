/**
 * Panel de LFOs: la lista de moduladores del proyecto.
 *
 * Un LFO no dibuja el valor de un parámetro (eso es un clip de
 * automatización): lo hace **oscilar alrededor del valor que tenga**, así que
 * si además hay automatización en el mismo destino, el LFO ondula sobre la
 * curva. Se crean desde el menú contextual de cualquier perilla; aquí se
 * ajustan forma, velocidad (en beats por ciclo), profundidad y fase.
 *
 * La perilla de la UI NO se mueve con el LFO: la modulación vive en el motor
 * y el valor guardado sigue siendo la base. Por eso cada fila muestra el
 * recorrido real ("0.50 → 1.50") calculado con las mismas conversiones del
 * kernel (`paramRefValue`), y así se ve de un vistazo hasta dónde llega.
 */

import {
  LFO_SHAPES,
  describeParamRef,
  formatParamRef,
  paramRefNorm,
  type Lfo,
  type LfoShape,
  type Project,
} from '@orbit/core';
import { removeLfo } from '../../state/param-actions';
import { store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { Knob } from '../../widgets/Knob';
import './lfo.css';

/** Velocidades ofrecidas, en beats por ciclo (rejilla musical). */
const RATES: { beats: number; label: string }[] = [
  { beats: 0.25, label: '1/16' },
  { beats: 0.5, label: '1/8' },
  { beats: 1, label: '1/4' },
  { beats: 2, label: '1/2' },
  { beats: 4, label: '1 compás' },
  { beats: 8, label: '2 compases' },
  { beats: 16, label: '4 compases' },
  { beats: 32, label: '8 compases' },
];

const SHAPE_LABELS: Record<LfoShape, string> = {
  sine: 'Seno',
  triangle: 'Triángulo',
  saw: 'Sierra',
  square: 'Cuadrada',
  random: 'Aleatoria (S&H)',
};

/** Trazo del ciclo para el mini-dibujo de cada forma (viewBox 0 0 40 16). */
const SHAPE_PATHS: Record<LfoShape, string> = {
  sine: 'M0 8 C 5 8, 5 2, 10 2 C 15 2, 15 14, 20 14 C 25 14, 25 2, 30 2 C 35 2, 35 8, 40 8',
  triangle: 'M0 8 L10 2 L20 8 L30 14 L40 8',
  saw: 'M0 14 L20 2 L20 14 L40 2',
  square: 'M0 2 L20 2 L20 14 L40 14',
  random: 'M0 5 L10 5 L10 12 L20 12 L20 3 L30 3 L30 9 L40 9',
};

export function LfoPanel() {
  const project = useProject();
  const lfos = Object.values(project.lfos);

  return (
    <div className="lfo">
      <div className="lfo-head">
        <span className="lfo-count">
          {lfos.length === 0
            ? 'Sin LFOs'
            : `${lfos.length} LFO${lfos.length > 1 ? 's' : ''} en el proyecto`}
        </span>
        <span className="lfo-hint">
          Clic derecho en cualquier perilla → <b>Añadir LFO</b>
        </span>
      </div>

      {lfos.length === 0 ? (
        <p className="lfo-empty">
          Un LFO mueve un parámetro sin parar: filtro que respira, pan que se
          abre, volumen que late. Ábrelo desde la perilla que quieras modular y
          aparecerá aquí para afinarlo. La velocidad va en beats, así que sigue
          al tempo, y suena igual en directo que en el export.
        </p>
      ) : (
        <div className="lfo-list">
          {lfos.map((lfo) => (
            <LfoRow key={lfo.id} lfo={lfo} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

function LfoRow({ lfo, project }: { lfo: Lfo; project: Project }) {
  const patch = (p: Partial<Omit<Lfo, 'id'>>, label: string, mergeKey?: string) => {
    store.dispatch({ type: 'patchLfo', lfoId: lfo.id, patch: p }, { label, mergeKey });
  };

  const base = paramRefNorm(lfo.target, project);
  const range =
    base === null
      ? 'destino perdido'
      : `${formatParamRef(lfo.target, project, clamp01(base - Math.abs(lfo.amount)))} → ${formatParamRef(
          lfo.target,
          project,
          clamp01(base + Math.abs(lfo.amount)),
        )}`;

  return (
    <div className={`lfo-row${lfo.enabled ? '' : ' off'}`}>
      <button
        className={`lfo-led${lfo.enabled ? ' on' : ''}`}
        title={lfo.enabled ? 'Desactivar este LFO' : 'Activar este LFO'}
        onClick={() =>
          patch({ enabled: !lfo.enabled }, lfo.enabled ? 'Apagar LFO' : 'Encender LFO')
        }
      />

      <div className="lfo-target">
        <span className="lfo-name" title={describeParamRef(lfo.target, project)}>
          {describeParamRef(lfo.target, project)}
        </span>
        <span className="lfo-range" title="Recorrido del parámetro con esta profundidad">
          {range}
        </span>
      </div>

      <svg className="lfo-wave" viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
        <path d={SHAPE_PATHS[lfo.shape]} />
      </svg>

      <label className="lfo-field">
        Forma
        <select
          value={lfo.shape}
          onChange={(e) => patch({ shape: e.target.value as LfoShape }, 'Forma del LFO')}
        >
          {LFO_SHAPES.map((s) => (
            <option key={s} value={s}>
              {SHAPE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="lfo-field">
        Velocidad
        <select
          value={nearestRate(lfo.rateBeats)}
          onChange={(e) => patch({ rateBeats: Number(e.target.value) }, 'Velocidad del LFO')}
        >
          {RATES.map((r) => (
            <option key={r.beats} value={r.beats}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <Knob
        value={lfo.amount}
        min={-1}
        max={1}
        defaultValue={0.25}
        size={28}
        label="Cantidad"
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => patch({ amount: v }, 'Profundidad del LFO', `lfo:${lfo.id}:amt`)}
      />
      <Knob
        value={lfo.phase}
        min={0}
        max={1}
        defaultValue={0}
        size={28}
        label="Fase"
        format={(v) => `${Math.round(v * 360)}°`}
        onChange={(v) => patch({ phase: v }, 'Fase del LFO', `lfo:${lfo.id}:phase`)}
      />

      <button className="lfo-del" title="Quitar este LFO" onClick={() => removeLfo(lfo.id)}>
        ✕
      </button>
    </div>
  );
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** La velocidad guardada puede no estar en la lista (proyecto de otra versión). */
function nearestRate(beats: number): number {
  let best = RATES[0]!.beats;
  for (const r of RATES) {
    if (Math.abs(r.beats - beats) < Math.abs(best - beats)) best = r.beats;
  }
  return best;
}
