/**
 * Cuadrar una toma con el beat al milímetro (audífonos inalámbricos: la voz
 * cae corrida y arrastrar con el ratón no da la precisión).
 *
 * La aritmética vive en `editors/playlist/nudge.ts` (pura); que el teclado, el
 * selector de rejilla y Ajustes la usen se fija leyendo la fuente, como el
 * resto del repo (sin jsdom).
 */
import { describe, expect, it } from 'vitest';
import { msToBeats, NUDGE_FINE_MS, NUDGE_MS, nudgePatches, type NudgeClip } from '../src/editors/playlist/nudge';
import { readSource } from './read-source';

const audio = (over: Partial<NudgeClip> = {}): NudgeClip => ({
  id: 'a', kind: 'audio', start: 4, length: 8, audioOffset: 0, ...over,
});

describe('nudgePatches', () => {
  it('10 ms a 120 BPM son 0,02 beats', () => {
    expect(msToBeats(10, 120)).toBeCloseTo(0.02);
    expect(msToBeats(10, 0)).toBe(0);
    expect(NUDGE_MS).toBe(10);
    expect(NUDGE_FINE_MS).toBe(1);
  });

  it('corre el clip hacia atrás y hacia delante', () => {
    expect(nudgePatches([audio()], -0.5, 120)).toEqual([{ id: 'a', start: 3.5, length: 8, audioOffset: 0 }]);
    expect(nudgePatches([audio()], 0.25, 120)).toEqual([{ id: 'a', start: 4.25, length: 8, audioOffset: 0 }]);
  });

  it('una toma en el compás 1 que hay que adelantar recorta su arranque en vez de quedarse clavada', () => {
    // 0,4 beats a 120 BPM = 0,2 s de audio que se quedan antes del inicio.
    const [patch] = nudgePatches([audio({ start: 0, audioOffset: 0.1 })], -0.4, 120);
    expect(patch!.start).toBe(0);
    expect(patch!.length).toBeCloseTo(7.6);
    expect(patch!.audioOffset).toBeCloseTo(0.3);
  });

  it('un clip estirado, de patrón o que se quedaría sin audio se acota en 0', () => {
    expect(nudgePatches([audio({ start: 0.1, audioStretch: true })], -1, 120)).toEqual([{ id: 'a', start: 0 }]);
    expect(nudgePatches([{ id: 'p', kind: 'pattern', start: 0.2, length: 4 }], -1, 120)).toEqual([{ id: 'p', start: 0 }]);
    expect(nudgePatches([audio({ start: 0, length: 0.3 })], -1, 120)).toEqual([]);
  });

  it('no mover no despacha nada', () => {
    expect(nudgePatches([audio()], 0, 120)).toEqual([]);
    expect(nudgePatches([audio()], Number.NaN, 120)).toEqual([]);
    expect(nudgePatches([{ id: 'p', kind: 'pattern', start: 0, length: 4 }], -1, 120)).toEqual([]);
  });
});

describe('deshacer una ráfaga', () => {
  it('un Ctrl+Z devuelve también el arranque recortado, aunque el primer toque solo moviera', async () => {
    const core = await import('@orbit/core');
    const store = new core.ProjectStore();
    const track = Object.values(store.project.playlistTracks)[0]!;
    const sample = { id: 's1', name: 'Toma', path: 'recording:t.wav', hash: 'h', duration: 10 };
    store.dispatch({ type: 'registerSample', sample });
    const clip = { id: 'c1', kind: 'audio' as const, playlistTrackId: track.id, start: 0.02, length: 8, muted: false, sampleId: 's1', audioOffset: 0, audioGain: 1 };
    store.dispatch({ type: 'addClips', clips: [clip] });
    const tempo = store.project.tempo;
    // Primer toque: solo cabe moverlo (sigue >= 0). Los siguientes ya recortan.
    for (const ms of [-1, -100, -100]) {
      const now = store.project.clips['c1']!;
      const patches = nudgePatches([now], msToBeats(ms, tempo), tempo);
      store.dispatch({ type: 'patchClips', patches }, { label: 'Ajustar clip', mergeKey: 'pl:nudge:c1' });
    }
    expect(store.project.clips['c1']!.audioOffset).toBeGreaterThan(0);
    store.undo();
    const back = store.project.clips['c1']!;
    expect(back.start).toBeCloseTo(0.02);
    expect(back.length).toBe(8);
    expect(back.audioOffset).toBe(0);
  });
});

describe('dónde se usa', () => {
  it('la Playlist corre la selección con Alt+←/→ (Shift: fino) en un solo undo', () => {
    const src = readSource('editors/playlist/Playlist.tsx');
    expect(src).toContain("e.altKey && !e.ctrlKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')");
    expect(src).toContain("(e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? NUDGE_FINE_MS : NUDGE_MS)");
    expect(src).toContain('mergeKey: `pl:nudge:');
    // La rejilla sin snap se llama por lo que es y el control explica los atajos.
    expect(src).toContain("{ label: 'Libre', value: null }");
    expect(src).toContain('Alt+←/→ lo corre 10 ms');
  });

  it('el retardo de grabación se pone en milisegundos', () => {
    const src = readSource('settings/MidiSection.tsx');
    expect(src).toContain('onChange={setLatencyMsManually}');
    expect(src).toContain('suffix=" ms"');
  });
});
