/**
 * Tests del ToolExecutor: cada tool muta el proyecto por el bus de comandos
 * (origin 'claude') y los efectos se comprueban sobre el estado del store,
 * no sobre el texto de respuesta (que es para el modelo).
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore, newId, noteToMidi, trackOfChannel, type ChannelGroup, type Command } from '@orbit/core';
import { MAX_PACK_SOUNDS, type PackRequest } from '@orbit/sound-library';
import { ToolExecutor } from '../src/executor';
import { findTool } from '../src/tools';

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

  it('get_project dice por dónde compila DE VERDAD un canal de grupo (bus), no su mixerTrack crudo', async () => {
    // Bug real (auditoría v3.5): la línea de cada canal imprimía
    // `ch.mixerTrack` tal cual. Un canal sin pista propia (mixerTrack 0,
    // "Master") dentro de una carpeta con bus en realidad compila en el BUS
    // del grupo (`trackOfChannel`, ver `model/routing.ts`) — el resumen decía
    // "mixer 0" cuando el canal ni pasa por Master.
    const { store, executor } = setup();
    const channelId = await addChannel(executor, store, 'drums', 'Hats');
    expect(store.project.channels[channelId]!.mixerTrack).toBe(0);

    const group: ChannelGroup = {
      id: newId(),
      name: 'Batería',
      color: '#888',
      collapsed: false,
      busTrack: 2,
    };
    store.dispatch({ type: 'addChannelGroup', group, members: [channelId] }, { label: 'Agrupar' });

    // El campo crudo del canal NO cambia al agruparlo: sigue en 0.
    expect(store.project.channels[channelId]!.mixerTrack).toBe(0);
    // Pero por dónde compila de verdad es el bus, 2.
    expect(trackOfChannel(store.project, channelId)).toBe(2);

    const { text } = await executor.execute('get_project', {});
    const line = text.split('\n').find((l) => l.includes('"Hats"'));
    expect(line, 'la línea del canal "Hats" tiene que estar en el resumen').toBeTruthy();
    expect(line).toMatch(/mixer 2\b/);
    expect(line).not.toMatch(/mixer 0\b/);
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
        dir: 'C:\\fake\\packs\\hats-de-drill',
        seconds: 1.2,
        added: opts.addChannels ? 6 : 0,
      };
    });

    const { text } = await executor.execute('generate_pack', {
      family: 'hats',
      style: 'drill',
      count: 6,
      name: '  Hats Oscuros  ',
      key: 'f',
      seed: 3.6,
    });

    expect(encargos).toEqual([
      { family: 'hats', style: 'drill', count: 6, name: 'Hats Oscuros', key: 'F', seed: 4 },
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

// ── list_library / load_sample ────────────────────────────────────────────────
// La librería la lee el renderer (manifest de fábrica + packs del disco), así
// que aquí se inyecta una de mentira: lo que se comprueba es la RESOLUCIÓN —
// cómo se filtra, cómo se resuelve un nombre y qué pasa cuando es ambiguo—,
// que es lo único que decide este paquete.

describe('librería de sonidos', () => {
  const SOUNDS = [
    { id: 'pack:drums/warehouse/kick-hard-groove-01', name: 'Kick Hard Groove 01',
      pack: 'Warehouse', category: 'drums', subcategory: 'warehouse',
      tags: ['techno', 'kick'], durationSec: 0.42 },
    { id: 'pack:drums/warehouse/kick-rumble-01', name: 'Kick Rumble 01',
      pack: 'Warehouse', category: 'drums', subcategory: 'warehouse',
      tags: ['rave', 'kick'], durationSec: 0.9 },
    { id: 'pack:melodic-loops/warehouse/acid-134-am', name: 'Acid 134 Am',
      pack: 'Warehouse', category: 'melodic-loops', tags: ['acid'],
      durationSec: 7.16, bpm: 134, keyRoot: 'A' },
    { id: 'factory/drums/trap/kick-01', name: 'Kick Trap 01',
      pack: 'Orbit Essentials', category: 'drums', subcategory: 'trap',
      tags: ['trap'], durationSec: 0.5 },
  ];

  /** Executor con una librería de mentira; `cargados` recoge lo que se pidió. */
  function withLibrary() {
    const store = new ProjectStore();
    const cargados: string[][] = [];
    const executor = new ToolExecutor(store, undefined, undefined, undefined, {
      list: async () => SOUNDS,
      load: async (ids, opts) => {
        cargados.push([...ids]);
        return ids.map((id) => {
          const channel = { id: newId(), name: SOUNDS.find((s) => s.id === id)?.name ?? id };
          store.dispatch({
            type: 'addChannel',
            channel: {
              id: channel.id, name: channel.name, color: '#fff', kind: 'sampler',
              params: {}, volume: 1, pan: 0, mute: false, solo: false,
              // El ruteo sale de las opciones, en el mismo paso que el canal:
              // es lo que el executor le pide al renderer.
              mixerTrack: opts?.mixerTrack ?? 0, fx: [null, null, null, null],
            },
          }, opts?.origin !== undefined ? { origin: opts.origin, label: opts.label } : {});
          return channel;
        });
      },
    });
    return { store, executor, cargados };
  }

  it('list_library filtra por texto sin acentos ni mayúsculas', async () => {
    const { executor } = withLibrary();
    const { text } = await executor.execute('list_library', { busca: 'RUMBLE' });
    expect(text).toContain('Kick Rumble 01');
    expect(text).not.toContain('Kick Hard Groove 01');
  });

  it('list_library enseña BPM y nota de los loops, que es lo que decide si encajan', async () => {
    const { executor } = withLibrary();
    const { text } = await executor.execute('list_library', { categoria: 'melodic-loops' });
    expect(text).toContain('134 BPM');
    expect(text).toContain('A');
  });

  it('list_library se queda con un pack cuando se le pide', async () => {
    const { executor } = withLibrary();
    const { text } = await executor.execute('list_library', { pack: 'warehouse' });
    expect(text).not.toContain('Kick Trap 01');
    expect(text).toContain('Warehouse (3)');
  });

  it('load_sample resuelve por nombre y respeta el orden pedido', async () => {
    const { executor, cargados, store } = withLibrary();
    await executor.execute('load_sample', {
      sonidos: ['Kick Rumble 01', 'Acid 134 Am'],
    });
    expect(cargados).toEqual([
      ['pack:drums/warehouse/kick-rumble-01', 'pack:melodic-loops/warehouse/acid-134-am'],
    ]);
    expect(store.project.channelOrder).toHaveLength(2);
  });

  it('load_sample enruta los canales creados a la pista pedida', async () => {
    const { executor, store } = withLibrary();
    await executor.execute('load_sample', { sonidos: ['Kick Hard Groove 01'], mixerTrack: 3 });
    const channel = store.project.channels[store.project.channelOrder[0]!]!;
    expect(channel.mixerTrack).toBe(3);
  });

  it('load_sample no elige a ciegas cuando el nombre es ambiguo', async () => {
    const { executor, cargados } = withLibrary();
    await expect(executor.execute('load_sample', { sonidos: ['Kick'] })).rejects.toThrow(
      /cuadra con 3 sonidos/,
    );
    expect(cargados).toEqual([]);
  });

  it('load_sample dice qué nombre no existe en vez de cargar de menos', async () => {
    const { executor } = withLibrary();
    await expect(
      executor.execute('load_sample', { sonidos: ['Kick Rumble 01', 'Trompeta'] }),
    ).rejects.toThrow(/No hay ningún sonido "Trompeta"/);
  });

  it('sin librería cableada lo dice en vez de fallar raro', async () => {
    const { executor } = setup();
    await expect(executor.execute('list_library', {})).rejects.toThrow(/no está disponible/);
  });
});

