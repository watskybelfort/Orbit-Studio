import { describe, expect, it } from 'vitest';
import { findSettingsSections, SETTINGS_SECTIONS } from '../src/settings/settings-catalog';

describe('búsqueda de ajustes por tarea', () => {
  it('sin consulta conserva todas las categorías y su orden', () => {
    expect(findSettingsSections(' \t ')).toEqual(SETTINGS_SECTIONS);
  });

  it('encuentra términos cotidianos aunque falten tildes o cambie la caja', () => {
    expect(findSettingsSections('MICROFONO').map((s) => s.id)).toEqual(['devices']);
    expect(findSettingsSections('acrilico').map((s) => s.id)).toEqual(['appearance']);
  });

  it('acepta varias palabras y espacios sin perder el contexto', () => {
    expect(findSettingsSections('  micro   LATENCIA  ').map((s) => s.id)).toEqual(['devices']);
  });

  it('no mezcla coincidencias de categorías distintas para una consulta', () => {
    expect(findSettingsSections('micro tipografia')).toEqual([]);
  });

  it('un resultado vacío permite mostrar ayuda en vez de un panel ajeno', () => {
    expect(findSettingsSections('zz-inexistente')).toEqual([]);
  });
});
