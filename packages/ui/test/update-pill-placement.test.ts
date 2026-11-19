/**
 * El cartel de «versión nueva» tapaba la barra de navegación.
 *
 * Estaba anclado con `top: calc(var(--titlebar-h) + 54px)` = 92 px, que cae
 * justo sobre la fila de Ajustes, Guía y Buscar: la cuenta que lo colocó
 * sumaba la titlebar y la toolbar, pero no la fila del menú. Arriba no hay un
 * hueco libre, así que el cartel vive en la esquina inferior derecha, donde
 * convive con el `app-notice` centrado y no tapa controles globales.
 *
 * Se lee el fuente porque la propiedad es el ancla de un aviso dentro de un
 * componente que arrastra medio store; montarlo para medir píxeles pediría
 * jsdom. Lo que se fija es la decisión que se rompió: contra qué borde va.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const file = readSource('App.tsx');

describe('Cartel de versión nueva: abajo, no encima de la navegación', () => {
  it('se ancla a la esquina inferior derecha', () => {
    const start = file.indexOf('{updateAvailable && updateRelease');
    const end = file.indexOf('Ver la release');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const pill = file.slice(start, end);
    expect(pill).toMatch(/bottom:\s*14/);
    expect(pill).toMatch(/right:\s*14/);
  });

  it('no vuelve al top que caía sobre Ajustes, Guía y Buscar', () => {
    expect(file).not.toContain("top: 'calc(var(--titlebar-h) + 54px)'");
  });
});