describe('set_keymap', () => {
  /** Registra samples en el proyecto con nombres de archivo de librería. */
  function withSamples(store: ProjectStore, files: string[]): void {
    for (const file of files) {
      store.dispatch({
        type: 'registerSample',
        sample: {
          id: file,
          name: file.replace(/\.wav$/, ''),
          path: `user:${file}`,
          hash: file,
          duration: 1,
        },
      });
    }
  }

  it('monta el keymap leyendo las notas de los nombres', async () => {
    const { store, executor } = setup();
    const id = await addChannel(executor, store, 'sampler', 'Piano');
    withSamples(store, ['Piano_C3.wav', 'Piano_C4.wav', 'Piano_C5.wav']);
    await executor.execute('set_keymap', {
      channelId: 'Piano',
      samples: ['Piano_C3.wav', 'Piano_C4.wav', 'Piano_C5.wav'],
    });
    const keymap = store.project.channels[id]!.keymap!;
    expect(keymap).toHaveLength(3);
    expect(keymap.map((z) => z.keyRoot).sort((a, b) => a - b)).toEqual([
      noteToMidi('C3'),
      noteToMidi('C4'),
      noteToMidi('C5'),
    ]);
    // Y cubren el teclado entero: es lo que se espera de "repartir".
    expect(keymap[0]!.keyLow).toBe(0);
    expect(keymap[keymap.length - 1]!.keyHigh).toBe(127);
  });

  it('acepta las raíces a mano cuando el nombre no dice nada', async () => {
    const { store, executor } = setup();
    const id = await addChannel(executor, store, 'sampler', 'Kit');
    withSamples(store, ['golpe-a.wav', 'golpe-b.wav']);
    await executor.execute('set_keymap', {
      channelId: 'Kit',
      samples: ['golpe-a.wav', 'golpe-b.wav'],
      roots: [40, 80],
    });
    expect(store.project.channels[id]!.keymap!.map((z) => z.keyRoot)).toEqual([40, 80]);
  });

  it('con la lista vacía quita el keymap', async () => {
    const { store, executor } = setup();
    const id = await addChannel(executor, store, 'sampler', 'Piano');
    withSamples(store, ['Piano_C3.wav']);
    await executor.execute('set_keymap', { channelId: 'Piano', samples: ['Piano_C3.wav'] });
    expect(store.project.channels[id]!.keymap).toHaveLength(1);
    await executor.execute('set_keymap', { channelId: 'Piano', samples: [] });
    expect(store.project.channels[id]!.keymap ?? []).toHaveLength(0);
  });

  it('se queja si el canal no es un sampler', async () => {
    const { store, executor } = setup();
    await addChannel(executor, store, 'sub808', 'Bajo');
    withSamples(store, ['Piano_C3.wav']);
    await expect(
      executor.execute('set_keymap', { channelId: 'Bajo', samples: ['Piano_C3.wav'] }),
    ).rejects.toThrow(/sampler/);
  });

  it('se queja si el sample no está en el proyecto', async () => {
    const { store, executor } = setup();
    await addChannel(executor, store, 'sampler', 'Piano');
    await expect(
      executor.execute('set_keymap', { channelId: 'Piano', samples: ['no-existe.wav'] }),
    ).rejects.toThrow(/no-existe/);
  });

  it('se queja —en vez de colocar a bulto— si no sabe leer ninguna nota', async () => {
    const { store, executor } = setup();
    await addChannel(executor, store, 'sampler', 'Kit');
    withSamples(store, ['golpe.wav']);
    await expect(
      executor.execute('set_keymap', { channelId: 'Kit', samples: ['golpe.wav'] }),
    ).rejects.toThrow(/roots/);
  });

  it('se queja si roots no cuadra con samples', async () => {
    const { store, executor } = setup();
    await addChannel(executor, store, 'sampler', 'Kit');
    withSamples(store, ['a.wav', 'b.wav']);
    await expect(
      executor.execute('set_keymap', { channelId: 'Kit', samples: ['a.wav', 'b.wav'], roots: [40] }),
    ).rejects.toThrow();
  });

  it('todo el keymap es UN paso de undo', async () => {
    const { store, executor } = setup();
    const id = await addChannel(executor, store, 'sampler', 'Piano');
    withSamples(store, ['Piano_C3.wav', 'Piano_C5.wav']);
    await executor.execute('set_keymap', {
      channelId: 'Piano',
      samples: ['Piano_C3.wav', 'Piano_C5.wav'],
    });
    expect(store.project.channels[id]!.keymap).toHaveLength(2);
    // Por el origen de Claude, que es donde va lo que hace el bridge.
    await executor.execute('undo', {});
    expect(store.project.channels[id]!.keymap ?? []).toHaveLength(0);

  });
});

