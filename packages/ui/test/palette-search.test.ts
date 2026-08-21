import { describe, expect, it } from 'vitest';
import { fuzzyScore, normalize, searchCommands } from '../src/palette/search';
import type { PaletteCommand } from '../src/palette/registry';

function cmd(id: string, title: string, group = 'Ver', keywords?: string): PaletteCommand {
  return { id, title, group, ...(keywords ? { keywords } : null), run: () => {} };
}

const COMMANDS: PaletteCommand[] = [
  cmd('ver.playlist', 'Abrir la Playlist'),
  cmd('ver.pianoroll', 'Abrir el Piano Roll'),
  cmd('ver.mixer', 'Abrir el Mixer'),
  cmd('archivo.guardar-como', 'Guardar proyecto como…', 'Archivo'),
  cmd('archivo.guardar', 'Guardar proyecto', 'Archivo'),
  cmd('archivo.exportar', 'Exportar…', 'Archivo', 'wav mp3 stems render'),
];

const titles = (list: PaletteCommand[]) => list.map((c) => c.title);

describe('fuzzyScore', () => {
  it('casa por subsecuencia, no solo por prefijo', () => {
    expect(fuzzyScore('piano roll', 'pr')).not.toBeNull();
    expect(fuzzyScore('piano roll', 'prl')).not.toBeNull();
  });

  it('no casa si falta una letra o van en otro orden', () => {
    expect(fuzzyScore('piano roll', 'px')).toBeNull();
    expect(fuzzyScore('piano roll', 'rp')).toBeNull();
  });

  it('lo seguido puntúa más que lo repartido', () => {
    const seguido = fuzzyScore('piano', 'pia')!;
    const repartido = fuzzyScore('perdido en la mar', 'pia')!;
    expect(seguido).toBeGreaterThan(repartido);
  });

  it('caer en principio de palabra puntúa más que en medio', () => {
    const inicioDePalabra = fuzzyScore('orbit prisma', 'op')!;
    const enMedio = fuzzyScore('orbit espuma', 'op')!;
    expect(inicioDePalabra).toBeGreaterThan(enMedio);
  });

  it('la consulta vacía no descarta nada', () => {
    expect(fuzzyScore('lo que sea', '')).toBe(0);
  });
});

describe('searchCommands', () => {
  it('encuentra por iniciales de palabra', () => {
    expect(titles(searchCommands(COMMANDS, 'pr'))[0]).toBe('Abrir el Piano Roll');
  });

  it('encuentra sin acentos y sin mayúsculas', () => {
    expect(normalize('Automatización')).toBe('automatizacion');
    expect(titles(searchCommands(COMMANDS, 'EXPORT'))).toContain('Exportar…');
  });

  it('busca también en los sinónimos, pero pesan menos que el título', () => {
    const found = titles(searchCommands(COMMANDS, 'stems'));
    expect(found).toContain('Exportar…');
  });

  it('lo más específico gana: "guardar" antes que "guardar como"', () => {
    const found = titles(searchCommands(COMMANDS, 'guardar proyecto'));
    expect(found[0]).toBe('Guardar proyecto');
  });

  it('sin consulta, los últimos usados salen primero', () => {
    const found = titles(searchCommands(COMMANDS, '', { recent: ['ver.mixer', 'archivo.guardar'] }));
    expect(found.slice(0, 2)).toEqual(['Abrir el Mixer', 'Guardar proyecto']);
  });

  it('la recencia solo desempata: no adelanta a quien casa mejor', () => {
    // "mixer" no casa mejor con "pia" que el Piano Roll por mucho que se use.
    const found = titles(searchCommands(COMMANDS, 'pia', { recent: ['ver.mixer'] }));
    expect(found[0]).toBe('Abrir el Piano Roll');
  });

  it('respeta el tope de resultados', () => {
    expect(searchCommands(COMMANDS, '', { limit: 2 })).toHaveLength(2);
  });

  it('lo que no casa se queda fuera', () => {
    expect(searchCommands(COMMANDS, 'zzzz')).toEqual([]);
  });
});
