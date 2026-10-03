import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('el instalador usa la misma versión de Electron que npm ci', () => {
  const root = new URL('../../', import.meta.url);
  const config = readFileSync(new URL('apps/desktop/electron-builder.yml', root), 'utf8');
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const installed = lock.packages['node_modules/electron']?.version;
  expect(installed).toBeTruthy();
  const packaged = /^electronVersion:\s*([^\s#]+)/m.exec(config)?.[1];
  expect(packaged).toBe(installed);
});
