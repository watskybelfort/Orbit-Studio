import { describe, expect, it } from 'vitest';
import { parseLatestRelease, shouldRecheck } from '../src/main/update-check';

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

describe('shouldRecheck — throttle: no se consulta en cada arranque', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('sin fecha previa (primer arranque), toca mirar', () => {
    expect(shouldRecheck(undefined, Date.now(), DAY)).toBe(true);
  });

  it('recién mirado, no toca todavía', () => {
    const now = 1_000_000 * DAY;
    expect(shouldRecheck(now - HOUR, now, DAY)).toBe(false);
  });

  it('pasado el intervalo, vuelve a tocar', () => {
    const now = 1_000_000 * DAY;
    expect(shouldRecheck(now - DAY - 1, now, DAY)).toBe(true);
  });

  it('justo en el borde del intervalo, toca (>=)', () => {
    const now = 1_000_000 * DAY;
    expect(shouldRecheck(now - DAY, now, DAY)).toBe(true);
  });

  it('una fecha guardada corrupta no bloquea el aviso para siempre', () => {
    expect(shouldRecheck(Number.NaN, Date.now(), DAY)).toBe(true);
  });
});
