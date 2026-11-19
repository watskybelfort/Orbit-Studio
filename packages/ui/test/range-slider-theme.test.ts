/**
 * El deslizador de Ajustes se pintaba con la canaleta casi negra en tema claro.
 *
 * En Windows con el sistema en modo oscuro, Chromium dibuja el `range` con su
 * paleta oscura aunque `color-scheme: light` esté puesto, y `accent-color` solo
 * alcanza al pomo: la canaleta quedaba negra sobre una fila blanca. La capa
 * suave lo dibuja con los mismos tokens que el fader del mixer.
 *
 * Se lee el CSS porque la decisión es de pintura, no de lógica: montar el
 * deslizador para medir píxeles pediría jsdom, que este repo no usa. Lo que hay
 * que evitar es volver, sin darse cuenta, al control nativo que ignora el tema.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const native = readSource('theme/native.css');

describe('Sliders del acabado suave: los pinta el tema, no el control nativo', () => {
  it('apaga la apariencia nativa del range', () => {
    expect(native).toMatch(
      /html\[data-style='soft'\] input\[type='range'\] \{[^}]*appearance:\s*none/,
    );
  });

  it('la canaleta y el pomo salen de tokens del tema', () => {
    expect(native).toMatch(
      /::-webkit-slider-runnable-track \{[^}]*background:\s*var\(--fill-pressed\)/,
    );
    expect(native).toMatch(
      /::-webkit-slider-thumb \{[^}]*background:\s*var\(--slider-thumb\)/,
    );
    expect(native).toMatch(/var\(--slider-thumb-border\)/);
  });

  it('el foco se ve en el pomo, no como un rectángulo alrededor del input', () => {
    expect(native).toMatch(
      /html\[data-style='soft'\] input\[type='range'\]:focus-visible \{[^}]*outline:\s*none/,
    );
    expect(native).toMatch(
      /:focus-visible::-webkit-slider-thumb \{[^}]*var\(--accent\)/,
    );
  });

  it('ninguna regla de range queda fuera de la capa suave', () => {
    // Clásico conserva el control nativo de la v3.14: si aparece una regla de
    // range sin el prefijo, el acabado clásico cambia sin querer.
    const selectors = native
      .split('\n')
      .filter((line) => line.includes("input[type='range']") && line.includes('{'));
    expect(selectors.length).toBeGreaterThan(0);
    for (const line of selectors) {
      expect(line.trimStart().startsWith("html[data-style='soft']")).toBe(true);
    }
  });
});
