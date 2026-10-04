import { describe, expect, it, vi } from 'vitest';
import { createChannel, createEmptyProject, createKeymapZone, ProjectStore } from '@orbit/core';
import { analyzeMix, compileProject, encodeWav, renderProject } from '@orbit/engine';
import { ToolExecutor, type RenderInputs, type ResolveRenderInputsFn } from '../src/executor';

const pcm = Float32Array.from({ length: 44100 }, (_, i) => .2 * Math.sin(i * 2 * Math.PI * 220 / 44100));
const inputs = (): RenderInputs => ({ samples: new Map([['sample', { left: pcm, right: pcm, rate: 44100 }]]), plugins: new Map() });
function scene(kind: 'sample' | 'keymap' | 'audio') {
  const store = new ProjectStore();
  store.dispatch({ type: 'registerSample', sample: { id: 'sample', name: 'Voz real', path: 'recording:voice.wav', hash: 'hash', duration: 1 } });
  if (kind === 'audio') {
    store.dispatch({ type: 'addClips', clips: [{ id: 'audio', kind: 'audio', playlistTrackId: Object.keys(store.project.playlistTracks)[0]!,
      start: 0, length: 4, muted: false, sampleId: 'sample' }] });
  } else {
    const channel = createChannel('sampler', 0);
    if (kind === 'sample') channel.sampleId = 'sample';
    else channel.keymap = [createKeymapZone('sample')];
    store.dispatch({ type: 'addChannel', channel });
    store.dispatch({ type: 'addNotes', patternId: store.project.patternOrder[0]!, channelId: channel.id,
      notes: [{ id: 'n', key: 60, start: 0, duration: 1, velocity: 1, pan: 0, slide: false }] });
  }
  const play = kind === 'audio' ? { mode: 'song' as const } : { mode: 'pattern' as const, patternId: store.project.patternOrder[0]! };
  return { store, play };
}
function executor(store: ProjectStore, resolve?: ResolveRenderInputsFn) {
  const save = vi.fn(async (_name: string, _data: Uint8Array) => 'render.wav');
  return { save, tools: new ToolExecutor(store, save, undefined, undefined, undefined, resolve) };
}

describe('bridge: mismas muestras y plugins que el render offline', () => {
  it.each(['sample', 'keymap', 'audio'] as const)('el WAV de %s coincide byte a byte con el render de referencia', async (kind) => {
    const { store, play } = scene(kind);
    const resolver = vi.fn(async () => inputs());
    const { tools, save } = executor(store, resolver);
    const reference = renderProject(compileProject(store.project, play), { sampleRate: 44100, tailSeconds: 2, ...inputs() });
    expect(reference.left.some((value) => Math.abs(value) > .01)).toBe(true);
    await tools.execute('render', { mode: play.mode });
    expect(save).toHaveBeenCalledOnce();
    expect(Buffer.from(save.mock.calls[0]![1]).equals(Buffer.from(encodeWav(reference.left, reference.right, reference.sampleRate, 16)))).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('análisis y consejos miden la misma señal completa', async () => {
    const { store, play } = scene('keymap');
    const resolver = vi.fn(async () => inputs());
    const { tools } = executor(store, resolver);
    const audio = renderProject(compileProject(store.project, play), { sampleRate: 44100, tailSeconds: 1, ...inputs() });
    const analysis = analyzeMix(audio.left, audio.right, audio.sampleRate);
    const peak = String(Math.round(analysis.peakDb * 10) / 10);
    expect((await tools.execute('analyze_mix', {})).text).toContain(`Peak: ${peak} dBFS`);
    expect((await tools.execute('advise_mix', {})).text).toContain(`peak ${peak} dBFS`);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it.each(['render', 'analyze_mix', 'advise_mix'])('%s informa muestras ausentes sin guardar ni aplicar mezcla', async (tool) => {
    const { store } = scene('sample');
    const before = JSON.stringify(store.project);
    const { tools, save } = executor(store);
    await expect(tools.execute(tool, { mode: 'pattern', apply: true })).rejects.toThrow(/Audio incompleto.*Voz real/);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(store.project)).toBe(before);
  });

  it.each(['instrument', 'channel', 'mixer'] as const)('exige y entrega el plugin de %s', async (kind) => {
    const { store, play } = scene('sample');
    const channelId = store.project.channelOrder[0]!;
    const silencer = 'function createEffect(){return {process(l,r,n){for(let i=0;i<n;i++){l[i]=0;r[i]=0;}}};}';
    const instrument = 'function createInstrument(){return {noteOn(){},noteOff(){},render(){return false;}};}';
    const slot = { id: 'fx', kind: 'plugin' as const, enabled: true, mix: 1, params: {}, pluginId: 'plugin' };
    if (kind === 'instrument') store.dispatch({ type: 'patchChannel', channelId, patch: { instrumentPluginId: 'plugin' } });
    else if (kind === 'channel') store.dispatch({ type: 'setChannelEffect', channelId, slotIndex: 0, slot });
    else store.dispatch({ type: 'setEffect', trackIndex: 0, slotIndex: 0, slot });
    const assets = inputs();
    const { tools, save } = executor(store, async () => assets);
    await expect(tools.execute('render', { mode: 'pattern' })).rejects.toThrow(/plugins: plugin/);
    assets.plugins.set('plugin', kind === 'instrument' ? instrument : silencer);
    await tools.execute('render', { mode: 'pattern' });
    const expected = renderProject(compileProject(store.project, play), { sampleRate: 44100, tailSeconds: 2, ...assets });
    expect(expected.left.every((value) => value === 0)).toBe(true);
    expect(Buffer.from(save.mock.calls[0]![1]).equals(Buffer.from(encodeWav(expected.left, expected.right, expected.sampleRate, 16)))).toBe(true);
  });

  it.each(['render', 'analyze_mix', 'advise_mix'])('%s rechaza resultados tras sustituir el proyecto aun conservando su id', async (tool) => {
    const { store } = scene('sample');
    let resolve!: (value: RenderInputs) => void;
    const gate = new Promise<RenderInputs>((done) => { resolve = done; });
    const { tools, save } = executor(store, () => gate);
    const result = tools.execute(tool, { mode: 'pattern', apply: true });
    const replacement = createEmptyProject('B');
    replacement.id = store.project.id;
    store.replaceProject(replacement);
    const before = JSON.stringify(store.project);
    resolve(inputs());
    await expect(result).rejects.toThrow(/proyecto cambió/);
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(store.project)).toBe(before);
  });
});
