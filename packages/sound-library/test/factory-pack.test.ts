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
 *
 * Subido de 80 a 115 al entrar la tercera capa de fuerza de los instrumentos
 * (72 grabaciones más: 144 → 216). El pack real mide 98,87 MB medidos —no
 * estimados— al regenerar; 115 deja el mismo margen (~16 %) que tenía el
 * tope de 80 sobre los 70 MB reales de antes. Tiene que coincidir con el
 * tope del generador (`generate.ts`): si uno cambia y el otro no, este test
 * es el que avisa.
 */
const TOPE_MB = 115;

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

  it('hay veinticuatro y todos traen sus nueve tomas (3 alturas × 3 capas)', () => {
    expect(instrumentos.length).toBe(24);
    for (const entry of instrumentos) {
      expect(entry.samples?.length ?? 0, entry.id).toBe(9);
    }
  });

  it('cada instrumento cubre su registro con notas distintas y en octavas', () => {
    for (const entry of instrumentos) {
      // Las notas SIN REPETIR: cada altura trae ahora una toma por capa de
      // fuerza, y las dos declaran la misma nota. Que se repita la nota es lo
      // normal aquí; lo que no puede repetirse es la pareja (nota, capa), y de
      // eso se ocupa la prueba de abajo.
      const roots = [...new Set(entry.samples!.map((s) => s.rootMidi))].sort((a, b) => a - b);
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

  it('cada nota trae sus capas de fuerza, y tapan el 0..1 sin huecos', () => {
    // Un hueco en la franja es una nota MUDA a esa fuerza y un solape es una
    // nota que suena el doble. Las dos cosas se descubren tocando y ninguna da
    // error por su cuenta: es de las pocas que hay que dejar escritas.
    for (const entry of instrumentos) {
      const porNota = new Map<number, { velLow: number; velHigh: number }[]>();
      for (const s of entry.samples!) {
        const lista = porNota.get(s.rootMidi) ?? [];
        lista.push({ velLow: s.velLow ?? 0, velHigh: s.velHigh ?? 1 });
        porNota.set(s.rootMidi, lista);
      }
      for (const [nota, capas] of porNota) {
        const donde = `${entry.id} en la nota ${nota}`;
        expect(capas.length, donde).toBe(3);
        capas.sort((a, b) => a.velLow - b.velLow);
        expect(capas[0]!.velLow, `${donde}: nadie cubre la velocidad 0`).toBe(0);
        expect(
          capas[capas.length - 1]!.velHigh,
          `${donde}: nadie cubre la velocidad máxima`,
        ).toBe(1);
        for (let i = 1; i < capas.length; i++) {
          const hueco = capas[i]!.velLow - capas[i - 1]!.velHigh;
          expect(hueco, `${donde}: las capas se pisan`).toBeGreaterThan(0);
          expect(hueco, `${donde}: hueco entre capas`).toBeLessThan(0.01);
        }
      }
    }
  });

  it('la toma principal es la del registro natural con el golpe entero', () => {
    // No es cualquiera de las seis: es la que conserva el nombre de archivo de
    // siempre, la que se escucha en el browser y la que cae en la playlist. Y
    // es la de arriba de la franja porque el pack de una sola capa —al que
    // apunta todo proyecto guardado— era exactamente esa grabación.
    for (const entry of instrumentos) {
      const principal = entry.samples!.find((s) => s.file === entry.file)!;
      expect(principal.velHigh, entry.id).toBe(1);
      expect(principal.file, entry.id).toBe(`${entry.id}.wav`);
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
