/**
 * Barras de scroll de la Playlist: la aritmética del pulgar (pura) y que el
 * lienzo las monte en los dos ejes (lectura de la fuente, sin jsdom).
 */
import { describe, expect, it } from 'vitest';
import { MIN_THUMB_PX, playlistContentBeats, scrollForOffset, thumbGeometry } from '../src/editors/playlist/scrollbar';
import { readSource } from './read-source';

describe('thumbGeometry', () => {
  it('el pulgar mide lo que se ve respecto del total', () => {
    const g = thumbGeometry(200, 800, 0, 400);
    expect(g.size).toBe(100);
    expect(g.offset).toBe(0);
    expect(g.maxScroll).toBe(600);
  });

  it('al fondo del scroll, el pulgar toca el final del carril', () => {
    const g = thumbGeometry(200, 800, 600, 400);
    expect(g.offset + g.size).toBeCloseTo(400);
  });

  it('nunca es más chico que el mínimo agarrable, ni más largo que el carril', () => {
    expect(thumbGeometry(10, 100000, 0, 400).size).toBe(MIN_THUMB_PX);
    expect(thumbGeometry(500, 400, 0, 300).size).toBe(300);
    expect(thumbGeometry(10, 100000, 0, 10).size).toBe(10);
  });

  it('un scroll fuera de rango se dibuja en el borde', () => {
    expect(thumbGeometry(200, 800, -50, 400).offset).toBe(0);
    const g = thumbGeometry(200, 800, 5000, 400);
    expect(g.offset + g.size).toBeCloseTo(400);
  });
});

describe('scrollForOffset', () => {
  it('es la inversa de thumbGeometry', () => {
    for (const scroll of [0, 150, 333, 600]) {
      const g = thumbGeometry(200, 800, scroll, 400);
      expect(scrollForOffset(g.offset, 200, 800, 400)).toBeCloseTo(scroll);
    }
  });

  it('se acota a los extremos y vale 0 si no hay nada que desplazar', () => {
    expect(scrollForOffset(-100, 200, 800, 400)).toBe(0);
    expect(scrollForOffset(10000, 200, 800, 400)).toBe(600);
    expect(scrollForOffset(50, 800, 200, 400)).toBe(0);
  });
});

describe('playlistContentBeats', () => {
  it('llega al último clip más cuatro compases de margen', () => {
    expect(playlistContentBeats(200, 0, 32, 4)).toBe(216);
  });
  it('nunca menos de 32 compases ni menos de lo que ya se ve', () => {
    expect(playlistContentBeats(0, 0, 32, 4)).toBe(128);
    expect(playlistContentBeats(0, 300, 40, 4)).toBe(340);
  });
});

describe('montaje', () => {
  it('la Playlist pone una barra vertical (pistas) y otra horizontal (tiempo)', () => {
    const src = readSource('editors/playlist/Playlist.tsx');
    expect(src).toContain('orientation="v"');
    expect(src).toContain('orientation="h"');
    expect(src).toContain('content={totalH}');
    expect(src).toContain('onScroll={setScrollY}');
  });
});
