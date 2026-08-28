/**
 * Recolección de samples del worklet: quién sobra, quién se queda y quién
 * tiene que ESPERAR.
 *
 * Lo que se prueba aquí es lo que no se ve fallar. Que la RAM del hilo de audio
 * baje se mide contando el mapa del kernel; que no se suelte de más se mide de
 * la única forma que vale — pidiendo la recolección con una lista incompleta y
 * comprobando que lo que el motor tiene puesto sigue ahí—, porque soltar el
 * sample de un canal es dejar un instrumento MUDO dentro de la mezcla, y eso
 * es de lo último que se mira.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createKeymapZone,
  newId,
  type Clip,
  type Note,
  type Project,
  type SampleRef,
} from '@orbit/core';
import { compileProject, countSampleRefs, sampleKeepSet } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 48000;

/** Dos segundos de tono: largo de sobra para que la voz no se muera sola. */
function tone(hz: number): { left: Float32Array; right: Float32Array } {
  const n = 2 * SR;
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = Math.sin((2 * Math.PI * hz * i) / SR) * 0.5;
  return { left, right: left.slice() };
}

function load(core: KernelCore, id: string, hz = 220): void {
  const { left, right } = tone(hz);
  core.handleMessage({ type: 'loadSample', sampleId: id, left, right, sampleRate: SR });
}

function ref(id: string): SampleRef {
  return { id, name: id, path: `qa:${id}`, hash: id, duration: 2 };
}

function run(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < blocks; b++) core.process(l, r, MAX_BLOCK);
}

/** Proyecto con un canal de sampler apuntando a `sampleId`. */
function samplerProject(sampleId: string): { project: Project; channelId: string } {
  const project = createEmptyProject('GC');
  const channel = createChannel('sampler', 0, 'Uno');
  applyCommand(project, { type: 'addChannel', channel });
  applyCommand(project, { type: 'registerSample', sample: ref(sampleId) });
  applyCommand(project, {
    type: 'patchChannel',
    channelId: channel.id,
    patch: { sampleId },
  });
  return { project, channelId: channel.id };
}

function firstTrackId(project: Project): string {
  return Object.values(project.playlistTracks).find(
    (t) => t.arrangementId === project.activeArrangementId,
  )!.id;
}

function audioClip(project: Project, sampleId: string, muted = false): Clip {
  return {
    id: newId(),
    kind: 'audio',
    playlistTrackId: firstTrackId(project),
    start: 0,
    length: 4,
    muted,
    sampleId,
  };
}

// ── Contar referencias ───────────────────────────────────────────────────────

describe('countSampleRefs', () => {
  it('cuenta cada fuente por separado: canal, slicer, keymap, clip y registro', () => {
    const project = createEmptyProject('Refs');
    const sampler = createChannel('sampler', 0, 'Sampler');
    const slicer = createChannel('slicer', 1, 'Slicer');
    const multi = createChannel('sampler', 2, 'Multi');
    applyCommand(project, { type: 'addChannel', channel: sampler });
    applyCommand(project, { type: 'addChannel', channel: slicer });
    applyCommand(project, { type: 'addChannel', channel: multi });
    for (const id of ['a', 'b', 'c', 'd', 'suelto']) {
      applyCommand(project, { type: 'registerSample', sample: ref(id) });
    }
    applyCommand(project, {
      type: 'patchChannel',
      channelId: sampler.id,
      patch: { sampleId: 'a' },
    });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: slicer.id,
      patch: { sampleId: 'b', slicePoints: [0, 0.5] },
    });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: multi.id,
      patch: { keymap: [createKeymapZone('c'), createKeymapZone('c')] },
    });
    applyCommand(project, { type: 'addClips', clips: [audioClip(project, 'd')] });

    const counts = countSampleRefs(project);
    expect(counts.get('a')).toMatchObject({ channels: 1, slicers: 0, keymapZones: 0 });
    expect(counts.get('b')).toMatchObject({ channels: 0, slicers: 1 });
    expect(counts.get('c')).toMatchObject({ keymapZones: 2, channels: 0 });
    expect(counts.get('d')).toMatchObject({ audioClips: 1 });
    // El registro cuenta aparte: lo declaran los cinco, no solo el que nadie usa.
    expect(counts.get('suelto')).toMatchObject({
      channels: 0,
      slicers: 0,
      keymapZones: 0,
      audioClips: 0,
      registered: true,
    });
  });

  it('cuenta los clips que el compilador NO compila (muteados)', () => {
    const project = createEmptyProject('Muteado');
    applyCommand(project, { type: 'registerSample', sample: ref('mudo') });
    applyCommand(project, { type: 'addClips', clips: [audioClip(project, 'mudo', true)] });

    // El proyecto compilado se salta el clip muteado: contar ahí soltaría su
    // audio y volver del mute daría silencio.
    expect(compileProject(project, { mode: 'song' }).audioClips).toHaveLength(0);
    expect(countSampleRefs(project).get('mudo')?.audioClips).toBe(1);
    expect(sampleKeepSet(project)).toContain('mudo');
  });

  it('sin `keepRegistered` suelta lo registrado que no usa nadie', () => {
    const project = createEmptyProject('Registro');
    applyCommand(project, { type: 'registerSample', sample: ref('huerfano') });
    expect(sampleKeepSet(project)).toContain('huerfano');
    expect(sampleKeepSet(project, { keepRegistered: false })).not.toContain('huerfano');
  });

  it('los pins entran en la lista aunque el proyecto no los conozca', () => {
    const project = createEmptyProject('Pins');
    const keep = sampleKeepSet(project, { pinned: ['bounce-en-vuelo', 'bounce-en-vuelo'] });
    expect(keep.filter((id) => id === 'bounce-en-vuelo')).toHaveLength(1);
  });
});

