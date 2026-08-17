/**
 * Grabación de movimientos de perillas.
 *
 * Armas el botón, das al play y mueves lo que quieras: cada parámetro tocado
 * abre su carril y va guardando (posición, valor). Al parar el transporte —o
 * al desarmar— cada carril se convierte en un clip de automatización con la
 * curva simplificada, todo en UN solo paso de undo.
 *
 * Dos decisiones que importan:
 * - la posición se pide a `currentBeat()`, que interpola entre frames del
 *   kernel; con los ~46 ms del medidor la curva saldría escalonada;
 * - los puntos se reducen con Douglas-Peucker por distancia vertical (el eje
 *   X es tiempo, no espacio): un barrido de filtro pasa de cientos de puntos
 *   a unas decenas sin que se note el cambio, y el clip queda editable a mano.
 */

import { newId, paramRefKey, paramRefNorm, type AutomationPoint, type Clip, type Command, type ParamRef } from '@orbit/core';
import { create } from 'zustand';
import { currentBeat, store } from './app';
import { pickFreeTrack } from './param-actions';
import { onParamTouch } from './param-touch';
import { simplifyCurve } from './simplify';
import { useUiStore } from './ui';

interface Sample {
  beat: number;
  norm: number;
}

interface Lane {
  ref: ParamRef;
  samples: Sample[];
}

interface ParamRecordState {
  /** Armado: la próxima reproducción graba lo que muevas. */
  armed: boolean;
  /** Sonando y capturando. */
  recording: boolean;
  /** Parámetros distintos tocados en esta pasada (para el rótulo del botón). */
  lanes: number;
}

export const useParamRecord = create<ParamRecordState>(() => ({
  armed: false,
  recording: false,
  lanes: 0,
}));

/** Tope por carril: un arrastre largo no puede comerse la memoria. */
const MAX_SAMPLES = 6000;
/** Distancia mínima entre muestras del mismo carril, en beats (~1/128). */
const MIN_STEP = 1 / 128;
/** Tolerancia de la simplificación, en unidades normalizadas del parámetro. */
const RDP_EPSILON = 0.006;
/** Rejilla a la que se ajustan inicio y final del clip (1/16). */
const SNAP = 0.25;

const lanes = new Map<string, Lane>();

export function toggleParamRecordArmed(): void {
  const { armed } = useParamRecord.getState();
  if (armed) {
    // Desarmar en caliente: lo grabado hasta aquí se queda.
    flushLanes();
    useParamRecord.setState({ armed: false, recording: false });
  } else {
    lanes.clear();
    useParamRecord.setState({
      armed: true,
      recording: useUiStore.getState().playing,
      lanes: 0,
    });
  }
}

/** Un movimiento de perilla (lo llama `param-touch` tras el dispatch). */
function capture(ref: ParamRef): void {
  const { armed, recording } = useParamRecord.getState();
  if (!armed || !recording) return;
  const norm = paramRefNorm(ref, store.project);
  if (norm === null) return;

  const key = paramRefKey(ref);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { ref, samples: [] };
    lanes.set(key, lane);
    useParamRecord.setState({ lanes: lanes.size });
  }
  if (lane.samples.length >= MAX_SAMPLES) return;

  const beat = Math.max(0, currentBeat());
  const last = lane.samples[lane.samples.length - 1];
  // Misma posición: sustituye (el valor bueno es el último), no acumules.
  if (last && beat - last.beat < MIN_STEP) {
    last.norm = norm;
    return;
  }
  lane.samples.push({ beat, norm });
}

onParamTouch(capture);

// Arranque/parada del transporte: el play abre la pasada y el stop la cierra.
useUiStore.subscribe((s, prev) => {
  if (s.playing === prev.playing) return;
  if (!useParamRecord.getState().armed) return;
  if (s.playing) {
    lanes.clear();
    useParamRecord.setState({ recording: true, lanes: 0 });
  } else {
    flushLanes();
    useParamRecord.setState({ recording: false, lanes: 0 });
  }
});

/** Convierte los carriles capturados en clips de automatización. */
function flushLanes(): void {
  const pending = [...lanes.values()].filter((l) => l.samples.length >= 2);
  lanes.clear();
  if (pending.length === 0) return;

  const project = store.project;
  const commands: Command[] = [];
  const used = new Set<string>();
  const clips: Clip[] = [];

  for (const lane of pending) {
    const samples = lane.samples.slice().sort((a, b) => a.beat - b.beat);
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const start = Math.max(0, Math.floor(first.beat / SNAP) * SNAP);
    const end = Math.max(start + SNAP, Math.ceil(last.beat / SNAP) * SNAP);
    const length = end - start;

    // A tiempo relativo al clip y simplificado.
    const rel = samples.map((s) => ({ time: Math.max(0, s.beat - start), norm: s.norm }));
    const kept = simplifyCurve(rel, RDP_EPSILON);
    // Cierra el clip manteniendo el último valor hasta el final.
    if (kept[kept.length - 1]!.time < length) {
      kept.push({ time: length, norm: kept[kept.length - 1]!.norm });
    }
    const points: AutomationPoint[] = kept.map((p) => ({
      id: newId(),
      time: p.time,
      value: p.norm,
      tension: 0,
    }));

    const playlistTrackId = pickFreeTrack(
      project,
      start,
      length,
      commands,
      'Automatización',
      used,
    );
    const clip: Clip = {
      id: newId(),
      kind: 'automation',
      playlistTrackId,
      start,
      length,
      muted: false,
      target: lane.ref,
      points,
    };
    clips.push(clip);
    commands.push({ type: 'addClips', clips: [clip] });
  }

  const label =
    clips.length === 1
      ? 'Grabar movimiento de perilla'
      : `Grabar ${clips.length} movimientos de perilla`;
  store.dispatch({ type: 'batch', label, commands }, { label });
  // Abre el primero para revisar la curva recién grabada.
  useUiStore.setState({ automationClipId: clips[0]!.id });
}

