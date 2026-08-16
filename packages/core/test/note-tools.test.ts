import { describe, expect, it } from 'vitest';
import { newId, type Note } from '../src/index';
import { arpeggiate, chop, humanize, strum } from '../src/note-tools';

// ── Helpers de construcción ──────────────────────────────────────────────────

function makeNote(
  start: number,
  duration: number,
  key: number,
  velocity = 0.8,
  extra: Partial<Pick<Note, 'id' | 'pan' | 'slide'>> = {},
): Note {
  return { id: newId(), start, duration, key, velocity, pan: 0, slide: false, ...extra };
}

/** Congela el array y cada nota para detectar cualquier mutación. */
function deepFreeze(notes: Note[]): readonly Note[] {
  for (const n of notes) Object.freeze(n);
  return Object.freeze(notes);
}

const ids = (notes: Note[]) => notes.map((n) => n.id);
const keys = (notes: Note[]) => notes.map((n) => n.key);
const starts = (notes: Note[]) => notes.map((n) => n.start);
const durations = (notes: Note[]) => notes.map((n) => n.duration);

// ── arpeggiate ───────────────────────────────────────────────────────────────

describe('arpeggiate', () => {
  it('up: recorre el acorde en orden ascendente rellenando su ventana', () => {
    const chord = [
      makeNote(0, 2, 64, 0.6),
      makeNote(0, 2, 60, 0.3),
      makeNote(0, 2, 67, 0.9),
    ];
    const out = arpeggiate(chord, { rate: 0.5, mode: 'up' });

    expect(starts(out)).toEqual([0, 0.5, 1, 1.5]);
    expect(keys(out)).toEqual([60, 64, 67, 60]); // el ciclo vuelve a empezar
    expect(durations(out)).toEqual([0.5, 0.5, 0.5, 0.5]);
    // Cada nota hereda la velocity de la nota del grupo cuya altura usa.
    expect(out.map((n) => n.velocity)).toEqual([0.3, 0.6, 0.9, 0.3]);
    // Todas las notas generadas son nuevas.
    for (const id of ids(out)) expect(ids(chord)).not.toContain(id);
  });

  it('down: orden descendente', () => {
    const chord = [makeNote(0, 2, 60), makeNote(0, 2, 64), makeNote(0, 2, 67)];
    const out = arpeggiate(chord, { rate: 1, mode: 'down' });
    expect(keys(out)).toEqual([67, 64]);
    expect(starts(out)).toEqual([0, 1]);
  });

  it('updown con octaves: sube y baja sin repetir extremos, +12 por octava', () => {
    const chord = [makeNote(0, 3, 60, 0.3), makeNote(0, 3, 64, 0.6)];
    const out = arpeggiate(chord, { rate: 0.5, mode: 'updown', octaves: 2 });

    // Pool [60,64,72,76] → ciclo updown [60,64,72,76,72,64], justo 6 pasos.
    expect(keys(out)).toEqual([60, 64, 72, 76, 72, 64]);
    expect(starts(out)).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);
    // Las copias de octava heredan la velocity de su nota de origen.
    expect(out.map((n) => n.velocity)).toEqual([0.3, 0.6, 0.3, 0.6, 0.3, 0.6]);
  });

  it('recorta la última nota al final exacto de la ventana', () => {
    const out = arpeggiate([makeNote(0, 1.25, 60)], { rate: 0.5, mode: 'up' });
    expect(starts(out)).toEqual([0, 0.5, 1]);
    expect(durations(out)).toEqual([0.5, 0.5, 0.25]); // fin en 1.25, sin rebasar
  });

  it('agrupa por solape (transitivo) y trata cada grupo por separado', () => {
    const notes = [
      makeNote(0, 2, 60), // solapa con la siguiente…
      makeNote(1, 2, 64), // …ventana conjunta 0..3
      makeNote(4, 1, 50), // nota suelta = grupo de una altura
    ];
    const out = arpeggiate(notes, { rate: 1, mode: 'up' });
    expect(starts(out)).toEqual([0, 1, 2, 4]);
    expect(keys(out)).toEqual([60, 64, 60, 50]);
  });
});

// ── strum ────────────────────────────────────────────────────────────────────

