import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoundEntry } from '@orbit/sound-library';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Stage = 'read' | 'load' | 'hash' | 'duration' | 'placement';
type Kind = 'sampler' | 'keymap' | 'clip';

async function rig(stage: Stage = 'read') {
  vi.resetModules(); vi.useFakeTimers();
  const gate = deferred<void>();
  const entered = deferred<void>();
  let gated = false;
  const wait = async (at: Stage) => {
    if (!gated && stage === at) { gated = true; entered.resolve(); await gate.promise; }
  };
  const read = vi.fn(async () => { await wait('read'); return new ArrayBuffer(8); });
  vi.stubGlobal('window', { orbit: {
    library: { read }, settings: { get: async () => ({}), set: async () => ({}) },
  } });
  vi.stubGlobal('navigator', {});
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async () => {
    await wait('hash'); return new ArrayBuffer(20);
  });
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const gc = await import('../src/state/sample-gc');
  const ui = await import('../src/state/ui');
  const sounds = await import('../src/browser/sound-actions');
  app.store.replaceProject(core.createEmptyProject('A'));
  const channel = core.createChannel('sampler', 0, 'Destino');
  app.store.dispatch({ type: 'addChannel', channel });
  const trackId = Object.keys(app.store.project.playlistTracks)[0]!;
  const loaded = (app.engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
  const counts = new Map<string, number>();
  const upload = vi.spyOn(app.engine, 'loadSample').mockImplementation(async (id) => {
    loaded.add(id);
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    await wait(count === 1 ? 'load' : count === 2 ? 'duration' : 'placement');
    return { duration: 2 };
  });
  const entry = (id = 'a'): SoundEntry => ({
    id, name: `${id} C4`, file: `${id}_C4.wav`, category: 'instrumentos', tags: [],
    durationSec: stage === 'duration' || stage === 'placement' ? 0 : 2,
  });
  const run = (kind: Kind, entries = [entry()]) => {
    if (kind === 'sampler') return sounds.addSamplerChannels(entries);
    if (kind === 'keymap') return sounds.addKeymapZones(channel.id, entries);
    return sounds.addAudioClips(entries, trackId, 4);
  };
  return { core, ...app, gc, ui, sounds, gate, entered: entered.promise, read, loaded, upload, channelId: channel.id, trackId, entry, run };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const snapshot = (r: Rig) => ({ json: r.core.serializeProject(r.store.project), version: r.store.version, history: [...r.store.history] });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG031: carga de librería conserva sesión y destinos', () => {
  for (const kind of ['sampler', 'keymap', 'clip'] as const) {
    for (const stage of ['read', 'load', 'hash', 'duration'] as const) {
      it.each(['nuevo', 'mismo id'] as const)(`${kind}/${stage}: cancela proyecto %s sin mutarlo`, async (replacement) => {
        const r = await rig(stage);
        const result = r.run(kind).then(() => null, (error: unknown) => error);
        await r.entered;
        r.store.replaceProject(replacement === 'nuevo' ? r.core.createEmptyProject('B') : r.store.project);
        r.ui.useUiStore.setState({ pianoRollChannelId: 'selección B' });
        const before = snapshot(r);
        r.gate.resolve();
        const error = await result;
        expect(snapshot(r)).toEqual(before);
        expect(error).toBeInstanceOf(r.sounds.SoundLoadCancelledError);
        expect(r.ui.useUiStore.getState().pianoRollChannelId).toBe('selección B');
        expect(r.gc.pinnedSamples()).toEqual([]);
        expect(r.loaded.size).toBe(0);
        if (stage === 'read') expect(r.upload).not.toHaveBeenCalled();
      });
    }
  }

  it('la segunda espera de duración de playlist también se valida', async () => {
    const r = await rig('placement');
    const result = r.run('clip').then(() => null, (error: unknown) => error);
    await r.entered;
    r.store.replaceProject(r.store.project);
    const before = snapshot(r);
    r.gate.resolve();
    expect(await result).toBeInstanceOf(r.sounds.SoundLoadCancelledError);
    expect(snapshot(r)).toEqual(before);
  });

  it.each(['sampler', 'keymap', 'clip'] as const)('dos drops %s de la misma sesión se suman y conservan ediciones intermedias', async (kind) => {
    const r = await rig('hash');
    const first = r.run(kind);
    await r.entered;
    r.store.dispatch({ type: 'patchChannel', channelId: r.channelId, patch: { volume: 0.31 } });
    await r.run(kind, [r.entry('b')]);
    r.gate.resolve(); await first;
    expect(Object.keys(r.store.project.samples).sort()).toEqual(['a', 'b']);
    expect(r.store.project.channels[r.channelId]!.volume).toBe(0.31);
    if (kind === 'sampler') expect(r.store.project.channelOrder).toHaveLength(3);
    if (kind === 'keymap') expect(r.store.project.channels[r.channelId]!.keymap!.map((zone) => zone.sampleId).sort()).toEqual(['a', 'b']);
    if (kind === 'clip') expect(Object.values(r.store.project.clips).map((clip) => clip.sampleId).sort()).toEqual(['a', 'b']);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect([...r.loaded].sort()).toEqual(['a', 'b']);
  });

  it.each(['keymap', 'clip'] as const)('destino %s borrado durante lectura no deja registros ni referencias huérfanas', async (kind) => {
    const r = await rig();
    const result = r.run(kind).then(() => null, (error: unknown) => error);
    await r.entered;
    if (kind === 'keymap') r.store.dispatch({ type: 'removeChannel', channelId: r.channelId });
    else r.store.dispatch({ type: 'removePlaylistTrack', trackId: r.trackId });
    const before = snapshot(r);
    r.gate.resolve();
    expect(await result).toBeInstanceOf(Error);
    expect(snapshot(r)).toEqual(before);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.loaded.size).toBe(0);
  });

  it.each(['sampler', 'keymap', 'clip'] as const)('dos drops %s del mismo sonido mantienen el registro al deshacer el último', async (kind) => {
    const r = await rig('hash');
    const first = r.run(kind);
    await r.entered;
    await r.run(kind);
    const before = r.core.serializeProject(r.store.project);
    r.gate.resolve(); await first;
    r.store.undo();
    expect(r.core.serializeProject(r.store.project)).toBe(before);
    expect(r.store.project.samples.a).toBeDefined();
  });

  it('la inserción del bridge conserva origin/ruta/etiqueta y un solo undo', async () => {
    const r = await rig();
    const before = r.core.serializeProject(r.store.project);
    const pending = r.sounds.addSamplerChannels([r.entry()], { origin: 'claude', mixerTrack: 3, label: 'Carga del agente' });
    r.gate.resolve(); await pending;
    const added = Object.values(r.store.project.channels).find((channel) => channel.sampleId === 'a')!;
    expect(added.mixerTrack).toBe(3);
    expect(r.store.history.at(-1)).toMatchObject({ origin: 'claude', label: 'Carga del agente' });
    r.store.undo('claude');
    expect(r.core.serializeProject(r.store.project)).toBe(before);
  });

  it('un arreglo distinto que se vuelve activo no redirige el drop a otro destino', async () => {
    const r = await rig();
    const originalArrangement = r.store.project.playlistTracks[r.trackId]!.arrangementId;
    const result = r.run('clip'); await r.entered;
    r.store.dispatch({ type: 'addArrangement', arrangement: { id: 'other', name: 'Otro' } });
    r.store.dispatch({ type: 'setActiveArrangement', arrangementId: 'other' });
    r.store.dispatch({ type: 'setTempo', tempo: 120 });
    r.gate.resolve(); await result;
    const clip = Object.values(r.store.project.clips)[0]!;
    expect(clip.playlistTrackId).toBe(r.trackId);
    expect(r.store.project.playlistTracks[r.trackId]!.arrangementId).toBe(originalArrangement);
    expect(clip.length).toBe(4);
  });

  it('A cancelada no libera muestras de B cargándose con el mismo id', async () => {
    const r = await rig('load');
    const first = r.run('sampler').then(() => null, (error: unknown) => error);
    await r.entered;
    r.store.replaceProject(r.store.project);
    const gateB = deferred<void>();
    const enteredB = deferred<void>();
    r.upload.mockImplementationOnce(async (id) => { r.loaded.add(id); enteredB.resolve(); await gateB.promise; return { duration: 2 }; });
    const second = r.run('sampler'); await enteredB.promise;
    r.gate.resolve();
    expect(await first).toBeInstanceOf(r.sounds.SoundLoadCancelledError);
    expect(r.gc.pinnedSamples()).toEqual(['a']);
    expect(r.loaded.has('a')).toBe(true);
    gateB.resolve(); await second;
    expect(r.store.project.samples.a).toBeDefined();
    expect(r.loaded.has('a')).toBe(true);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it.each(['success', 'failure'] as const)('feedback %s de A no muestra éxito ni error en B; B nuevo sí funciona', async (outcome) => {
    const r = await rig();
    const success = vi.fn(); const error = vi.fn();
    const first = r.sounds.runSoundLoadAction(async (check) => { await r.run('sampler'); check(); success(); }, error);
    await r.entered;
    r.store.replaceProject(r.store.project);
    if (outcome === 'failure') r.gate.reject(new Error('Disco A')); else r.gate.resolve();
    await first;
    expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    await r.sounds.runSoundLoadAction(async (check) => { await r.run('sampler', [r.entry('b')]); check(); success(); }, error);
    expect(success).toHaveBeenCalledOnce();
    expect(r.store.project.samples.b).toBeDefined();
  });

  it('feedback comunica error real a su sesión y ejecuta triage antes de cualquier espera', async () => {
    const r = await rig(); const error = vi.fn(); const entered = vi.fn();
    const call = r.sounds.runSoundLoadAction(async () => { entered(); throw new Error('No existe el archivo'); }, error);
    expect(entered).toHaveBeenCalledOnce();
    await call; expect(error).toHaveBeenCalledWith('No existe el archivo');
  });

  it('los cuatro handlers usan el adaptador probado y validan los avisos posteriores', () => {
    for (const file of ['browser/Browser.tsx', 'editors/channel/KeymapEditor.tsx', 'editors/rack/ChannelRack.tsx', 'editors/playlist/Playlist.tsx']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain('runSoundLoadAction(');
      expect(source, file).toContain('check();');
    }
  });
});
