/**
 * Los `.bin` de salas cerradas no se recogían nunca: cada código que se abrió
 * una vez dejaba su snapshot en disco para siempre. Al arrancar, el servidor
 * pasa la escoba: borra lo que pasa del tope o de la edad, con sus compañeros
 * (`.corrupt`, `.tmp`, `.auth.json`), y no toca nada fresco.
 *
 * La selección es pura para poder fijarla sin disco; `sweepRooms` es la parte
 * que borra de verdad.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type ServerHandle } from '../src/index';
import { selectStaleRoomFiles, sweepRooms } from '../src/room-cleanup';

const DAY = 24 * 60 * 60 * 1000;

let handle: ServerHandle | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('selectStaleRoomFiles', () => {
  it('conserva las salas más recientes y marca las que pasan del tope', () => {
    const now = Date.now();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `ROOM0${i}.bin`,
      mtimeMs: now - i * 1000,
    }));
    expect(selectStaleRoomFiles(entries, { maxFiles: 3, now }).sort()).toEqual([
      'ROOM03.bin',
      'ROOM04.bin',
    ]);
  });

  it('una sala vieja cae aunque no se pase del tope', () => {
    const now = Date.now();
    const entries = [
      { name: 'VIEJAAA.bin', mtimeMs: now - 31 * DAY },
      { name: 'NUEVAAA.bin', mtimeMs: now - DAY },
    ];
    expect(selectStaleRoomFiles(entries, { now })).toEqual(['VIEJAAA.bin']);
  });

  it('se lleva los compañeros del bin recogido y los .tmp', () => {
    const now = Date.now();
    const entries = [
      { name: 'VIEJAAA.bin', mtimeMs: now - 31 * DAY },
      { name: 'VIEJAAA.auth.json', mtimeMs: now - 31 * DAY },
      { name: 'VIEJAAA.bin.corrupt', mtimeMs: now - 31 * DAY },
      { name: 'NUEVAAA.bin', mtimeMs: now },
      { name: 'NUEVAAA.auth.json', mtimeMs: now },
      { name: 'NUEVAAA.bin.tmp', mtimeMs: now },
    ];
    expect(selectStaleRoomFiles(entries, { now }).sort()).toEqual([
      'NUEVAAA.bin.tmp',
      'VIEJAAA.auth.json',
      'VIEJAAA.bin',
      'VIEJAAA.bin.corrupt',
    ]);
  });

  it('una contraseña sin bin NO se toca: borrarla quitaría la puerta de la sala', () => {
    const now = Date.now();
    const entries = [{ name: 'SOLOAAA.auth.json', mtimeMs: now - 999 * DAY }];
    expect(selectStaleRoomFiles(entries, { now })).toEqual([]);
  });
});

describe('sweepRooms', () => {
  it('borra del disco lo viejo y deja lo fresco', () => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-clean-'));
    writeFileSync(join(dir, 'VIEJAAA.bin'), 'x');
    writeFileSync(join(dir, 'VIEJAAA.auth.json'), '{}');
    writeFileSync(join(dir, 'NUEVAAA.bin'), 'y');
    const old = (Date.now() - 40 * DAY) / 1000;
    utimesSync(join(dir, 'VIEJAAA.bin'), old, old);
    utimesSync(join(dir, 'VIEJAAA.auth.json'), old, old);

    expect(sweepRooms(dir).sort()).toEqual(['VIEJAAA.auth.json', 'VIEJAAA.bin']);
    expect(existsSync(join(dir, 'VIEJAAA.bin'))).toBe(false);
    expect(existsSync(join(dir, 'NUEVAAA.bin'))).toBe(true);
  });

  it('startServer pasa la escoba al arrancar', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-clean-'));
    writeFileSync(join(dir, 'VIEJAAA.bin'), 'x');
    const old = (Date.now() - 40 * DAY) / 1000;
    utimesSync(join(dir, 'VIEJAAA.bin'), old, old);
    writeFileSync(join(dir, 'NUEVAAA.bin'), 'y');

    handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
    expect(existsSync(join(dir, 'VIEJAAA.bin'))).toBe(false);
    expect(existsSync(join(dir, 'NUEVAAA.bin'))).toBe(true);
  });
});