describe('cotas de tamaño en la playlist y la automatización', () => {
  it('arrange_clip rechaza posiciones y duraciones desmedidas', async () => {
    const { store, executor, patternId } = setup();
    await expect(
      executor.execute('arrange_clip', {
        action: 'add',
        patternId,
        trackIndex: 0,
        lengthBeats: 1e12,
      }),
    ).rejects.toThrow(/lengthBeats.*fuera de rango/);
    await expect(
      executor.execute('arrange_clip', { action: 'add', patternId, trackIndex: 0, startBeat: 1e12 }),
    ).rejects.toThrow(/startBeat.*fuera de rango/);
    // Y lo mismo al mover un clip que ya existe.
    await executor.execute('arrange_clip', { action: 'add', patternId, trackIndex: 0 });
    const clipId = Object.keys(store.project.clips)[0]!;
    await expect(
      executor.execute('arrange_clip', { action: 'move', clipId, startBeat: 1e12 }),
    ).rejects.toThrow(/startBeat.*fuera de rango/);
    await expect(
      executor.execute('arrange_clip', { action: 'move', clipId, lengthBeats: 1e12 }),
    ).rejects.toThrow(/lengthBeats.*fuera de rango/);
  });

  it('set_automation rechaza puntos a 1e12 beats', async () => {
    const { store, executor } = setup();
    const channelId = await addChannel(executor, store, 'synth', 'Lead');
    await expect(
      executor.execute('set_automation', {
        trackIndex: 0,
        startBeat: 0,
        lengthBeats: 4,
        targetJson: { kind: 'channelMix', channelId, param: 'volume' },
        points: [{ time: 1e12, value: 0.5 }],
      }),
    ).rejects.toThrow(/time.*fuera de rango/);
  });
});

