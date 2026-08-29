/**
 * `collectSessionSamples()`: la mitad de la recolección que faltaba en una
 * sesión de trabajo normal (auditoría v3.5, tarea db8986f2 / ac6c9c8f) —
 * `rehydrateSamples()` solo se disparaba al REEMPLAZAR el proyecto entero
 * (abrir, plantilla, autosave, restaurar versión); nada soltaba memoria al
 * borrar un canal, deshacer o rehacer DENTRO de la misma sesión.
 *
 * Lo que se prueba, con el store y el motor de la app REALES (no de mentira):
 *
 *  1. Un sample que nunca se registró (el preview del Explorador,
 *     `loadIntoEngine`) se suelta en cuanto algo dispara la recolección —esto
 *     solo con arreglar el disparo (bug #1 de la auditoría) ya lo arregla.
 *  2. Un sample REGISTRADO que se queda sin nadie que lo nombre NO se suelta
 *     de inmediato: sigue vivo en el inverso de la propia entrada de undo
 *     que lo dejó huérfano (bug #2: antes de esto, tampoco se soltaba nunca,
 *     ni siquiera cuando ya no había forma de deshacer hacia él).
 *  3. Una vez esa entrada cae del historial de verdad, SÍ se suelta.
 *  4. Un sample que usan DOS canales, uno en un CLIP de audio, o uno con un
 *     preview EN VUELO (pin) sobrevive a borrar lo que ya no lo necesita —
 *     nunca se suelta lo que sigue en uso por otro canal, clip o preview.
 *  5. El propio mecanismo de desregistro (origin 'gc') no rompe el redo del
 *     usuario — la razón de por qué NO usa origin 'local'.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SampleRef } from '@orbit/core';
import type { AudioEngine } from '@orbit/engine';

/** Extraído a función aparte para que TS infiera la sobrecarga de método (no la de getter). */
function spyOnSend(engine: AudioEngine) {
  return vi.spyOn(engine, 'send');
}
type SendSpy = ReturnType<typeof spyOnSend>;

function ref(id: string): SampleRef {
  return { id, name: id, path: `qa:${id}`, hash: id, duration: 1 };
}

async function freshRig() {
  vi.resetModules();
  vi.stubGlobal('window', {});
  const core = await import('@orbit/core');
  const { engine, store } = await import('../src/state/app');
  const soundActions = await import('../src/browser/sound-actions');
  const send = spyOnSend(engine);
  return { core, engine, store, soundActions, send };
}

/** El último `keep` que se le mandó al motor vía `collectSamples`. */
function lastKeep(send: SendSpy): readonly string[] {
  const calls = send.mock.calls.filter(([msg]) => msg.type === 'collectSamples');
  const last = calls.at(-1)?.[0];
  return last && last.type === 'collectSamples' ? last.keep : [];
}

