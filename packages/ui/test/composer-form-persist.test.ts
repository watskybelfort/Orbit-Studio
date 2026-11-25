/**
 * Lo que `updateForm` deja escrito en `settings.json`, con un `window.orbit`
 * de mentira y el reloj en la mano.
 *
 * Dos invariantes que no se ven hasta que fallan, y que ninguna excepción
 * delata:
 *
 * - la semilla NO se guarda: abrir el panel otro día tiene que dar un beat
 *   nuevo, no repetir el de ayer;
 * - el formulario se guarda entero y en un solo escrito por ráfaga (el
 *   debounce de 400 ms), así que dos gestos seguidos —elegir género y luego
 *   variante— no dejan el estado a medias en disco.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface Rig {
  form: () => Record<string, unknown>;
  writes: Record<string, unknown>[];
  updateForm: typeof import('../src/state/composer')['updateForm'];
}

async function rig(): Promise<Rig> {
  vi.resetModules();
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('window', {
    orbit: {
      settings: {
        set: async (patch: Record<string, unknown>) => {
          writes.push(patch);
        },
      },
    },
  });
  const mod = await import('../src/state/composer');
  return {
    writes,
    updateForm: mod.updateForm,
    form: () => (writes[writes.length - 1]?.['composerForm'] ?? {}) as Record<string, unknown>,
  };
}

describe('formulario del compositor en settings.json', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('guarda lo elegido y deja fuera la semilla', async () => {
    vi.useFakeTimers();
    const { updateForm, writes, form } = await rig();
    updateForm({ genre: 'reggaeton', variant: 'moderno', seed: 4242 });
    await vi.advanceTimersByTimeAsync(400);

    expect(writes).toHaveLength(1);
    expect(form()['genre']).toBe('reggaeton');
    expect(form()['variant']).toBe('moderno');
    expect(form()).not.toHaveProperty('seed');
  });

  it('dos gestos seguidos dejan un solo escrito, con el último estado', async () => {
    vi.useFakeTimers();
    const { updateForm, writes, form } = await rig();
    updateForm({ genre: 'reggaeton', variant: 'moderno' });
    updateForm({ genre: 'boombap', variant: null });
    await vi.advanceTimersByTimeAsync(400);

    expect(writes).toHaveLength(1);
    expect(form()['genre']).toBe('boombap');
    expect(form()['variant']).toBeNull();
  });
});
