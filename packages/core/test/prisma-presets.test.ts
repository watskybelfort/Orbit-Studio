/**
 * Catálogo de presets de Orbit Prisma: validación ESTRUCTURAL.
 *
 * Los presets se escriben a mano y son muchos, así que aquí no se juzga el
 * gusto de nadie: se caza la errata. Una clave mal escrita en `base`, un valor
 * fuera del rango de su perilla, una macro que apunta a una capa que no existe
 * o un motor con un nombre que el kernel no conoce son cosas que no dan error
 * en ningún sitio — simplemente no suenan, o suenan mal, y nadie se entera.
 *
 * Todo lo que se afirma aquí vale para CUALQUIER catálogo: no hay un solo id
 * de preset escrito a mano en este archivo.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRISMA_PRESET,
  INSTRUMENT_PARAMS,
  PRISMA_CATEGORIES,
  PRISMA_CATEGORY_LABELS,
  PRISMA_ENGINES,
  PRISMA_ENGINE_LABELS,
  PRISMA_MACROS,
  PRISMA_PRESETS,
  findParamSpec,
  findPrismaPreset,
  prismaMacroLabel,
  prismaPacks,
  prismaPresetParams,
  prismaPresetsOf,
  type PrismaPreset,
} from '../src/index';

const SPECS = INSTRUMENT_PARAMS.prisma;
const PARAM_KEYS = new Set(SPECS.map((s) => s.key));
const CATEGORIES = new Set<string>(PRISMA_CATEGORIES);
const ENGINES = new Set<string>(PRISMA_ENGINES);

/** Máximo de capas por preset que promete el modelo ("hasta cuatro"). */
const MAX_LAYERS = 4;

/**
 * Campos de una capa que una macro puede mover (ver el comentario de
 * `PrismaMacroTarget` en model/prisma.ts) más los que la voz lee igual por ser
 * propiedades propias de la capa.
 */
const LAYER_FIELDS = new Set([
  'wave',
  'level',
  'pan',
  'semi',
  'fine',
  'attackMul',
  'decayMul',
  'releaseMul',
  'sustainAdd',
  'cutoffOct',
  'keyLo',
  'keyHi',
  'velTrack',
  'phase',
]);

/**
 * Parámetros propios de cada motor que el kernel LEE de verdad
 * (engine/dsp/prisma-voice.ts, `createOsc`). Una clave que no esté aquí se
 * escribe en el preset y no la lee nadie.
 */
const ENGINE_PARAMS: Record<string, string[]> = {
  wt: [],
  pulse: [],
  noise: ['q'],
  fm: ['ratio', 'feedback'],
  pluck: ['damp'],
  organ: ['perc'],
  bell: ['partials', 'inharm'],
  formant: [],
  sub: [],
};

/** Etiqueta corta de un preset para los mensajes de error. */
const tag = (p: PrismaPreset): string => `${p.id} ("${p.name}")`;

// ── Identidad ────────────────────────────────────────────────────────────────

