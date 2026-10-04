import { describe, expect, it } from 'vitest';
import { beatsInBar, meterBeatUnit } from '../src/model/meter';

describe('compases medidos en negras del timeline', () => {
  it.each([[4, 4, 4, 1], [6, 8, 3, 0.5], [6, 4, 6, 1], [3, 8, 1.5, 0.5], [1, 8, 0.5, 0.5], [2, 2, 4, 2]])('%i/%i ocupa %f negras y cada pulso %f', (num, den, beats, unit) => {
    expect(beatsInBar({ num, den })).toBe(beats);
    expect(meterBeatUnit({ num, den })).toBe(unit);
  });
});
