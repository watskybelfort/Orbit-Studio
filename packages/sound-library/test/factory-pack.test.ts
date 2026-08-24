/**
 * El pack de fábrica que está EN EL REPO, tal como se va a instalar.
 *
 * Estos 132 archivos son un artefacto versionado: se generan a mano con
 * `npx tsx packages/sound-library/generate/generate.ts` y se commitean. El
 * generador se verifica a sí mismo al terminar, pero eso solo corre cuando
 * alguien lo ejecuta — y entre una regeneración y la siguiente pueden pasar
 * meses. Lo que este test vigila es lo que puede pasar en medio: que alguien
 * toque el manifest a mano, que un archivo se pierda en un merge, o que el
 * pack engorde sin que nadie se dé cuenta hasta ver el instalador.
 *
 * Un archivo que falta no da error en ningún sitio: da un sonido mudo, o un
 * agujero en el teclado de un instrumento, y eso se descubre tocando.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entrySamples, loadManifest, sampleIdFor } from '../src/index';

const PACK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'factory');
const MANIFEST = path.join(PACK, 'manifest.json');

/**
 * Presupuesto del pack. No es un límite técnico: este pack viaja DENTRO del
 * instalador, así que es la promesa de que descargarse Orbit sigue siendo
 * rápido. Subirlo es una decisión, y por eso está aquí escrito y no solo en el
 * generador — tocarlo obliga a tocar un test.
 */
const TOPE_MB = 48;

const hayPack = fs.existsSync(MANIFEST);

describe.skipIf(!hayPack)('el pack de fábrica del repo', () => {
  const manifest = loadManifest(fs.readFileSync(MANIFEST, 'utf8'));

  it('carga y trae los seis grupos del browser', () => {
    expect(manifest.pack).toBe('Orbit Essentials');
    expect(manifest.entries.length).toBeGreaterThan(60);
    const categorias = new Set(manifest.entries.map((e) => e.category));
    expect([...categorias].sort()).toEqual([
      '808s',
      'drums',
      'fx',
      'instrumentos',
      'melodic-loops',
      'percusion-latina',
    ]);
  });

  it('TODOS los archivos que promete existen en disco', () => {
    const faltan: string[] = [];
    for (const entry of manifest.entries) {
      for (const sample of entrySamples(entry)) {
        if (!fs.existsSync(path.join(PACK, sample.file))) faltan.push(sample.file);
      }
    }
    expect(faltan).toEqual([]);
  });

  it('ningún archivo del pack se queda huérfano', () => {
    // Al revés que el anterior: un WAV que ya no referencia nadie son cientos
    // de kilobytes viajando en el instalador para nada.
    const referenciados = new Set<string>();
    for (const entry of manifest.entries) {
      for (const sample of entrySamples(entry)) referenciados.add(sample.file.replace(/\\/g, '/'));
    }
    const enDisco: string[] = [];
    const recorrer = (dir: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) recorrer(full);
        else if (item.name.endsWith('.wav')) {
          enDisco.push(path.relative(PACK, full).replace(/\\/g, '/'));
        }
      }
    };
    recorrer(PACK);
    expect(enDisco.filter((f) => !referenciados.has(f))).toEqual([]);
  });

  it('los ids de sample no chocan entre sí', () => {
    // Dos grabaciones con el mismo id se pisan en el kernel: la segunda gana y
    // la primera suena donde no debe, en otro instrumento.
    const vistos = new Map<string, string>();
    for (const entry of manifest.entries) {
      for (const sample of entrySamples(entry)) {
        const id = sampleIdFor(entry, sample.file);
        expect(vistos.has(id), `id repetido "${id}" (${vistos.get(id)} y ${entry.id})`).toBe(false);
        vistos.set(id, entry.id);
      }
    }
  });

  it('cabe en el presupuesto del instalador', () => {
    let bytes = fs.statSync(MANIFEST).size;
    for (const entry of manifest.entries) {
      for (const sample of entrySamples(entry)) {
        bytes += fs.statSync(path.join(PACK, sample.file)).size;
      }
    }
    const mb = bytes / 1024 / 1024;
    expect(mb, `el pack ocupa ${mb.toFixed(1)} MB`).toBeLessThan(TOPE_MB);
  });
});

describe.skipIf(!hayPack)('los instrumentos son multisample de verdad', () => {
  const manifest = loadManifest(fs.readFileSync(MANIFEST, 'utf8'));
  const instrumentos = manifest.entries.filter((e) => e.category === 'instrumentos');

  it('hay veinticuatro y todos traen varias tomas', () => {
    expect(instrumentos.length).toBe(24);
    for (const entry of instrumentos) {
      expect(entry.samples?.length ?? 0, entry.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('cada instrumento cubre su registro con notas distintas y en octavas', () => {
    for (const entry of instrumentos) {
      const roots = entry.samples!.map((s) => s.rootMidi).sort((a, b) => a - b);
      expect(new Set(roots).size, entry.id).toBe(roots.length);
      for (let i = 1; i < roots.length; i++) {
        expect(roots[i]! - roots[i - 1]!, entry.id).toBe(12);
      }
      // Y caen en el teclado con sitio de sobra a los lados: la zona más grave
      // y la más aguda se estiran hacia los bordes, y estirar tres octavas es
      // justo lo que esto vino a quitar.
      expect(roots[0]!, entry.id).toBeGreaterThanOrEqual(12);
      expect(roots[roots.length - 1]!, entry.id).toBeLessThanOrEqual(108);
    }
  });

  it('la toma principal está entre sus tomas', () => {
    // Si no, el browser escucharía un archivo que el instrumento no usa.
    for (const entry of instrumentos) {
      expect(entry.samples!.some((s) => s.file === entry.file), entry.id).toBe(true);
    }
  });

  it('el resto del pack sigue siendo de un archivo', () => {
    // Un kick no es un instrumento: darle keymap sería confundir a quien lo
    // suelte en el rack esperando un canal de sampler normal.
    for (const entry of manifest.entries) {
      if (entry.category === 'instrumentos') continue;
      expect(entry.samples, entry.id).toBeUndefined();
    }
  });
});
