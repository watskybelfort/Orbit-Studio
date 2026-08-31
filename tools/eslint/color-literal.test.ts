/**
 * El predicado que hace cumplir la regla dura 4, probado donde vive.
 *
 * Hasta la v3.10 este código estaba duplicado en la regla de ESLint y en el
 * script de los `.css`, y no lo probaba nadie: se comprobó a mano una vez,
 * contra la `shell.css` de antes del arreglo, y ahí quedó. Una auditoría lo
 * ejercitó después contra formas que nadie había probado y encontró que un
 * `RGB(1,2,3)` en mayúsculas se le escapaba a los dos — la regex no llevaba el
 * flag `i`, y CSS no distingue mayúsculas.
 *
 * Los casos de abajo son literalmente los que esa auditoría probó. Están aquí
 * para que la próxima vez lo conteste un test y no una persona.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — módulo JS sin tipos, a propósito: el plugin de reglas
// duras va sin build ni dependencias (ver `tools/eslint/index.js`).
import { looksLikeColor } from './color-literal.js';

const es = (t: string): boolean => looksLikeColor(t) as boolean;

describe('looksLikeColor: lo que SÍ es un color', () => {
  it('funciones de color, en cualquier caja — el bug que encontró la auditoría', () => {
    expect(es('color: rgb(1, 2, 3)')).toBe(true);
    expect(es('color: RGB(1, 2, 3)')).toBe(true);
    expect(es('color: Rgba(1, 2, 3, .5)')).toBe(true);
    expect(es('color: HSL(210 50% 40%)')).toBe(true);
    expect(es('color: OKLCH(0.7 0.1 200)')).toBe(true);
  });

  it('funciones con espacios raros antes del paréntesis', () => {
    expect(es('color: rgb (1,2,3)')).toBe(true);
  });

  it('hex de 3, 4, 6 y 8 dígitos', () => {
    expect(es('background: #abc')).toBe(true);
    expect(es('background: #abcd')).toBe(true);
    expect(es('background: #a1b2c3')).toBe(true);
    expect(es('background: #a1b2c3d4')).toBe(true);
  });

  it('un color escondido en un shorthand o en un gradiente', () => {
    expect(es('border: 1px solid #abc')).toBe(true);
    expect(es('background: linear-gradient(135deg, #3a4a66 0%, #1c2230 60%)')).toBe(true);
  });

  it('el `#` percent-encoded de una data-URI, que el navegador sí lee como color', () => {
    expect(es(`background: url("data:image/svg+xml,<svg fill='%23ff0000'/>")`)).toBe(true);
  });
});

describe('looksLikeColor: lo que NO lo es', () => {
  it('un hex de longitud imposible', () => {
    expect(es('background: #12345')).toBe(false);
    expect(es('background: #abcdef12345')).toBe(false);
  });

  it('una referencia a un fragmento SVG, aunque su id parezca un hex', () => {
    // Este es el falso POSITIVO que importa: un linter que marca lo que está
    // bien acaba desactivado, así que aquí el riesgo va en la otra dirección.
    expect(es('fill: url(#dead)')).toBe(false);
    expect(es('mask: url(#beef1234)')).toBe(false);
    expect(es('fill: url(#icon-play)')).toBe(false);
  });

  it('un token, que es justo lo que la regla quiere que se escriba', () => {
    expect(es('color: var(--acento)')).toBe(false);
    expect(es('box-shadow: var(--shadow-node)')).toBe(false);
  });

  it('los nombres de color CSS, que la regla no persigue a propósito', () => {
    // Distinguir `red`-el-color de `red`-la-palabra necesita saber en qué
    // propiedad cae. Está decidido y documentado en `color-literal.js`.
    expect(es('color: red')).toBe(false);
    expect(es('content: "rojo"')).toBe(false);
  });
});