// ── El mapa del kernel encoge ────────────────────────────────────────────────

describe('collectSamples', () => {
  it('suelta lo que ya no usa nadie: el mapa del kernel ENCOGE', () => {
    const core = new KernelCore(SR);
    const { project } = samplerProject('usado');
    load(core, 'usado');
    load(core, 'preview-1');
    load(core, 'preview-2');
    load(core, 'proyecto-viejo');
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    expect(core.sampleCount).toBe(4);

    core.handleMessage({ type: 'collectSamples', keep: sampleKeepSet(project) });

    expect(core.sampleCount).toBe(1);
    expect(core.hasSample('usado')).toBe(true);
    expect(core.hasSample('preview-1')).toBe(false);
    expect(core.hasSample('proyecto-viejo')).toBe(false);
    core.dispose();
  });

  it('el kernel protege lo que su proyecto compilado referencia, aunque la lista se lo deje', () => {
    const core = new KernelCore(SR);
    const project = createEmptyProject('Red');
    const multi = createChannel('sampler', 0, 'Multi');
    applyCommand(project, { type: 'addChannel', channel: multi });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: multi.id,
      patch: { sampleId: 'base', keymap: [createKeymapZone('zona')] },
    });
    applyCommand(project, { type: 'addClips', clips: [audioClip(project, 'clip')] });
    for (const id of ['base', 'zona', 'clip', 'sobra']) load(core, id);
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });

    // Lista VACÍA a propósito: el motor no puede quedarse mudo por un error de
    // quien la calculó.
    core.handleMessage({ type: 'collectSamples', keep: [] });

    expect(core.hasSample('base')).toBe(true);
    expect(core.hasSample('zona')).toBe(true);
    expect(core.hasSample('clip')).toBe(true);
    expect(core.hasSample('sobra')).toBe(false);
    core.dispose();
  });

  it('protege también el snapshot que espera en cola', () => {
    const core = new KernelCore(SR);
    const { project: a } = samplerProject('a');
    const { project: b } = samplerProject('b');
    load(core, 'a');
    load(core, 'b');
    core.handleMessage({ type: 'snapshot', project: compileProject(a, { mode: 'song' }) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    core.handleMessage({ type: 'queueSnapshot', project: compileProject(b, { mode: 'song' }) });

    core.handleMessage({ type: 'collectSamples', keep: [] });

    expect(core.hasSample('a')).toBe(true);
    expect(core.hasSample('b')).toBe(true);
    core.dispose();
  });
});

// ── Nada se suelta bajo los pies de una voz ──────────────────────────────────

