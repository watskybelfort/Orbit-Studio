import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function rig() {
  vi.resetModules();
  const written: { path: string; bytes: Uint8Array }[] = [];
  vi.stubGlobal('window', { orbit: {
    settings: { get: async () => ({}), set: async () => ({}) },
    file: { write: async (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); } },
  } });
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => setTimeout(() => callback(0), 0));
  // Decodificador independiente para el WAV float estéreo que sí se lee por IPC.
  // Ni collectSamples ni el DSP ni el escritor de stems están simulados.
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData(bytes: ArrayBuffer) {
      const view = new DataView(bytes);
      expect(view.getUint16(20, true)).toBe(3);
      expect(view.getUint16(34, true)).toBe(32);
      const channels = view.getUint16(22, true);
      const frames = (bytes.byteLength - 44) / (4 * channels);
      const pcm = Array.from({ length: channels }, (_, channel) =>
        Float32Array.from({ length: frames }, (_, frame) => view.getFloat32(44 + (frame * channels + channel) * 4, true)));
      return { numberOfChannels: channels, sampleRate: view.getUint32(24, true), getChannelData: (channel: number) => pcm[channel]! };
    }
  });
  const core = await import('@orbit/core');
  const engine = await import('@orbit/engine');
  const { store } = await import('../src/state/app');
  const exp = await import('../src/export/run-export');
  const project = core.createEmptyProject('Voz sola');
  const lane = Object.values(project.playlistTracks)[0]!;
  core.applyCommand(project, { type: 'patchPlaylistTrack', trackId: lane.id, patch: { mixerTrack: 3 } });
  const pcm = Float32Array.from({ length: 22050 }, (_, i) => 0.1 * Math.sin(i * 2 * Math.PI * 220 / 44100));
  const wav = engine.encodeWav(pcm, pcm, 44100, 32);
  const read = vi.fn(async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
  Object.assign(window.orbit!, { recording: { read } });
  core.applyCommand(project, { type: 'registerSample', sample: { id: 'voice', name: 'Voz', path: 'recording:voice.wav', hash: 'voice', duration: 0.5 } });
  core.applyCommand(project, { type: 'addClips', clips: [{ id: 'voice-clip', kind: 'audio', sampleId: 'voice', playlistTrackId: lane.id, start: 0, length: 1, muted: false }] });
  store.replaceProject(project);
  const options = { ...exp.DEFAULT_EXPORT_OPTIONS, source: 'song' as const, stems: true, midi: false, sampleRate: 44100, depth: 32 as const, tailSeconds: 0, normalize: false };
  return { core, engine, store, exp, project, lane, read, written, options };
}

function peak(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(34, true)).toBe(32);
  let result = 0;
  for (let i = 44; i < bytes.byteLength; i += 4) result = Math.max(result, Math.abs(view.getFloat32(i, true)));
  return result;
}

describe('stems de audio de la playlist', () => {
  it('una voz sin canales del rack produce mezcla y stem audibles', async () => {
    const r = await rig();
    expect(r.project.channelOrder).toEqual([]);
    const result = await r.exp.runExport('/out/voz.wav', r.options);
    expect(result.warnings).toEqual([]);
    expect(result.stemsWritten).toBe(1);
    expect(r.written.map((w) => w.path)).toEqual(['/out/voz.wav', '/out/voz-insert-3.wav']);
    expect(r.read).toHaveBeenCalled();
    expect(peak(r.written[0]!.bytes)).toBeGreaterThan(0.08);
    expect(peak(r.written[1]!.bytes)).toBeGreaterThan(0.08);
    expect(peak(r.written[1]!.bytes)).toBeCloseTo(peak(r.written[0]!.bytes), 5);
  });

  it('rack y varios clips dirigidos al mismo insert producen un único stem', async () => {
    const r = await rig();
    const channel = r.core.createChannel('synth', 0);
    channel.mixerTrack = 3;
    r.store.dispatch({ type: 'addChannel', channel });
    r.store.dispatch({ type: 'addClips', clips: [{ ...r.project.clips['voice-clip']!, id: 'voice-copy', start: 1 }] });
    expect(r.exp.usedMixerTracks(r.store.project)).toEqual([{ idx: 3, name: 'Insert 3' }]);
    const result = await r.exp.runExport('/out/mezcla.wav', r.options);
    expect(result.stemsWritten).toBe(1);
    expect(r.written).toHaveLength(2);
    expect(peak(r.written[1]!.bytes)).toBeGreaterThan(0.08);
  });

  it.each(['clip', 'lane', 'arrangement'] as const)('excluye audio fuera del render por %s', async (reason) => {
    const r = await rig();
    if (reason === 'clip') r.store.dispatch({ type: 'patchClips', patches: [{ id: 'voice-clip', muted: true }] });
    if (reason === 'lane') r.store.dispatch({ type: 'patchPlaylistTrack', trackId: r.lane.id, patch: { muted: true } });
    if (reason === 'arrangement') r.store.dispatch({ type: 'patchPlaylistTrack', trackId: r.lane.id, patch: { arrangementId: 'otro' } });
    expect(r.exp.usedMixerTracks(r.store.project)).toEqual([]);
  });

  it('un patrón no incluye stems de audio de la canción y el panel coincide', async () => {
    const r = await rig();
    const patternId = r.project.patternOrder[0]!;
    const compiled = r.engine.compileProject(r.project, { mode: 'pattern', patternId });
    expect(r.exp.usedMixerTracks(r.project, compiled)).toEqual([]);
    expect(r.exp.usedMixerTracks(r.project)).toEqual([{ idx: 3, name: 'Insert 3' }]);
    const result = await r.exp.runExport('/out/patron.wav', { ...r.options, source: 'pattern', patternId });
    expect(result.stemsWritten).toBe(0);
    expect(r.written).toHaveLength(1);
    const source = readFileSync(new URL('../src/export/ExportPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain("opts.source === 'pattern' ? { audioClips: [] } : undefined");
  });
});
