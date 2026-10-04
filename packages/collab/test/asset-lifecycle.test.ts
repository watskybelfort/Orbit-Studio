import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { SampleAssetBinding, type SampleAsset } from '../src/assets';

const bytes = new Uint8Array([1, 2]);
const hash = createHash('sha1').update(bytes).digest('hex');
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((f) => f()); vi.unstubAllGlobals(); });

function rig(maxRoomBytes = 10) {
  const gates: (() => void)[] = [];
  vi.stubGlobal('crypto', { subtle: { digest: (_: string, data: Uint8Array) =>
    new Promise<ArrayBuffer>((resolve) => {
      const copy = new Uint8Array(data);
      gates.push(() => {
        const result = createHash('sha1').update(copy).digest();
        resolve(new Uint8Array(result).buffer);
      });
    }),
  } });
  const doc = new Y.Doc();
  const map = doc.getMap<SampleAsset>('assets');
  const announced = vi.fn(), rejected = vi.fn();
  const binding = new SampleAssetBinding(doc, { maxRoomBytes, onAsset: announced, onRejected: rejected });
  binding.start();
  cleanup.push(() => { binding.destroy(); doc.destroy(); });
  const add = (key = hash, content = bytes) => map.set(key, {
    hash: key, bytes: content, name: key, size: content.length, by: 'peer', at: 1,
  });
  const finish = async () => { expect(gates.length).toBeGreaterThan(0); gates.shift()!(); await settle(); };
  return { binding, doc, map, announced, rejected, gates, add, finish };
}

describe('BUG055: verificación de muestras y ciclo de vida', () => {
  it('permite borrar un rechazo y publicar los bytes correctos con el mismo hash', async () => {
    const r = rig(); r.add(hash, new Uint8Array([3, 4])); await r.finish();
    expect(r.binding.get(hash)).toBeNull();
    r.map.delete(hash); r.add();
    expect(r.binding.get(hash)).toBeNull();
    await r.finish();
    expect(r.binding.get(hash)).toEqual(bytes);
    expect(r.announced).toHaveBeenCalledTimes(1);
  });

  it('un digest posterior a destroy no anuncia ni repone memoria ni reservas', async () => {
    const r = rig(); r.add(); r.binding.destroy(); await r.finish();
    expect(r.announced).not.toHaveBeenCalled();
    expect(r.binding.totalBytes).toBe(0);
    const state = r.binding as unknown as { identity: Map<string, string>; pendienteBytes: number };
    expect(state.identity.size).toBe(0);
    expect(state.pendienteBytes).toBe(0);
  });

  it('destroy y start no dejan que el digest viejo decida sobre la nueva entrada', async () => {
    const r = rig(); r.add(hash, new Uint8Array([3, 4])); r.binding.destroy();
    r.add(); r.binding.start();
    expect(r.gates).toHaveLength(2);
    await r.finish();
    expect(r.binding.get(hash)).toBeNull();
    expect(r.announced).not.toHaveBeenCalled();
    await r.finish();
    expect(r.binding.get(hash)).toEqual(bytes);
    expect(r.announced).toHaveBeenCalledTimes(1);
    expect(r.binding.totalBytes).toBe(2);
  });

  it('cuenta una sola vez la reserva pendiente al llegar otro sample', async () => {
    const r = rig(3); r.add(); r.add('legacy', new Uint8Array([7]));
    expect(r.rejected).not.toHaveBeenCalled();
    await r.finish();
    expect(r.binding.totalBytes).toBe(3);
    expect(r.binding.has(hash)).toBe(true);
    expect(r.binding.has('legacy')).toBe(true);
  });

  it('sin WebCrypto acepta por huella sin dejar una espera infinita', () => {
    const r = rig(); vi.stubGlobal('crypto', {}); r.add();
    expect(r.gates).toHaveLength(0);
    expect(r.binding.get(hash)).toEqual(bytes);
    expect(r.announced).toHaveBeenCalledTimes(1);
    expect(r.binding.totalBytes).toBe(2);
  });

  it('al borrar contenido admite inmediatamente el que esperaba por espacio', () => {
    const r = rig(3); r.add('old', new Uint8Array(3)); r.add('waiting');
    expect(r.binding.get('waiting')).toBeNull();
    r.map.delete('old');
    expect(r.binding.get('waiting')).toEqual(bytes);
    expect(r.binding.totalBytes).toBe(2);
    expect(r.announced.mock.calls.map(([a]) => a.hash)).toEqual(['old', 'waiting']);
  });

  it('la publicación local respeta el espacio reservado por un digest remoto', async () => {
    const r = rig(3); r.add();
    expect(r.binding.publish(bytes, { hash: 'own', name: 'local', by: 'me' })).toBe('room-full');
    expect(r.map.has('own')).toBe(false);
    await r.finish();
    expect(r.binding.has(hash)).toBe(true);
    expect(r.binding.totalBytes).toBe(2);
  });
});