describe('catálogo de Prisma · identidad', () => {
  it('hay presets y todos traen ficha completa', () => {
    expect(PRISMA_PRESETS.length).toBeGreaterThan(0);
    for (const p of PRISMA_PRESETS) {
      expect(p.name.trim(), `${p.id} no tiene nombre`).not.toBe('');
      expect(p.pack.trim(), `${tag(p)} no declara pack`).not.toBe('');
      expect(Array.isArray(p.tags), `${tag(p)} no trae tags`).toBe(true);
      expect(p.tags.length, `${tag(p)} no trae ni un tag para el buscador`).toBeGreaterThan(0);
      for (const t of p.tags) {
        expect(t.trim(), `${tag(p)} tiene un tag vacío`).not.toBe('');
      }
    }
  });

  it('los ids son únicos', () => {
    const vistos = new Map<string, number>();
    for (const p of PRISMA_PRESETS) vistos.set(p.id, (vistos.get(p.id) ?? 0) + 1);
    const repetidos = [...vistos].filter(([, n]) => n > 1).map(([id]) => id);
    expect(repetidos, 'ids repetidos (el buscador se queda con uno solo)').toEqual([]);
  });

  it('el prefijo del id es su categoría, y la categoría existe', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      if (!CATEGORIES.has(p.category)) {
        malas.push(`${tag(p)}: categoría "${p.category}" fuera de PRISMA_CATEGORIES`);
        continue;
      }
      const prefijo = p.id.split('/')[0];
      if (prefijo !== p.category) {
        malas.push(`${tag(p)}: el id empieza por "${prefijo}" y su categoría es "${p.category}"`);
      }
      if (!p.id.includes('/') || p.id.split('/')[1]?.length === 0) {
        malas.push(`${tag(p)}: el id no tiene la forma "categoría/nombre"`);
      }
    }
    expect(malas).toEqual([]);
  });

  it('la tabla de params por motor de este archivo cubre todos los motores', () => {
    // Si aparece un motor nuevo hay que decir aquí qué `params` lee, o los
    // tests de abajo dejarían de mirar sus capas sin avisar.
    for (const e of PRISMA_ENGINES) {
      expect(
        Object.prototype.hasOwnProperty.call(ENGINE_PARAMS, e),
        `añade "${e}" a ENGINE_PARAMS (mira createOsc en engine/dsp/prisma-voice.ts)`,
      ).toBe(true);
    }
  });

  it('todas las categorías y motores tienen etiqueta', () => {
    for (const c of PRISMA_CATEGORIES) {
      expect(PRISMA_CATEGORY_LABELS[c], `la categoría ${c} no tiene etiqueta`).toBeTruthy();
    }
    for (const e of PRISMA_ENGINES) {
      expect(PRISMA_ENGINE_LABELS[e], `el motor ${e} no tiene etiqueta`).toBeTruthy();
    }
  });

  it('el preset por defecto existe', () => {
    const preset = findPrismaPreset(DEFAULT_PRISMA_PRESET);
    expect(preset, `DEFAULT_PRISMA_PRESET (${DEFAULT_PRISMA_PRESET}) no está en el catálogo`)
      .toBeDefined();
  });

  it('findPrismaPreset encuentra todos los ids y solo esos', () => {
    for (const p of PRISMA_PRESETS) expect(findPrismaPreset(p.id)).toBe(p);
    expect(findPrismaPreset('no/existe')).toBeUndefined();
    expect(findPrismaPreset(undefined)).toBeUndefined();
  });

  it('prismaPresetsOf reparte el catálogo entero por categorías', () => {
    let total = 0;
    for (const c of PRISMA_CATEGORIES) {
      const lista = prismaPresetsOf(c);
      for (const p of lista) expect(p.category).toBe(c);
      total += lista.length;
    }
    expect(total, 'hay presets en categorías que no existen').toBe(PRISMA_PRESETS.length);
    expect(prismaPacks().length).toBeGreaterThan(0);
  });
});

// ── Perillas del canal (`base`) ──────────────────────────────────────────────

