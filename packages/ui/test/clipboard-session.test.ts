import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function rig() {
  vi.resetModules();
  vi.stubGlobal('window', { confirm: () => true, orbit: {
    app: { setDirty: async () => undefined },
    settings: { get: async () => ({}), set: async () => undefined },
    autosave: { clear: async () => undefined },
    versions: { list: async () => [] }, project: { recent: async () => [] },
  } });
  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const clipboard = await import('../src/state/clipboard');
  const files = await import('../src/state/project-file');
  const channel = core.createChannel('synth', 0);
  store.dispatch({ type: 'addChannel', channel });
  store.dispatch({ type: 'registerSample', sample: { id: 'sample', name: 'Voz', path: 'recording:voice.wav', hash: 'hash', duration: 1 } });
  const base = { id: 'clip', playlistTrackId: Object.keys(store.project.playlistTracks)[0]!, start: 0, length: 4, muted: false };
  const clips = [
    { ...base, kind: 'pattern' as const, patternId: store.project.patternOrder[0]! },
    { ...base, kind: 'audio' as const, sampleId: 'sample' },
    { ...base, kind: 'automation' as const, target: { kind: 'channelMix' as const, channelId: channel.id, param: 'volume' as const }, points: [{ id: 'p', time: 0, value: .5, tension: 0 }] },
  ];
  return { core, store, clipboard, files, clips };
}

describe('BUG046: portapapeles ligado a la sesión del proyecto', () => {
  it.each([0, 1, 2])('Nuevo proyecto invalida referencias de clips de tipo %d antes de pegar', async (index) => {
    const { store, clipboard, files, clips } = await rig();
    clipboard.setClipboard(clipboard.packClips([{ clip: clips[index]!, row: 0 }]));
    expect(clipboard.clipboardKind()).toBe('clips');
    files.newProject();
    expect(clipboard.readClipboard()).toBeNull();
    expect(clipboard.clipboardKind()).toBeNull();
    expect(Object.values(store.project.clips)).toEqual([]);
  });

  it('sustituir por una versión con el mismo id también invalida el payload', async () => {
    const { core, store, clipboard, clips } = await rig();
    clipboard.setClipboard(clipboard.packClips([{ clip: clips[0]!, row: 0 }]));
    const replacement = core.createEmptyProject('Versión');
    replacement.id = store.project.id;
    store.replaceProject(replacement);
    expect(clipboard.readClipboard()).toBeNull();
  });

  it('despachar/deshacer y copiar sin selección conservan un pegado válido en la misma sesión', async () => {
    const { store, clipboard, clips } = await rig();
    clipboard.setClipboard(clipboard.packClips([{ clip: clips[0]!, row: 0 }]));
    const payload = clipboard.readClipboard();
    store.dispatch({ type: 'setTempo', tempo: 150 });
    store.undo();
    clipboard.setClipboard(null);
    expect(clipboard.readClipboard()).toBe(payload);
    if (payload?.kind !== 'clips') throw new Error('Fixture sin clips');
    const pasted = clipboard.unpackClips(payload, 4, 0, [clips[0]!.playlistTrackId]);
    store.dispatch({ type: 'addClips', clips: pasted });
    expect(store.project.patterns[pasted[0]!.patternId!]).toBeDefined();
    expect(pasted[0]!.start).toBe(4);
    expect(pasted[0]!.id).not.toBe(clips[0]!.id);
  });

  it('cancelar Nuevo proyecto no borra el portapapeles', async () => {
    const { store, clipboard, files, clips } = await rig();
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    const id = store.project.id;
    clipboard.setClipboard(clipboard.packClips([{ clip: clips[0]!, row: 0 }]));
    files.newProject();
    expect(confirm).toHaveBeenCalledOnce();
    expect(store.project.id).toBe(id);
    expect(clipboard.clipboardKind()).toBe('clips');
  });
});
