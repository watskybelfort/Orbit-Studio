/**
 * La confianza de una calibración de latencia se persiste en settings.json,
 * no solo vive en memoria de la corrida que la midió.
 *
 * Bug real (auditoría v3.5): `MidiSection.tsx` decide el texto del panel por
 * `latConfidence !== null` (`useLatencyCalibrationStore`), pero `confidence`
 * solo se guardaba en el estado en memoria de `runLatencyCalibration()`. Al
 * reiniciar la app con una calibración medida y activa, la confianza volvía a
 * `null` de fábrica y el panel decía "Sin calibrar todavía" mientras el
 * retardo (dos líneas más abajo, `latSamples`) ya mostraba el número medido y
 * aplicándose de verdad. La compensación funcionaba; el mensaje mentía.
 *
 * `vi.resetModules()` + `import()` dinámico en cada test: los stores de
 * `latency-calibration.ts` son singletons de módulo, y sin resetear el
 * segundo test heredaría el estado que dejó el primero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** `window.orbit.settings` de mentira: get/set sobre un objeto en memoria. */
function fakeSettings(initial: Record<string, unknown> = {}) {
  const backing: Record<string, unknown> = { ...initial };
  const orbit = {
    settings: {
      get: () => Promise.resolve({ ...backing }),
      set: (patch: Record<string, unknown>) => {
        Object.assign(backing, patch);
        return Promise.resolve({ ...backing });
      },
    },
  };
  return { orbit, backing };
}

describe('confianza de calibración: persistida y recargada tras reiniciar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('con una medida guardada, la confianza vuelve (no se queda en null)', async () => {
    vi.resetModules();
    const { orbit } = fakeSettings({
      inputLatencySamples: 512,
      inputLatencySource: 'measured',
      inputLatencyFingerprint: '(sistema)|48000|0',
      inputLatencyConfidence: 0.87,
    });
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/latency-calibration');
    await mod.loadLatencySettings();

    const state = mod.useLatencyCalibrationStore.getState();
    expect(state.delaySamples).toBe(512);
    expect(state.source).toBe('measured');
    // Este es el bug real: sin persistir `confidence`, esto se quedaba en
    // `null` pese a haber una calibración medida y activa.
    expect(state.confidence).toBeCloseTo(0.87);
  });

  it('settings.json de una versión vieja (sin la clave nueva): no revienta, confianza null', async () => {
    vi.resetModules();
    const { orbit } = fakeSettings({
      inputLatencySamples: 512,
      inputLatencySource: 'measured',
      // sin inputLatencyConfidence: así guardaba una build anterior al fix.
    });
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/latency-calibration');
    await mod.loadLatencySettings();

    expect(mod.useLatencyCalibrationStore.getState().delaySamples).toBe(512);
    expect(mod.useLatencyCalibrationStore.getState().confidence).toBeNull();
  });

  it('un valor puesto a mano limpia la confianza persistida (no resucita una medida vieja)', async () => {
    vi.resetModules();
    const { orbit, backing } = fakeSettings({
      inputLatencySamples: 512,
      inputLatencySource: 'measured',
      inputLatencyConfidence: 0.9,
    });
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/latency-calibration');
    mod.setLatencySamplesManually(300);

    expect(mod.useLatencyCalibrationStore.getState().source).toBe('manual');
    expect(mod.useLatencyCalibrationStore.getState().confidence).toBeNull();
    // Y en disco: sin limpiar aquí, un reinicio posterior resucitaría la
    // confianza de 0.9 aunque la fuente activa ya sea 'manual'.
    expect(backing['inputLatencyConfidence']).toBeNull();
    expect(backing['inputLatencySource']).toBe('manual');
  });

  it('tras pasar a manual y reiniciar, el panel no vuelve a ver la confianza vieja', async () => {
    vi.resetModules();
    const { orbit } = fakeSettings({
      inputLatencySamples: 512,
      inputLatencySource: 'measured',
      inputLatencyConfidence: 0.9,
    });
    vi.stubGlobal('window', { orbit });

    const mod1 = await import('../src/state/latency-calibration');
    mod1.setLatencySamplesManually(300);

    // "Reiniciar la app": módulo nuevo, mismo `window.orbit` (mismo disco).
    vi.resetModules();
    vi.stubGlobal('window', { orbit });
    const mod2 = await import('../src/state/latency-calibration');
    await mod2.loadLatencySettings();

    expect(mod2.useLatencyCalibrationStore.getState().source).toBe('manual');
    expect(mod2.useLatencyCalibrationStore.getState().confidence).toBeNull();
  });
});
