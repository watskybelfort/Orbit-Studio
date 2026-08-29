import { describe, expect, it } from 'vitest';
import { parseLatestRelease } from '../src/main/update-check';

describe('parseLatestRelease — respuesta de GET /releases/latest', () => {
  it('acepta una release normal y le quita la "v" del tag', () => {
    expect(
      parseLatestRelease({
        tag_name: 'v3.5.0',
        html_url: 'https://github.com/watskybelfort/Orbit-Studio/releases/tag/v3.5.0',
        draft: false,
        prerelease: false,
      }),
    ).toEqual({
      version: '3.5.0',
      url: 'https://github.com/watskybelfort/Orbit-Studio/releases/tag/v3.5.0',
    });
  });

  it('un tag sin "v" también vale', () => {
    expect(
      parseLatestRelease({ tag_name: '3.5.0', html_url: 'https://github.com/x/y/releases/tag/3.5.0' }),
    ).toEqual({ version: '3.5.0', url: 'https://github.com/x/y/releases/tag/3.5.0' });
  });

  it('rechaza un draft o un prerelease (no es "la versión nueva" de verdad)', () => {
    expect(
      parseLatestRelease({
        tag_name: 'v3.5.0',
        html_url: 'https://github.com/x/y/releases/tag/v3.5.0',
        draft: true,
      }),
    ).toBeNull();
    expect(
      parseLatestRelease({
        tag_name: 'v3.5.0-beta.1',
        html_url: 'https://github.com/x/y/releases/tag/v3.5.0-beta.1',
        prerelease: true,
      }),
    ).toBeNull();
  });

  it('rechaza una URL que no sea de github.com (paranoia barata pero gratis)', () => {
    expect(
      parseLatestRelease({ tag_name: 'v3.5.0', html_url: 'https://evil.example/v3.5.0' }),
    ).toBeNull();
  });

  it('rechaza un tag que no tiene pinta de versión', () => {
    expect(
      parseLatestRelease({ tag_name: 'nightly-build', html_url: 'https://github.com/x/y' }),
    ).toBeNull();
  });

  it('formas inesperadas devuelven null sin reventar', () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease(undefined)).toBeNull();
    expect(parseLatestRelease('3.5.0')).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v3.5.0' })).toBeNull(); // sin html_url
    expect(parseLatestRelease({ message: 'Not Found' })).toBeNull(); // 404 de GitHub
  });
});

// No hay describe de throttle aquí: `shouldRecheck` (con sus cinco tests) se
// quitó de `src/main/update-check.ts` por ser código muerto — el throttle
// real es `dueToRecheck`, en `packages/ui/src/state/update-check.ts`, y ESE
// es el que se prueba (ver `packages/ui/test/update-check.test.ts`). Ver el
// comentario de cabecera del módulo para el porqué.
