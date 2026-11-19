/**
 * Resumen compacto del análisis de un audio: lo que la UI necesita para
 * enseñarlo, aplicarlo y recordarlo entre sesiones.
 *
 * El resultado completo del motor trae la rejilla de pulsos y las alternativas
 * de tonalidad. Eso sirve para dibujar un editor, pero no para guardarlo en
 * `settings.json` por cada archivo que pasa por el proyecto: aquí se queda solo
 * lo que se lee de un vistazo (BPM, clave, confianzas) y las alternativas de
 * mitad/doble. Es un módulo PURO —sin DOM, sin zustand, sin worker— para poder
 * probar las reglas de presentación y de aplicación sin montar un navegador.
 */

import type { SampleRef } from '@orbit/core';
import type { AudioAnalysis, KeyMode } from '@orbit/engine';

/** Confianza a partir de la cual el dato se puede dar por bueno sin matices. */
export const CONFIDENCE_HIGH = 0.6;
/** Por debajo de esto el dato es una pista, no una afirmación. */
export const CONFIDENCE_MEDIUM = 0.35;

/**
 * Umbral para cambiar el tempo del proyecto sin preguntar. Se queda por encima
 * del mínimo del motor a propósito: un patrón limpio da 0,85; una canción real
 * baja de 0,5 y sigue siendo aplicable, pero por debajo de 0,4 es más probable
 * haber medido una intro o un ritmo a contratiempo.
 */
export const AUTO_TEMPO_MIN_CONFIDENCE = 0.4;

/** Lo que se guarda y se pinta de un análisis. */
export interface AnalysisSummary {
  /** BPM redondeado a una décima. */
  bpm?: number;
  /** 0..1. */
  bpmConfidence?: number;
  /** Mitad/doble plausibles, de mayor a menor confianza. */
  bpmAlternatives?: number[];
  /** Clase de altura de la tónica, 0 = Do. */
  keyRoot?: number;
  keyMode?: KeyMode;
  /** Etiqueta legible, ej. "F# menor". */
  keyName?: string;
  /** Notación Camelot, ej. "11A". */
  camelot?: string;
  /** 0..1. */
  keyConfidence?: number;
  /** Desafinación respecto a A440, en cents. */
  tuningCents?: number;
  durationSec: number;
  /** Cuándo se analizó, para poder recortar el caché por antigüedad. */
  at: number;
}

/** Clave del caché: el contenido manda; el id es el respaldo sin WebCrypto. */
export function analysisKeyOf(sample: Pick<SampleRef, 'id' | 'hash'>): string {
  return sample.hash || sample.id;
}

export function roundBpm(bpm: number): number {
  return Math.round(bpm * 10) / 10;
}

/** BPM listo para `setTempo`: una décima y dentro del rango del proyecto. */
export function tempoToApply(bpm: number): number {
  return Math.min(999, Math.max(20, roundBpm(bpm)));
}

