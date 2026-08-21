import { describe, expect, it } from 'vitest';
import {
  packClips,
  packNotes,
  unpackClips,
  unpackNotes,
  type ClipWithRow,
} from '../src/state/clipboard';
import type { Clip, Note } from '@orbit/core';

function note(id: string, start: number, key = 60, duration = 1): Note {
  return { id, start, duration, key, velocity: 0.8, pan: 0, slide: false };
}

function clip(id: string, start: number, length = 4, trackId = 't0'): Clip {
  return {
    id,
    kind: 'pattern',
    playlistTrackId: trackId,
    start,
    length,
    muted: false,
    patternId: 'p1',
  };
}

describe('portapapeles de notas', () => {
  it('normaliza al 0 conservando la separación', () => {
    const packed = packNotes([note('a', 8), note('b', 9.5), note('c', 8)]);
    expect(packed).not.toBeNull();
    expect(packed!.notes.map((n) => n.start).sort()).toEqual([0, 0, 1.5]);
    expect(packed!.span).toBe(2.5); // del 8 al 10.5
  });

  it('sin selección no hay nada que copiar', () => {
    expect(packNotes([])).toBeNull();
  });

  it('pegar coloca en el destino con ids nuevos', () => {
    const packed = packNotes([note('a', 8), note('b', 9.5)])!;
    const fresh = unpackNotes(packed, 4);
    expect(fresh.map((n) => n.start)).toEqual([4, 5.5]);
    expect(fresh.map((n) => n.id)).not.toContain('a');
    expect(new Set(fresh.map((n) => n.id)).size).toBe(2);
  });

  it('conserva altura, velocity, pan y slide', () => {
    const original: Note = { id: 'a', start: 2, duration: 0.5, key: 43, velocity: 0.31, pan: -0.7, slide: true };
    const [pasted] = unpackNotes(packNotes([original])!, 0);
    expect(pasted).toMatchObject({ duration: 0.5, key: 43, velocity: 0.31, pan: -0.7, slide: true });
  });

  it('pegar antes del 0 mueve el grupo entero, no lo apelmaza', () => {
    const packed = packNotes([note('a', 0), note('b', 2)])!;
    const fresh = unpackNotes(packed, -5);
    expect(fresh.map((n) => n.start)).toEqual([0, 2]);
  });
});

describe('portapapeles de clips', () => {
  const items: ClipWithRow[] = [
    { clip: clip('a', 16, 4, 't1'), row: 1 },
    { clip: clip('b', 20, 8, 't3'), row: 3 },
  ];

  it('normaliza beat y fila', () => {
    const packed = packClips(items)!;
    expect(packed.clips.map((c) => c.start)).toEqual([0, 4]);
    expect(packed.clips.map((c) => c.row)).toEqual([0, 2]);
    expect(packed.rows).toBe(3);
    expect(packed.homeRow).toBe(1);
    expect(packed.span).toBe(12); // del 16 al 28
  });

  it('pegar reparte por las pistas de destino', () => {
    const packed = packClips(items)!;
    const fresh = unpackClips(packed, 32, 0, ['t0', 't1', 't2', 't3']);
    expect(fresh.map((c) => c.start)).toEqual([32, 36]);
    expect(fresh.map((c) => c.playlistTrackId)).toEqual(['t0', 't2']);
    expect(fresh.map((c) => c.id)).not.toContain('a');
  });

  it('si no cabe hacia abajo, sube el grupo entero', () => {
    const packed = packClips(items)!; // ocupa 3 filas
    const fresh = unpackClips(packed, 0, 2, ['t0', 't1', 't2', 't3']);
    // Pedía las filas 2..4 y solo hay hasta la 3: baja el ancla a la 1.
    expect(fresh.map((c) => c.playlistTrackId)).toEqual(['t1', 't3']);
  });

  it('lo que no cabe ni subiendo se queda fuera', () => {
    const packed = packClips(items)!; // 3 filas
    const fresh = unpackClips(packed, 0, 0, ['t0', 't1']);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.playlistTrackId).toBe('t0');
  });

  it('sin pistas no pega nada', () => {
    expect(unpackClips(packClips(items)!, 0, 0, [])).toEqual([]);
  });

  it('conserva lo propio del clip (mute, color, fundidos, audio)', () => {
    const source: Clip = {
      ...clip('a', 4),
      muted: true,
      color: '#ff0000',
      fadeIn: 0.5,
      fadeOut: 1,
      kind: 'audio',
      sampleId: 's1',
      audioGain: 0.5,
      audioPitch: -3,
    };
    const [pasted] = unpackClips(packClips([{ clip: source, row: 0 }])!, 8, 0, ['t9']);
    expect(pasted).toMatchObject({
      muted: true,
      color: '#ff0000',
      fadeIn: 0.5,
      fadeOut: 1,
      kind: 'audio',
      sampleId: 's1',
      audioGain: 0.5,
      audioPitch: -3,
      start: 8,
      playlistTrackId: 't9',
    });
  });

  it('el carril de toma sobrevive (Clip.lane no es la fila)', () => {
    const source: Clip = { ...clip('a', 0), lane: 2 };
    const [pasted] = unpackClips(packClips([{ clip: source, row: 5 }])!, 0, 0, ['t0']);
    expect(pasted!.lane).toBe(2);
  });

  it('los puntos de automatización se clonan, no se comparten', () => {
    const source: Clip = {
      ...clip('a', 0),
      kind: 'automation',
      points: [{ id: 'pt1', time: 0, value: 0.5, tension: 0 }],
    };
    const packed = packClips([{ clip: source, row: 0 }])!;
    const [pasted] = unpackClips(packed, 0, 0, ['t0']);
    pasted!.points![0]!.value = 1;
    expect(source.points![0]!.value).toBe(0.5);
    expect(packed.clips[0]!.points![0]!.value).toBe(0.5);
  });

  it('frozenFrom no viaja: la copia no es dueña de los clips escondidos', () => {
    const source: Clip = { ...clip('a', 0), frozenFrom: ['x', 'y'] };
    const [pasted] = unpackClips(packClips([{ clip: source, row: 0 }])!, 0, 0, ['t0']);
    expect(pasted!.frozenFrom).toBeUndefined();
  });
});
