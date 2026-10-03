import { describe, expect, it } from 'vitest';
import { ProjectStore, serializeProject } from '@orbit/core';
import { compileProject } from '@orbit/engine';
import { ToolExecutor } from '../src/executor';
import { findTool } from '../src/tools';

const automation = { trackIndex: 0, startBeat: 0, lengthBeats: 4, points: [{ time: 0, value: 1 }] };

describe('048: el bridge solo confirma automatización que el motor admite', () => {
  it.each(['objeto', 'JSON'])('rechaza swing en %s sin crear clips ni undo', async (form) => {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store);
    const target = { kind: 'transport', param: 'swing' };
    const before = serializeProject(store.project);
    const history = store.historyView();
    const version = store.version;
    await expect(executor.execute('set_automation', {
      ...automation, targetJson: form === 'JSON' ? JSON.stringify(target) : target,
    })).rejects.toThrow(/swing.*set_swing/i);
    expect(serializeProject(store.project)).toBe(before);
    expect(store.version).toBe(version);
    expect(store.historyView()).toEqual(history);
  });

  it('tempo sigue creando un clip compilable y reversible por el bus', async () => {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store);
    const before = serializeProject(store.project);
    await executor.execute('set_automation', { ...automation, targetJson: { kind: 'transport', param: 'tempo' } });
    expect(compileProject(store.project, { mode: 'song' }).automation).toHaveLength(1);
    expect(Object.values(store.project.clips)[0]).toMatchObject({ kind: 'automation', target: { kind: 'transport', param: 'tempo' } });
    expect(store.undo('claude')).toBe(true);
    expect(serializeProject(store.project)).toBe(before);
  });

  it('el control manual set_swing sigue desplazando los contratiempos', async () => {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store);
    const patternId = store.project.patternOrder[0]!;
    await executor.execute('add_channel', { kind: 'synth', name: 'Lead' });
    const channelId = store.project.channelOrder[0]!;
    await executor.execute('set_notes', { patternId, channelId, notes: [{ start: 0.25, duration: 0.25, note: 'C4' }] });
    expect(compileProject(store.project, { mode: 'pattern', patternId }).events[0]?.start).toBe(0.25);
    await executor.execute('set_swing', { amount: 1 });
    expect(compileProject(store.project, { mode: 'pattern', patternId }).events[0]?.start).toBe(0.375);
  });

  it('la herramienta deja de ofrecer swing como destino automatizable', () => {
    const tool = findTool('set_automation')!;
    expect(tool.description).not.toContain('"tempo"|"swing"');
    expect(tool.description).toContain('set_swing');
  });
});
