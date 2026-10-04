import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { parseVersionFile, versionFileName } from '@orbit/core';
import { writeFileAtomic } from '../src/main/atomic-write';

let sandbox: string | undefined;
afterEach(async () => { if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

async function rig() {
  sandbox = await mkdtemp(join(tmpdir(), 'orbit-version-handler-'));
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const versionsDir =');
  const end = source.indexOf('  // ── Librería de sonidos', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  type Handler = (...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  class FixedDate extends Date { static override now() { return 1791060000000; } }
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    ipcMain: { handle: (name: string, fn: Handler) => handlers.set(name, fn) },
    Date: FixedDate, app: { getPath: () => sandbox }, join, mkdir, readFile, readdir,
    stat, rm, writeFile, writeFileAtomic, randomUUID, parseVersionFile, versionFileName,
  });
  return {
    dir: join(sandbox, 'versions', 'project-a'),
    save: (label: string, json: string) => handlers.get('version:save')!({}, 'project-a', label, json) as Promise<string>,
    list: () => handlers.get('version:list')!({}, 'project-a') as Promise<{ file: string; at: number; bytes: number }[]>,
    read: (file: string) => handlers.get('version:read')!({}, 'project-a', file) as Promise<string>,
    remove: (file: string) => handlers.get('version:remove')!({}, 'project-a', file),
  };
}

describe('versiones: handlers reales sobre disco', () => {
  it('dos saves simultáneos con misma fecha/etiqueta conservan ambas fotos', async () => {
    const r = await rig();
    const [a, b] = await Promise.all([r.save('Misma versión', '{"title":"A"}'), r.save('Misma versión', '{"title":"B"}')]);
    expect(a).not.toBe(b);
    expect(await r.read(a)).toBe('{"title":"A"}');
    expect(await r.read(b)).toBe('{"title":"B"}');
    const entries = await r.list();
    expect(entries.map((e) => e.file).sort()).toEqual([a, b].sort());
    expect(entries.every((e) => e.at === 1791060000000 && e.bytes > 0)).toBe(true);
    expect(parseVersionFile(a)?.slug).toBe('misma-version');
    await r.remove(a);
    expect((await r.list()).map((e) => e.file)).toEqual([b]);
    expect(await r.read(b)).toBe('{"title":"B"}');
  });

  it('lista/lee/elimina archivos antiguos y poda los más viejos junto a los nuevos', async () => {
    const r = await rig();
    await mkdir(r.dir, { recursive: true });
    for (let i = 0; i < 40; i++) await writeFile(join(r.dir, `${1791050000000 + i}-antes.orbit`), `old-${i}`);
    expect(await r.read('1791050000000-antes.orbit')).toBe('old-0');
    const fresh = await r.save('Nueva', '{"title":"nueva"}');
    const list = await r.list();
    expect(list).toHaveLength(40);
    expect(list[0]!.file).toBe(fresh);
    expect(list.some((e) => e.file === '1791050000000-antes.orbit')).toBe(false);
    expect(await readdir(r.dir)).toHaveLength(40);
    await r.remove('1791050000001-antes.orbit');
    expect(await r.list()).toHaveLength(39);
  });

  it('los handlers rechazan rutas ajenas incluso con nombres que parecen versiones', async () => {
    const r = await rig();
    for (const file of ['../1791060000000-x.orbit', '1791060000000-x.orbit/extra', '1791060000000-x.txt']) {
      await expect(r.read(file)).rejects.toThrow(/Versión no válida/);
      await expect(r.remove(file)).rejects.toThrow(/Versión no válida/);
    }
  });
});
