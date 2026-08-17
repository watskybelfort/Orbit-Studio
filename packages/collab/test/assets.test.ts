/**
 * Los BYTES de los samples viajando por la sala, SIN red: dos Y.Doc enlazados a
 * mano, igual que en convergence.test.ts.
 *
 * Lo que se comprueba:
 * - publicar un sample lo anuncia por HASH y el peer lo recibe UNA sola vez;
 * - republicar el mismo hash (o publicarlo los dos a la vez) no manda un byte;
 * - lo que no cabe se rechaza con aviso y NO entra al doc;
 * - quien entra tarde recibe el contenido que la sala ya tenía;
 * - unirse (join) y re-derivar (replay) avisan de que hay que rehidratar: es el
 *   agujero por el que el proyecto se quedaba lleno de referencias y el kernel
 *   del que entraba, vacío.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createChannel,
  createEmptyProject,
  newId,
  parseProject,
  ProjectStore,
  serializeProject,
  type Project,
  type SampleRef,
} from '@orbit/core';
import { CommandLogBinding } from '../src/command-log';
import {
  SampleAssetBinding,
  type AssetRejection,
  type SampleAsset,
} from '../src/assets';

// ── Utilidades ───────────────────────────────────────────────────────────────

function cloneProject(p: Project): Project {
  return parseProject(serializeProject(p));
}

/** Relay entre dos docs: cada update local de uno se aplica en el otro. */
function linkDocs(docA: Y.Doc, docB: Y.Doc): { hold(): void; release(): void } {
  const origin = { link: true };
  let holding = false;
  const aToB: Uint8Array[] = [];
  const bToA: Uint8Array[] = [];
  docA.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) aToB.push(u);
    else Y.applyUpdate(docB, u, origin);
  });
  docB.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) bToA.push(u);
    else Y.applyUpdate(docA, u, origin);
  });
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const u of aToB.splice(0)) Y.applyUpdate(docB, u, origin);
      for (const u of bToA.splice(0)) Y.applyUpdate(docA, u, origin);
    },
  };
}

/** Un blob reconocible de `size` bytes. */
function blob(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i + seed) % 251;
  return out;
}

function sampleRef(id: string, hash: string, path: string): SampleRef {
  return { id, name: id, path, hash, duration: 1 };
}

// ── Almacén de samples ───────────────────────────────────────────────────────

describe('SampleAssetBinding: el contenido viaja por la sala', () => {
  it('publicar anuncia el hash al peer, y solo una vez', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    const mine: SampleAsset[] = [];
    const theirs: SampleAsset[] = [];
    const bindA = new SampleAssetBinding(docA, { onAsset: (a) => mine.push(a) });
    const bindB = new SampleAssetBinding(docB, { onAsset: (a) => theirs.push(a) });
    bindA.start();
    bindB.start();

    expect(bindA.publish(blob(64), { hash: 'h-kick', name: 'Kick', by: 'Ana' })).toBe('published');

    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.hash).toBe('h-kick');
    expect(theirs[0]!.by).toBe('Ana');
    expect([...theirs[0]!.bytes]).toEqual([...blob(64)]);
    // Lo que subimos nosotros no se nos anuncia: ya lo teníamos cargado.
    expect(mine).toHaveLength(0);

    // Cualquier otro cambio del doc no vuelve a anunciar lo mismo.
    bindA.publish(blob(32, 7), { hash: 'h-snare', name: 'Snare', by: 'Ana' });
    expect(theirs.map((a) => a.hash)).toEqual(['h-kick', 'h-snare']);
  });

  it('el mismo hash no se sube dos veces (ni por el mismo ni por el otro)', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    const theirs: SampleAsset[] = [];
    const bindA = new SampleAssetBinding(docA, {});
    const bindB = new SampleAssetBinding(docB, { onAsset: (a) => theirs.push(a) });
    bindA.start();
    bindB.start();

    expect(bindA.publish(blob(128), { hash: 'h1', name: 'Vox', by: 'Ana' })).toBe('published');
    expect(bindA.publish(blob(128), { hash: 'h1', name: 'Vox', by: 'Ana' })).toBe('duplicate');
    // Beto arrastra el MISMO archivo: mismo sha1, así que tampoco lo manda.
    expect(bindB.publish(blob(128), { hash: 'h1', name: 'Vox', by: 'Beto' })).toBe('duplicate');

    expect(bindA.hashes).toEqual(['h1']);
    expect(bindA.totalBytes).toBe(128);
    expect(theirs).toHaveLength(1); // y el peer solo lo pidió una vez
  });

  it('lo que no cabe se rechaza con aviso y no entra al doc', () => {
    const doc = new Y.Doc();
    const rejected: AssetRejection[] = [];
    const bind = new SampleAssetBinding(doc, {
      maxAssetBytes: 1024,
      maxRoomBytes: 2048,
      onRejected: (info) => rejected.push(info),
    });
    bind.start();

    expect(bind.publish(blob(2000), { hash: 'gordo', name: 'Stem completo', by: 'Ana' })).toBe(
      'too-large',
    );
    expect(bind.has('gordo')).toBe(false);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe('too-large');
    expect(rejected[0]!.message).toMatch(/Stem completo/);

    // Y el tope de la sala: dos que sí caben, el tercero ya no.
    expect(bind.publish(blob(1000), { hash: 'a', name: 'A', by: 'Ana' })).toBe('published');
    expect(bind.publish(blob(1000), { hash: 'b', name: 'B', by: 'Ana' })).toBe('published');
    expect(bind.publish(blob(1000), { hash: 'c', name: 'C', by: 'Ana' })).toBe('room-full');
    expect(bind.hashes.sort()).toEqual(['a', 'b']);
    expect(rejected[1]!.reason).toBe('room-full');

    // Un blob vacío o sin hash no ensucia la sala.
    expect(bind.publish(new Uint8Array(0), { hash: 'x', name: 'X', by: 'Ana' })).toBe('invalid');
    expect(bind.publish(blob(10), { hash: '  ', name: 'X', by: 'Ana' })).toBe('invalid');
  });

  it('quien entra tarde recibe el contenido que la sala ya tenía', () => {
    const docA = new Y.Doc();
    const bindA = new SampleAssetBinding(docA, {});
    bindA.start();
    bindA.publish(blob(48), { hash: 'h1', name: 'Kick', by: 'Ana' });
    bindA.publish(blob(48, 3), { hash: 'h2', name: 'Snare', by: 'Ana' });

    // Cari llega después: su doc arranca del estado de la sala.
    const docC = new Y.Doc();
    Y.applyUpdate(docC, Y.encodeStateAsUpdate(docA));
    const received: SampleAsset[] = [];
    const bindC = new SampleAssetBinding(docC, { onAsset: (a) => received.push(a) });
    bindC.start();

    expect(received.map((a) => a.hash).sort()).toEqual(['h1', 'h2']);
    expect(bindC.get('h1')).not.toBeNull();
    expect([...bindC.get('h2')!]).toEqual([...blob(48, 3)]);
    expect(bindC.totalBytes).toBe(96);

    // Y no se repite: arrancar el observer de nuevo no re-anuncia nada.
    received.length = 0;
    bindC.start();
    expect(received).toHaveLength(0);
  });

  it('los bytes se copian: mutar el buffer de origen no cambia lo publicado', () => {
    const doc = new Y.Doc();
    const bind = new SampleAssetBinding(doc, {});
    bind.start();
    const bytes = blob(16);
    bind.publish(bytes, { hash: 'h', name: 'Loop', by: 'Ana' });
    bytes.fill(0);
    expect([...bind.get('h')!]).toEqual([...blob(16)]);
  });
});