describe('strum', () => {
  it('up: escalona desde la grave, abanico = spread y end fijo', () => {
    const chord = [
      makeNote(2, 2, 67),
      makeNote(2, 2, 60),
      makeNote(2, 2, 64),
    ];
    const solo = makeNote(0, 1, 40); // start distinto → intacta
    const out = strum([...chord, solo], { spread: 0.5, direction: 'up' });

    expect(out[0]).toEqual(solo);
    const byKey = new Map(out.map((n) => [n.key, n]));
    expect(byKey.get(60)!.start).toBe(2);
    expect(byKey.get(64)!.start).toBe(2.25);
    expect(byKey.get(67)!.start).toBe(2.5);
    // El final no cambia: start + duration === 4 en las tres.
    for (const k of [60, 64, 67]) {
      const n = byKey.get(k)!;
      expect(n.start + n.duration).toBe(4);
    }
    // Conserva ids.
    expect(new Set(ids(out))).toEqual(new Set([...ids(chord), solo.id]));
  });

  it('down: la aguda queda en su sitio y la grave cierra el abanico', () => {
    const chord = [makeNote(0, 4, 60), makeNote(0, 4, 64), makeNote(0, 4, 67)];
    const out = strum(chord, { spread: 1, direction: 'down' });
    const byKey = new Map(out.map((n) => [n.key, n]));
    expect(byKey.get(67)!.start).toBe(0);
    expect(byKey.get(64)!.start).toBe(0.5);
    expect(byKey.get(60)!.start).toBe(1);
    expect(byKey.get(60)!.duration).toBe(3);
  });
});

// ── humanize ─────────────────────────────────────────────────────────────────

describe('humanize', () => {
  const base = () =>
    Array.from({ length: 8 }, (_, i) => makeNote(i * 0.5, 1, 60 + i, 0.5, { id: `n${i}` }));

  it('misma seed → resultado idéntico; seed distinta → distinto', () => {
    const a = humanize(base(), { timing: 0.05, velocity: 0.2, seed: 42 });
    const b = humanize(base(), { timing: 0.05, velocity: 0.2, seed: 42 });
    expect(a).toEqual(b);

    const c = humanize(base(), { timing: 0.05, velocity: 0.2, seed: 43 });
    expect(a).not.toEqual(c);
  });

  it('clamps: start ≥ 0 y velocity en 0.05..1', () => {
    const out = humanize(base(), { timing: 10, velocity: 2, seed: 7 });
    for (const n of out) {
      expect(n.start).toBeGreaterThanOrEqual(0);
      expect(n.velocity).toBeGreaterThanOrEqual(0.05);
      expect(n.velocity).toBeLessThanOrEqual(1);
    }
    // Con rangos tan grandes los dos topes se alcanzan (determinista por seed).
    expect(out.some((n) => n.velocity === 0.05)).toBe(true);
    expect(out.some((n) => n.velocity === 1)).toBe(true);
  });

  it('conserva ids y duraciones', () => {
    const input = base();
    const out = humanize(input, { timing: 0.1, velocity: 0.1, seed: 1 });
    expect(new Set(ids(out))).toEqual(new Set(ids(input)));
    for (const n of out) {
      const orig = input.find((m) => m.id === n.id)!;
      expect(n.duration).toBe(orig.duration);
      expect(n.key).toBe(orig.key);
    }
  });
});

// ── chop ─────────────────────────────────────────────────────────────────────

describe('chop', () => {
  it('parte en trozos de grid con resto corto; primer id y slide al último', () => {
    const note = makeNote(1, 2.25, 48, 0.7, { id: 'orig', pan: -0.5, slide: true });
    const out = chop([note], { grid: 1 });

    expect(starts(out)).toEqual([1, 2, 3]);
    expect(durations(out)).toEqual([1, 1, 0.25]);
    // El primer trozo conserva el id; los demás son nuevos y únicos.
    expect(out[0]!.id).toBe('orig');
    expect(out[1]!.id).not.toBe('orig');
    expect(new Set(ids(out)).size).toBe(3);
    // Key/velocity/pan se copian; slide solo en el último trozo.
    for (const n of out) {
      expect(n.key).toBe(48);
      expect(n.velocity).toBe(0.7);
      expect(n.pan).toBe(-0.5);
    }
    expect(out.map((n) => n.slide)).toEqual([false, false, true]);
  });

  it('resto < 1e-3 se absorbe; nota más corta que grid queda entera', () => {
    // 1.0005 con grid 0.5 → [0.5, 0.5005]: sin trozos-astilla.
    const out = chop([makeNote(0, 1.0005, 60)], { grid: 0.5 });
    expect(out.length).toBe(2);
    expect(out[1]!.duration).toBeCloseTo(0.5005, 10);

    // Más corta que grid: un solo trozo, id y slide intactos.
    const short = makeNote(0, 0.4, 60, 0.8, { id: 'corta', slide: true });
    expect(chop([short], { grid: 1 })).toEqual([short]);
  });
});

// ── Pureza ───────────────────────────────────────────────────────────────────

describe('pureza', () => {
  it('ninguna herramienta muta la entrada (notas congeladas)', () => {
    const input = deepFreeze([
      makeNote(0, 2, 60, 0.5),
      makeNote(0, 2, 64, 0.6),
      makeNote(3, 1.5, 67, 0.7, { slide: true }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(input));

    arpeggiate(input, { rate: 0.5, mode: 'updown', octaves: 2 });
    strum(input, { spread: 0.5, direction: 'up' });
    humanize(input, { timing: 0.1, velocity: 0.2, seed: 99 });
    chop(input, { grid: 0.5 });

    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});
