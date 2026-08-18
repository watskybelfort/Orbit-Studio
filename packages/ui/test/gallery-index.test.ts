/**
 * Índices de la galería de plugins.
 *
 * El JSON lo escribe un tercero, así que lo que se prueba es la desconfianza:
 * que un id que no vale como nombre de archivo no entre, que una URL que no
 * sea http(s) se caiga (un `file:` apuntando a cualquier sitio del disco sería
 * justo el agujero), y que una entrada rota no se lleve por delante a las
 * demás — una galería con un plugin mal escrito sigue sirviendo.
 */

import { describe, expect, it } from 'vitest';
import { isGalleryUrl, isPluginUrl, parseGalleryIndex } from '../src/state/gallery-index';

const ok = {
  name: 'Galería de prueba',
  description: 'Dos plugins',
  plugins: [
    {
      id: 'tremolo',
      name: 'Tremolo suave',
      url: 'https://example.com/tremolo.js',
      author: 'Orbit',
      description: 'Amplitud que respira',
      tags: ['modulación', 'clásico'],
      kind: 'effect',
    },
  ],
};

describe('índice de galería', () => {
  it('lee lo válido con todos sus campos', () => {
    const index = parseGalleryIndex(JSON.stringify(ok));
    expect(index?.name).toBe('Galería de prueba');
    expect(index?.plugins).toHaveLength(1);
    expect(index?.plugins[0]).toEqual({
      id: 'tremolo',
      name: 'Tremolo suave',
      url: 'https://example.com/tremolo.js',
      author: 'Orbit',
      description: 'Amplitud que respira',
      tags: ['modulación', 'clásico'],
      kind: 'effect',
    });
  });

  it('sin nombre, el id hace de nombre', () => {
    const index = parseGalleryIndex(
      JSON.stringify({ plugins: [{ id: 'eco', url: 'https://x.dev/eco.js' }] }),
    );
    expect(index?.plugins[0]?.name).toBe('eco');
    expect(index?.name).toBe('Galería');
  });

  it('descarta ids que no valdrían como archivo', () => {
    const malos = ['../../etc/passwd', 'con espacio', 'MAYUS.js', '', 'a'.repeat(60)];
    for (const id of malos) {
      const index = parseGalleryIndex(JSON.stringify({ plugins: [{ id, url: 'https://x.dev/a.js' }] }));
      expect(index, id).toBeNull();
    }
  });

  it('solo acepta URLs http(s)', () => {
    expect(isPluginUrl('https://x.dev/a.js')).toBe(true);
    expect(isPluginUrl('http://x.dev/a.js')).toBe(true);
    expect(isPluginUrl('file:///C:/Windows/System32/a.js')).toBe(false);
    expect(isPluginUrl('javascript:alert(1)')).toBe(false);
    expect(isPluginUrl('/relativo.js')).toBe(false);
    expect(isPluginUrl(42)).toBe(false);
    expect(isGalleryUrl('https://x.dev/index.json')).toBe(true);
  });

  it('una entrada rota no se lleva por delante a las buenas', () => {
    const index = parseGalleryIndex(
      JSON.stringify({
        plugins: [
          { id: 'roto', url: 'file:///peligro.js' },
          { id: 'bueno', url: 'https://x.dev/bueno.js' },
          { nada: true },
        ],
      }),
    );
    expect(index?.plugins.map((p) => p.id)).toEqual(['bueno']);
  });

  it('los ids repetidos se quedan con el primero', () => {
    const index = parseGalleryIndex(
      JSON.stringify({
        plugins: [
          { id: 'eco', name: 'Primero', url: 'https://x.dev/1.js' },
          { id: 'eco', name: 'Segundo', url: 'https://x.dev/2.js' },
        ],
      }),
    );
    expect(index?.plugins).toHaveLength(1);
    expect(index?.plugins[0]?.name).toBe('Primero');
  });

  it('lo que no es un índice devuelve null', () => {
    expect(parseGalleryIndex('no soy json')).toBeNull();
    expect(parseGalleryIndex('[]')).toBeNull();
    expect(parseGalleryIndex(JSON.stringify({ plugins: [] }))).toBeNull();
    expect(parseGalleryIndex(JSON.stringify({ plugins: 'muchos' }))).toBeNull();
  });

  it('recorta las etiquetas a algo razonable', () => {
    const index = parseGalleryIndex(
      JSON.stringify({
        plugins: [
          {
            id: 'x',
            url: 'https://x.dev/x.js',
            tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
          },
        ],
      }),
    );
    expect(index?.plugins[0]?.tags).toHaveLength(8);
  });
});
