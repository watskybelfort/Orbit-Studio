import { afterEach, expect, it, vi } from 'vitest';
import { versionFileName } from '@orbit/core';

afterEach(() => { vi.unstubAllGlobals(); });

it('la lista de versiones muestra la etiqueta humana de nombres antiguos y nuevos', async () => {
  vi.resetModules();
  const at = 1791060000000;
  const file = versionFileName(at, 'Voz más clara', '662b2f68-3cb7-45f8-9e39-3e9b3714ade6');
  vi.stubGlobal('window', { orbit: {
    settings: { get: async () => ({}), set: async () => ({}) },
    versions: { list: async () => [
      { file, at, bytes: 10 },
      { file: '1791060000000-voz-antigua.orbit', at, bytes: 10 },
      { file: versionFileName(at, '', '762b2f68-3cb7-45f8-9e39-3e9b3714ade6'), at, bytes: 10 },
    ] },
  } });
  const versions = await import('../src/state/versions');
  await versions.refreshVersions();
  expect(versions.useVersions.getState().entries.map((entry) => entry.label)).toEqual(['Voz mas clara', 'Voz antigua', 'Sin nombre']);
});
