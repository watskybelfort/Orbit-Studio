/**
 * Recetas de packs a medida.
 *
 * Lo que se prueba: que el mismo encargo dé SIEMPRE el mismo pack (si no, no
 * se puede rehacer ni comparar), que las variaciones recorran de verdad el
 * carácter de la familia en vez de amontonarse, que los ids y los archivos
 * sean seguros para un disco... y, sobre todo, que cada parámetro que la
 * receta le pasa al motor EXISTA: una clave mal escrita no rompe nada, se
 * queda en el valor por defecto y el pack sale sonando a otra cosa sin que
 * nadie se entere.
 */

import { describe, expect, it } from 'vitest';
import { EFFECT_PARAMS, INSTRUMENT_PARAMS, type EffectKind, type InstrumentKind } from '@orbit/core';
import {
  MAX_PACK_SOUNDS,
  PACK_FAMILIES,
  PACK_STYLES,
  isPackFamily,
  isPackStyle,
  planPack,
  slugifyName,
} from '../src/pack-recipes';

describe('encargo', () => {
  it('por defecto: ocho sonidos de trap con nombre propio', () => {
    const plan = planPack({ family: 'hats' });
    expect(plan.sounds).toHaveLength(8);
    expect(plan.style).toBe('trap');
    expect(plan.name).toBe('Hats de trap');
    expect(plan.slug).toBe('hats-de-trap');
  });

  it('la cantidad se recorta a lo razonable', () => {
    expect(planPack({ family: 'kicks', count: 0 }).sounds).toHaveLength(1);
    expect(planPack({ family: 'kicks', count: 999 }).sounds).toHaveLength(MAX_PACK_SOUNDS);
    expect(planPack({ family: 'kicks', count: 12 }).sounds).toHaveLength(12);
  });

  it('un estilo desconocido cae en trap en vez de romper', () => {
    expect(planPack({ family: 'kicks', style: 'reggaeton' as never }).style).toBe('trap');
  });

  it('una familia desconocida sí es un error (la pide quien llama)', () => {
    expect(() => planPack({ family: 'guitarras' as never })).toThrow(/desconocida/i);
  });

  it('el nombre del encargo manda sobre el automático', () => {
    const plan = planPack({ family: 'hats', style: 'drill', name: 'Hats Oscuros del Doctor' });
    expect(plan.name).toBe('Hats Oscuros del Doctor');
    expect(plan.slug).toBe('hats-oscuros-del-doctor');
  });
});