// ── Rehidratación: join() y replay() tienen que avisar ───────────────────────

describe('CommandLogBinding: avisa cuando el proyecto se sustituye entero', () => {
  it('unirse a la sala dispara la rehidratación con los samples ya en el proyecto', () => {
    const base = createEmptyProject('Con samples');
    const storeA = new ProjectStore(cloneProject(base));
    const ref = sampleRef('rec-1', 'h-take', 'recording:take1.wav');
    storeA.dispatch({ type: 'registerSample', sample: ref });
    const channel = createChannel('sampler', 0, 'Take 1');
    channel.sampleId = ref.id;
    storeA.dispatch({ type: 'addChannel', channel });

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }).start();

    const storeB = new ProjectStore();
    let replaced = 0;
    new CommandLogBinding(
      storeB,
      docB,
      { name: 'Beto', color: '#5aa9e6' },
      { isHost: () => false, onProjectReplaced: () => replaced++ },
    ).start();

    // El proyecto llegó entero…
    expect(storeB.project.samples[ref.id]).toEqual(ref);
    // …y con el aviso de que ese sample todavía no tiene bytes en su kernel.
    expect(replaced).toBe(1);
  });

  it('re-derivar tras un merge cruzado también avisa', () => {
    const base = createEmptyProject('Cruce');
    const storeA = new ProjectStore(cloneProject(base));
    const storeB = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const link = linkDocs(docA, docB);
    let replacedA = 0;
    let replacedB = 0;
    new CommandLogBinding(
      storeA,
      docA,
      { name: 'Ana', color: '#e6675a' },
      { onProjectReplaced: () => replacedA++ },
    ).start();
    new CommandLogBinding(
      storeB,
      docB,
      { name: 'Beto', color: '#5aa9e6' },
      { isHost: () => false, onProjectReplaced: () => replacedB++ },
    ).start();

    const joinAvisos = replacedA + replacedB;

    // Cada uno registra un sample sin ver al otro: al soltar, el orden total
    // del log obliga a re-derivar en al menos un cliente.
    link.hold();
    storeA.dispatch({
      type: 'registerSample',
      sample: sampleRef(newId(), 'h-ana', 'recording:ana.wav'),
    });
    storeA.dispatch({ type: 'setTempo', tempo: 96 });
    storeB.dispatch({
      type: 'registerSample',
      sample: sampleRef(newId(), 'h-beto', 'recording:beto.wav'),
    });
    storeB.dispatch({ type: 'setSwing', swing: 0.2 });
    link.release();

    expect(replacedA + replacedB).toBeGreaterThan(joinAvisos);
    // Y los dos acaban viendo los dos samples (con el kernel por rellenar).
    expect(Object.keys(storeA.project.samples)).toHaveLength(2);
    expect(serializeProject(storeA.project)).toBe(serializeProject(storeB.project));
  });
});
