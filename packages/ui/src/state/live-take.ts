/**
 * La toma que se está grabando, pintable en la Playlist MIENTRAS se graba.
 *
 * Antes la toma no existía en la Playlist hasta parar: se cantaba a ciegas y el
 * clip aparecía de golpe al guardar. Esto lleva dos cosas, las dos puras (sin
 * React ni motor) para poder probarlas en Node:
 *
 * - `LivePeaks`: la forma de onda resumida a medida que llegan los trozos del
 *   micro —un mínimo y un máximo por cada `LIVE_PEAK_FRAMES` muestras—, que es
 *   lo único que necesita el lienzo. No copia el audio: la toma de verdad la
 *   sigue juntando el grabador.
 * - `liveTakeClips`: en qué piezas se reparte la toma hasta ahora, con la MISMA
 *   regla que usa el guardado (`recordedTakeSegments`: una pieza por vuelta de
 *   loop, cada una en su carril, la última es la que suena). Si la vista en
 *   vivo usara otra regla, el clip saltaría de sitio al parar.
 *
 * Corre en el hilo de UI, no en el de audio: la regla de cero alocaciones es del
 * worklet. Aun así los búferes crecen por duplicación y no por trozo.
 */
import { recordedTakeSegments } from './take-stack';

/** Muestras por columna de picos: ~11,6 ms a 44,1 kHz, de sobra para el zoom de la Playlist. */
export const LIVE_PEAK_FRAMES = 512;

export class LivePeaks {
  min = new Float32Array(256);
  max = new Float32Array(256);
  /** Columnas COMPLETAS. La que se está llenando no cuenta todavía. */
  columns = 0;
  /** Muestras recibidas en total (por canal). */
  frames = 0;
  private partialMin = 0;
  private partialMax = 0;
  private partialCount = 0;

  push(left: Float32Array, right: Float32Array): void {
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      // Mono para pintar: la media de los dos lados, como el resto de ondas.
      const v = (left[i]! + right[i]!) * 0.5;
      if (this.partialCount === 0) {
        this.partialMin = v;
        this.partialMax = v;
      } else {
        if (v < this.partialMin) this.partialMin = v;
        if (v > this.partialMax) this.partialMax = v;
      }
      this.partialCount++;
      if (this.partialCount === LIVE_PEAK_FRAMES) this.commit();
    }
    this.frames += n;
  }

  private commit(): void {
    if (this.columns === this.min.length) {
      const min = new Float32Array(this.min.length * 2);
      const max = new Float32Array(this.max.length * 2);
      min.set(this.min);
      max.set(this.max);
      this.min = min;
      this.max = max;
    }
    this.min[this.columns] = this.partialMin;
    this.max[this.columns] = this.partialMax;
    this.columns++;
    this.partialCount = 0;
  }

  /** Columna que cubre la muestra `frame`, o -1 si todavía no se completó. */
  columnAt(frame: number): number {
    if (!(frame >= 0)) return -1;
    const col = Math.floor(frame / LIVE_PEAK_FRAMES);
    return col < this.columns ? col : -1;
  }
}

export interface LiveTakeClip {
  /** Beat de la Playlist donde empieza la pieza. */
  start: number;
  length: number;
  /** Beats de la toma que quedan ANTES de esta pieza (su sitio en el audio). */
  offsetBeats: number;
  /** Carril de comping; el carril base lo decide quien coloca la toma. */
  lane: number;
  /** Las vueltas anteriores quedan calladas: suena la última. */
  muted: boolean;
}

/**
 * Las piezas de una toma que lleva `totalBeats` grabados, empezando en
 * `startBeat`. Mismo reparto y mismo carril que `saveRecordedTakes`.
 */
export function liveTakeClips(
  startBeat: number,
  totalBeats: number,
  loop: { start: number; end: number } | null | undefined,
  baseLane: number,
): LiveTakeClip[] {
  const segments = recordedTakeSegments(startBeat, totalBeats, loop);
  const many = segments.length > 1;
  return segments.map((segment, index) => ({
    start: segment.start,
    length: segment.length,
    offsetBeats: segment.offsetBeats,
    lane: many ? baseLane + index : baseLane,
    muted: many && index < segments.length - 1,
  }));
}

/** Beats que ocupan `frames` muestras a un tempo y una frecuencia dados. */
export function framesToBeats(frames: number, sampleRate: number, tempo: number): number {
  if (!(sampleRate > 0) || !(tempo > 0)) return 0;
  return (frames / sampleRate) * (tempo / 60);
}
