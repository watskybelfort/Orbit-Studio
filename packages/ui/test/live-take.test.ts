/**
 * La toma se ve en la Playlist MIENTRAS se graba, en el sitio donde va a caer.
 *
 * Dos niveles, como el resto del repo (sin jsdom):
 *
 * - el módulo puro (`live-take.ts`): picos por columna y reparto por vueltas;
 * - el grabador de verdad con una fuente de mentira (mismo andamiaje que
 *   `input-routes-record.test.ts`): la vista aparece al grabar, crece con cada
 *   trozo, está en la MISMA pista y el MISMO carril que el clip que se guarda
 *   al parar —si no, el clip saltaría de sitio— y desaparece al terminar.
 *
 * Que el lienzo la pinte se fija leyendo `Playlist.tsx`: el dibujo vive en un
 * `useCallback` que no se puede ejercitar sin canvas.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { framesToBeats, LIVE_PEAK_FRAMES, LivePeaks, liveTakeClips } from '../src/state/live-take';
import { readSource } from './read-source';

function block(value: number, length = 128): Float32Array {
  return new Float32Array(length).fill(value);
}

describe('LivePeaks', () => {
  it('resume en una columna por LIVE_PEAK_FRAMES muestras, con mínimo y máximo', () => {
    const peaks = new LivePeaks();
    const left = new Float32Array(LIVE_PEAK_FRAMES * 2 + 10);
    left[3] = 0.8;
    left[LIVE_PEAK_FRAMES + 7] = -0.6;
    peaks.push(left, left);
    expect(peaks.frames).toBe(LIVE_PEAK_FRAMES * 2 + 10);
    expect(peaks.columns).toBe(2);
    expect(peaks.max[0]).toBeCloseTo(0.8);
    expect(peaks.min[1]).toBeCloseTo(-0.6);
    // La columna a medio llenar no se pinta todavía.
    expect(peaks.columnAt(LIVE_PEAK_FRAMES * 2 + 5)).toBe(-1);
    expect(peaks.columnAt(LIVE_PEAK_FRAMES + 1)).toBe(1);
  });

  it('crece sin perder lo anterior cuando la toma pasa de su capacidad inicial', () => {
    const peaks = new LivePeaks();
    const columns = 1000;
    for (let i = 0; i < columns; i++) peaks.push(block(i / columns, LIVE_PEAK_FRAMES), block(i / columns, LIVE_PEAK_FRAMES));
    expect(peaks.columns).toBe(columns);
    expect(peaks.max[0]).toBe(0);
    expect(peaks.max[999]).toBeCloseTo(0.999);
  });

  it('mezcla los dos lados a mono para pintar', () => {
    const peaks = new LivePeaks();
    peaks.push(block(1, LIVE_PEAK_FRAMES), block(0, LIVE_PEAK_FRAMES));
    expect(peaks.max[0]).toBeCloseTo(0.5);
  });
});

describe('liveTakeClips', () => {
  it('sin loop es una sola pieza que crece desde el inicio de la toma', () => {
    expect(liveTakeClips(8, 3, null, 0)).toEqual([
      { start: 8, length: 3, offsetBeats: 0, lane: 0, muted: false },
    ]);
  });

  it('con loop reparte por vueltas: cada una en su carril y solo la última suena', () => {
    const clips = liveTakeClips(0, 10, { start: 0, end: 4 }, 1);
    expect(clips.map((c) => [c.start, c.length, c.offsetBeats, c.lane, c.muted])).toEqual([
      [0, 4, 0, 1, true],
      [0, 4, 4, 2, true],
      [0, 2, 8, 3, false],
    ]);
  });

  it('framesToBeats: un segundo a 120 BPM son dos beats', () => {
    expect(framesToBeats(48000, 48000, 120)).toBe(2);
    expect(framesToBeats(48000, 0, 120)).toBe(0);
  });
});

function fakeStream(channels: number): MediaStream {
  const track = {
    stop: () => undefined,
    getSettings: () => ({ channelCount: channels, deviceId: 'interfaz-de-mentira' }),
  };
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

async function rig() {
  vi.resetModules();
  vi.stubGlobal('window', {
    orbit: {
      recording: { save: (name: string) => Promise.resolve(name) },
      settings: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('navigator', {});
  const app = await import('../src/state/app');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  vi.spyOn(app.engine, 'loadSample').mockResolvedValue({ duration: 1 });
  vi.spyOn(app.engine, 'connectInput').mockReturnValue({
    disconnect: () => undefined,
  } as unknown as MediaStreamAudioSourceNode);
  const monitor = await import('../src/state/input-monitor');
  monitor.setInputStreamFactory(() => Promise.resolve(fakeStream(2)));
  const recorder = await import('../src/state/recorder');
  recorder.useRecorderStore.setState({ countInBars: 0 });
  return { app, recorder };
}

describe('el grabador expone la toma en curso', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sin grabar no hay nada que pintar', async () => {
    const { recorder } = await rig();
    expect(recorder.liveRecordingView()).toEqual([]);
  });

  it('aparece al grabar, crece con cada trozo y cae donde luego cae el clip', async () => {
    const { app, recorder } = await rig();
    await recorder.toggleRecording();
    expect(recorder.useRecorderStore.getState().phase).toBe('recording');

    recorder.pushInputChunk(block(0.5, 4096), block(0.5, 4096));
    const first = recorder.liveRecordingView();
    expect(first).toHaveLength(1);
    const length1 = first[0]!.clips[0]!.length;
    expect(length1).toBeGreaterThan(0);
    expect(first[0]!.peaks.columns).toBe(Math.floor(4096 / LIVE_PEAK_FRAMES));

    recorder.pushInputChunk(block(0.5, 4096), block(0.5, 4096));
    const second = recorder.liveRecordingView();
    expect(second[0]!.clips[0]!.length).toBeCloseTo(length1 * 2);
    // La pista que se ve es una que YA existe en la Playlist.
    const liveTrack = second[0]!.trackId;
    expect(app.store.project.playlistTracks[liveTrack]).toBeDefined();
    const liveLane = second[0]!.clips[0]!.lane;

    await recorder.toggleRecording();
    const clips = Object.values(app.store.project.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.playlistTrackId).toBe(liveTrack);
    expect(clips[0]!.lane ?? 0).toBe(liveLane);
    // Terminada la toma, la vista en vivo se suelta.
    expect(recorder.liveRecordingView()).toEqual([]);
  });

  it('mirar la vista en vivo no cambia dónde cae la toma', async () => {
    // `placeTake` recuerda la pista por entrada; la vista en vivo lo llama en
    // seco y no puede dejar esa memoria tocada.
    const { app, recorder } = await rig();
    await recorder.toggleRecording();
    recorder.pushInputChunk(block(0.4, 2048), block(0.4, 2048));
    for (let i = 0; i < 5; i++) recorder.liveRecordingView();
    await recorder.toggleRecording();
    await recorder.toggleRecording();
    recorder.pushInputChunk(block(0.4, 2048), block(0.4, 2048));
    const live = recorder.liveRecordingView();
    await recorder.toggleRecording();
    // La segunda toma se apila sobre la primera, en la misma pista y un carril más.
    const clips = Object.values(app.store.project.clips);
    expect(clips).toHaveLength(2);
    expect(new Set(clips.map((c) => c.playlistTrackId)).size).toBe(1);
    expect(live[0]!.trackId).toBe(clips[0]!.playlistTrackId);
    expect(live[0]!.clips[0]!.lane).toBe(1);
  });
});

describe('la Playlist la pinta', () => {
  it('lee la vista en vivo en cada dibujado, con el rojo de Rec de su paleta', () => {
    const src = readSource('editors/playlist/Playlist.tsx');
    expect(src).toContain('const live = liveRecordingView();');
    expect(src).toContain("const rec = col('--pl-rec');");
    // Se repinta al terminar la toma aunque el transporte esté parado.
    expect(src).toMatch(/selection, recPhase\]\);/);
    // Al grabar, la Playlist baja hasta la pista de la toma si no se ve: una
    // vez, cuando llega el primer trozo, y se para el temporizador.
    expect(src).toMatch(/if \(recPhase !== 'recording'\) return;\s+const timer = window\.setInterval\(\(\) => \{\s+const live = liveRecordingView\(\)\[0\];\s+if \(!live\) return;\s+window\.clearInterval\(timer\);/);
    const css = readSource('editors/playlist/playlist.css');
    expect(css.match(/--pl-rec: #[0-9a-f]{6};/g)).toHaveLength(3);
  });
});