describe('collectSessionSamples: flujo real de sesión', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('un sample sin registrar (preview) se suelta en cuanto se borra CUALQUIER canal', async () => {
    const { core, engine, store, soundActions, send } = await freshRig();
    // Simula `loadIntoEngine`: subido al motor, nunca registrado en el
    // proyecto — como escuchar un sonido en el Explorador sin llegar a usarlo.
    (engine as unknown as { loadedSamples: Set<string> }).loadedSamples.add('preview-x');

    const channel = core.createChannel('synth', 0, 'Lead'); // sin sampleId: no lo nombra
    store.dispatch({ type: 'addChannel', channel });
    store.dispatch({ type: 'removeChannel', channelId: channel.id });
    soundActions.collectSessionSamples();

    expect(lastKeep(send)).not.toContain('preview-x');
    expect(
      (engine as unknown as { loadedSamples: Set<string> }).loadedSamples.has('preview-x'),
    ).toBe(false);
  });

  it('un sample REGISTRADO que un canal deja huérfano NO se suelta de inmediato (undo lo puede devolver)', async () => {
    const { core, store, soundActions, send } = await freshRig();
    const channel = core.createChannel('sampler', 0, 'Uno');
    store.dispatch({ type: 'addChannel', channel });
    store.dispatch({ type: 'registerSample', sample: ref('huerfano-1') });
    store.dispatch({
      type: 'patchChannel',
      channelId: channel.id,
      patch: { sampleId: 'huerfano-1' },
    });

    store.dispatch({ type: 'removeChannel', channelId: channel.id });
    soundActions.collectSessionSamples();

    // Sigue registrado (el registro es lo que permite reconstruirlo) y sigue
    // en el `keep` que se le manda al motor: la entrada de undo que acaba de
    // crear `removeChannel` guarda el canal ENTERO con su `sampleId`.
    expect(store.project.samples['huerfano-1']).toBeDefined();
    expect(lastKeep(send)).toContain('huerfano-1');
  });

  it('una vez esa entrada cae del historial (tope de 500), el siguiente ciclo SÍ lo suelta', async () => {
    const { core, store, soundActions, send } = await freshRig();
    const channel = core.createChannel('sampler', 0, 'Uno');
    store.dispatch({ type: 'addChannel', channel });
    store.dispatch({ type: 'registerSample', sample: ref('huerfano-2') });
    store.dispatch({
      type: 'patchChannel',
      channelId: channel.id,
      patch: { sampleId: 'huerfano-2' },
    });
    store.dispatch({ type: 'removeChannel', channelId: channel.id });
    soundActions.collectSessionSamples();
    expect(lastKeep(send)).toContain('huerfano-2');

    // Relleno hasta que la entrada del borrado cae de la ventana de 500.
    for (let i = 0; i < 500; i++) {
      store.dispatch({ type: 'setTempo', tempo: 100 + (i % 10) });
    }
    soundActions.collectSessionSamples();

    expect(store.project.samples['huerfano-2']).toBeUndefined();
    expect(lastKeep(send)).not.toContain('huerfano-2');
  });

  it('un sample que usan DOS canales sobrevive a borrar uno de los dos', async () => {
    const { core, store, soundActions, send } = await freshRig();
    const a = core.createChannel('sampler', 0, 'A');
    const b = core.createChannel('sampler', 1, 'B');
    store.dispatch({ type: 'addChannel', channel: a });
    store.dispatch({ type: 'addChannel', channel: b });
    store.dispatch({ type: 'registerSample', sample: ref('compartido') });
    store.dispatch({ type: 'patchChannel', channelId: a.id, patch: { sampleId: 'compartido' } });
    store.dispatch({ type: 'patchChannel', channelId: b.id, patch: { sampleId: 'compartido' } });

    store.dispatch({ type: 'removeChannel', channelId: a.id });
    soundActions.collectSessionSamples();

    // B lo sigue usando: nunca fue candidato a huérfano.
    expect(store.project.samples['compartido']).toBeDefined();
    expect(lastKeep(send)).toContain('compartido');

    // Y sigue vivo incluso mucho más tarde (no es cuestión de ventana de undo:
    // sigue habiendo un canal de verdad que lo nombra).
    for (let i = 0; i < 500; i++) {
      store.dispatch({ type: 'setTempo', tempo: 100 + (i % 10) });
    }
    soundActions.collectSessionSamples();
    expect(store.project.samples['compartido']).toBeDefined();
    expect(lastKeep(send)).toContain('compartido');
  });

  it('un sample que sigue en un CLIP de audio sobrevive a borrar el canal que lo compartía', async () => {
    const { core, store, soundActions, send } = await freshRig();
    const channel = core.createChannel('sampler', 0, 'Uno');
    store.dispatch({ type: 'addChannel', channel });
    store.dispatch({ type: 'registerSample', sample: ref('en-clip') });
    store.dispatch({ type: 'patchChannel', channelId: channel.id, patch: { sampleId: 'en-clip' } });
    const trackId = Object.keys(store.project.playlistTracks)[0]!;
    store.dispatch({
      type: 'addClips',
      clips: [
        {
          id: core.newId(),
          kind: 'audio',
          playlistTrackId: trackId,
          start: 0,
          length: 4,
          muted: false,
          sampleId: 'en-clip',
        },
      ],
    });

    store.dispatch({ type: 'removeChannel', channelId: channel.id });
    soundActions.collectSessionSamples();

    // El clip lo sigue nombrando: nunca fue candidato a huérfano.
    expect(store.project.samples['en-clip']).toBeDefined();
    expect(lastKeep(send)).toContain('en-clip');
  });

  it('un sample con un preview EN VUELO (pin) no se suelta aunque nada del proyecto lo use', async () => {
    const { store, soundActions, send } = await freshRig();
    const gc = await import('../src/state/sample-gc');
    store.dispatch({ type: 'registerSample', sample: ref('en-vuelo') });
    gc.pinSample('en-vuelo');
    try {
      soundActions.collectSessionSamples();
      expect(lastKeep(send)).toContain('en-vuelo');
      // Y sin registro siquiera, el pin solo basta para protegerlo.
      expect(store.project.samples['en-vuelo']).toBeDefined();
    } finally {
      gc.unpinSample('en-vuelo');
    }
  });

  it('desregistrar un huérfano (origin "gc") no le come el redo al usuario', async () => {
    const { core, store, soundActions } = await freshRig();
    // Un huérfano YA inalcanzable por undo, de sesiones/limpiezas anteriores:
    // basta con que exista un registro sin ninguna referencia y sin ninguna
    // entrada de historial que lo mencione.
    store.dispatch({ type: 'registerSample', sample: ref('viejo-suelto') });
    for (let i = 0; i < 500; i++) {
      store.dispatch({ type: 'setTempo', tempo: 100 + (i % 10) });
    }

    // El usuario hace SU cambio, lo deshace, y todavía no ha hecho nada más:
    // Ctrl+Y tiene que devolvérselo intacto.
    const channel = core.createChannel('synth', 0, 'Lead');
    store.dispatch({ type: 'addChannel', channel }, { label: 'Añadir Lead' });
    store.undo();
    expect(store.project.channels[channel.id]).toBeUndefined();

    // La recolección en sesión corre (como tras un Ctrl+Z real) y de paso
    // desregistra 'viejo-suelto', que ya nadie puede alcanzar.
    soundActions.collectSessionSamples();
    expect(store.project.samples['viejo-suelto']).toBeUndefined();

    // El redo del usuario sigue disponible pese a la limpieza intercalada.
    expect(store.redo()).toBe(true);
    expect(store.project.channels[channel.id]).toBeDefined();
  });
});