/** Sin ceros de más: 142, no 142.0; 142.4 se queda en 142.4. */
export function formatBpm(bpm: number): string {
  const rounded = roundBpm(bpm);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** "F# menor" → "F#m"; "Do mayor" → "Do". Para la tira del clip. */
export function compactKeyName(name: string): string {
  return name.replace(/\s+menor$/u, 'm').replace(/\s+mayor$/u, '');
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

/**
 * Reduce el resultado del motor a lo que se guarda.
 *
 * Las alternativas salen de los candidatos que el motor marcó como mitad o
 * doble (`octave !== 0`), no de cualquier vecino: un tempo a 4/3 no es una
 * lectura alternativa de la métrica, es otro ritmo, y ofrecerlo como botón
 * invitaría a aplicar un tempo que el motor descartó.
 */
export function summarizeAnalysis(result: AudioAnalysis, at = Date.now()): AnalysisSummary {
  const summary: AnalysisSummary = { durationSec: result.durationSec, at };
  if (result.tempo) {
    summary.bpm = roundBpm(result.tempo.bpm);
    summary.bpmConfidence = round3(result.tempo.confidence);
    const alternatives: number[] = [];
    for (const candidate of [...result.tempo.candidates]
      .filter((c) => c.octave !== 0 && c.bpm > 0)
      .sort((a, b) => b.confidence - a.confidence)) {
      const bpm = roundBpm(candidate.bpm);
      if (bpm === summary.bpm || alternatives.includes(bpm)) continue;
      alternatives.push(bpm);
      if (alternatives.length === 2) break;
    }
    if (alternatives.length > 0) summary.bpmAlternatives = alternatives;
  }
  if (result.key) {
    summary.keyRoot = result.key.root;
    summary.keyMode = result.key.mode;
    summary.keyName = result.key.name;
    summary.camelot = result.key.camelot;
    summary.keyConfidence = round3(result.key.confidence);
    summary.tuningCents = Math.round(result.key.tuningCents);
  }
  return summary;
}

/** "alta" / "media" / "baja", o null si no hay confianza que etiquetar. */
export function confidenceLabel(value: number | undefined): 'alta' | 'media' | 'baja' | null {
  if (value === undefined) return null;
  if (value >= CONFIDENCE_HIGH) return 'alta';
  if (value >= CONFIDENCE_MEDIUM) return 'media';
  return 'baja';
}

/** Texto corto para la tira del clip: "142.4 · F#m". */
export function analysisBadge(summary: AnalysisSummary): string {
  const parts: string[] = [];
  if (summary.bpm !== undefined) parts.push(formatBpm(summary.bpm));
  if (summary.keyName) parts.push(compactKeyName(summary.keyName));
  return parts.join(' · ');
}

/** Texto completo para el editor y los avisos: "142.4 BPM · F# menor (11A)". */
export function describeAnalysis(summary: AnalysisSummary): string {
  const parts: string[] = [];
  if (summary.bpm !== undefined) parts.push(`${formatBpm(summary.bpm)} BPM`);
  if (summary.keyName) {
    parts.push(summary.camelot ? `${summary.keyName} (${summary.camelot})` : summary.keyName);
  }
  return parts.join(' · ');
}

/**
 * ¿Toca cambiar el tempo del proyecto solo, sin preguntar?
 *
 * Solo en el caso en que no hay nada que descolocar: el proyecto no tenía
 * ningún clip antes del drop y el audio entró como el único clip. En cuanto hay
 * trabajo encima, cambiar el tempo mueve todo lo demás y la decisión es del
 * usuario. La confianza filtra las mediciones dudosas.
 */
export function shouldAutoApplyTempo(options: {
  wasEmptyPlaylist: boolean;
  clipCount: number;
  bpm?: number;
  bpmConfidence?: number;
}): boolean {
  return (
    options.wasEmptyPlaylist &&
    options.clipCount === 1 &&
    options.bpm !== undefined &&
    (options.bpmConfidence ?? 0) >= AUTO_TEMPO_MIN_CONFIDENCE
  );
}

/**
 * Largo en beats que conserva los segundos de audio al cambiar el tempo.
 *
 * Un clip de audio a velocidad natural dura lo que dura: si el proyecto pasa de
 * 120 a 140 BPM, mantener el largo en beats lo acortaría en segundos y se
 * comería el final del tema. Esto solo se aplica a clips sin time-stretch; con
 * stretch el audio se estira para llenar el clip y el largo no se toca.
 */
export function retimedLengthBeats(
  lengthBeats: number,
  fromTempo: number,
  toTempo: number,
): number {
  if (!(fromTempo > 0) || !(toTempo > 0)) return lengthBeats;
  return Math.max(0.25, lengthBeats * (toTempo / fromTempo));
}

/**
 * Valida lo leído de `settings.json`. Un campo corrupto no tira la entrada
 * entera ni el resto del caché: se queda fuera lo que no se puede sostener y se
 * conserva lo demás, que es lo que evita reanalizar todo por un JSON a medias.
 */
export function parseStoredAnalysis(raw: unknown): Record<string, AnalysisSummary> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, AnalysisSummary> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '' || typeof value !== 'object' || value === null) continue;
    const r = value as Record<string, unknown>;
    const durationSec = typeof r['durationSec'] === 'number' && r['durationSec'] >= 0
      ? r['durationSec']
      : 0;
    const at = typeof r['at'] === 'number' && Number.isFinite(r['at']) ? r['at'] : 0;
    const entry: AnalysisSummary = { durationSec, at };
    if (typeof r['bpm'] === 'number' && r['bpm'] > 0 && r['bpm'] <= 1000) {
      entry.bpm = roundBpm(r['bpm']);
    }
    if (typeof r['bpmConfidence'] === 'number') entry.bpmConfidence = round3(r['bpmConfidence']);
    if (Array.isArray(r['bpmAlternatives'])) {
      const alternatives = r['bpmAlternatives']
        .filter((v): v is number => typeof v === 'number' && v > 0 && v <= 1000)
        .map(roundBpm);
      if (alternatives.length > 0) entry.bpmAlternatives = alternatives.slice(0, 2);
    }
    if (
      typeof r['keyRoot'] === 'number' &&
      Number.isInteger(r['keyRoot']) &&
      r['keyRoot'] >= 0 &&
      r['keyRoot'] < 12
    ) {
      entry.keyRoot = r['keyRoot'];
    }
    if (r['keyMode'] === 'major' || r['keyMode'] === 'minor') entry.keyMode = r['keyMode'];
    if (typeof r['keyName'] === 'string' && r['keyName'] !== '') entry.keyName = r['keyName'];
    if (typeof r['camelot'] === 'string' && r['camelot'] !== '') entry.camelot = r['camelot'];
    if (typeof r['keyConfidence'] === 'number') entry.keyConfidence = round3(r['keyConfidence']);
    if (typeof r['tuningCents'] === 'number' && Number.isFinite(r['tuningCents'])) {
      entry.tuningCents = Math.round(r['tuningCents']);
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Entrada de un sample en el mapa del caché, o undefined.
 *
 * La usan los consumidores que no son componentes (el alta de clips, el
 * editor) para no repetir la regla hash-primero en cada sitio.
 */
export function summaryForSample(
  sample: Pick<SampleRef, 'id' | 'hash'> | undefined,
  entries: Readonly<Record<string, AnalysisSummary>>,
): AnalysisSummary | undefined {
  return sample ? entries[analysisKeyOf(sample)] : undefined;
}
