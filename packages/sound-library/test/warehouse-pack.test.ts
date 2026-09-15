/**
 * El PLAN del pack "Warehouse", sin renderizarlo.
 *
 * El generador ya se verifica a sí mismo cada vez que corre (picos, ficheros
 * presentes, los dos topes de `pack:save`, que ningún loop arranque en
 * silencio), pero eso solo lo ve quien lo ejecuta — y este pack no se ejecuta
 * en la CI porque escribe 15 MB en la carpeta de packs de la máquina.
 *
 * Aquí están las reglas que puede romper una regresión silenciosa y que se
 * pueden leer de la lista declarada: ids únicos, el archivo que cuadra con su
 * id, un loop sin BPM, un bombo colocado fuera de `drums`. Milisegundos, y no
 * hace falta renderizar nada.
 */

import { describe, expect, it } from 'vitest';
import { SPECS } from '../generate/warehouse';
import { SOUND_CATEGORIES } from '../src/types';

/** Tope de archivos por pack que impone `pack:save` (main de Electron). */
const MAX_ARCHIVOS = 64;

describe('pack Warehouse: el plan', () => {
  it('cabe en un pack de usuario (los WAV + el manifest)', () => {
    expect(SPECS.length + 1).toBeLessThanOrEqual(MAX_ARCHIVOS);
  });

  it('no repite ids', () => {
    const ids = SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('el archivo de cada sonido es su id + .wav', () => {
    // No es cosmético: `pack:save` valida la ruta con su propia expresión
    // (minúsculas, números, guiones y barras) y rechaza el pack entero si una
    // sola no le cuadra.
    const RUTA = /^[a-z0-9][a-z0-9/-]*\.wav$/;
    for (const s of SPECS) {
      expect(s.file).toBe(`${s.id}.wav`);
      expect(s.file).toMatch(RUTA);
    }
  });

  it('todas las categorías son del catálogo del browser', () => {
    for (const s of SPECS) {
      expect(SOUND_CATEGORIES as readonly string[]).toContain(s.category);
    }
  });

  it('los bombos viven en drums y los bajos en 808s', () => {
    for (const s of SPECS) {
      if (s.id.includes('kick')) expect(s.category).toBe('drums');
      if (s.id.includes('bass')) expect(s.category).toBe('808s');
    }
  });

  it('todo loop declara su BPM y se corta en el beat', () => {
    // Un loop sin BPM entra en el browser como un one-shot y no encaja con
    // nada; uno sin corte exacto encaja mal, que es peor porque no se ve.
    for (const s of SPECS) {
      if (!s.id.includes('loop') && s.category !== 'melodic-loops') continue;
      expect(s.bpm, `${s.id} sin bpm`).toBeGreaterThan(0);
      expect(s.build().exactSamples, `${s.id} sin corte exacto`).toBeGreaterThan(0);
    }
  });

  it('los dos tempos del pack son los que se midieron en las referencias', () => {
    const tempos = new Set(SPECS.filter((s) => s.bpm !== undefined).map((s) => s.bpm));
    expect([...tempos].sort()).toEqual([134, 156]);
  });

  it('ningún one-shot se corta en el beat (eso es de los loops)', () => {
    for (const s of SPECS) {
      if (s.bpm !== undefined) continue;
      expect(s.build().exactSamples, `${s.id} se corta como un loop`).toBeUndefined();
    }
  });

  it('cada sonido propone una ganancia razonable', () => {
    for (const s of SPECS) {
      expect(s.gainSuggestion).toBeGreaterThan(0);
      expect(s.gainSuggestion).toBeLessThanOrEqual(1);
    }
  });

  it('el proyecto de cada sonido tiene notas y canales', () => {
    // Un sonido sin eventos sale en silencio y el generador lo caza al
    // renderizar; cazarlo aquí dice CUÁL sin esperar medio minuto.
    for (const s of SPECS) {
      const { project } = s.build();
      expect(project.channels.length, `${s.id} sin canales`).toBeGreaterThan(0);
      expect(project.events.length, `${s.id} sin notas`).toBeGreaterThan(0);
      for (const e of project.events) {
        expect(e.channelIndex, `${s.id}: nota a un canal que no existe`)
          .toBeLessThan(project.channels.length);
      }
    }
  });

  it('la automatización apunta a slots que existen', () => {
    // Una curva a un slot inexistente no da error: no hace nada, y el sonido
    // sale plano sin que nadie sepa por qué.
    for (const s of SPECS) {
      const { project } = s.build();
      for (const a of project.automation) {
        const t = a.target;
        if (t.scope === 'effect') {
          expect(project.mixer[t.trackIndex]?.slots[t.slotIndex], `${s.id}: curva al vacío`)
            .toBeDefined();
        }
        if (t.scope === 'channelMix') {
          expect(project.channels[t.channelIndex], `${s.id}: curva a un canal que no existe`)
            .toBeDefined();
        }
        expect(a.values.length, `${s.id}: curva vacía`).toBeGreaterThan(1);
      }
    }
  });

  it('todos los sonidos llevan tags y ninguno va sin nombre', () => {
    for (const s of SPECS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.tags.length).toBeGreaterThan(0);
    }
  });
});
