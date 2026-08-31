/**
 * El grafo de paquetes, escrito una vez y comparado con quien lo repite.
 *
 * La regla 6 de CLAUDE.md describió durante ocho versiones un grafo de cuatro
 * paquetes que el árbol ya no tenía: `sound-library` ni figuraba, y doce
 * imports reales la incumplían. No lo notó nadie porque la prosa no la
 * comprobaba nada — el linter sí hacía cumplir el grafo verdadero, pero era el
 * único que lo sabía. Este test cierra ese hueco: `package-graph.json` es la
 * fuente, y aquí se comprueba que CLAUDE.md, `docs/ARCHITECTURE.md` y los
 * exports reales de `core` siguen de acuerdo con ella.
 *
 * Lo que NO hace: vigilar los imports del árbol. De eso ya se encarga
 * `orbit/package-boundaries` en `npm run lint`, que ve cada `import` de cada
 * archivo. Aquí se vigila lo otro, lo que un linter no puede ver: que lo
 * ESCRITO en tres sitios siga diciendo lo mismo.
 *
 *   npx vitest run tools/eslint/package-graph.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import config from './package-graph.json';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function leer(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Cómo se reconoce la lista canónica dentro de un `.md`.
 *
 * Un token es `` `nombre→dep,dep` `` sin espacios, y una LISTA es una tirada de
 * dos o más tokens seguidos separados por `·` o por comas. Así, mencionar una
 * arista suelta en prosa —«`ui→sound-library` son ocho sitios»— no cuenta como
 * declaración, que es justo lo que hace falta para poder explicar el grafo sin
 * romper el test. Y de las tiradas solo valen las que declaran `core`, que es
 * el ancla de la lista de verdad y no aparece en ningún ejemplo de prosa.
 */
function listasDeclaradas(markdown: string): Record<string, string[]>[] {
  const texto = markdown.replace(/\s+/g, ' ');
  const tirada = /`[a-z-]+→[^`]+`(?:\s*[,·]\s*`[a-z-]+→[^`]+`)+/g;
  const listas: Record<string, string[]>[] = [];

  for (const run of texto.match(tirada) ?? []) {
    const mapa: Record<string, string[]> = {};
    for (const [, nombre, deps] of run.matchAll(/`([a-z-]+)→([^`]+)`/g)) {
      mapa[nombre!] = deps === '∅' ? [] : deps!.split(',').sort();
    }
    if ('core' in mapa) listas.push(mapa);
  }
  return listas;
}

/**
 * El JSON, en el vocabulario de los documentos: solo `packages/*` y sin el
 * prefijo. Las apps son hojas y se explican en prosa, no en la lista.
 */
function grafoEsperado(): Record<string, string[]> {
  const corto = (u: string) => u.replace(/^packages\//, '');
  const out: Record<string, string[]> = {};
  for (const [unidad, deps] of Object.entries(config.graph)) {
    if (!unidad.startsWith('packages/')) continue;
    out[corto(unidad)] = deps.map(corto).sort();
  }
  return out;
}

describe('el grafo escrito coincide con el grafo declarado', () => {
  const esperado = grafoEsperado();

  for (const doc of ['CLAUDE.md', 'docs/ARCHITECTURE.md']) {
    it(`${doc} declara el mismo grafo que package-graph.json`, () => {
      const listas = listasDeclaradas(leer(doc));
      expect(
        listas.length,
        `${doc} no declara ninguna lista de dependencias reconocible (ver el comentario de este test)`,
      ).toBeGreaterThan(0);
      for (const lista of listas) expect(lista).toEqual(esperado);
    });
  }
});

describe('el grafo es un DAG por capas', () => {
  it('toda dependencia apunta a una unidad declarada', () => {
    const unidades = new Set(Object.keys(config.graph));
    for (const [unidad, deps] of Object.entries(config.graph)) {
      for (const dep of deps) {
        expect(unidades, `${unidad} depende de ${dep}, que no está en el grafo`).toContain(dep);
      }
    }
  });

  it('no hay ciclos: existe un orden topológico', () => {
    // Kahn. Si sobra alguna unidad al final, es que están en un ciclo — y un
    // ciclo aquí es el único fallo que la regla 6 nunca podría tolerar.
    const pendientes = new Map(Object.entries(config.graph).map(([u, d]) => [u, new Set(d)]));
    const orden: string[] = [];
    let avanzo = true;
    while (avanzo) {
      avanzo = false;
      for (const [unidad, deps] of pendientes) {
        if (deps.size > 0) continue;
        pendientes.delete(unidad);
        orden.push(unidad);
        for (const otras of pendientes.values()) otras.delete(unidad);
        avanzo = true;
      }
    }
    expect([...pendientes.keys()], 'estas unidades forman un ciclo').toEqual([]);
    expect(orden[0], 'la capa 0 tiene que ser core').toBe('packages/core');
  });
});

describe('la lista `modelOnly` sigue cubriendo el estado de core', () => {
  // `engine` puede usar el MODELO de `core` (tipos, constantes y funciones
  // puras de `model/`) pero no su ESTADO. Como `core` exporta todo por un
  // índice plano, la regla de ESLint solo puede vigilarlo por nombre, con una
  // lista. Una lista escrita a mano se queda corta en cuanto `core` crece: esto
  // la vuelve a derivar de los exports de verdad y falla si se desincroniza.
  const runtimeExports = (rel: string): string[] => {
    const src = leer(path.posix.join('packages/core/src', rel));
    const nombres: string[] = [];
    for (const [, nombre] of src.matchAll(
      /^export\s+(?:async\s+)?(?:class|function\s*\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      nombres.push(nombre!);
    }
    return nombres;
  };

  for (const [unidad, regla] of Object.entries(config.modelOnly)) {
    it(`${unidad}: la lista prohibida son exactamente los exports en runtime de ${regla.sources.join(', ')}`, () => {
      const reales = regla.sources.flatMap(runtimeExports).sort();
      expect(reales.length, 'no se leyó ningún export: ¿se movieron los archivos?').toBeGreaterThan(0);
      expect([...regla.deny].sort()).toEqual(reales);
    });
  }
});
