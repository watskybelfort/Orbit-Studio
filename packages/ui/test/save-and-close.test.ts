/**
 * «Guardar y salir»: un solo guardado, y cancelar devuelve el control al main.
 *
 * El bug que cubre: el main reabría el aviso a los 8 s mientras el usuario
 * todavía estaba en «Guardar como», y cada aviso encolaba otro `saveProject`.
 * El runner es single-flight y decide por el flag real, no por la promesa.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSaveAndCloseRunner } from '../src/state/save-and-close';
import { readSource } from './read-source';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Dependencias con contadores; `dirty` se puede cambiar desde el test. */
function harness(initialDirty: boolean) {
  const state = { dirty: initialDirty };
  const save = vi.fn(async () => {});
  const flushClean = vi.fn(async () => true);
  const close = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const runner = createSaveAndCloseRunner({
    dirty: () => state.dirty,
    save,
    flushClean,
    close,
    cancel,
  });
  return { state, save, flushClean, close, cancel, runner };
}

describe('createSaveAndCloseRunner', () => {
  it('con el proyecto limpio no guarda: sincroniza y cierra', async () => {
    const h = harness(false);
    await h.runner();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.flushClean).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('sucio: guarda, sincroniza el flag y cierra', async () => {
    const h = harness(true);
    h.save.mockImplementation(async () => {
      h.state.dirty = false;
    });
    await h.runner();
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.flushClean).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('si el guardado se cancela, avisa al main y NO cierra', async () => {
    const h = harness(true);
    await h.runner();
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.flushClean).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it('si guardar falla, avisa al main y la ventana sigue abierta', async () => {
    const h = harness(true);
    h.save.mockRejectedValue(new Error('disco lleno'));
    await h.runner();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.close).not.toHaveBeenCalled();
  });

  it('los eventos repetidos no encolan un segundo guardado', async () => {
    const h = harness(true);
    const pending = deferred();
    h.save.mockImplementation(async () => {
      await pending.promise;
      h.state.dirty = false;
    });
    const first = h.runner();
    const second = h.runner();
    // El segundo vuelve enseguida: no guarda ni cierra por su cuenta.
    await second;
    expect(h.save).toHaveBeenCalledOnce();
    pending.resolve();
    await first;
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('el cableado del cierre', () => {
  const desktop = readFileSync(
    new URL('../../../apps/desktop/src/main/index.ts', import.meta.url),
    'utf8',
  );
  const preload = readFileSync(
    new URL('../../../apps/desktop/src/preload/index.ts', import.meta.url),
    'utf8',
  );
  const app = readSource('App.tsx');

  it('el main ya no reabre el aviso con un timeout', () => {
    expect(desktop).not.toContain('SAVE_AND_CLOSE_TIMEOUT_MS');
    expect(desktop).not.toContain('saveAndCloseTimer');
  });

  it('un segundo cierre mientras se guarda no vuelve a preguntar', () => {
    expect(desktop).toContain('if (closeRequestInFlight) return;');
    expect(desktop).toContain("ipcMain.handle('app:save-and-close-cancelled'");
    expect(desktop).toContain('closeRequestInFlight = false;');
  });

  it('el renderer usa el runner y puede cancelar el cierre', () => {
    expect(app).toContain('createSaveAndCloseRunner({');
    expect(app).toContain('cancelSaveAndClose()');
    expect(preload).toContain("ipcRenderer.invoke('app:save-and-close-cancelled')");
  });
});
