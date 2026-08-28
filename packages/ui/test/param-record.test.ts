/**
 * La grabación de movimientos de perillas (`param-record.ts`), sin panel.
 *
 * Es el otro camino de "grabar un gesto" — distinto del de la rueda de tono
 * (ver `live-input-bend.test.ts`): aquí no hay `mergeKey` por frame, hay una
 * PASADA entera: se abre al entrar en play con el botón armado, cada perilla
 * que se toca abre su carril y acumula (beat, valor), y al parar (o desarmar
 * en caliente) cada carril se convierte en un clip de automatización — todo
 * en un solo `dispatch`.
 *
 * Nunca se probó (0 tests): `capture()`, `flushLanes()` y la suscripción al
 * play/stop son privados, así que esto los ejercita por la puerta pública —
 * `touchParam()` (lo que llama cualquier perilla tras su propio dispatch) y
 * `toggleParamRecordArmed()` — con un `store` y un `engine.onMeters` reales
 * (así avanza `currentBeat()`, del que depende el muestreo).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clip } from '@orbit/core';

async function importApp() {
  return import('../src/state/app');
}

interface Rig {
  store: Awaited<ReturnType<typeof importApp>>['store'];
  channelId: string;
  ref: { kind: 'channelMix'; channelId: string; param: 'volume' };
  /** Avanza el playhead (vía un frame de medidores) y arranca/para el transporte. */
  frameAt: (positionBeats: number, playing: boolean) => void;
  /** Mueve la perilla a un valor REAL (no normalizado) y avisa a la grabación. */
  moveTo: (value: number) => void;
  toggleArmed: () => void;
}

/**
 * Un `param-record` recién nacido, con un canal de destino y `engine.onMeters`
 * cableado de verdad (así `currentBeat()` —de la que depende cada muestra—
 * avanza sin esperar un frame real de audio).
 */
async function rig(): Promise<Rig> {
  vi.resetModules();

  const core = await import('@orbit/core');
  const { store, engine } = await importApp();
  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const ui = await import('../src/state/ui');
  const { touchParam } = await import('../src/state/param-touch');
  const record = await import('../src/state/param-record');

  const ref = { kind: 'channelMix' as const, channelId: channel.id, param: 'volume' as const };

  const frameAt = (positionBeats: number, playing: boolean): void => {
    engine.onMeters?.({
      peaks: new Float32Array(1),
      rms: new Float32Array(1),
      masterRms: [0, 0],
      positionBeats,
      playing,
      inputPeak: 0,
      cpu: 0,
    });
  };

  const moveTo = (value: number): void => {
    const norm = core.paramValueNorm(value, ref, store.project);
    const cmd = core.paramRefCommand(ref, norm, store.project);
    if (!cmd) throw new Error('no debería ser null: el canal existe');
    // "El aviso llega DESPUÉS del dispatch" — aquí se reproduce ese orden.
    store.dispatch(cmd, { label: 'Volumen' });
    touchParam(ref);
  };

  return {
    store,
    channelId: channel.id,
    ref,
    frameAt,
    moveTo,
    toggleArmed: record.toggleParamRecordArmed,
  };
}

/** El único clip de automatización sobre `ref` que haya en el proyecto, si hay. */
function clipFor(
  project: Awaited<ReturnType<typeof importApp>>['store']['project'],
  channelId: string,
): Clip | undefined {
  return Object.values(project.clips).find(
    (c) =>
      c.kind === 'automation' &&
      c.target?.kind === 'channelMix' &&
      c.target.channelId === channelId,
  );
}

describe('grabación de movimientos de perillas: una pasada, un clip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('armar sin tocar nada, sin play: no hay pasada, no hay carriles', async () => {
    const { toggleArmed } = await rig();
    const { useParamRecord } = await import('../src/state/param-record');
    toggleArmed();
    expect(useParamRecord.getState()).toMatchObject({ armed: true, recording: false });
  });

  it('mover una perilla varias veces durante la pasada y parar: UN clip con la curva', async () => {
    const { store, channelId, frameAt, moveTo, toggleArmed } = await rig();

    toggleArmed(); // armado, transporte parado todavía
    frameAt(0, true); // entra el play: abre la pasada

    moveTo(0.2);
    frameAt(1, true);
    moveTo(1.4);
    frameAt(2, true);
    moveTo(0.6);

    frameAt(2, false); // para el transporte: vuelca

    const clip = clipFor(store.project, channelId);
    expect(clip).toBeDefined();
    const points = clip!.points!;
    expect(points.length).toBeGreaterThanOrEqual(2);
    // El primer y último valor de la curva son los extremos del gesto: 0.2 al
    // principio, 0.6 (el último tocado) al final — la simplificación puede
    // podar el tramo de en medio, pero no los dos bordes.
    const first = points[0]!;
    const last = points[points.length - 1]!;
    expect(first.value).toBeCloseTo(0.1, 2); // norm de 0.2 (rango real 0..2)
    expect(last.value).toBeCloseTo(0.3, 2); // norm de 0.6
  });

  it('desarmar en caliente (sin parar el transporte) también vuelca lo grabado', async () => {
    const { store, channelId, frameAt, moveTo, toggleArmed } = await rig();
    toggleArmed();
    frameAt(0, true);
    moveTo(0.2);
    frameAt(1, true);
    moveTo(1.8);

    toggleArmed(); // desarma sin parar: "lo grabado hasta aquí se queda"

    expect(clipFor(store.project, channelId)).toBeDefined();
  });

  it('un solo toque (sin segundo punto) no dispara un clip: no hay curva que dibujar', async () => {
    const { store, channelId, frameAt, moveTo, toggleArmed } = await rig();
    toggleArmed();
    frameAt(0, true);
    moveTo(0.9); // un único touchParam en toda la pasada

    frameAt(0, false);

    expect(clipFor(store.project, channelId)).toBeUndefined();
  });

  it('tocar la perilla ARMADO pero con el transporte parado no graba nada', async () => {
    // `recording` solo se pone a true cuando entra el play; armar solo
    // predispone la siguiente pasada, no la que ya pasó.
    const { store, channelId, moveTo, toggleArmed } = await rig();
    toggleArmed(); // armado, playing sigue false
    moveTo(0.3);
    moveTo(1.1);

    expect(clipFor(store.project, channelId)).toBeUndefined();
  });

  it('sin armar, mover la perilla no abre ningún carril aunque esté sonando', async () => {
    const { store, channelId, frameAt, moveTo } = await rig();
    frameAt(0, true); // suena, pero nadie armó la grabación
    moveTo(0.5);
    frameAt(1, false);

    expect(clipFor(store.project, channelId)).toBeUndefined();
  });
});
