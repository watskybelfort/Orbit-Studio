/**
 * Reglas puras del análisis que ve el usuario: cómo se resume el resultado del
 * motor, cómo se pinta, cuándo se aplica solo el tempo y cómo se conserva el
 * audio al cambiarlo.
 *
 * Nada de DOM ni de workers: lo que se prueba aquí es la aritmética y las
 * decisiones que una regresión silenciosa podría romper (un BPM con tres
 * decimales, una alternativa a 4/3 colada como si fuera mitad, un cambio de
 * tempo que acorta el tema). El DSP ya tiene sus propios tests en `engine`.
 */

import { describe, expect, it } from 'vitest';
import type { AudioAnalysis, TempoCandidate } from '@orbit/engine';
import {
  analysisBadge,
  analysisKeyOf,
  compactKeyName,
  confidenceLabel,
  describeAnalysis,
  formatBpm,
  parseStoredAnalysis,
  retimedLengthBeats,
  roundBpm,
  shouldAutoApplyTempo,
  summarizeAnalysis,
  summaryForSample,
  tempoToApply,
} from '../src/state/audio-analysis-summary';

function candidate(
  bpm: number,
  confidence: number,
  octave: -1 | 0 | 1,
): TempoCandidate {
  return { bpm, confidence, octave, score: confidence, periodicity: confidence };
}

function fixture(overrides: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    durationSec: 180,
    analyzedSec: 120,
    tempo: {
      bpm: 142.37,
      confidence: 0.72,
      grid: {
        offsetSec: 0.05,
        downbeatSec: 0.05,
        beatsPerBar: 4,
        beatPeriodSec: 0.421,
        stability: 0.9,
        beatTimes: [0.05, 0.471],
      },
      // Desordenados a propósito: el resumen ordena por confianza, no por orden.
      candidates: [
        candidate(284.74, 0.22, 1),
        candidate(142.37, 0.72, 0),
        candidate(71.19, 0.41, -1),
        candidate(94.91, 0.35, 0),
        candidate(213.56, 0.18, 0),
      ],
    },
    key: {
      root: 6,
      mode: 'minor',
      name: 'F# menor',
      camelot: '11A',
      confidence: 0.66,
      tuningCents: -4.2,
      alternatives: [],
    },
    ...overrides,
  };
}

describe('summarizeAnalysis', () => {
  it('redondea el BPM a una décima y conserva la confianza', () => {
    const summary = summarizeAnalysis(fixture(), 1234);
    expect(summary.bpm).toBe(142.4);
    expect(summary.bpmConfidence).toBe(0.72);
    expect(summary.at).toBe(1234);
    expect(summary.durationSec).toBe(180);
  });

  it('solo ofrece mitad y doble, ordenados por confianza', () => {
    const summary = summarizeAnalysis(fixture());
    // 71,19 (mitad) tiene más confianza que 284,74 (doble); el 4/3 no entra
    // porque su octava es 0 y no es una lectura alternativa de la métrica.
    expect(summary.bpmAlternatives).toEqual([71.2, 284.7]);
  });

  it('no repite el BPM elegido ni deja alternativas absurdas', () => {
    const summary = summarizeAnalysis(
      fixture({
        tempo: {
          bpm: 120,
          confidence: 0.8,
          grid: {
            offsetSec: 0,
            downbeatSec: 0,
            beatsPerBar: 4,
            beatPeriodSec: 0.5,
            stability: 1,
            beatTimes: [0, 0.5],
          },
          candidates: [
            candidate(120, 0.8, 0),
            candidate(119.96, 0.7, 0),
            candidate(0, 0.5, -1),
          ],
        },
      }),
    );
    expect(summary.bpm).toBe(120);
    expect(summary.bpmAlternatives).toBeUndefined();
  });

  it('traduce la tonalidad a nombre y Camelot sin recalcular el DSP', () => {
    const summary = summarizeAnalysis(fixture());
    expect(summary.keyRoot).toBe(6);
    expect(summary.keyMode).toBe('minor');
    expect(summary.keyName).toBe('F# menor');
    expect(summary.camelot).toBe('11A');
    expect(summary.keyConfidence).toBe(0.66);
    expect(summary.tuningCents).toBe(-4);
  });

  it('deja el resumen vacío cuando no hay pulso ni tonalidad', () => {
    const summary = summarizeAnalysis({
      durationSec: 0.4,
      analyzedSec: 0.4,
      tempo: null,
      key: null,
    });
    expect(summary.bpm).toBeUndefined();
    expect(summary.keyName).toBeUndefined();
    expect(describeAnalysis(summary)).toBe('');
    expect(analysisBadge(summary)).toBe('');
  });
});

