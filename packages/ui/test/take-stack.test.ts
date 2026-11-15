import { describe, expect, it } from 'vitest';
import type { Clip } from '@orbit/core';
import {
  TAKE_LANE_MIN_H,
  chooseTakePatches,
  clipsOverlap,
  compactTakeLanePatches,
  heightForTakeLanes,
  takeLaneCount,
  takeRows,
} from '../src/state/take-stack';

function clip(id: string, start: number, length: number, lane?: number, muted = false): Clip {
  return {
    id,
    kind: 'audio',
    playlistTrackId: 'track',
    start,
    length,
    muted,
    ...(lane === undefined ? null : { lane }),
  };
}

describe('carriles de toma', () => {
  it('sin tomas apiladas todo sigue en un carril', () => {
    expect(takeLaneCount([])).toBe(1);
    expect(takeLaneCount([clip('a', 0, 4)])).toBe(1);
    expect(takeLaneCount([clip('a', 0, 4, 0)])).toBe(1);
  });

  it('el carril más alto manda, aunque falte el del medio', () => {
    expect(takeLaneCount([clip('a', 0, 4, 0), clip('b', 0, 4, 2)])).toBe(3);
  });

  it('un carril negativo o roto no inventa carriles de más', () => {
    expect(takeLaneCount([clip('a', 0, 4, -3), clip('b', 0, 4, 1.9)])).toBe(2);
  });

  it('un clip de patrón o automatización no cuenta como toma', () => {
    const pattern = { ...clip('p', 0, 8, 4), kind: 'pattern' as const };
    expect(takeLaneCount([clip('a', 0, 4, 0), pattern])).toBe(1);
  });
});

describe('alto para las tomas', () => {
  it('una pista baja crece hasta que cada carril es legible', () => {
    expect(heightForTakeLanes(56, 3)).toBe(3 * TAKE_LANE_MIN_H);
    expect(heightForTakeLanes(56, 4)).toBe(4 * TAKE_LANE_MIN_H);
  });

  it('dos carriles crecen lo justo por encima de la pista de fábrica', () => {
    expect(heightForTakeLanes(56, 2)).toBe(2 * TAKE_LANE_MIN_H);
  });

  it('nunca encoge una pista que ya es más alta', () => {
    expect(heightForTakeLanes(160, 2)).toBe(160);
    expect(heightForTakeLanes(30, 1)).toBe(30);
  });

  it('un número de carriles absurdo no produce un alto inválido', () => {
    expect(heightForTakeLanes(56, 0)).toBe(56);
    expect(heightForTakeLanes(56, Number.NaN)).toBe(56);
  });
});

describe('elegir toma', () => {
  const clips = [
    clip('t1', 0, 4, 0, true),
    clip('t2', 0, 4, 1, false),
    clip('t3', 0, 4, 2, true),
    clip('otra', 8, 4, 0, false),
  ];

  it('desmutea la elegida y mutea solo las que pisa', () => {
    expect(chooseTakePatches(clips, 't1')).toEqual([
      { id: 't1', muted: false },
      { id: 't2', muted: true },
    ]);
  });

  it('elegir la que ya suena no emite patches redundantes', () => {
    expect(chooseTakePatches(clips, 't2')).toEqual([]);
  });

  it('no toca un clip que no se pisa', () => {
    const patches = chooseTakePatches(clips, 'otra');
    expect(patches).toEqual([]);
  });

  it('una toma que no existe se distingue de un patch vacío', () => {
    expect(chooseTakePatches(clips, 'fantasma')).toBeNull();
  });

  it('el solape es estricto en los bordes', () => {
    expect(clipsOverlap({ start: 0, length: 4 }, { start: 4, length: 4 })).toBe(false);
    expect(clipsOverlap({ start: 0, length: 4 }, { start: 3.999, length: 4 })).toBe(true);
  });

  it('elegir una toma no mutea un patrón que suena encima', () => {
    const pattern = { ...clip('pat', 0, 4), kind: 'pattern' as const, muted: false };
    expect(chooseTakePatches([clip('t1', 0, 4, 0, true), pattern], 't1')).toEqual([
      { id: 't1', muted: false },
    ]);
  });
});

describe('filas del menú de tomas', () => {
  it('ordena por carril y numera desde 1', () => {
    const rows = takeRows([clip('b', 8, 4, 1), clip('a', 0, 4, 0), clip('c', 0, 4, 2, true)]);
    expect(rows.map((row) => row.clip.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.active)).toEqual([true, true, false]);
  });

  it('no lista clips que no son tomas', () => {
    const pattern = { ...clip('p', 0, 4, 0), kind: 'pattern' as const };
    expect(takeRows([pattern, clip('a', 0, 4, 0)]).map((row) => row.clip.id)).toEqual(['a']);
  });
});

describe('renumerar carriles al borrar una toma', () => {
  it('cierra el hueco sin reordenar ni tocar otras pistas', () => {
    const clips = [
      clip('t1', 0, 4, 0),
      clip('t2', 0, 4, 1),
      clip('t3', 0, 4, 2),
      { ...clip('auto', 0, 4), kind: 'automation' as const, lane: 2 },
    ];
    // Borrar t2 deja 0 y 2: el 2 baja a 1.
    expect(compactTakeLanePatches(clips.filter((c) => c.id !== 't2'))).toEqual([
      { id: 't3', lane: 1 },
    ]);
  });

  it('si ya está compacto no emite nada', () => {
    expect(compactTakeLanePatches([clip('t1', 0, 4, 0), clip('t2', 0, 4, 1)])).toEqual([]);
  });
});
