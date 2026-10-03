import { expect, it } from 'vitest';
import { createChannel, newId, ProjectStore } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';

it('rechazar el envío de retorno conserva el audio de la mezcla bit a bit', () => {
  const store = new ProjectStore();
  const patternId = store.project.patternOrder[0]!;
  const channel = createChannel('synth', 0);
  channel.mixerTrack = 1;
  store.dispatch({ type: 'addChannel', channel });
  store.dispatch({ type: 'addNotes', patternId, channelId: channel.id, notes: [
    { id: newId(), start: 0, duration: 1, key: 60, velocity: 0.9, pan: 0, slide: false },
  ] });
  store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 2 });
  const render = () => renderProject(compileProject(store.project, { mode: 'pattern', patternId }), {
    sampleRate: 8000, tailSeconds: 0,
  });
  const before = render();
  const peak = before.left.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  expect(peak).toBeGreaterThan(0.1);
  expect(() => store.dispatch({ type: 'setSend', trackIndex: 2, target: 1, level: 1 })).toThrow(/ciclo/);
  const after = render();
  expect(after.left).toEqual(before.left);
  expect(after.right).toEqual(before.right);
});
