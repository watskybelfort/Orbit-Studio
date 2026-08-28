/**
 * Dos reglas de la frontera que viven en el ORDEN y en la FORMA del código, y
 * que ninguna prueba funcional pillaría si alguien las rompe:
 *
 * 1. El worker se desarma a sí mismo ANTES de compilar el plugin. Si alguien
 *    mueve `harden()` una línea más abajo, todos los tests siguen en verde —
 *    porque los plugins de prueba no intentan escaparse— y sin embargo el
 *    top-level del plugin habría corrido con `fetch` y `WebSocket` en la mano.
 * 2. Al worker solo se le mandan los mensajes de la sesión. Si alguien colara
 *    ahí el canvas, su contexto o un nodo del árbol, el plugin tendría
 *    `ownerDocument` y con él la app entera — y el dibujo seguiría saliendo
 *    igual de bonito, así que nadie se enteraría.
 *
 * Se comprueban sobre el código fuente de verdad, como
 * `drop-handlers-sync.test.ts`: montar el componente traería jsdom a un repo
 * que no lo necesita (ver CLAUDE.md).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(resolve(here, '../src', p), 'utf8');

/** Quita comentarios de línea y de bloque: la regla es sobre el CÓDIGO. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('el worker se desarma antes de correr nada del usuario', () => {
  const code = stripComments(read('plugins/plugin-view-worker.ts'));

  it('harden() se llama, y se llama antes de compileView()', () => {
    // Se buscan las LLAMADAS, no las declaraciones: `function harden(): void`
    // contiene la subcadena "harden()" y haría vacua la comparación.
    const hardenCall = /(^|[\s;{])harden\(\);/m.exec(code);
    const compileCall = code.indexOf('= compileView(');
    expect(hardenCall).not.toBeNull();
    expect(compileCall).toBeGreaterThan(-1);
    expect(compileCall).toBeGreaterThan(hardenCall!.index);
    // Y la llamada a harden está dentro del manejador de 'init', que es lo
    // primero que recibe el worker.
    const initAt = code.indexOf("msg.type === 'init'");
    expect(hardenCall!.index).toBeGreaterThan(initAt);
  });

  it('no hay ningún new Function fuera de compileView', () => {
    const news = code.match(/new Function\(/g) ?? [];
    expect(news).toHaveLength(1);
  });

  it('lo que se le quita al global cubre red, disco, hilos y el canal al host', () => {
    for (const cap of [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'importScripts',
      'indexedDB',
      'Worker',
      'navigator',
      'postMessage',
    ]) {
      expect(code).toContain(`'${cap}'`);
    }
  });
});

describe('al worker no se le manda nada del DOM', () => {
  const view = read('plugins/PluginView.tsx');
  const code = stripComments(view);

  it('solo hay un postMessage, y reenvía sus propios argumentos', () => {
    const calls = [...code.matchAll(/worker\.postMessage\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      // Nada de canvas, contexto ni refs: solo lo que le llega al puerto.
      expect(args).toMatch(/^message(, transfer)?$/);
    }
  });

  it('el contexto 2D solo se usa para repintar, y no sale de ahí', () => {
    // `getContext('2d')` aparece una vez, y su resultado solo se le pasa a
    // `replayDisplayList`. Si apareciera en un postMessage o en el objeto de
    // la sesión, la frontera dejaría de ser de datos.
    expect((code.match(/getContext\('2d'\)/g) ?? []).length).toBe(1);
    expect(code).toContain('replayDisplayList(ctx as unknown as Canvas2DLike');
    expect(code).not.toMatch(/post\([^)]*\bctx\b/);
    expect(code).not.toMatch(/postMessage\([^)]*\b(ctx|canvas|cv)\b/);
  });

  it('la sesión recibe la fuente del plugin como TEXTO, no compilada', () => {
    // Un `new Function` en el renderer sería justo lo que se quiere evitar.
    expect(code).not.toContain('new Function');
    expect(code).not.toContain('eval(');
  });

  it('el bucle de dibujo llama a tick en TODAS las vueltas (el watchdog late ahí)', () => {
    // Si el `tick` quedara dentro de un `if` de "toca mandar frame", un worker
    // colgado no se cazaría nunca: nadie volvería a mirar el reloj.
    const loop = code.slice(code.indexOf('const loop = ()'), code.indexOf('raf = requestAnimationFrame(loop);\n\n    return'));
    expect(loop).toContain('session.tick(performance.now()');
  });
});

describe('la sesión no compila ni ejecuta nada del plugin', () => {
  const code = stripComments(read('plugins/view-session.ts'));

  it('ni new Function, ni eval, ni import dinámico', () => {
    expect(code).not.toContain('new Function');
    expect(code).not.toContain('eval(');
  });

  it('el frame siempre viaja con su lista de transferencia', () => {
    // Sin la lista, `postMessage` haría una COPIA del buffer en cada frame: el
    // ping-pong dejaría de serlo y nadie lo notaría salvo por el GC.
    const post = code.slice(code.indexOf("this.port.post({ type: 'frame'"));
    expect(post).toContain('input.buffer as ArrayBuffer');
    expect(post).toContain('out.buffer as ArrayBuffer');
  });
});
