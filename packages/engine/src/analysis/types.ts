/**
 * Tipos del analizador de audio de Orbit (tempo y tonalidad).
 *
 * Todo lo de esta carpeta es DSP PURO sobre PCM mono: no toca DOM, Electron ni
 * el AudioContext, y es determinista (misma señal, mismo resultado bit a bit).
 * Eso lo hace usable desde el renderer, desde un script Node y desde los tests.
 */

/** Nombres de nota con sostenidos. El índice es la clase de altura (0 = Do). */
export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export type NoteName = (typeof NOTE_NAMES)[number];

export type KeyMode = 'major' | 'minor';

export const KEY_MODE_LABELS: Record<KeyMode, string> = {
  major: 'mayor',
  minor: 'menor',
};

/** Un candidato de tempo, con la puntuación que lo respalda. */
export interface TempoCandidate {
  bpm: number;
  /** 0..1 — confianza de ese candidato por sí solo. */
  confidence: number;
  /** Relación con el tempo elegido: 0 = el elegido, -1 = mitad, +1 = doble. */
  octave: -1 | 0 | 1;
  /** Puntuación interna (no normalizada), para depurar y ordenar. */
  score: number;
  /** Autocorrelación normalizada en su periodo (0..1). */
  periodicity: number;
}

/** Rejilla de pulsos deducida del audio. */
export interface BeatGrid {
  /** Primer pulso, en segundos desde el inicio del audio analizado. */
  offsetSec: number;
  /** Primer pulso fuerte (el "1" del compás), en segundos. */
  downbeatSec: number;
  /** Pulsos por compás. Hoy se asume 4/4, el denominador común del producto. */
  beatsPerBar: number;
  /** Intervalo medio entre pulsos, en segundos. */
  beatPeriodSec: number;
  /** 0..1 — 1 = intervalos idénticos (un click), 0 = pulso irregular. */
  stability: number;
  /**
   * Posiciones de los pulsos en segundos, acotadas a `MAX_GRID_BEATS` para que
   * un tema de diez minutos no infle el JSON del proyecto.
   */
  beatTimes: number[];
}

/** Tempo global de un audio. */
export interface TempoEstimate {
  /** Tempo elegido, en pulsos por minuto. */
  bpm: number;
  /** 0..1 — confianza combinada (periodicidad, soporte, estabilidad, margen). */
  confidence: number;
  grid: BeatGrid;
  /** Alternativas, incluida la mitad y el doble cuando son plausibles. */
  candidates: TempoCandidate[];
}

/** Un candidato de tonalidad. */
export interface KeyCandidate {
  /** Clase de altura de la tónica, 0 = Do. */
  root: number;
  mode: KeyMode;
  /** Etiqueta legible, ej. "F# menor". */
  name: string;
  /** Notación Camelot, ej. "11A". */
  camelot: string;
  /** 0..1. */
  confidence: number;
  /** Correlación del croma con el perfil ganador, -1..1. */
  score: number;
}

/** Tonalidad global de un audio. */
export interface KeyEstimate {
  /** Clase de altura de la tónica, 0 = Do. */
  root: number;
  mode: KeyMode;
  name: string;
  camelot: string;
  /** 0..1. */
  confidence: number;
  /** Desafinación global respecto a A440, en cents (-50..50). */
  tuningCents: number;
  /** Las siguientes tonalidades más probables (sin repetir la ganadora). */
  alternatives: KeyCandidate[];
}

/** Resultado completo del analizador. */
export interface AudioAnalysis {
  /** Duración total del audio, en segundos. */
  durationSec: number;
  /** Segundos que se analizaron de verdad (puede ser menos en temas largos). */
  analyzedSec: number;
  /** `null` cuando no hay pulso que medir (un one-shot, silencio, ambiente). */
  tempo: TempoEstimate | null;
  /** `null` cuando no hay contenido tonal suficiente. */
  key: KeyEstimate | null;
}

export interface AudioAnalysisOptions {
  /** Tempo más lento que se considera, por defecto 40. */
  minBpm?: number;
  /** Tempo más rápido que se considera, por defecto 220. */
  maxBpm?: number;
  /** Tope de audio para el tempo, por defecto 120 s. */
  maxTempoSeconds?: number;
  /** Tope de audio para la tonalidad, por defecto 120 s. */
  maxKeySeconds?: number;
  /**
   * Centro del prior log-normal de tempo, en BPM. Por defecto 118, que es el
   * punto medio razonable entre trap (140), reggaetón (95) y boom bap (87).
   */
  tempoPriorBpm?: number;
  /** Anchura del prior, en octavas. Por defecto 0.75. */
  tempoPriorOctaves?: number;
  /**
   * Bonificar los tempos que cuadran el archivo entero en compases de 4/4.
   * Solo se aplica a archivos cortos (≤ 32 s), donde "loop" es una hipótesis
   * razonable. Por defecto sí.
   */
  barPrior?: boolean;
  /** Umbral de confianza para dar el tempo por bueno. Por defecto 0 (sin filtro). */
  minTempoConfidence?: number;
  /** Umbral de confianza para dar la tonalidad por buena. Por defecto 0 (sin filtro). */
  minKeyConfidence?: number;
}

/** Máximo de pulsos que se devuelven en `BeatGrid.beatTimes`. */
export const MAX_GRID_BEATS = 512;
