import { describe, expect, it } from 'vitest';
import { parseVersionFile, versionFileName } from '../src/version-files';

describe('nombres de versión antiguos y únicos', () => {
  const nonce = '662b2f68-3cb7-45f8-9e39-3e9b3714ade6';
  it('conserva etiqueta, fecha y límite de longitud sin mostrar el UUID', () => {
    const file = versionFileName(1791060000000, 'Voz más cálida / final', nonce);
    expect(parseVersionFile(file)).toEqual({ at: 1791060000000, slug: 'voz-mas-calida-final' });
    expect(parseVersionFile(versionFileName(1791060000000, 'a'.repeat(80), nonce))?.slug).toHaveLength(40);
    expect(parseVersionFile(versionFileName(1791060000000, '', nonce))?.slug).toBe('');
    expect(parseVersionFile('1791060000000-voz-mas-calida-final.orbit')).toEqual({ at: 1791060000000, slug: 'voz-mas-calida-final' });
    expect(parseVersionFile('1791060000000-.orbit')?.slug).toBe('');
  });
  it('no acepta rutas ni identificadores malformados', () => {
    expect(() => versionFileName(1791060000000, 'Nombre', '../x')).toThrow();
    expect(() => versionFileName(NaN, 'Nombre', nonce)).toThrow();
    expect(parseVersionFile('../1791060000000-voz.orbit')).toBeNull();
  });
});
