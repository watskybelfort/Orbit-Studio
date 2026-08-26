/**
 * La inclinación del reparto de bits, que ya no es fija.
 *
 * El asignador reparte bits entre bandas con una recta, y este número es su
 * pendiente: por debajo de 5 favorece a los graves, por encima a los agudos.
 * Con el 5 fijo de antes, un acorde —toda su energía abajo y casi nada
 * arriba— recibía el mismo esfuerzo en las bandas vacías que en las que
 * llevaban la música.
 *
 * Aquí se comprueba la DECISIÓN, que es pura y no toca el formato. Que el
 * archivo siga siendo legible por otros lo comprueba `tools/qa/opus-verify.ts`,
 * y cuánto se gana, `tools/qa/opus-quality.ts`. Son tres preguntas distintas.
 */

import { describe, expect, it } from 'vitest';
import { allocTrimAnalysis } from '../src/render/opus/celt-encoder';

const BANDAS = 21;

/** Espectro con una pendiente en dB por banda (0 = plano). */
function espectro(pendiente: number, channels = 1): Float64Array {
  const out = new Float64Array(BANDAS * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < BANDAS; i++) out[i + c * BANDAS] = i * pendiente;
  }
  return out;
}

describe('la inclinación sale de la pendiente del espectro', () => {
  it('un espectro plano deja el reparto neutro', () => {
    // Neutro es 5 y aquí sale 4: el término de la referencia lleva un `+1`
    // dentro (`(diff + 1) / 6`) y luego se TRUNCA, no se redondea. Se copia el
    // comportamiento en vez de mejorarlo — portar sirve para que las dos
    // implementaciones tomen la misma decisión, no una parecida.
    const plano = allocTrimAnalysis(espectro(0), BANDAS, 1);
    expect(plano).toBeGreaterThanOrEqual(4);
    expect(plano).toBeLessThanOrEqual(5);
  });

  it('si la energía cae hacia los agudos, los bits se van a los graves', () => {
    // Es el caso del acorde, y el que motivó todo esto.
    const cae = allocTrimAnalysis(espectro(-1), BANDAS, 1);
    const plano = allocTrimAnalysis(espectro(0), BANDAS, 1);
    expect(cae).toBeGreaterThan(plano);
  });

  it('si la energía sube hacia los agudos, se van hacia arriba', () => {
    const sube = allocTrimAnalysis(espectro(1), BANDAS, 1);
    const plano = allocTrimAnalysis(espectro(0), BANDAS, 1);
    expect(sube).toBeLessThan(plano);
  });

  it('la pendiente manda pero acotada: ±2 sobre el neutro', () => {
    // Sin el tope, un espectro con un agujero enorme vaciaría un extremo
    // entero del reparto en vez de inclinarlo.
    for (const pendiente of [-50, -8, 8, 50]) {
      const trim = allocTrimAnalysis(espectro(pendiente), BANDAS, 1);
      expect(trim, `pendiente ${pendiente}`).toBeGreaterThanOrEqual(3);
      expect(trim, `pendiente ${pendiente}`).toBeLessThanOrEqual(7);
    }
  });

  it('nunca se sale del alfabeto que admite el símbolo (0..10)', () => {
    // Si se saliera, `enc.icdf` escribiría un símbolo que no existe y el
    // archivo dejaría de ser legible — no sonaría peor: no se abriría.
    for (const pendiente of [-1000, -3.7, 0, 0.1, 3.7, 1000]) {
      const trim = allocTrimAnalysis(espectro(pendiente, 2), BANDAS, 2);
      expect(Number.isInteger(trim), `pendiente ${pendiente}`).toBe(true);
      expect(trim).toBeGreaterThanOrEqual(0);
      expect(trim).toBeLessThanOrEqual(10);
    }
  });

  it('los dos canales se promedian: el mismo espectro da la misma inclinación', () => {
    // La división entre `channels` está por esto. Sin ella, un estéreo
    // inclinaría el doble que un mono con el mismo contenido.
    for (const pendiente of [-2, -0.5, 0, 0.5, 2]) {
      expect(allocTrimAnalysis(espectro(pendiente, 2), BANDAS, 2)).toBe(
        allocTrimAnalysis(espectro(pendiente, 1), BANDAS, 1),
      );
    }
  });
});
