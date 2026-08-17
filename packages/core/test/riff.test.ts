import { describe, expect, it } from 'vitest';
import { SCALES, type Note } from '../src/index';
import { riff, type RiffOptions } from '../src/note-tools';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE: RiffOptions = {
  seed: 1234,
  root: 5, // F
  scale: SCALES['Menor natural']!,
  bars: 2,
  beatsPerBar: 4,
  density: 4,
  octaveLow: 4,
  octaves: 2,
  character: 'sostenido',
};

const make = (over: Partial<RiffOptions> = {}): Note[] => riff({ ...BASE, ...over });

/** Los ids son nuevos en cada llamada: la identidad musical es el resto. */
const musical = (notes: Note[]) => notes.map(({ id: _id, ...rest }) => rest);

const keys = (notes: Note[]) => notes.map((n) => n.key);
const starts = (notes: Note[]) => notes.map((n) => n.start);

/** ¿La altura pertenece a la escala (root en semitonos 0..11)? */
function isInScale(key: number, root: number, scale: readonly number[]): boolean {
  return scale.map((s) => ((s % 12) + 12) % 12).includes((((key - root) % 12) + 12) % 12);
}

// ── Determinismo ─────────────────────────────────────────────────────────────

describe('riff · determinismo', () => {
  it('misma semilla → exactamente las mismas notas', () => {
    expect(musical(make())).toEqual(musical(make()));
    // También con otro carácter y otra densidad: la semilla manda siempre.
    const opts = { character: 'sincopado', density: 6, bars: 3 } as Partial<RiffOptions>;
    expect(musical(make(opts))).toEqual(musical(make(opts)));
  });

  it('semilla distinta → riff distinto (mismas opciones)', () => {
    expect(musical(make({ seed: 1234 }))).not.toEqual(musical(make({ seed: 1235 })));
  });

  it('los ids son siempre nuevos y únicos', () => {
    const a = make();
    const b = make();
    expect(new Set(a.map((n) => n.id)).size).toBe(a.length);
    for (const n of a) expect(b.map((m) => m.id)).not.toContain(n.id);
  });
});

// ── Escala y tónica ──────────────────────────────────────────────────────────

describe('riff · escala', () => {
  it('todas las notas caen en la escala pedida', () => {
    for (const [name, scale] of Object.entries(SCALES)) {
      for (const root of [0, 5, 8, 11]) {
        const out = riff({ ...BASE, scale, root, seed: root * 31 + name.length, density: 6 });
        expect(out.length).toBeGreaterThan(0);
        for (const n of out) {
          expect(
            isInScale(n.key, root, scale),
            `${name} en root ${root}: ${n.key} fuera de escala`,
          ).toBe(true);
        }
      }
    }
  });

  it('la pentatónica menor solo usa sus cinco grados', () => {
    const scale = SCALES['Pent. menor']!;
    const out = riff({ ...BASE, scale, root: 2, density: 8, bars: 4, seed: 77 });
    const grados = new Set(out.map((n) => (((n.key - 2) % 12) + 12) % 12));
    for (const g of grados) expect(scale).toContain(g);
  });

  it('la primera nota es la tónica (pie del motivo)', () => {
    const out = make({ root: 5, octaveLow: 4, octaves: 2 });
    expect(out[0]!.key % 12).toBe(5);
  });
});

// ── Longitud y rango ─────────────────────────────────────────────────────────

describe('riff · longitud y rango', () => {
  it('respeta la longitud en compases (nada rebasa el final)', () => {
    for (const bars of [1, 2, 4, 8]) {
      const out = make({ bars, density: 3 });
      const end = bars * 4;
      for (const n of out) {
        expect(n.start).toBeGreaterThanOrEqual(0);
        expect(n.start + n.duration).toBeLessThanOrEqual(end + 1e-9);
      }
      // Y llena el último compás: hay notas después del penúltimo.
      expect(Math.max(...starts(out))).toBeGreaterThanOrEqual(end - 4);
    }
  });

  it('el offset `start` desplaza el riff entero', () => {
    const out = make({ start: 8, bars: 2 });
    for (const n of out) {
      expect(n.start).toBeGreaterThanOrEqual(8);
      expect(n.start + n.duration).toBeLessThanOrEqual(16 + 1e-9);
    }
    // Mismo motivo desplazado: las alturas no cambian con el offset.
    expect(keys(out)).toEqual(keys(make({ bars: 2 })));
  });

  it('respeta compases de 3 pulsos', () => {
    const out = make({ beatsPerBar: 3, bars: 2, density: 3 });
    expect(out.length).toBe(6);
    for (const n of out) expect(n.start + n.duration).toBeLessThanOrEqual(6 + 1e-9);
  });

  it('respeta el rango de octavas', () => {
    for (const [octaveLow, octaves] of [[3, 1], [4, 2], [5, 3], [6, 1]] as const) {
      const out = riff({ ...BASE, octaveLow, octaves, density: 8, bars: 4, seed: octaveLow });
      const low = octaveLow * 12;
      const high = low + octaves * 12 - 1;
      for (const n of out) {
        expect(n.key).toBeGreaterThanOrEqual(low);
        expect(n.key).toBeLessThanOrEqual(high);
      }
    }
  });

  it('con una sola octava el riff sigue moviéndose (no una nota repetida)', () => {
    const out = make({ octaveLow: 5, octaves: 1, density: 8, bars: 4 });
    expect(new Set(keys(out)).size).toBeGreaterThan(2);
  });
});

