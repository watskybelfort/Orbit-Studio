import { describe, expect, it, vi } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, parseProject, serializeProject } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore } from '../src/kernel-core';
import { renderProject, renderStems, RenderLimitError, RenderCancelledError } from '../src/render/offline';

function longSong() {
  const project = createEmptyProject('Más de veinte minutos');
  applyCommand(project, { type: 'setTempo', tempo: 120 });
  const channel = createChannel('synth', 0, 'Final audible');
  const patternId = project.patternOrder[0]!;
  applyCommand(project, { type: 'addChannel', channel });
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id,
    notes: [{ id: 'last-note', start: 0, duration: 1, key: 60, velocity: 1, pan: 0, slide: false }] });
  applyCommand(project, { type: 'addClips', clips: [{ id: 'last-clip', kind: 'pattern', patternId,
    playlistTrackId: Object.keys(project.playlistTracks)[0]!, start: 2402, length: 4, muted: false }] });
  return compileProject(parseProject(serializeProject(project)), { mode: 'song' });
}

describe('BUG058: agotar el presupuesto de render no devuelve audio amputado', () => {
  it('el evento tras veinte minutos causa un error explícito, sin progreso de éxito y soltando el kernel', () => {
    const progress: number[] = [];
    const disposed = vi.spyOn(KernelCore.prototype, 'dispose');
    try {
      // El límite es temporal. 1 kHz conserva los veinte minutos reales con
      // ocho veces menos DSP; la selección audible se verifica abajo a 8 kHz.
      expect(() => renderProject(longSong(), { sampleRate: 1000, tailSeconds: 0,
        onProgress: (value) => progress.push(value) })).toThrow(RenderLimitError);
      expect(progress.length).toBeGreaterThan(0);
      expect(Math.max(...progress)).toBeLessThan(1);
      expect(disposed).toHaveBeenCalledOnce();
    } finally { disposed.mockRestore(); }
  });

  it('la selección tardía sí conserva el evento audible completo', () => {
    const progress: number[] = [];
    const out = renderProject(longSong(), { sampleRate: 8000, tailSeconds: 0,
      startBeat: 2402, endBeat: 2406, onProgress: (value) => progress.push(value) });
    expect(out.left.length / out.sampleRate).toBeCloseTo(2, 1);
    expect(out.left.reduce((max, value) => Math.max(max, Math.abs(value)), 0)).toBeGreaterThan(0.3);
    expect(progress.at(-1)).toBe(1);
  });

  it('un stem que supera el límite queda en errores, nunca en resultados', () => {
    const out = renderStems(longSong(), [0], { sampleRate: 1000, tailSeconds: 0 });
    expect(out.results.size).toBe(0);
    expect(out.errors.get(0)).toMatch(/límite.*1200/);
  });

  it('cancelar conserva su señal distinta de un límite de recursos', () => {
    expect(() => renderProject(longSong(), { sampleRate: 8000, tailSeconds: 0,
      isCancelled: () => true })).toThrow(RenderCancelledError);
  });
});