describe('presentación', () => {
  it('quita el cero de más y conserva la décima', () => {
    expect(formatBpm(142)).toBe('142');
    expect(formatBpm(142.04)).toBe('142');
    expect(formatBpm(86.47)).toBe('86.5');
    expect(roundBpm(86.44)).toBe(86.4);
  });

  it('etiqueta la confianza con los mismos umbrales para tempo y clave', () => {
    expect(confidenceLabel(0.8)).toBe('alta');
    expect(confidenceLabel(0.6)).toBe('alta');
    expect(confidenceLabel(0.59)).toBe('media');
    expect(confidenceLabel(0.35)).toBe('media');
    expect(confidenceLabel(0.34)).toBe('baja');
    expect(confidenceLabel(undefined)).toBeNull();
  });

  it('compacta la clave para la tira del clip y la deja legible en el editor', () => {
    expect(compactKeyName('F# menor')).toBe('F#m');
    expect(compactKeyName('Do mayor')).toBe('Do');
    const summary = summarizeAnalysis(fixture());
    expect(analysisBadge(summary)).toBe('142.4 · F#m');
    expect(describeAnalysis(summary)).toBe('142.4 BPM · F# menor (11A)');
  });
});

describe('aplicación del tempo', () => {
  it('redondea a una décima y respeta el rango del proyecto', () => {
    expect(tempoToApply(142.371)).toBe(142.4);
    expect(tempoToApply(2)).toBe(20);
    expect(tempoToApply(5000)).toBe(999);
  });

  it('conserva los segundos de audio al cambiar el tempo', () => {
    // 32 beats a 120 BPM son 16 s; a 140 BPM esos 16 s son 37,333 beats.
    expect(retimedLengthBeats(32, 120, 140)).toBeCloseTo(37.333, 3);
    // Nunca deja un clip por debajo del mínimo del modelo.
    expect(retimedLengthBeats(0.25, 120, 40)).toBe(0.25);
    // Un tempo inválido no debe romper el largo.
    expect(retimedLengthBeats(8, 0, 140)).toBe(8);
  });

  it('solo se aplica solo en una playlist vacía con un único clip', () => {
    const base = { bpm: 142, bpmConfidence: 0.72 };
    expect(shouldAutoApplyTempo({ ...base, wasEmptyPlaylist: true, clipCount: 1 })).toBe(true);
    expect(shouldAutoApplyTempo({ ...base, wasEmptyPlaylist: false, clipCount: 1 })).toBe(false);
    expect(shouldAutoApplyTempo({ ...base, wasEmptyPlaylist: true, clipCount: 2 })).toBe(false);
    expect(
      shouldAutoApplyTempo({ bpm: 142, bpmConfidence: 0.2, wasEmptyPlaylist: true, clipCount: 1 }),
    ).toBe(false);
    expect(shouldAutoApplyTempo({ wasEmptyPlaylist: true, clipCount: 1 })).toBe(false);
  });
});

describe('persistencia', () => {
  it('usa el hash como identidad y cae al id si no hay WebCrypto', () => {
    expect(analysisKeyOf({ id: 'sample-1', hash: 'abc123' })).toBe('abc123');
    expect(analysisKeyOf({ id: 'sample-1', hash: '' })).toBe('sample-1');
  });

  it('encuentra el resumen por hash aunque el id cambie', () => {
    const summary = summarizeAnalysis(fixture());
    const entries = { abc123: summary };
    expect(summaryForSample({ id: 'otro-id', hash: 'abc123' }, entries)).toBe(summary);
    expect(summaryForSample({ id: 'otro-id', hash: '' }, entries)).toBeUndefined();
    expect(summaryForSample(undefined, entries)).toBeUndefined();
  });

  it('descarta basura sin tirar las entradas válidas del resto', () => {
    const parsed = parseStoredAnalysis({
      bueno: {
        bpm: 142.37,
        bpmConfidence: 0.72,
        bpmAlternatives: [71.19, 'x', 3000],
        keyRoot: 6,
        keyMode: 'minor',
        keyName: 'F# menor',
        camelot: '11A',
        keyConfidence: 0.66,
        durationSec: 180,
        at: 1234,
      },
      soloDuracion: { durationSec: 0.4, at: 99 },
      roto: 'no soy un objeto',
      fueraDeRango: { bpm: -3, keyRoot: 19, keyMode: 'dorio', durationSec: 4, at: 1 },
    });
    expect(parsed['bueno']).toEqual({
      bpm: 142.4,
      bpmConfidence: 0.72,
      bpmAlternatives: [71.2],
      keyRoot: 6,
      keyMode: 'minor',
      keyName: 'F# menor',
      camelot: '11A',
      keyConfidence: 0.66,
      durationSec: 180,
      at: 1234,
    });
    expect(parsed['soloDuracion']).toEqual({ durationSec: 0.4, at: 99 });
    expect(parsed['roto']).toBeUndefined();
    // Los campos inválidos se caen uno a uno; la entrada sobrevive si aún dice
    // algo (aquí, la duración).
    expect(parsed['fueraDeRango']).toEqual({ durationSec: 4, at: 1 });
  });

  it('no se cae con un valor que no es un mapa', () => {
    expect(parseStoredAnalysis(null)).toEqual({});
    expect(parseStoredAnalysis('{}')).toEqual({});
    expect(parseStoredAnalysis([])).toEqual({});
  });
});
