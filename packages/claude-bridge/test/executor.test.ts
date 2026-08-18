/**
 * Tests del ToolExecutor: cada tool muta el proyecto por el bus de comandos
 * (origin 'claude') y los efectos se comprueban sobre el estado del store,
 * no sobre el texto de respuesta (que es para el modelo).
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore, noteToMidi } from '@orbit/core';
import { MAX_PACK_SOUNDS, type PackRequest } from '@orbit/sound-library';
import { ToolExecutor } from '../src/executor';

/** Store nuevo + executor; devuelve también helpers de lectura frecuentes. */
function setup(saveFile?: (name: string, data: Uint8Array) => Promise<string>) {
  const store = new ProjectStore();
  const executor = new ToolExecutor(store, saveFile);
  const patternId = store.project.patternOrder[0]!;
  return { store, executor, patternId };
}

/** Crea un canal vía la tool y devuelve su id (el último del orden). */
async function addChannel(
  executor: ToolExecutor,
  store: ProjectStore,
  kind: string,
  name?: string,
): Promise<string> {
  await executor.execute('add_channel', { kind, name });
  return store.project.channelOrder[store.project.channelOrder.length - 1]!;
}

describe('ToolExecutor', () => {
  it('add_channel crea el canal y el texto incluye su id', async () => {
    const { store, executor } = setup();
    const before = store.project.channelOrder.length;
    const { text } = await executor.execute('add_channel', { kind: 'sub808', name: 'Bajo' });
    expect(store.project.channelOrder.length).toBe(before + 1);
    const id = store.project.channelOrder[before]!;
    expect(store.project.channels[id]?.kind).toBe('sub808');
    expect(store.project.channels[id]?.name).toBe('Bajo');
    expect(text).toContain(id);
  });

  it('set_steps escribe golpes de 1/16 con velocity por dígito', async () => {
    const { store, executor, patternId } = setup();
    const channelId = await addChannel(executor, store, 'drums', 'Kit');
    await executor.execute('set_steps', {
      patternId,
      channelId,
      steps: 'x---9---x---5---',
    });
    const notes = store.project.patterns[patternId]!.notes[channelId]!;
    expect(notes.map((n) => n.start)).toEqual([0, 1, 2, 3]);
    expect(notes.every((n) => n.duration === 0.25 && n.key === 36)).toBe(true);
    expect(notes[1]!.velocity).toBeCloseTo(1);
    expect(notes[3]!.velocity).toBeCloseTo(5 / 9);
  });

  it('set_notes acepta nombres de nota, slide y replace', async () => {
    const { store, executor, patternId } = setup();
    const channelId = await addChannel(executor, store, 'sub808', '808');
    await executor.execute('set_notes', {
      patternId,
      channelId,
      notes: [{ start: 0, duration: 1, note: 'F2' }],
    });
    await executor.execute('set_notes', {
      patternId,
      channelId,
      replace: true,
      notes: [
        { start: 0, duration: 2, note: 'F2' },
        { start: 2, duration: 2, note: 'G#2', slide: true },
      ],
    });
    const notes = store.project.patterns[patternId]!.notes[channelId]!;
    expect(notes).toHaveLength(2);
    expect(notes[0]!.key).toBe(noteToMidi('F2'));
    expect(notes[1]!.key).toBe(noteToMidi('G#2'));
    expect(notes[1]!.slide).toBe(true);
  });

  it('set_tempo valida el rango y aplica el cambio', async () => {
    const { store, executor } = setup();
    await executor.execute('set_tempo', { bpm: 142 });
    expect(store.project.tempo).toBe(142);
    await expect(executor.execute('set_tempo', { bpm: 5 })).rejects.toThrow(/20\.\.999/);
  });

  it('arrange_clip hace el ciclo add → move → remove sobre la playlist', async () => {
    const { store, executor, patternId } = setup();
    const before = Object.keys(store.project.clips).length;
    await executor.execute('arrange_clip', {
      action: 'add',
      patternId,
      trackIndex: 0,
      startBeat: 4,
    });
    expect(Object.keys(store.project.clips).length).toBe(before + 1);
    const clipId = Object.keys(store.project.clips)[0]!;
    const clip = store.project.clips[clipId]!;
    expect(clip.start).toBe(4);

    await executor.execute('arrange_clip', { action: 'move', clipId, startBeat: 8 });
    expect(store.project.clips[clipId]!.start).toBe(8);

    await executor.execute('arrange_clip', { action: 'remove', clipId });
    expect(store.project.clips[clipId]).toBeUndefined();
  });

  it('add_effect / set_effect / remove_effect gestionan la cadena del mixer', async () => {
    const { store, executor } = setup();
    await executor.execute('add_effect', { trackIndex: 1, slotIndex: 0, kind: 'reverb' });
    const slot = () => store.project.mixer[1]!.slots[0];
    expect(slot()?.kind).toBe('reverb');

    await executor.execute('set_effect', { trackIndex: 1, slotIndex: 0, mix: 0.4 });
    expect(slot()?.mix).toBeCloseTo(0.4);

    await executor.execute('remove_effect', { trackIndex: 1, slotIndex: 0 });
    expect(slot()).toBeNull();
  });

  it('undo deshace SOLO los cambios de Claude, no los del usuario', async () => {
    const { store, executor } = setup();
    store.dispatch({ type: 'setTempo', tempo: 150 }); // cambio del usuario (local)
    await executor.execute('set_tempo', { bpm: 99 }); // cambio de Claude
    expect(store.project.tempo).toBe(99);

    await executor.execute('undo', {});
    expect(store.project.tempo).toBe(150); // vuelve el valor del usuario

    const { text } = await executor.execute('undo', {});
    expect(text).toContain('No hay cambios de Claude');
    expect(store.project.tempo).toBe(150);

    await executor.execute('redo', {});
    expect(store.project.tempo).toBe(99);
  });

  it('get_project resume tempo, patrones y canales', async () => {
    const { store, executor } = setup();
    await addChannel(executor, store, 'supersaw', 'Pad Ancho');
    const { text } = await executor.execute('get_project', {});
    expect(text).toContain(String(store.project.tempo));
    expect(text).toContain('Pad Ancho');
    expect(text).toContain(store.project.patternOrder[0]!);
  });

  it('render (pattern) produce un WAV RIFF por el saveFile inyectado', async () => {
    let saved: Uint8Array | null = null;
    const { store, executor, patternId } = setup(async (name, data) => {
      saved = data;
      return `C:\\fake\\${name}`;
    });
    const channelId = await addChannel(executor, store, 'drums', 'Kit');
    await executor.execute('set_steps', { patternId, channelId, steps: 'x---x---' });

    const { text } = await executor.execute('render', { mode: 'pattern', patternId });
    expect(text).toContain('C:\\fake\\');
    expect(saved).not.toBeNull();
    const header = new TextDecoder().decode(saved!.slice(0, 4));
    expect(header).toBe('RIFF');
  });
  // ── generate_pack ───────────────────────────────────────────────
  // El render y el disco los pone el renderer: aquí se comprueba que el
  // encargo se valida y llega normalizado a esa función inyectada.

  it('generate_pack pasa el encargo normalizado al generador', async () => {
    const store = new ProjectStore();
    const encargos: PackRequest[] = [];
    const executor = new ToolExecutor(store, undefined, undefined, async (request, opts) => {
      encargos.push(request);
      return {
        slug: 'hats-de-drill',
        name: 'Hats de drill',
        count: request.count ?? 8,
        dir: 'C:\fake\packs\hats-de-drill',
        seconds: 1.2,
        added: opts.addChannels ? 6 : 0,
      };
    });

    const { text } = await executor.execute('generate_pack', {
      family: 'hats',
      style: 'drill',
      count: 6,
      name: '  Hats del Doctor  ',
      key: 'f',
      seed: 3.6,
    });

    expect(encargos).toEqual([
      { family: 'hats', style: 'drill', count: 6, name: 'Hats del Doctor', key: 'F', seed: 4 },
    ]);
    expect(text).toContain('Hats de drill');
    expect(text).toContain('Packs generados');
  });

  it('generate_pack recorta la cantidad a lo que admite el generador', async () => {
    const store = new ProjectStore();
    const encargos: PackRequest[] = [];
    const executor = new ToolExecutor(store, undefined, undefined, async (request) => {
      encargos.push(request);
      return { slug: 'p', name: 'P', count: 1, dir: 'd', seconds: 0.1, added: 0 };
    });
    await executor.execute('generate_pack', { family: 'kicks', count: 500 });
    expect(encargos[0]?.count).toBe(MAX_PACK_SOUNDS);
  });

  it('generate_pack cuenta los canales que ha metido en el proyecto', async () => {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store, undefined, undefined, async (_r, opts) => ({
      slug: 'p',
      name: 'P',
      count: 3,
      dir: 'd',
      seconds: 0.3,
      added: opts.addChannels ? 3 : 0,
    }));
    const { text } = await executor.execute('generate_pack', { family: 'claps', addChannels: true });
    expect(text).toContain('3 canal(es) sampler');
  });

  it('generate_pack rechaza familias y estilos que no existen', async () => {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store, undefined, undefined, async () => ({
      slug: 'p',
      name: 'P',
      count: 1,
      dir: 'd',
      seconds: 0.1,
      added: 0,
    }));
    await expect(executor.execute('generate_pack', { family: 'guitarras' })).rejects.toThrow(
      /Familia desconocida/,
    );
    await expect(
      executor.execute('generate_pack', { family: 'hats', style: 'cumbia' }),
    ).rejects.toThrow(/Estilo desconocido/);
  });

  it('sin generador cableado lo dice en vez de fallar raro', async () => {
    const { executor } = setup();
    await expect(executor.execute('generate_pack', { family: 'hats' })).rejects.toThrow(
      /no está disponible/,
    );
  });
});
