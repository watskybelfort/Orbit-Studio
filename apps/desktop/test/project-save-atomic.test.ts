import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

let sandbox: string | undefined;
afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

it('el handler project:save real conserva el .orbit anterior ante ENOSPC parcial', async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'orbit-save-handler-'));
  const target = join(sandbox, 'original.orbit');
  await writeFile(target, 'original valid project');
  const failWrite = async (path: string, data: string) => {
    await writeFile(path, data.slice(0, 3));
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  vi.resetModules();
  vi.doMock('node:fs/promises', async (original) => ({
    ...await original<typeof import('node:fs/promises')>(), writeFile: failWrite,
  }));
  const { writeFileAtomic } = await import('../src/main/atomic-write');
  // Mismo handler que invoca Electron, con disco real en sandbox. No se
  // reproduce su lógica en el test: se ejecuta el código del main.
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const middle = source.indexOf("'project:save'");
  const start = source.lastIndexOf('  ipcMain.handle(', middle);
  const end = source.indexOf('  // ── Autosave', middle);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  type Handler = (event: unknown, path: string, json: string, name: string) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const rememberRecent = vi.fn();
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) },
    resolvePath: resolve, isWriteAllowed: async () => true, mkdir, dirname,
    writeFile: failWrite, writeFileAtomic, rememberRecent, join,
  });
  await expect(handlers.get('project:save')!({}, target, 'new project contents', 'new.orbit')).rejects.toThrow('disk full');
  expect(await readFile(target, 'utf8')).toBe('original valid project');
  expect(await readdir(sandbox)).toEqual(['original.orbit']);
  expect(rememberRecent).not.toHaveBeenCalled();
});
