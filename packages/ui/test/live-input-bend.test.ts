/**
 * El gesto de la rueda de tono, de punta a punta: `live-input.ts` cableado a
 * un MIDI y un DOM de mentira, no las piezas sueltas de `midi-message.ts`
 * (eso ya lo cubre `bend-wheel.test.ts`).
 *
 * La rueda va por DOS caminos a la vez (ver el comentario largo encima de
 * `dumpBend` en el propio archivo):
 *
 * - al motor, DIRECTO y en cada mensaje — es un gesto, no puede haber ni un
 *   frame entre mover la rueda y oír el doblez;
 * - al proyecto, una vez por frame con `mergeKey` — así sesenta mensajes por
 *   segundo son UN paso de undo y no sesenta.
 *
 * Y falta la mitad que no se ve si no se prueba: **soltar la rueda también se
 * graba**. Si el volcado al soltar se rompe, la curva se queda colgada arriba
 * y la nota siguiente nace doblada — un bug mudo, no una excepción.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** Los 3 bytes de un pitch bend MIDI de fábrica, canal 1, bipolar -1..1. */
function pitchBendBytes(value: number): Uint8Array {
  const raw = Math.round(8192 + Math.min(1, Math.max(-1, value)) * 8192);
  const clamped = Math.min(16383, Math.max(0, raw));
  return new Uint8Array([0xe0, clamped & 0x7f, (clamped >> 7) & 0x7f]);
}

interface Rig {
  store: Awaited<ReturnType<typeof importApp>>['store'];
  channelId: string;
  send: (value: number) => void;
  /** Los manejadores que `initLiveInput()` registró en el `window` de mentira. */
  fire: (type: string) => void;
}

async function importApp() {
  return import('../src/state/app');
}

/**
 * Un `live-input` recién nacido, con un controlador MIDI de mentira ya
 * conectado y un canal al que apunta (el último del proyecto, que es a lo que
 * cae `targetChannel()` sin nada seleccionado en el piano roll).
 *
 * `vi.resetModules()` hace falta porque `initLiveInput()` solo arma una vez
 * por instancia de módulo (`wired`): sin reset, el segundo test heredaría el
 * cableado — y el estado (`bentChannel`, etc.) — del primero.
 */
async function rig(): Promise<Rig> {
  vi.resetModules();

  const listeners = new Map<string, (e: unknown) => void>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  vi.stubGlobal('document', { activeElement: null });

  const fakeInput: { id: string; name: string; onmidimessage: ((e: unknown) => void) | null } = {
    id: 'dev1',
    name: 'Controlador de mentira',
    onmidimessage: null,
  };
  const access = { inputs: new Map([['dev1', fakeInput]]), onstatechange: null as unknown };
  // `navigator` ya existe como global de solo lectura en Node: no se puede
  // asignar directo, hace falta `vi.stubGlobal` (que sí sabe reemplazarlo).
  vi.stubGlobal('navigator', {
    requestMIDIAccess: () => Promise.resolve(access),
  });

  const core = await import('@orbit/core');
  const { store, engine } = await importApp();
  // El gesto llama `ensureAudioReady()`, que arranca un AudioContext de
  // verdad — no existe en Node. Se sustituye por uno que resuelve ya: lo que
  // se prueba aquí es el camino de datos, no el arranque del audio.
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);

  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const live = await import('../src/state/live-input');
  live.initLiveInput();

  // La resolución de `requestMIDIAccess()` es una promesa: dejarla asentar.
  await Promise.resolve();
  await Promise.resolve();

  const send = (value: number): void => {
    fakeInput.onmidimessage?.({ data: pitchBendBytes(value), timeStamp: 0 });
  };
  const fire = (type: string): void => {
    listeners.get(type)?.({ type });
  };

  return { store, channelId: channel.id, send, fire };
}

/** Dispara la rutina de la fila 16 (setTimeout de 16 ms: no hay rAF en Node). */
async function nextFrame(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

describe('la rueda de tono: motor en cada mensaje, proyecto una vez por frame', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('el motor oye los tres mensajes; el proyecto solo el frame', async () => {
    const { store, channelId, send } = await rig();
    const app = await importApp();
    const pitchBend = vi.spyOn(app.engine, 'pitchBend');
    const dispatch = vi.spyOn(store, 'dispatch');

    // Un barrido: tres mensajes de un solo gesto, sin ceder el turno entre
    // ellos (así llegaría de verdad un mando físico).
    send(0.3);
    send(0.7);
    send(1.0); // rango de fábrica = 2 semitonos → +2 a tope

    // El motor es el camino "ya": si esto pide menos de tres llamadas, algún
    // mensaje se está perdiendo antes de llegar al oído.
    expect(pitchBend).toHaveBeenCalledTimes(3);
    // Precisión de 14 bits del MIDI real (8192 pasos), no números exactos.
    const semitonos = pitchBend.mock.calls.map((c) => c[1] as number);
    [0.6, 1.4, 2].forEach((esperado, i) => expect(semitonos[i]).toBeCloseTo(esperado, 2));

    // Antes del frame: el proyecto todavía no se enteró. Si esto disparara ya,
    // el mergeKey no estaría haciendo su trabajo (sesenta despachos/seg).
    expect(dispatch).not.toHaveBeenCalled();

    await nextFrame();

    // Un solo despacho para los tres mensajes — y con el ÚLTIMO valor, no un
    // promedio ni el primero.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(store.project.channels[channelId]?.bend).toBeCloseTo(2, 2);
  });

  it('volver al centro se escribe: la curva no se queda colgada arriba', async () => {
    const { store, channelId, send } = await rig();

    send(0.9);
    await nextFrame();
    expect(store.project.channels[channelId]?.bend).toBeGreaterThan(0);

    // La rueda física vuelve sola al centro y manda su propio pitch bend: no
    // hace falta que nadie "suelte" nada a propósito.
    send(0);
    await nextFrame();

    // Si el volcado al soltar se rompiera, `bend` seguiría en el valor de
    // arriba: la nota siguiente nacería doblada sin que nada lo avisara.
    expect(store.project.channels[channelId]?.bend).toBe(0);
  });

  it('soltar por perder el foco (alt-tab) también recentra y lo graba', async () => {
    const { store, channelId, send, fire } = await rig();

    send(0.9);
    await nextFrame();
    expect(store.project.channels[channelId]?.bend).toBeGreaterThan(0);

    // No todo el mundo deja la rueda en el centro antes de soltarla: alt-tab
    // (blur de la ventana) es el otro disparador de `releaseAll()` →
    // `recenterBend()`, y sin él el canal se quedaría desafinado esperando un
    // mensaje que igual no llega nunca.
    fire('blur');
    await nextFrame();

    expect(store.project.channels[channelId]?.bend).toBe(0);
  });

  it('todo el barrido (arriba y de vuelta al centro) es UN solo paso de undo', async () => {
    const { store, channelId, send } = await rig();
    const before = store.history.length;

    send(0.9);
    await nextFrame();
    send(0);
    await nextFrame();

    // El mergeKey ('bend:<canal>') fusiona los dos frames en la MISMA entrada:
    // un solo Ctrl+Z, no uno por frame.
    expect(store.history.length).toBe(before + 1);

    store.undo();
    // El deshacer vuelve a como estaba ANTES del barrido entero (sin bend),
    // no al tramo intermedio.
    expect(store.project.channels[channelId]?.bend ?? 0).toBe(0);
  });
});
