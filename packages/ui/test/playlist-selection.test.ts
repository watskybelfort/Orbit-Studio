import { describe, expect, it } from 'vitest';
import {
  clampGroupMove,
  clipsInMarquee,
  type MoveAnchor,
  type SelectableClip,
} from '../src/editors/playlist/selection';

const clips: SelectableClip[] = [
  { id: 'a', start: 0, length: 4, trackIndex: 0 },
  { id: 'b', start: 4, length: 4, trackIndex: 0 },
  { id: 'c', start: 0, length: 4, trackIndex: 1 },
  { id: 'd', start: 16, length: 4, trackIndex: 2 },
];

describe('rectángulo de selección', () => {
  it('coge los clips que cruza y ninguno más', () => {
    const hits = clipsInMarquee(clips, {
      fromBeat: 2,
      toBeat: 5,
      fromTrack: 0,
      toTrack: 0,
    });
    expect(hits.sort()).toEqual(['a', 'b']);
  });

  it('un clip que solo roza el borde no entra', () => {
    // El clip 'b' empieza EXACTAMENTE donde acaba el rectángulo.
    expect(clipsInMarquee(clips, { fromBeat: 0, toBeat: 4, fromTrack: 0, toTrack: 0 })).toEqual([
      'a',
    ]);
  });

  it('el rectángulo vale dibujado en cualquier dirección', () => {
    const derecha = clipsInMarquee(clips, { fromBeat: 1, toBeat: 6, fromTrack: 0, toTrack: 1 });
    const izquierda = clipsInMarquee(clips, { fromBeat: 6, toBeat: 1, fromTrack: 1, toTrack: 0 });
    expect(izquierda).toEqual(derecha);
    expect(derecha.sort()).toEqual(['a', 'b', 'c']);
  });

  it('las filas fuera del rectángulo se quedan fuera', () => {
    expect(clipsInMarquee(clips, { fromBeat: 0, toBeat: 100, fromTrack: 2, toTrack: 2 })).toEqual([
      'd',
    ]);
  });
});

describe('clamp del arrastre de grupo', () => {
  const grupo: MoveAnchor[] = [
    { start: 0, trackIndex: 1 },
    { start: 8, trackIndex: 3 },
  ];

  it('deja pasar un desplazamiento que cabe', () => {
    expect(clampGroupMove(grupo, { beats: 4, tracks: 1 }, 8)).toEqual({ beats: 4, tracks: 1 });
  });

  it('el clip más a la izquierda frena a todo el grupo en el beat 0', () => {
    // -8 llevaría el primero al beat -8: el tope lo pone él, no el otro.
    const { beats } = clampGroupMove(grupo, { beats: -8, tracks: 0 }, 8);
    expect(beats).toBe(0);
    // Y el segundo se queda donde estaba: el grupo conserva su forma.
    expect(grupo.map((a) => a.start + beats)).toEqual([0, 8]);
  });

  it('el grupo no se sale por arriba ni por abajo de las pistas', () => {
    expect(clampGroupMove(grupo, { beats: 0, tracks: -5 }, 8).tracks).toBe(-1);
    expect(clampGroupMove(grupo, { beats: 0, tracks: 9 }, 8).tracks).toBe(4);
  });

  it('el grupo entero mantiene su forma al toparse (no se apelmaza)', () => {
    // Bajando a tope, los dos bajan lo MISMO: la distancia entre ellos (2
    // filas) se conserva. Acotando clip a clip, el de abajo se clavaría y el
    // de arriba se le echaría encima.
    const { tracks } = clampGroupMove(grupo, { beats: 0, tracks: 99 }, 8);
    expect(grupo.map((a) => a.trackIndex + tracks)).toEqual([5, 7]);
  });

  it('sin nada que mover no inventa desplazamientos', () => {
    expect(clampGroupMove([], { beats: 12, tracks: 3 }, 8)).toEqual({ beats: 0, tracks: 0 });
  });

  it('un grupo más alto que las pistas que quedan no se mueve de fila', () => {
    // Puede pasar si borran pistas mientras arrastras.
    expect(clampGroupMove(grupo, { beats: 0, tracks: 1 }, 2).tracks).toBe(0);
  });
});
