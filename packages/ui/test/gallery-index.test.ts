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

describe('firma y hashes en el índice', () => {
  const base = {
    name: 'G',
    plugins: [{ id: 'a', name: 'A', url: 'https://x.example/a.js' }],
  };

  it('un índice sin firma sigue valiendo (lo de siempre)', () => {
    const index = parseGalleryIndex(JSON.stringify(base));
    expect(index?.signature).toBeUndefined();
  });

  it('acepta un bloque de firma con la forma buena', () => {
    const index = parseGalleryIndex(
      JSON.stringify({
        ...base,
        signature: { alg: 'ECDSA-P256-SHA256', key: 'AAAA', sig: 'BBBB', signedAt: 123 },
      }),
    );
    expect(index?.signature).toEqual({
      alg: 'ECDSA-P256-SHA256',
      key: 'AAAA',
      sig: 'BBBB',
      signedAt: 123,
    });
  });

  it('una firma con otro algoritmo, sin clave o gigante se descarta', () => {
    const malas = [
      { alg: 'RSA', key: 'A', sig: 'B' },
      { alg: 'ECDSA-P256-SHA256', sig: 'B' },
      { alg: 'ECDSA-P256-SHA256', key: 'A' },
      { alg: 'ECDSA-P256-SHA256', key: 'x'.repeat(600), sig: 'B' },
      'no soy un objeto',
      null,
    ];
    for (const signature of malas) {
      expect(parseGalleryIndex(JSON.stringify({ ...base, signature }))?.signature).toBeUndefined();
    }
  });

  it('descartar la firma NO tira el índice entero', () => {
    const index = parseGalleryIndex(JSON.stringify({ ...base, signature: { alg: 'RSA' } }));
    expect(index?.plugins).toHaveLength(1);
  });

  it('el sha256 se acepta solo con forma de SHA-256 en base64', () => {
    const bueno = 'A'.repeat(43) + '=';
    const conHash = parseGalleryIndex(
      JSON.stringify({ ...base, plugins: [{ ...base.plugins[0], sha256: bueno }] }),
    );
    expect(conHash?.plugins[0]?.sha256).toBe(bueno);

    for (const malo of ['', 'corto', 'x'.repeat(200), 'no-base64-!!!!']) {
      const index = parseGalleryIndex(
        JSON.stringify({ ...base, plugins: [{ ...base.plugins[0], sha256: malo }] }),
      );
      expect(index?.plugins[0]?.sha256).toBeUndefined();
    }
  });
});
