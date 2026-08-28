/**
 * La regla que hoy solo vive en un comentario, en los tres sitios que sueltan
 * archivos del Explorador (Playlist, Channel Rack, Keymap Editor):
 *
 *   `triageDrop` tiene que llamarse SÍNCRONO, antes del primer `await` del
 *   manejador — `webkitGetAsEntry` (lo único que distingue una carpeta de un
 *   archivo) deja de responder en cuanto se cede el turno, y `dataTransfer` se
 *   vacía. Por eso `dropped-audio.ts` parte `triageDrop` de `importTriaged`.
 *
 * `dropped-audio.test.ts` ya prueba `triageDrop` aislado, pero eso no pilla
 * la regresión real: alguien que en un `.tsx` meta un `await` (o mueva la
 * llamada) ENTRE el evento y `triageDrop(e.dataTransfer)`. Montar los tres
 * componentes para probarlo traería jsdom a un repo que hoy no lo necesita
 * (ver CLAUDE.md); en su lugar, esto lee el CÓDIGO FUENTE de verdad de los
 * tres manejadores y comprueba la propiedad síncrona sobre él — así que un
 * `await` de más ahí lo hace fallar de verdad, no en teoría.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);

/**
 * El cuerpo de la función que arranca en `startMarker` (el primer `{` que
 * sigue), contando llaves hasta la que cierra. Sirve para aislar SOLO el
 * manejador de drop de un archivo que tiene muchos más al lado.
 */
function functionBodyAfter(source: string, startMarker: string): string {
  const at = source.indexOf(startMarker);
  if (at < 0) throw new Error(`no se encontró "${startMarker}" en el archivo`);
  const braceStart = source.indexOf('{', at);
  if (braceStart < 0) throw new Error(`"${startMarker}" no abre con { detrás`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`la función que abre en "${startMarker}" nunca cierra`);
}

/**
 * Quita comentarios de línea y de bloque (bien simple: este archivo no tiene
 * `//` dentro de un string en la zona que se analiza). Hace falta porque el
 * propio comentario que documenta la regla usa la palabra "await" — sin
 * quitarlo, ESE texto sería el primer "await" y el test se rompería en el
 * archivo que precisamente explica por qué no puede haber uno ahí.
 */
function stripComments(code: string): string {
  return code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Comprueba que, DENTRO del cuerpo dado, `triageDrop(` aparece antes que
 * cualquier `await` de código real — o que no hay ningún `await` en absoluto.
 * Es la propiedad de la que depende toda la función: si alguien mete un
 * `await` previo (o mueve la llamada detrás de uno), esto lo pilla en el
 * propio texto fuente, sin tener que montar el componente.
 */
function triageIsSyncBeforeAwait(body: string): void {
  const triageAt = body.indexOf('triageDrop(');
  expect(triageAt, 'el cuerpo tiene que llamar a triageDrop(...)').toBeGreaterThanOrEqual(0);
  const code = stripComments(body);
  const firstAwait = code.search(/\bawait\b/);
  if (firstAwait === -1) return; // sin await en el cuerpo: no hay forma de romperlo
  // `triageAt` es del body CON comentarios; comparar posiciones absolutas
  // entre los dos textos no vale si un comentario de por medio cambia de
  // longitud al quitarlo. Se compara sobre el mismo texto sin comentarios.
  const triageAtCode = code.indexOf('triageDrop(');
  expect(
    firstAwait,
    'hay un await ANTES de triageDrop(...): dataTransfer ya se habrá vaciado para cuando se lea',
  ).toBeGreaterThan(triageAtCode);
}

describe('el triaje del arrastre del Explorador es síncrono, en el código real', () => {
  it('Playlist.tsx: el onDrop del canvas', () => {
    const file = readFileSync(src('editors/playlist/Playlist.tsx'), 'utf8');
    // El onDrop es un arrow function SÍNCRONO (no `async`): la parte que
    // depende de `await` va aparte, en un `.then()`, precisamente para no
    // poder tentar a nadie a poner un await por delante.
    const body = functionBodyAfter(file, 'onDrop={(e) => {');
    expect(body).toContain('hasSystemFiles(e.dataTransfer)');
    triageIsSyncBeforeAwait(body);
  });

  it('ChannelRack.tsx: el onDrop del rack entero', () => {
    const file = readFileSync(src('editors/rack/ChannelRack.tsx'), 'utf8');
    const body = functionBodyAfter(file, 'onDrop={(e) => {');
    expect(body).toContain('hasSystemFiles(e.dataTransfer)');
    triageIsSyncBeforeAwait(body);
  });

  it('KeymapEditor.tsx: drop() es async, pero triageDrop va antes de su primer await', () => {
    const file = readFileSync(src('editors/channel/KeymapEditor.tsx'), 'utf8');
    // Aquí el manejador SÍ es `async` (usa `await importTriaged(...)` más
    // abajo, tras avisar "Importando…"): la regla no es "nunca haya un
    // await en la función", es que no haya ninguno ANTES de triageDrop.
    const body = functionBodyAfter(file, 'const drop = async (e: React.DragEvent) => {');
    expect(body).toContain('hasSystemFiles(e.dataTransfer)');
    triageIsSyncBeforeAwait(body);
  });

  it('la propia comprobación falla si se le da un cuerpo con el await mal puesto', () => {
    // No es solo "estos tres archivos pasan hoy": la función que los juzga
    // también sabe decir que no. Sin este test, un `triageIsSyncBeforeAwait`
    // que siempre pasara dejaría a los tres de arriba en verde por accidente.
    const roto = `{
      if (hasSystemFiles(e.dataTransfer)) {
        await algo();
        const triage = triageDrop(e.dataTransfer);
      }
    }`;
    expect(() => triageIsSyncBeforeAwait(roto)).toThrow(/await/);
  });
});