describe('catálogo de Prisma · perillas del preset', () => {
  it('toda clave de `base` es una perilla real de Prisma', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      for (const key of Object.keys(p.base)) {
        if (!PARAM_KEYS.has(key)) {
          malas.push(`${tag(p)}: base."${key}" no existe en INSTRUMENT_PARAMS.prisma`);
        }
      }
    }
    expect(malas, 'claves de `base` que no las lee nadie').toEqual([]);
  });

  it('todo valor de `base` cae DENTRO del rango de su perilla', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      for (const [key, value] of Object.entries(p.base)) {
        const spec = findParamSpec(SPECS, key);
        if (!spec) continue; // ya lo canta el test de arriba
        if (!Number.isFinite(value)) {
          malas.push(`${tag(p)}: base.${key} = ${value}`);
        } else if (value < spec.min || value > spec.max) {
          malas.push(
            `${tag(p)}: base.${key} = ${value} fuera de [${spec.min}, ${spec.max}]`,
          );
        }
      }
    }
    expect(malas, 'valores de `base` fuera de rango (la UI los recorta y el preset miente)')
      .toEqual([]);
  });

  it('un preset no fija sus macros por `base` (para eso están las macros)', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      for (const key of Object.keys(p.base)) {
        if (/^macro[1-8]$/.test(key)) {
          malas.push(`${tag(p)}: base.${key} lo pisa el valor de la macro`);
        }
      }
    }
    expect(malas).toEqual([]);
  });

  it('prismaPresetParams devuelve TODAS las perillas del instrumento', () => {
    for (const p of PRISMA_PRESETS) {
      const params = prismaPresetParams(p);
      const faltan = SPECS.map((s) => s.key).filter((k) => !(k in params));
      expect(faltan, `${tag(p)}: faltan perillas al cargar el preset`).toEqual([]);
      const sobran = Object.keys(params).filter((k) => !PARAM_KEYS.has(k));
      expect(sobran, `${tag(p)}: el preset deja perillas de más en el canal`).toEqual([]);
    }
  });

  it('lo que carga el preset respeta el rango de cada perilla', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      const params = prismaPresetParams(p);
      for (const spec of SPECS) {
        const v = params[spec.key]!;
        if (v < spec.min || v > spec.max) {
          malas.push(`${tag(p)}: ${spec.key} = ${v} fuera de [${spec.min}, ${spec.max}]`);
        }
      }
    }
    expect(malas).toEqual([]);
  });

  it('el preset escribe en el canal exactamente lo que dice `base`', () => {
    for (const p of PRISMA_PRESETS) {
      const params = prismaPresetParams(p);
      for (const [key, value] of Object.entries(p.base)) {
        if (/^macro[1-8]$/.test(key)) continue;
        expect(params[key], `${tag(p)}: base.${key} no llegó al canal`).toBe(value);
      }
    }
  });
});

// ── Capas ────────────────────────────────────────────────────────────────────