describe('determinismo', () => {
  it('dos veces el mismo encargo dan exactamente el mismo pack', () => {
    const a = planPack({ family: 'kicks', style: 'drill', count: 6 });
    const b = planPack({ family: 'kicks', style: 'drill', count: 6 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('la semilla cambia los sonidos sin cambiar el pack', () => {
    const a = planPack({ family: 'kicks', style: 'drill', count: 6 });
    const b = planPack({ family: 'kicks', style: 'drill', count: 6, seed: 7 });
    expect(b.sounds.map((s) => s.id)).toEqual(a.sounds.map((s) => s.id));
    expect(JSON.stringify(b.sounds)).not.toBe(JSON.stringify(a.sounds));
  });
});

describe('los sonidos', () => {
  it('ids y archivos únicos y seguros para el disco', () => {
    for (const family of PACK_FAMILIES) {
      const plan = planPack({ family, count: 5 });
      const ids = new Set(plan.sounds.map((s) => s.id));
      const files = new Set(plan.sounds.map((s) => s.file));
      expect(ids.size).toBe(plan.sounds.length);
      expect(files.size).toBe(plan.sounds.length);
      for (const sound of plan.sounds) {
        expect(sound.file).toMatch(/^[a-z0-9][a-z0-9/-]*\.wav$/);
        expect(sound.file).not.toContain('..');
        expect(sound.name.trim()).not.toBe('');
      }
    }
  });

  it('cada uno trae un proyecto que suena: un canal y su nota', () => {
    for (const family of PACK_FAMILIES) {
      for (const sound of planPack({ family, count: 3 }).sounds) {
        expect(sound.project.channels).toHaveLength(1);
        expect(sound.project.events.length).toBeGreaterThan(0);
        expect(sound.project.lengthBeats).toBeGreaterThan(0);
        expect(sound.maxSec).toBeGreaterThan(0);
        expect(sound.project.events.every((e) => e.channelIndex === 0)).toBe(true);
      }
    }
  });

  it('las variaciones no son doce veces el mismo golpe', () => {
    const plan = planPack({ family: 'hats', count: 12 });
    const params = plan.sounds.map((s) => JSON.stringify(s.project.channels[0]!.params));
    expect(new Set(params).size).toBe(12);
    // Y el recorrido llega a los dos extremos del carácter de la familia.
    const tones = plan.sounds.map((s) => s.project.channels[0]!.params['tone'] ?? 0);
    expect(Math.max(...tones) - Math.min(...tones)).toBeGreaterThan(0.5);
  });

  it('el estilo elige el kit y ensucia el master cuando toca', () => {
    const trap = planPack({ family: 'kicks', style: 'trap', count: 2 });
    const boombap = planPack({ family: 'kicks', style: 'boombap', count: 2 });
    const lofi = planPack({ family: 'kicks', style: 'lofi', count: 2 });
    expect(trap.sounds[0]!.project.channels[0]!.params['kit']).toBe(0);
    expect(boombap.sounds[0]!.project.channels[0]!.params['kit']).toBe(1);
    expect(trap.sounds[0]!.project.mixer[0]!.slots).toHaveLength(0);
    // lo-fi va con distorsión, vinilo y bitcrush encima
    expect(lofi.sounds[0]!.project.mixer[0]!.slots.length).toBeGreaterThanOrEqual(3);
  });

  it('los 808 salen en la nota que se pida', () => {
    const c = planPack({ family: '808s', count: 2 });
    const f = planPack({ family: '808s', count: 2, key: 'F' });
    expect(c.sounds[0]!.keyRoot).toBe('C');
    expect(c.sounds[0]!.project.events[0]!.key).toBe(24);
    expect(f.sounds[0]!.keyRoot).toBe('F');
    expect(f.sounds[0]!.project.events[0]!.key).toBe(29);
  });

  it('una nota rara cae en C en vez de desafinar el pack entero', () => {
    const plan = planPack({ family: '808s', count: 1, key: 'H' });
    expect(plan.sounds[0]!.keyRoot).toBe('C');
  });

  it('los risers suben y los downlifters bajan', () => {
    const up = planPack({ family: 'risers', count: 2 }).sounds[0]!;
    const down = planPack({ family: 'downlifters', count: 2 }).sounds[0]!;
    const curva = (s: typeof up) => s.project.automation[0]!.values;
    expect(curva(up)[curva(up).length - 1]!).toBeGreaterThan(curva(up)[0]!);
    expect(curva(down)[curva(down).length - 1]!).toBeLessThan(curva(down)[0]!);
  });

  it('las categorías del manifest son las del browser', () => {
    expect(planPack({ family: 'kicks', count: 1 }).sounds[0]!.category).toBe('drums');
    expect(planPack({ family: '808s', count: 1 }).sounds[0]!.category).toBe('808s');
    expect(planPack({ family: 'risers', count: 1 }).sounds[0]!.category).toBe('fx');
    expect(planPack({ family: 'percs', count: 1 }).sounds[0]!.category).toBe('percusion-latina');
  });
});

describe('los parámetros existen de verdad en el motor', () => {
  it('ni un instrumento ni un efecto reciben claves inventadas', () => {
    for (const family of PACK_FAMILIES) {
      for (const style of PACK_STYLES) {
        for (const sound of planPack({ family, style, count: 2 }).sounds) {
          for (const channel of sound.project.channels) {
            const spec = INSTRUMENT_PARAMS[channel.kind as InstrumentKind];
            expect(spec, `instrumento ${channel.kind}`).toBeDefined();
            const keys = new Set(spec.map((p) => p.key));
            for (const key of Object.keys(channel.params)) {
              expect(keys.has(key), `${channel.kind}.${key}`).toBe(true);
            }
          }
          for (const slot of sound.project.mixer[0]!.slots) {
            if (!slot) continue;
            const spec = EFFECT_PARAMS[slot.kind as EffectKind];
            expect(spec, `efecto ${slot.kind}`).toBeDefined();
            const keys = new Set(spec.map((p) => p.key));
            for (const key of Object.keys(slot.params)) {
              expect(keys.has(key), `${slot.kind}.${key}`).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('slugifyName', () => {
  it('quita acentos, espacios y lo que no valga en una carpeta', () => {
    expect(slugifyName('Percusión Latina ¡ya!')).toBe('percusion-latina-ya');
    expect(slugifyName('  ')).toBe('pack');
    expect(slugifyName('../../etc/passwd')).toBe('etc-passwd');
  });
});

describe('guardas de tipo', () => {
  it('reconocen lo que hay y rechazan lo que no', () => {
    expect(isPackFamily('hats')).toBe(true);
    expect(isPackFamily('guitarras')).toBe(false);
    expect(isPackStyle('drill')).toBe(true);
    expect(isPackStyle('cumbia')).toBe(false);
  });
});

describe('loops', () => {
  it('traen BPM, tonalidad y compáses exactos', () => {
    for (const family of ['melodic-loops', 'drum-loops', 'bass-loops'] as const) {
      for (const sound of planPack({ family, style: 'drill', count: 3 }).sounds) {
        expect(sound.bpm).toBe(142);
        expect(sound.project.tempo).toBe(142);
        expect(sound.exactBeats).toBeGreaterThan(0);
        // El timeline dura justo lo que se va a guardar.
        expect(sound.project.lengthBeats).toBe(sound.exactBeats);
        if (family !== 'drum-loops') expect(sound.keyRoot).toBe('C');
      }
    }
  });

  it('el loop melódico toca la progresión del estilo en la tonalidad pedida', () => {
    const loop = planPack({ family: 'melodic-loops', style: 'trap', count: 1, key: 'F' }).sounds[0]!;
    // Cuatro compáses, y el primero arranca en la tónica (F3 = 53).
    const primerCompas = loop.project.events.filter((e) => e.start < 4).map((e) => e.key);
    expect(primerCompas).toContain(53);
    const compases = new Set(loop.project.events.map((e) => Math.floor(e.start / 4)));
    expect([...compases].sort()).toEqual([0, 1, 2, 3]);
    // Y no se sale de la escala menor de F.
    for (const e of loop.project.events) {
      expect([0, 2, 3, 5, 7, 8, 10]).toContain((((e.key - 53) % 12) + 12) % 12);
    }
  });

  it('dos loops melódicos seguidos no llevan el mismo ritmo', () => {
    const plan = planPack({ family: 'melodic-loops', style: 'boombap', count: 3 });
    const ritmos = plan.sounds.map((s) => s.project.events.length);
    expect(new Set(ritmos).size).toBeGreaterThan(1);
  });

  it('el break lleva bombo, caja y hats, y ninguna nota se sale del compás', () => {
    for (const sound of planPack({ family: 'drum-loops', style: 'house', count: 4 }).sounds) {
      const keys = new Set(sound.project.events.map((e) => e.key));
      expect(keys.has(36)).toBe(true); // kick
      expect(keys.has(39) || keys.has(38)).toBe(true); // clap o caja
      expect(keys.has(42)).toBe(true); // hat
      for (const e of sound.project.events) {
        expect(e.start).toBeGreaterThanOrEqual(0);
        expect(e.start).toBeLessThan(sound.exactBeats!);
      }
    }
  });

  it('la línea de 808 sigue la progresión y usa slide cuando lleva glide', () => {
    const plan = planPack({ family: 'bass-loops', style: 'trap', count: 2, key: 'G' });
    const sinGlide = plan.sounds[0]!;
    const conGlide = plan.sounds[1]!;
    expect(sinGlide.project.events.some((e) => e.slide)).toBe(false);
    expect(conGlide.project.events.some((e) => e.slide)).toBe(true);
    // La primera nota es la tónica en la octava del 808 (G1 = 31).
    expect(sinGlide.project.events[0]!.key).toBe(31);
  });

  it('un one-shot NO pide corte exacto (se recorta por donde deja de oírse)', () => {
    const hat = planPack({ family: 'hats', count: 1 }).sounds[0]!;
    expect(hat.exactBeats).toBeUndefined();
    expect(hat.bpm).toBeUndefined();
  });
});