describe('add_effect: el pseudo-efecto plugin no entra sin pluginId', () => {
  it('lo rechaza en runtime y no lo anuncia en el esquema', async () => {
    const { executor } = setup();
    await expect(
      executor.execute('add_effect', { trackIndex: 1, slotIndex: 0, kind: 'plugin' }),
    ).rejects.toThrow(/kind inválido/);

    const schema = findTool('add_effect')!.inputSchema.properties!['kind'] as { enum: string[] };
    expect(schema.enum).not.toContain('plugin');
    expect(schema.enum).toContain('eq');
  });
});

describe('load_sample: los canales de Claude son deshacibles', () => {
  const CATALOGO = [
    { id: 'pack:drums/warehouse/kick-hard-groove-01', name: 'Kick Hard Groove 01',
      pack: 'Warehouse', category: 'drums', tags: ['kick'], durationSec: 0.42 },
    { id: 'pack:drums/warehouse/kick-rumble-01', name: 'Kick Rumble 01',
      pack: 'Warehouse', category: 'drums', tags: ['kick'], durationSec: 0.9 },
  ];

  /**
   * Librería de mentira que hace lo que debe hacer la del renderer: subir los
   * samples Y despachar los canales con el origen y el ruteo que le pide el
   * executor, en un solo dispatch.
   */
  function withUndoableLibrary() {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store, undefined, undefined, undefined, {
      list: async () => CATALOGO,
      load: async (ids, opts) => {
        const created = ids.map((id) => ({
          id: newId(),
          name: CATALOGO.find((s) => s.id === id)!.name,
        }));
        const commands: Command[] = created.map((c) => ({
          type: 'addChannel',
          channel: {
            id: c.id, name: c.name, color: '#fff', kind: 'sampler', params: {},
            volume: 1, pan: 0, mute: false, solo: false,
            mixerTrack: opts?.mixerTrack ?? 0, fx: [null, null, null, null],
          },
        }));
        const label = opts?.label ?? 'Cargar sonidos';
        store.dispatch(
          commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
          { label, ...(opts?.origin !== undefined ? { origin: opts.origin } : {}) },
        );
        return created;
      },
    });
    return { store, executor };
  }

  it('los canales entran como UN cambio de Claude y undo los quita de una', async () => {
    const { store, executor } = withUndoableLibrary();
    await executor.execute('load_sample', { sonidos: ['Kick Hard Groove 01'] });
    expect(store.project.channelOrder).toHaveLength(1);
    expect(store.history).toHaveLength(1);
    expect(store.history[0]!.origin).toBe('claude');

    const { text } = await executor.execute('undo', {});
    expect(text).toContain('Deshecho');
    expect(store.project.channelOrder).toHaveLength(0);
  });

  it('con mixerTrack el enrutado va en el MISMO paso de undo', async () => {
    const { store, executor } = withUndoableLibrary();
    await executor.execute('load_sample', {
      sonidos: ['Kick Hard Groove 01', 'Kick Rumble 01'],
      mixerTrack: 3,
    });
    expect(store.history).toHaveLength(1);
    expect(store.history[0]!.origin).toBe('claude');
    for (const id of store.project.channelOrder) {
      expect(store.project.channels[id]!.mixerTrack).toBe(3);
    }

    await executor.execute('undo', {});
    expect(store.project.channelOrder).toHaveLength(0);
  });

  it('si el renderer aún no lee las opciones, el ruteo no se pierde', async () => {
    // Red de seguridad: una librería que despacha sin mirar `mixerTrack`
    // (implementación vieja) no puede dejar los canales en Master mientras la
    // tool dice "en el mixer 2".
    const store = new ProjectStore();
    const executor = new ToolExecutor(store, undefined, undefined, undefined, {
      list: async () => CATALOGO,
      load: async (ids) =>
        ids.map((id) => {
          const c = { id: newId(), name: CATALOGO.find((s) => s.id === id)!.name };
          store.dispatch({
            type: 'addChannel',
            channel: {
              id: c.id, name: c.name, color: '#fff', kind: 'sampler', params: {},
              volume: 1, pan: 0, mute: false, solo: false,
              mixerTrack: 0, fx: [null, null, null, null],
            },
          });
          return c;
        }),
    });
    await executor.execute('load_sample', { sonidos: ['Kick Rumble 01'], mixerTrack: 2 });
    const channelId = store.project.channelOrder[0]!;
    expect(store.project.channels[channelId]!.mixerTrack).toBe(2);
  });
});