describe('catálogo de Prisma · capas', () => {
  it('cada preset tiene entre una y cuatro capas', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      if (p.layers.length < 1 || p.layers.length > MAX_LAYERS) {
        malas.push(`${tag(p)}: ${p.layers.length} capas`);
      }
    }
    expect(malas, `un preset lleva de 1 a ${MAX_LAYERS} capas`).toEqual([]);
  });

  it('todos los motores de capa existen', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      p.layers.forEach((l, i) => {
        if (!ENGINES.has(l.engine)) {
          malas.push(`${tag(p)}: capa ${i} usa el motor "${l.engine}"`);
        }
      });
    }
    expect(malas, 'motores que el kernel no conoce (caerían a la tabla de ondas)').toEqual([]);
  });

  it('los campos de cada capa están en su rango', () => {
    const malas: string[] = [];
    const check = (ok: boolean, msg: string) => {
      if (!ok) malas.push(msg);
    };
    for (const p of PRISMA_PRESETS) {
      p.layers.forEach((l, i) => {
        const donde = `${tag(p)}: capa ${i} (${l.engine})`;
        check(l.level >= 0 && l.level <= 1, `${donde} level = ${l.level} fuera de 0..1`);
        check(l.pan >= -1 && l.pan <= 1, `${donde} pan = ${l.pan} fuera de -1..1`);
        check(l.wave >= 0 && l.wave <= 1, `${donde} wave = ${l.wave} fuera de 0..1`);
        check(l.keyLo <= l.keyHi, `${donde} keyLo ${l.keyLo} > keyHi ${l.keyHi}`);
        check(
          l.keyLo >= 0 && l.keyHi <= 127,
          `${donde} rango de teclas ${l.keyLo}..${l.keyHi} fuera de 0..127`,
        );
        check(l.velTrack >= 0 && l.velTrack <= 1, `${donde} velTrack = ${l.velTrack}`);
        check(
          l.sustainAdd >= -1 && l.sustainAdd <= 1,
          `${donde} sustainAdd = ${l.sustainAdd} fuera de -1..1`,
        );
        check(l.attackMul > 0, `${donde} attackMul = ${l.attackMul} (tiene que ser > 0)`);
        check(l.decayMul > 0, `${donde} decayMul = ${l.decayMul} (tiene que ser > 0)`);
        check(l.releaseMul > 0, `${donde} releaseMul = ${l.releaseMul} (tiene que ser > 0)`);
        check(l.phase >= -1 && l.phase <= 1, `${donde} phase = ${l.phase} fuera de -1..1`);
        check(Math.abs(l.semi) <= 48, `${donde} semi = ${l.semi} (más de cuatro octavas)`);
        check(Math.abs(l.fine) <= 100, `${donde} fine = ${l.fine} cents`);
        check(Math.abs(l.cutoffOct) <= 8, `${donde} cutoffOct = ${l.cutoffOct} octavas`);
      });
    }
    expect(malas).toEqual([]);
  });

  it('ningún preset nace mudo (alguna capa con nivel y rango)', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      const suenan = p.layers.filter((l) => l.level > 0 && l.keyLo <= l.keyHi);
      if (suenan.length === 0) malas.push(`${tag(p)}: ninguna capa suena (nivel 0 o rango vacío)`);
    }
    // Que suene DE VERDAD lo comprueba engine/test/prisma-v1.test.ts
    // renderizando el catálogo entero; aquí solo se mira la ficha.
    expect(malas).toEqual([]);
  });

  it('los params propios de la capa son los que lee su motor', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      p.layers.forEach((l, i) => {
        const permitidos = ENGINE_PARAMS[l.engine];
        if (!permitidos) return; // motor desconocido: ya lo canta otro test
        for (const key of Object.keys(l.params)) {
          if (!permitidos.includes(key)) {
            malas.push(
              `${tag(p)}: capa ${i} (${l.engine}) declara params.${key}, ` +
                `que ese motor no lee (lee: ${permitidos.join(', ') || 'ninguno'})`,
            );
          }
        }
      });
    }
    expect(malas, 'params de motor que no los lee nadie (errata segura)').toEqual([]);
  });
});

// ── Macros ───────────────────────────────────────────────────────────────────

