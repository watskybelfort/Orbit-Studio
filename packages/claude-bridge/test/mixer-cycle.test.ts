import { expect, it } from 'vitest';
import { ProjectStore } from '@orbit/core';
import { ToolExecutor } from '../src/executor';

it('set_mixer comunica el rechazo del ciclo y revierte el resto del lote', async () => {
  const store = new ProjectStore();
  store.dispatch({ type: 'setSend', trackIndex: 1, target: 2, level: 1 });
  const before = structuredClone(store.project);
  const history = store.historyView();
  const executor = new ToolExecutor(store);
  await expect(executor.execute('set_mixer', {
    trackIndex: 2, patch: { name: 'No se guarda', volume: 0.5, routeTo: 1 },
  })).rejects.toThrow(/ciclo/);
  expect(store.project).toEqual(before);
  expect(store.historyView()).toEqual(history);
});