// ── Densidad ─────────────────────────────────────────────────────────────────

describe('riff · densidad', () => {
  it('la densidad marca el número de notas (density × bars)', () => {
    expect(make({ density: 2, bars: 2 }).length).toBe(4);
    expect(make({ density: 4, bars: 2 }).length).toBe(8);
    expect(make({ density: 8, bars: 2 }).length).toBe(16);
    expect(make({ density: 4, bars: 4 }).length).toBe(16);
  });

  it('más densidad = más notas, monótono', () => {
    let prev = 0;
    for (const density of [1, 2, 3, 6, 12]) {
      const n = make({ density, bars: 2 }).length;
      expect(n).toBeGreaterThan(prev);
      prev = n;
    }
  });

  it('densidad fuera de rango se limita (0 → 1 nota por compás, tope 32)', () => {
    expect(make({ density: 0, bars: 2 }).length).toBe(2);
    expect(make({ density: 999, bars: 1 }).length).toBe(32);
  });
});

// ── Carácter rítmico ─────────────────────────────────────────────────────────

describe('riff · carácter', () => {
  it('sostenido: rejilla regular y sin huecos', () => {
    const out = make({ character: 'sostenido', density: 4, bars: 1 });
    expect(starts(out)).toEqual([0, 1, 2, 3]);
    for (const n of out) expect(n.duration).toBeCloseTo(1, 10);
  });

  it('sincopado: ancla el pie del compás y el resto va a contratiempo', () => {
    const out = make({ character: 'sincopado', density: 4, bars: 1 });
    expect(starts(out)).toEqual([0, 1.5, 2.5, 3.5]);
    for (const n of out) expect(n.duration).toBeCloseTo(0.5, 10);
    // Y deja huecos: no llena el compás como los otros caracteres.
    const suma = out.reduce((acc, n) => acc + n.duration, 0);
    expect(suma).toBeLessThan(4);
  });

  it('puntillo: parejas larga-corta 3:1', () => {
    const out = make({ character: 'puntillo', density: 4, bars: 1 });
    expect(starts(out)).toEqual([0, 1.5, 2, 3.5]);
    expect(out.map((n) => n.duration)).toEqual([1.5, 0.5, 1.5, 0.5]);
  });

  it('ningún carácter genera solapes', () => {
    for (const character of ['sostenido', 'sincopado', 'puntillo'] as const) {
      for (const density of [3, 4, 5, 7]) {
        const out = riff({ ...BASE, character, density, bars: 3, seed: density });
        for (let i = 1; i < out.length; i++) {
          const prev = out[i - 1]!;
          expect(prev.start + prev.duration).toBeLessThanOrEqual(out[i]!.start + 1e-9);
        }
        for (const n of out) expect(n.duration).toBeGreaterThan(0);
      }
    }
  });
});

// ── Contrato ─────────────────────────────────────────────────────────────────

describe('riff · contrato', () => {
  it('velocity en 0.05..1, pan 0 y sin slide', () => {
    const out = make({ density: 8, bars: 4, velocity: 1 });
    for (const n of out) {
      expect(n.velocity).toBeGreaterThanOrEqual(0.05);
      expect(n.velocity).toBeLessThanOrEqual(1);
      expect(n.pan).toBe(0);
      expect(n.slide).toBe(false);
    }
  });

  it('sale ordenado por start', () => {
    const out = make({ density: 6, bars: 4 });
    expect(starts(out)).toEqual([...starts(out)].sort((a, b) => a - b));
  });

  it('rechaza opciones imposibles', () => {
    expect(() => make({ bars: 0 })).toThrow(/bars/);
    expect(() => make({ beatsPerBar: 0 })).toThrow(/beatsPerBar/);
    expect(() => make({ scale: [] })).toThrow(/grado/);
  });
});
