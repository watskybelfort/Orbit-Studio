import { afterEach, expect, it, vi } from 'vitest';
import { createChannel } from '@orbit/core';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('el puente real del renderer lee/decodifica muestras y entrega plugins al executor', async () => {
  vi.resetModules();
  let onCall!: (call: { id: string; tool: string; args: unknown }) => void;
  let finish!: (result: { text?: string; error?: string }) => void;
  const write = vi.fn(async () => undefined);
  const read = vi.fn(async () => new ArrayBuffer(4));
  vi.stubGlobal('window', { orbit: {
    claude: { onBridgeStatus: vi.fn(), onToolCall: (fn: typeof onCall) => { onCall = fn; }, sendToolResult: (_id: string, result: Parameters<typeof finish>[0]) => finish(result) },
    file: { saveDialog: async () => 'qa.wav', write },
    recording: { read },
  } });
  const tone = Float32Array.from({ length: 44100 }, (_, i) => .2 * Math.sin(i * .04));
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData() { return { numberOfChannels: 1, sampleRate: 44100, getChannelData: () => tone }; }
  });
  const { store } = await import('../src/state/app');
  const { usePluginsStore } = await import('../src/state/plugins');
  const { initClaudeBridge } = await import('../src/state/claude');
  const channel = createChannel('sampler', 0);
  channel.sampleId = 'voice';
  channel.fx = [{ id: 'fx', kind: 'plugin', enabled: true, mix: 1, params: {}, pluginId: 'mute' }];
  store.dispatch({ type: 'registerSample', sample: { id: 'voice', name: 'Voz', path: 'recording:voice.wav', hash: 'qa', duration: 1 } });
  store.dispatch({ type: 'addChannel', channel });
  store.dispatch({ type: 'addNotes', patternId: store.project.patternOrder[0]!, channelId: channel.id,
    notes: [{ id: 'n', start: 0, duration: 1, key: 60, velocity: 1, pan: 0, slide: false }] });
  usePluginsStore.setState({ sources: new Map([['mute', 'function createEffect(){return {process(l,r,n){for(let i=0;i<n;i++){l[i]=0;r[i]=0;}}};}']]) });
  initClaudeBridge();
  const call = (tool: string) => new Promise<Parameters<typeof finish>[0]>((done) => {
    finish = done;
    onCall({ id: tool, tool, args: { mode: 'pattern' } });
  });
  expect((await call('render')).text).toContain('WAV renderizado');
  expect(read).toHaveBeenCalledWith('voice.wav');
  expect(write).toHaveBeenCalledOnce();
  // Quitar el plugin fuerza un error explícito del resolver cableado: con el
  // cable antiguo se afirmaba éxito aun omitiendo muestras y efectos enteros.
  usePluginsStore.setState({ sources: new Map() });
  expect((await call('analyze_mix')).error).toMatch(/Audio incompleto.*plugins: mute/);
});