describe('collectSamples con una voz viva', () => {
  it('no suelta el sample que una voz está leyendo hasta que la voz termina', () => {
    const core = new KernelCore(SR);
    const { project, channelId } = samplerProject('viejo');
    load(core, 'viejo', 220);
    load(core, 'nuevo', 440);
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });

    // Una nota sostenida sobre el sample viejo.
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
    run(core, 4);

    // El canal cambia de sonido: el proyecto ya no nombra 'viejo', pero la voz
    // que suena lo sigue leyendo.
    applyCommand(project, {
      type: 'patchChannel',
      channelId,
      patch: { sampleId: 'nuevo' },
    });
    applyCommand(project, { type: 'registerSample', sample: ref('nuevo') });
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });

    core.handleMessage({ type: 'collectSamples', keep: ['nuevo'] });
    expect(core.hasSample('viejo')).toBe(true);
    expect(core.pendingSampleRelease).toContain('viejo');

    // Sigue sonando: pase lo que pase, el buffer no se toca.
    run(core, 40);
    expect(core.hasSample('viejo')).toBe(true);

    // Se suelta la nota: la voz cierra su release y ENTONCES cae el sample.
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: false });
    run(core, 60);

    expect(core.hasSample('viejo')).toBe(false);
    expect(core.pendingSampleRelease).toHaveLength(0);
    expect(core.hasSample('nuevo')).toBe(true);
    core.dispose();
  });

  it('el keymap protege TODAS sus zonas mientras suena, no solo la que tocó', () => {
    const core = new KernelCore(SR);
    const project = createEmptyProject('Keymap');
    const multi = createChannel('sampler', 0, 'Multi');
    applyCommand(project, { type: 'addChannel', channel: multi });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: multi.id,
      patch: { keymap: [createKeymapZone('z1'), createKeymapZone('z2')] },
    });
    load(core, 'z1');
    load(core, 'z2');
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
    run(core, 4);

    // El keymap desaparece del canal: el proyecto ya no nombra ninguna zona.
    applyCommand(project, { type: 'patchChannel', channelId: multi.id, patch: { keymap: [] } });
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    core.handleMessage({ type: 'collectSamples', keep: [] });

    expect(core.hasSample('z1')).toBe(true);
    expect(core.hasSample('z2')).toBe(true);
    core.dispose();
  });

  it('el preview del Explorador aguanta lo suyo mientras suena', () => {
    const core = new KernelCore(SR);
    // El preview suena por el master, así que hace falta un proyecto puesto.
    core.handleMessage({
      type: 'snapshot',
      project: compileProject(createEmptyProject('Preview'), { mode: 'song' }),
    });
    // Sample corto: el preview se acaba solo a los pocos bloques.
    const n = 3 * MAX_BLOCK;
    const left = new Float32Array(n).fill(0.2);
    core.handleMessage({
      type: 'loadSample',
      sampleId: 'escuchado',
      left,
      right: left.slice(),
      sampleRate: SR,
    });
    core.handleMessage({ type: 'previewSample', sampleId: 'escuchado', gain: 1 });
    core.handleMessage({ type: 'collectSamples', keep: [] });
    expect(core.hasSample('escuchado')).toBe(true);

    run(core, 10); // el preview llega al final y se apaga solo
    expect(core.hasSample('escuchado')).toBe(false);
    core.dispose();
  });

  it('volver a cargar un sample aplazado lo saca de la cola de descarga', () => {
    const core = new KernelCore(SR);
    const { project, channelId } = samplerProject('x');
    load(core, 'x');
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: true });
    run(core, 4);

    applyCommand(project, { type: 'patchChannel', channelId, patch: { sampleId: undefined } });
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    core.handleMessage({ type: 'collectSamples', keep: [] });
    expect(core.pendingSampleRelease).toContain('x');

    // Se vuelve a subir mientras la voz vieja aún suena: la descarga aplazada
    // NO puede llevarse por delante la carga nueva.
    load(core, 'x');
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 60, on: false });
    run(core, 80);

    expect(core.hasSample('x')).toBe(true);
    expect(core.pendingSampleRelease).toHaveLength(0);
    core.dispose();
  });
});

// ── Y esto no cambia el sonido ───────────────────────────────────────────────

describe('recolectar no cambia el sonido', () => {
  it('la salida es idéntica con y sin recolección de por medio', () => {
    const render = (collect: boolean): Float32Array => {
      const project = createEmptyProject('Sonido');
      const channel = createChannel('sampler', 0, 'Uno');
      applyCommand(project, { type: 'addChannel', channel });
      applyCommand(project, { type: 'registerSample', sample: ref('bueno') });
      applyCommand(project, {
        type: 'patchChannel',
        channelId: channel.id,
        patch: { sampleId: 'bueno' },
      });
      const patternId = project.patternOrder[0]!;
      const note: Note = {
        id: newId(),
        start: 0,
        duration: 2,
        key: 60,
        velocity: 1,
        pan: 0,
        slide: false,
      };
      applyCommand(project, {
        type: 'addNotes',
        patternId,
        channelId: channel.id,
        notes: [note],
      });

      const core = new KernelCore(SR);
      load(core, 'bueno', 330);
      load(core, 'sobra', 110);
      core.handleMessage({
        type: 'snapshot',
        project: compileProject(project, { mode: 'pattern', patternId }),
      });
      if (collect) {
        core.handleMessage({ type: 'collectSamples', keep: sampleKeepSet(project) });
      }
      core.handleMessage({ type: 'play', fromBeat: 0 });

      const blocks = 200;
      const out = new Float32Array(blocks * MAX_BLOCK);
      const l = new Float32Array(MAX_BLOCK);
      const r = new Float32Array(MAX_BLOCK);
      for (let b = 0; b < blocks; b++) {
        core.process(l, r, MAX_BLOCK);
        out.set(l, b * MAX_BLOCK);
      }
      core.dispose();
      return out;
    };

    const limpio = render(false);
    const recolectado = render(true);
    expect(recolectado).toEqual(limpio);
    // Y que el render no era silencio, que si no esto no prueba nada.
    expect(Math.max(...limpio)).toBeGreaterThan(0.01);
  });
});
