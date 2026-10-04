import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSource } from './read-source';

async function rig() {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal('window', {orbit: {settings: {get: async () => ({}), set: async () => ({})}}});
  vi.stubGlobal('navigator', {});
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const {useUiStore} = await import('../src/state/ui');
  const {useRecorderStore} = await import('../src/state/recorder');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const messages: string[] = [];
  vi.spyOn(app.engine, 'send').mockImplementation(message => {messages.push(message.type);});
  const epoch = app.store.historyEpoch;
  const text = readSource('state/recorder.ts');
  const from = text.indexOf('async function runCountIn(');
  const to = text.indexOf('\nasync function startRecording()', from);
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const context = {
    ...app, useUiStore, useRecorderStore, beatsInBar: core.beatsInBar,
    meterBeatUnit: core.meterBeatUnit, cancelCountIn: false,
    ownsRecorder: () => app.store.historyEpoch === epoch,
    setTimeout, performance, waitCountIn: () => {throw Error('No es el camino sin preroll');},
    runActual: null as unknown as (bars: number, target: number, take: object) => Promise<number | null>,
  };
  runInNewContext(stripTypeScriptTypes(text.slice(from, to) + '\nglobalThis.runActual = runCountIn;'), context);
  useUiStore.setState({playing: false, positionBeats: 8, metronome: false});
  const frame = (beat: number, playing = true) => app.engine.onMeters?.({
    positionBeats: beat, playing, peaks: new Float32Array(20), rms: new Float32Array(20),
    masterRms: [0, 0], notes: new Uint16Array(0), inputPeak: 0, cpu: 0,
  });
  return {...app, useUiStore, useRecorderStore, messages, frame, run: () => context.runActual(1, 8, {})};
}

afterEach(() => {vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('057: preroll espera el primer acuse de reproducción', () => {
  it.each([0, 46])('primer medidor a %sms inicia la grabación al llegar al objetivo', async delay => {
    const r = await rig();
    vi.spyOn(r.engine, 'play').mockImplementation(() => {
      if (delay === 0) r.frame(4);
      else setTimeout(() => r.frame(4), delay);
      setTimeout(() => r.frame(8), 120);
    });
    const pending = r.run();
    await vi.advanceTimersByTimeAsync(30);
    expect(r.useRecorderStore.getState().phase).toBe('countin');
    expect(r.messages).not.toContain('stop');
    await vi.advanceTimersByTimeAsync(120);
    expect(await pending).toBeGreaterThanOrEqual(8);
    expect(r.messages).not.toContain('stop');
    expect(r.useUiStore.getState().metronome).toBe(false);
  });
  it.each(['stop', 'pause'] as const)('%s antes del primer medidor cancela sin esperar el plazo', async action => {
    const r = await rig();
    const pending = r.run();
    await vi.advanceTimersByTimeAsync(20);
    if (action === 'stop') r.stopPlayback(); else r.pausePlayback();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeNull();
    expect(r.useRecorderStore.getState()).toMatchObject({phase: 'idle', error: null, countdown: 0});
  });
  it('motor sin acuse cancela con un error visible y sin cuenta infinita', async () => {
    const r = await rig();
    const pending = r.run();
    await vi.advanceTimersByTimeAsync(1510);
    expect(await pending).toBeNull();
    expect(r.useRecorderStore.getState()).toMatchObject({phase: 'idle', countdown: 0});
    expect(r.useRecorderStore.getState().error).toContain('no confirmó');
    expect(r.messages).toContain('stop');
  });
  it('Stop durante init retira la orden antes de enviarla al kernel', async () => {
    const r = await rig();
    let release!: () => void;
    vi.mocked(r.engine.init).mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
    const pending = r.play();
    r.stopPlayback(); release(); await pending;
    expect(r.messages).not.toContain('play');
  });
  it('la cuenta cancelada no para un Play nuevo que ya pertenece a otro gesto', async () => {
    const r = await rig();
    const pending = r.run();
    await vi.advanceTimersByTimeAsync(20);
    await r.play();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBeNull();
    expect(r.messages.filter(type => type === 'play')).toHaveLength(2);
    expect(r.messages).not.toContain('stop');
  });
});