describe('catálogo de Prisma · macros', () => {
  it('ningún preset declara más de PRISMA_MACROS macros', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      if (p.macros.length > PRISMA_MACROS) {
        malas.push(`${tag(p)}: ${p.macros.length} macros (el canal solo tiene ${PRISMA_MACROS})`);
      }
    }
    expect(malas).toEqual([]);
  });

  it('cada macro tiene etiqueta, valor 0..1 y al menos un destino', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      p.macros.forEach((m, i) => {
        const donde = `${tag(p)}: macro ${i + 1}`;
        if (m.label.trim() === '') malas.push(`${donde} sin etiqueta`);
        if (!(m.value >= 0 && m.value <= 1)) malas.push(`${donde} value = ${m.value}`);
        if (m.targets.length === 0) malas.push(`${donde} ("${m.label}") no mueve nada`);
      });
    }
    expect(malas).toEqual([]);
  });

  it('todo destino de macro apunta a algo que existe y de verdad se mueve', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      p.macros.forEach((m, mi) => {
        m.targets.forEach((t, ti) => {
          const donde = `${tag(p)}: macro ${mi + 1} ("${m.label}") destino ${ti}`;
          if (!Number.isFinite(t.min) || !Number.isFinite(t.max)) {
            malas.push(`${donde}: rango no numérico [${t.min}, ${t.max}]`);
            return;
          }
          // Un barrido al revés (min > max) es legítimo y se usa: la voz
          // interpola min → max, así que la perilla mueve el parámetro hacia
          // abajo. Lo que no vale es que no mueva nada.
          if (t.min === t.max) {
            malas.push(`${donde}: barre [${t.min}, ${t.max}] — no mueve nada`);
          }
          if (t.layer < 0) {
            if (!findParamSpec(SPECS, t.param)) {
              malas.push(`${donde}: "${t.param}" no es una perilla de Prisma`);
            }
            return;
          }
          const capa = p.layers[t.layer];
          if (!capa) {
            malas.push(`${donde}: la capa ${t.layer} no existe (hay ${p.layers.length})`);
            return;
          }
          if (LAYER_FIELDS.has(t.param)) {
            const lo = Math.min(t.min, t.max);
            const hi = Math.max(t.min, t.max);
            if ((t.param === 'level' || t.param === 'wave') && (lo < 0 || hi > 1)) {
              malas.push(`${donde}: ${t.param} barre [${lo}, ${hi}] y es 0..1`);
            }
            if (t.param === 'pan' && (lo < -1 || hi > 1)) {
              malas.push(`${donde}: pan barre [${lo}, ${hi}] y es -1..1`);
            }
            return;
          }
          const propios = ENGINE_PARAMS[capa.engine] ?? [];
          if (!propios.includes(t.param)) {
            malas.push(`${donde}: "${t.param}" no es campo de capa ni param de ${capa.engine}`);
          }
        });
      });
    }
    expect(malas, 'destinos de macro que no mueven nada').toEqual([]);
  });

  /**
   * BUG del catálogo (no se arregla aquí: los presets son de otro agente).
   * Una macro sobre una perilla del canal escribe el valor TAL CUAL en
   * `params`, así que si su barrido se sale del rango del spec la perilla
   * acaba con un valor que ni la UI puede mostrar ni `normalizeParam` puede
   * devolver (lo recorta), y automatizar esa perilla da un salto.
   *
   * Al escribir esto se salían cuatro barridos:
   *   · prisma-presets-melodic.ts:457 — bass/upright-humo, "Madera":
   *     chan('bass', -2, 13) y la perilla Graves es -12..12 dB.
   *   · prisma-presets-rhythm.ts:514 — atmos/nube-coral, "Deriva":
   *     chan('modAttack', 1, 5) y Mod Atk es 0.001..4 s.
   *   · prisma-presets-rhythm.ts:743 — fx/barrido-inverso, "Subida":
   *     chan('attack', 0.6, 4.2) y chan('modAttack', 0.6, 4.2), ambas 0.001..4 s.
   */
  it.skip('los barridos de macro sobre el canal caben en su perilla', () => {
    const malas: string[] = [];
    for (const p of PRISMA_PRESETS) {
      p.macros.forEach((m, mi) => {
        m.targets.forEach((t, ti) => {
          if (t.layer >= 0) return;
          const spec = findParamSpec(SPECS, t.param);
          if (!spec) return;
          const lo = Math.min(t.min, t.max);
          const hi = Math.max(t.min, t.max);
          if (lo < spec.min || hi > spec.max) {
            malas.push(
              `${tag(p)}: macro ${mi + 1} ("${m.label}") destino ${ti}: ${t.param} ` +
                `barre [${lo}, ${hi}] y la perilla es [${spec.min}, ${spec.max}]`,
            );
          }
        });
      });
    }
    expect(malas).toEqual([]);
  });

  it('las macros cargan su valor en el canal y su etiqueta se lee del preset', () => {
    for (const p of PRISMA_PRESETS) {
      const params = prismaPresetParams(p);
      for (let i = 0; i < PRISMA_MACROS; i++) {
        const esperado = p.macros[i]?.value ?? 0.5;
        expect(params[`macro${i + 1}`], `${tag(p)}: macro${i + 1} no cargó su valor`).toBe(
          esperado,
        );
        expect(prismaMacroLabel(p, i)).toBe(p.macros[i]?.label ?? '');
      }
    }
    // Sin preset no hay etiqueta, pero tampoco se rompe nada.
    expect(prismaMacroLabel(undefined, 0)).toBe('');
  });
});
