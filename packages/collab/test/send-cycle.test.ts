import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { parseProject, ProjectStore, serializeProject } from '@orbit/core';
import { CommandLogBinding, type LogEntry } from '../src/command-log';

it('un envío cíclico recibido se omite también al reconstruir la sala para un nuevo cliente', () => {
  const store = new ProjectStore();
  const doc = new Y.Doc();
  const binding = new CommandLogBinding(store, doc, { name: 'Ana', color: '#fff' });
  binding.start();
  store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 2 });
  const before = serializeProject(store.project);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const lateDoc = new Y.Doc();
  let lateBinding: CommandLogBinding | undefined;
  try {
    // Entrada de un cliente antiguo, que todavía no valida setSend.
    doc.getArray<LogEntry>('commands').push([{
      cmd: { type: 'setSend', trackIndex: 2, target: 1, level: 1 },
      client: 123, seq: 0, user: 'Cliente antiguo', origin: 'local', role: 'productor',
    }]);
    expect(serializeProject(store.project)).toBe(before);
    Y.applyUpdate(lateDoc, Y.encodeStateAsUpdate(doc));
    const lateStore = new ProjectStore(parseProject(before));
    lateBinding = new CommandLogBinding(lateStore, lateDoc, { name: 'Beto', color: '#fff' }, { isHost: () => false });
    lateBinding.start();
    expect(serializeProject(lateStore.project)).toBe(before);
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringMatching(/ciclo/) }));
    store.dispatch({ type: 'setTempo', tempo: 123 });
    Y.applyUpdate(lateDoc, Y.encodeStateAsUpdate(doc));
    expect(lateStore.project.tempo).toBe(123);
    expect(serializeProject(lateStore.project)).toBe(serializeProject(store.project));
  } finally {
    warning.mockRestore();
    binding.destroy();
    lateBinding?.destroy();
    doc.destroy();
    lateDoc.destroy();
  }
});
