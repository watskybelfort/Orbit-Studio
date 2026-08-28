import { describe, expect, it } from 'vitest';
import {
  CURRENT_KEY,
  compareDirection,
  compareHint,
  compareSemver,
  compareTitle,
  defaultPair,
  isNewerVersion,
  parseVersionParts,
  resolvePick,
  type ComparableVersion,
} from '../src/state/version-compare';

const ENTRIES: ComparableVersion[] = [
  { file: '20260819120000-antes-del-drop.orbit', label: 'Antes del drop', at: 1_000 },
  { file: '20260819130000-con-la-voz.orbit', label: 'Con la voz', at: 2_000 },
];

describe('resolvePick', () => {
  it('el proyecto de ahora es un lado válido y no tiene hora', () => {
    expect(resolvePick(CURRENT_KEY, ENTRIES)).toEqual({
      key: CURRENT_KEY,
      label: 'El proyecto de ahora',
      at: null,
    });
  });

  it('una versión de la lista se resuelve con su nombre y su hora', () => {
    expect(resolvePick(ENTRIES[0]!.file, ENTRIES)).toEqual({
      key: ENTRIES[0]!.file,
      label: 'Antes del drop',
      at: 1_000,
    });
  });

  it('una versión que ya no está no se resuelve (mejor no comparar que mentir)', () => {
    expect(resolvePick('20260101000000-borrada.orbit', ENTRIES)).toBeNull();
  });
});

describe('compareDirection', () => {
  const vieja = resolvePick(ENTRIES[0]!.file, ENTRIES)!;
  const nueva = resolvePick(ENTRIES[1]!.file, ENTRIES)!;
  const ahora = resolvePick(CURRENT_KEY, ENTRIES)!;

  it('de la vieja a la nueva se avanza', () => {
    expect(compareDirection(vieja, nueva)).toBe('forward');
  });

  it('de la nueva a la vieja se retrocede', () => {
    expect(compareDirection(nueva, vieja)).toBe('backward');
  });

  it('el proyecto de ahora es lo más nuevo que hay', () => {
    expect(compareDirection(nueva, ahora)).toBe('forward');
    expect(compareDirection(ahora, nueva)).toBe('backward');
  });

  it('la misma a los dos lados', () => {
    expect(compareDirection(nueva, nueva)).toBe('same');
    expect(compareDirection(ahora, ahora)).toBe('same');
  });

  it('dos versiones distintas guardadas en el mismo milisegundo no inventan direccion', () => {
    const gemelas: ComparableVersion[] = [
      { file: 'a.orbit', label: 'A', at: 5 },
      { file: 'b.orbit', label: 'B', at: 5 },
    ];
    expect(compareDirection(resolvePick('a.orbit', gemelas)!, resolvePick('b.orbit', gemelas)!)).toBe(
      'same',
    );
  });
});

describe('compareTitle y compareHint', () => {
  const vieja = resolvePick(ENTRIES[0]!.file, ENTRIES)!;
  const nueva = resolvePick(ENTRIES[1]!.file, ENTRIES)!;

  it('el titulo lleva la direccion delante', () => {
    expect(compareTitle(vieja, nueva)).toBe('De «Antes del drop» a «Con la voz»');
  });

  it('mirando hacia atras avisa de como leer lo anadido', () => {
    expect(compareHint('backward')).toContain('hacia atrás');
    expect(compareHint('forward')).toBeNull();
    expect(compareHint('same')).toContain('lo mismo');
  });
});

describe('defaultPair', () => {
  it('la mas reciente contra el proyecto de ahora', () => {
    expect(defaultPair(ENTRIES)).toEqual({ from: ENTRIES[1]!.file, to: CURRENT_KEY });
  });

  it('sin versiones, los dos lados son el proyecto de ahora', () => {
    expect(defaultPair([])).toEqual({ from: CURRENT_KEY, to: CURRENT_KEY });
  });
});

describe('parseVersionParts', () => {
  it('trocea una versión normal en números', () => {
    expect(parseVersionParts('3.4.0')).toEqual([3, 4, 0]);
  });

  it('acepta el prefijo "v" (como etiquetan los tags de GitHub)', () => {
    expect(parseVersionParts('v3.4.0')).toEqual([3, 4, 0]);
  });

  it('ignora el sufijo de prerelease/build', () => {
    expect(parseVersionParts('3.4.0-beta.1')).toEqual([3, 4, 0]);
    expect(parseVersionParts('3.4.0+build5')).toEqual([3, 4, 0]);
  });

  it('un trozo que no es número cuenta como 0 sin reventar', () => {
    expect(parseVersionParts('3.x.0')).toEqual([3, 0, 0]);
  });
});

describe('compareSemver / isNewerVersion — la app instalada contra la última release', () => {
  it('detecta un patch nuevo', () => {
    expect(compareSemver('3.4.1', '3.4.0')).toBe(1);
    expect(isNewerVersion('3.4.1', '3.4.0')).toBe(true);
  });

  it('detecta un minor o un major nuevo aunque el resto sea menor', () => {
    expect(isNewerVersion('3.5.0', '3.4.9')).toBe(true);
    expect(isNewerVersion('4.0.0', '3.9.9')).toBe(true);
  });

  it('la misma versión no es "más nueva"', () => {
    expect(compareSemver('3.4.0', '3.4.0')).toBe(0);
    expect(isNewerVersion('3.4.0', '3.4.0')).toBe(false);
  });

  it('una versión vieja no es "más nueva" que la instalada', () => {
    expect(isNewerVersion('3.3.9', '3.4.0')).toBe(false);
    expect(compareSemver('3.3.9', '3.4.0')).toBe(-1);
  });

  it('el "v" de los tags de GitHub no rompe la comparación', () => {
    expect(isNewerVersion('v3.5.0', '3.4.0')).toBe(true);
  });

  it('quince releases seguidas: cada una es más nueva que la anterior', () => {
    const releases = [
      '2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '3.0.0',
      '3.1.0', '3.2.0', '3.3.0', '3.3.1', '3.4.0',
    ];
    for (let i = 1; i < releases.length; i++) {
      expect(isNewerVersion(releases[i]!, releases[i - 1]!), `${releases[i]} > ${releases[i - 1]}`).toBe(
        true,
      );
    }
  });
});
