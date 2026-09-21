/**
 * Ids heredados de `Object.prototype` en el executor.
 *
 * `p.channels[ref]`, `p.patterns[ref]`, `p.samples[ref]` y `p.clips[id]` a
 * secas dan por buenos `'__proto__'`, `'constructor'`, `'toString'`… (son
 * propiedades heredadas, truthy), así que el executor devolvía entidades que
 * no existen y llegaba a mutar el prototipo: `arrange_clip {clipId:'__proto__'}`
 * dejaba `({}).start === 9` y `clipId:'toString'` creaba
 * `project.clips['undefined']`. Aquí se comprueba que TODA búsqueda por id es
 * por propiedad propia y que ninguna call contamina `Object.prototype`.
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@orbit/core';
import { ToolExecutor } from '../src/executor';

/** Los nombres heredados que un pool indexado por id da por válidos. */
const HEREDADOS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

function setup() {
  const store = new ProjectStore();
  const executor = new ToolExecutor(store);
  const patternId = store.project.patternOrder[0]!;
  return { store, executor, patternId };
}

describe('el executor no confunde ids heredados con entidades', () => {
  it('findPattern: rechaza un patrón heredado', async () => {
    const { executor, patternId } = setup();
    for (const malo of HEREDADOS) {
      await expect(
        executor.execute('get_notes', { patternId: malo, channelId: patternId }),
      ).rejects.toThrow(new RegExp(`No existe el patrón "${malo}"`));
    }
  });

  it('findChannel: rechaza un canal heredado', async () => {
    const { executor } = setup();
    for (const malo of HEREDADOS) {
      await expect(
        executor.execute('set_channel', { channelId: malo, patch: { mute: true } }),
      ).rejects.toThrow(new RegExp(`No existe el canal "${malo}"`));
    }
  });

  it('findSample: rechaza un sample heredado', async () => {
    const { store, executor } = setup();
    await executor.execute('add_channel', { kind: 'sampler', name: 'Piano' });
    const channelId = store.project.channelOrder[0]!;
    for (const malo of HEREDADOS) {
      await expect(
        executor.execute('set_keymap', { channelId, samples: [malo] }),
      ).rejects.toThrow(new RegExp(`No hay ningún sample "${malo}"`));
    }
  });

  it('set_keymap: un canal heredado no borra el keymap de nadie', async () => {
    const { store, executor } = setup();
    await executor.execute('add_channel', { kind: 'sampler', name: 'Piano' });
    const channelId = store.project.channelOrder[0]!;
    // El canal real sí tiene keymap; el id heredado no puede pasar por él.
    store.dispatch(
      { type: 'patchChannel', channelId, patch: { keymap: [] } },
      { label: 'keymap vacío' },
    );
    for (const malo of HEREDADOS) {
      await expect(
        executor.execute('set_keymap', { channelId: malo, samples: [] }),
      ).rejects.toThrow(new RegExp(`No existe el canal "${malo}"`));
    }
  });

  it('arrange_clip: rechaza un clip heredado', async () => {
    const { executor } = setup();
    for (const malo of HEREDADOS) {
      await expect(
        executor.execute('arrange_clip', { action: 'move', clipId: malo, startBeat: 9 }),
      ).rejects.toThrow(new RegExp(`No existe el clip ${malo}`));
      await expect(
        executor.execute('arrange_clip', { action: 'remove', clipId: malo }),
      ).rejects.toThrow(new RegExp(`No existe el clip ${malo}`));
    }
  });

  // Último a propósito: si el fix se rompiera, la contaminación queda medida
  // aquí aunque algún test de arriba hubiera cortado antes.
  it('ninguna búsqueda contaminó Object.prototype', () => {
    expect(({} as Record<string, unknown>)['start']).toBeUndefined();
    expect(({} as Record<string, unknown>)['length']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('patternId');
  });
});
