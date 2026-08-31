/**
 * Regresión para tres `exhaustive-deps` que faltaban de las listas (v3.6,
 * revisión de los once avisos de la v3.5): un manejador de puntero llama a una
 * función definida con `useCallback` más abajo, y esa función no estaba en su
 * array de dependencias.
 *
 * **Lo que este test NO afirma**, porque al verificarlo no se sostuvo: que la
 * ausencia produjera un fallo visible. Este docblock decía que el síntoma era
 * "el primer clic tras cambiar de modo usa el modo anterior", y eso nunca se
 * demostró. En los tres casos la dependencia ausente ya estaba cubierta
 * transitivamente por otra de la misma lista (`paintAt` arrastra `draw`, que
 * depende de `laneMode`; `deps(fadeHandleAt)` ⊆ `deps(clipAt)`) o apunta a una
 * identidad estable (`setLoopRegion` es `useCallback(..., [])` y no lee nada del
 * render). Hoy no hay ninguna cerradura vieja.
 *
 * La razón de listarlas igual, y de que este test exista, es que esa cobertura
 * es **accidental**: depende de que otra función siga dependiendo de lo mismo.
 * El día que alguien "limpie" esas deps (o el `eslint-disable`) el bug pasa a
 * ser real. Eso es lo que se vigila: si el cuerpo LLAMA a la función, el array
 * de deps la LISTA. Se comprueba leyendo el CÓDIGO FUENTE de cada manejador, en
 * vez de montar el componente (jsdom está fuera del repo — ver CLAUDE.md),
 * porque esto es puro cableado de React y no hay aritmética que probar.
 */

import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';


/** Cuerpo entre llaves que arranca en el primer `{` tras `startMarker`, y el índice justo después de su `}` de cierre. */
function braceBodyAfter(source: string, startMarker: string): { body: string; end: number } {
  const at = source.indexOf(startMarker);
  if (at < 0) throw new Error(`no se encontró "${startMarker}" en el archivo`);
  const braceStart = source.indexOf('{', at);
  if (braceStart < 0) throw new Error(`"${startMarker}" no abre con { detrás`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(braceStart, i + 1), end: i + 1 };
    }
  }
  throw new Error(`la función que abre en "${startMarker}" nunca cierra`);
}

/** Quita comentarios de línea (algunos, aquí, citan un array de ejemplo entre corchetes). */
function stripLineComments(code: string): string {
  return code.replace(/\/\/[^\n]*/g, '');
}

/**
 * El array de dependencias de un useCallback/useMemo: el primer `[...]` (sin
 * corchetes anidados — así son siempre estas listas de identificadores) que
 * aparece después del cuerpo de la función, antes del `)` que cierra la llamada.
 * Los comentarios se quitan antes de buscar: alguno de los que explican por
 * qué falta/sobra una dependencia cita un array de ejemplo entre corchetes,
 * y eso no es el array real.
 */
function depsAfter(source: string, bodyEnd: number): string[] {
  const window = stripLineComments(source.slice(bodyEnd, bodyEnd + 800));
  const m = window.match(/\[([^\]]*)\]/);
  if (!m) throw new Error('no se encontró el array de dependencias tras el cuerpo de la función');
  return m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
}

/** ¿El cuerpo llama a `name(` y, si es así, `name` está en `deps`? */
function callImpliesDep(body: string, deps: string[], name: string): void {
  const calls = body.includes(`${name}(`);
  expect(calls, `se esperaba que el cuerpo llamara a ${name}(...)`).toBe(true);
  expect(deps, `${name} se llama dentro pero falta en las deps`).toContain(name);
}

describe('PianoRoll.tsx: onPointerDown no usa una cerradura vieja de applyVelocityAt', () => {
  const source = readSource('editors/pianoroll/PianoRoll.tsx');

  it('applyVelocityAt está declarado ANTES de onPointerDown (si no, sus deps no podrían citarlo)', () => {
    expect(source.indexOf('const applyVelocityAt = useCallback(')).toBeLessThan(
      source.indexOf('const onPointerDown = useCallback('),
    );
  });

  it('onPointerDown llama a applyVelocityAt y lo lista en sus deps', () => {
    const { body, end } = braceBodyAfter(source, 'const onPointerDown = useCallback(');
    callImpliesDep(body, depsAfter(source, end), 'applyVelocityAt');
  });
});

describe('Playlist.tsx: los manejadores de puntero no usan una cerradura vieja de fadeHandleAt/setLoopRegion', () => {
  const source = readSource('editors/playlist/Playlist.tsx');

  it('onPointerDown llama a fadeHandleAt y lo lista en sus deps', () => {
    const { body, end } = braceBodyAfter(source, 'const onPointerDown = useCallback(');
    callImpliesDep(body, depsAfter(source, end), 'fadeHandleAt');
  });

  it('onPointerMove llama a fadeHandleAt y setLoopRegion, y lista ambas en sus deps', () => {
    const { body, end } = braceBodyAfter(source, 'const onPointerMove = useCallback(');
    const deps = depsAfter(source, end);
    callImpliesDep(body, deps, 'fadeHandleAt');
    callImpliesDep(body, deps, 'setLoopRegion');
  });

  it('onDoubleClick llama a fadeHandleAt y lo lista en sus deps', () => {
    const { body, end } = braceBodyAfter(source, 'const onDoubleClick = useCallback(');
    callImpliesDep(body, depsAfter(source, end), 'fadeHandleAt');
  });

  it('clearLoop llama a setLoopRegion y lo lista en sus deps', () => {
    const { body, end } = braceBodyAfter(source, 'const clearLoop = useCallback(() => {');
    callImpliesDep(body, depsAfter(source, end), 'setLoopRegion');
  });
});

describe('callImpliesDep falla de verdad si la dependencia se cae de la lista', () => {
  it('cuerpo que llama a la función pero deps vacías: falla', () => {
    expect(() => callImpliesDep('foo(); bar();', [], 'foo')).toThrow(/falta en las deps/);
  });

  it('cuerpo que NO llama a la función: falla (para no dar por buena una prueba que no prueba nada)', () => {
    expect(() => callImpliesDep('bar();', ['foo'], 'foo')).toThrow(/se esperaba que el cuerpo llamara/);
  });

  it('cuerpo que llama y la lista sí la trae: pasa', () => {
    expect(() => callImpliesDep('foo();', ['foo'], 'foo')).not.toThrow();
  });
});
