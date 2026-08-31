/**
 * La ventana entre SUBIR el audio y REGISTRARLO, en el editor de audio.
 *
 * `runOp` (Normalizar / Reverse / Fades) y `runTune` (Afinar) escriben un sample
 * NUEVO: lo suben al motor con `engine.loadSample(id, wav)` y solo después lo
 * meten en el modelo con `registerSample`. Entre esas dos líneas ese id no lo
 * nombra NADA —ni un canal, ni un clip, ni el registro del proyecto—, así que
 * `sampleKeepSet` no lo incluye y un `collectSessionSamples()` que caiga ahí en
 * medio le dice al motor que lo suelte. El dispatch llega después, el clip queda
 * apuntando a un sample que el motor ya no tiene, y el usuario se encuentra un
 * clip MUDO hasta reabrir el proyecto: es el único de los tres huecos de esta
 * tarjeta que puede perder audio del usuario.
 *
 * Y no es una ventana teórica de "el mismo tick": dentro hay dos `await` que
 * ceden el hilo de verdad —`decodeAudioData` en `loadSample` y
 * `crypto.subtle.digest` en `sha1Hex`— y el Ctrl+Z de `useShortcuts` llama a
 * `collectSessionSamples()` sin preguntarle a nadie.
 *
 * Se prueba con el store y el motor REALES (como `sample-gc-session.test.ts`):
 *
 *  1. Con la sujeción, un `collectSessionSamples()` justo en la ventana deja el
 *     audio donde estaba.
 *  2. El control: SIN sujeción se lo lleva — si algún día alguien quita el
 *     `withPinnedSample`, este test es el que dice qué se rompió.
 *  3. La sujeción se suelta aunque la operación reviente (un pin que se queda
 *     puesto es la fuga contraria, y sería nueva).
 *  4. Y el componente de verdad pasa por ahí: los DOS `loadSample` del archivo
 *     están dentro de un bloque sujeto que se cierra DESPUÉS del dispatch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SampleRef } from '@orbit/core';
import type { AudioEngine } from '@orbit/engine';
import { readSource } from './read-source';

/** Extraído a función aparte para que TS infiera la sobrecarga de método. */
function spyOnSend(engine: AudioEngine) {
  return vi.spyOn(engine, 'send');
}
type SendSpy = ReturnType<typeof spyOnSend>;

function ref(id: string): SampleRef {
  return { id, name: id, path: `recording:${id}.wav`, hash: `h-${id}`, duration: 1 };
}

/** El último `keep` que se le mandó al motor vía `collectSamples`. */
function lastKeep(send: SendSpy): readonly string[] {
  const calls = send.mock.calls.filter(([msg]) => msg.type === 'collectSamples');
  const last = calls.at(-1)?.[0];
  return last && last.type === 'collectSamples' ? last.keep : [];
}

/**
 * El `loadedSamples` del motor real: la caché de "esto ya está arriba" que
 * `keepOnlySamples` vacía. Si el id sale de ahí, el audio se perdió — el próximo
 * `loadSample` de ese id tendría que volver a subirlo, y en esta sesión ya no lo
 * llama nadie.
 */
function loaded(engine: AudioEngine): Set<string> {
  return (engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
}

async function freshRig() {
  vi.resetModules();
  vi.stubGlobal('window', {});
  const core = await import('@orbit/core');
  const { engine, store } = await import('../src/state/app');
  const soundActions = await import('../src/browser/sound-actions');
  const gc = await import('../src/state/sample-gc');
  const send = spyOnSend(engine);

  // El mundo del editor: un clip de audio en la playlist con su toma original.
  store.dispatch({ type: 'registerSample', sample: ref('toma') });
  const trackId = Object.keys(store.project.playlistTracks)[0]!;
  const clipId = core.newId();
  store.dispatch({
    type: 'addClips',
    clips: [
      {
        id: clipId,
        kind: 'audio' as const,
        playlistTrackId: trackId,
        start: 0,
        length: 4,
        muted: false,
        sampleId: 'toma',
      },
    ],
  });
  return { core, engine, store, soundActions, gc, send, clipId };
}

type Rig = Awaited<ReturnType<typeof freshRig>>;

/**
 * Los pasos de `runOp` en el mismo orden que el componente, con un hueco donde
 * meterle a otro origen su recolección.
 *
 * `engine.loadSample` de verdad necesita un AudioContext que en Node no existe,
 * así que aquí se deja el MISMO estado que deja la de verdad (el id en
 * `loadedSamples`, el audio ya en el kernel), que es exactamente lo que un
 * collect borra. Lo que se prueba es la sujeción, no el decodificador.
 */
async function runOpLikeEditor(
  rig: Rig,
  opts: { sujeto: boolean; enLaVentana?: () => void; revienta?: boolean },
): Promise<string> {
  const { core, engine, store, gc, clipId } = rig;
  const newSampleId = core.newId();
  const pasos = async () => {
    loaded(engine).add(newSampleId);
    // El `await sha1Hex(wavBuf)` del editor: aquí es donde entra el Ctrl+Z.
    await Promise.resolve();
    opts.enLaVentana?.();
    if (opts.revienta) throw new Error('la operación falló a mitad');
    const label = 'Normalizar "toma"';
    store.dispatch(
      {
        type: 'batch',
        label,
        commands: [
          { type: 'registerSample', sample: ref(newSampleId) },
          { type: 'patchClips', patches: [{ id: clipId, sampleId: newSampleId }] },
        ],
      },
      { label },
    );
  };
  if (opts.sujeto) await gc.withPinnedSample(newSampleId, pasos);
  else await pasos();
  return newSampleId;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('un collectSessionSamples en la ventana de una operación destructiva', () => {
  it('con la sujeción, NO se lleva el audio recién subido', async () => {
    const rig = await freshRig();
    const nuevo = await runOpLikeEditor(rig, {
      sujeto: true,
      enLaVentana: () => rig.soundActions.collectSessionSamples(),
    });

    // La recolección corrió DENTRO de la ventana y aun así pidió conservarlo:
    // el pin era lo único que lo nombraba en ese instante.
    expect(lastKeep(rig.send)).toContain(nuevo);
    expect(loaded(rig.engine).has(nuevo)).toBe(true);
    // Y el resultado que ve el usuario: el clip apunta al sample nuevo y el
    // motor lo tiene.
    expect(rig.store.project.clips[rig.clipId]!.sampleId).toBe(nuevo);
    expect(rig.store.project.samples[nuevo]).toBeDefined();
    // La baja se hizo sola: un pin que se queda puesto sería la fuga contraria.
    expect(rig.gc.pinnedSamples()).not.toContain(nuevo);
  });

  it('SIN la sujeción se lo lleva y el clip queda mudo (el control que le da valor al test de arriba)', async () => {
    const rig = await freshRig();
    const nuevo = await runOpLikeEditor(rig, {
      sujeto: false,
      enLaVentana: () => rig.soundActions.collectSessionSamples(),
    });

    // Esto es el bug: nada nombraba ese id cuando pasó la recolección.
    expect(lastKeep(rig.send)).not.toContain(nuevo);
    expect(loaded(rig.engine).has(nuevo)).toBe(false);
    // El modelo queda perfecto y el sonido no: el clip apunta a un sample que
    // el motor ya no tiene, y nadie lo vuelve a subir en esta sesión.
    expect(rig.store.project.clips[rig.clipId]!.sampleId).toBe(nuevo);
    expect(rig.store.project.samples[nuevo]).toBeDefined();
  });

  it('sin nadie recolectando, sujetar no cambia el flujo normal', async () => {
    const rig = await freshRig();
    const nuevo = await runOpLikeEditor(rig, { sujeto: true });
    expect(loaded(rig.engine).has(nuevo)).toBe(true);
    expect(rig.store.project.clips[rig.clipId]!.sampleId).toBe(nuevo);
    expect(rig.gc.pinnedSamples()).toEqual([]);
  });

  it('si la operación revienta a mitad, la sujeción se suelta igual', async () => {
    const rig = await freshRig();
    await expect(runOpLikeEditor(rig, { sujeto: true, revienta: true })).rejects.toThrow();

    // Nada sujeto: sin el `finally` de `withPinnedSample`, ese id quedaría
    // protegido para siempre y el audio de un Normalizar fallido no se soltaría
    // jamás — la misma fuga, del otro lado.
    expect(rig.gc.pinnedSamples()).toEqual([]);
    rig.soundActions.collectSessionSamples();
    expect(lastKeep(rig.send)).toContain('toma');
  });
});

// ── Que el componente de verdad pase por ahí ────────────────────────────────

describe('AudioEditor.tsx sujeta de verdad, y hasta después del dispatch', () => {
  const file = readSource('editors/audio/AudioEditor.tsx');

  /**
   * Los bloques `withPinnedSample(...)` del archivo, cortados por la sangría de
   * su propia línea: así se puede afirmar qué queda DENTRO del pin, que es lo
   * único que importa — sujetar y soltar antes del dispatch no arregla nada.
   */
  function bloquesSujetos(src: string): string[] {
    const out: string[] = [];
    for (
      let at = src.indexOf('withPinnedSample(');
      at >= 0;
      at = src.indexOf('withPinnedSample(', at + 1)
    ) {
      const lineStart = src.lastIndexOf('\n', at) + 1;
      const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
      const close = src.indexOf(`\n${indent}});`, at);
      expect(close).toBeGreaterThan(at);
      out.push(src.slice(at, close));
    }
    return out;
  }

  it('los dos loadSample del editor están dentro de un bloque sujeto', () => {
    const bloques = bloquesSujetos(file);
    expect(bloques).toHaveLength(2); // runOp y runTune
    // Si mañana alguien añade una tercera operación destructiva sin sujetarla,
    // esta cuenta deja de cuadrar antes de que se note como un clip mudo.
    expect(file.split('engine.loadSample(').length - 1).toBe(bloques.length);
    for (const bloque of bloques) expect(bloque).toContain('engine.loadSample(');
  });

  it('el pin se suelta DESPUÉS del registerSample, no antes', () => {
    for (const bloque of bloquesSujetos(file)) {
      expect(bloque).toContain("type: 'registerSample'");
      expect(bloque.indexOf('engine.loadSample(')).toBeLessThan(
        bloque.indexOf("type: 'registerSample'"),
      );
    }
  });

  it('usa withPinnedSample (con su finally), no un pinSample suelto', () => {
    expect(file).toContain('withPinnedSample');
    // Un `pinSample` a mano dependería de que no haya una excepción en medio.
    expect(file).not.toMatch(/\bpinSample\(/);
  });
});

// ── El segundo hueco: el editor que se cierra ───────────────────────────────

/**
 * La caché PCM del editor no tenía baja de CONSUMIDOR: al cerrar la ventana sus
 * dos entradas seguían ahí esperando al próximo cambio de proyecto, que es el
 * barrido de otra cosa. Con el tope de recencia son ~23 MB en el peor caso y no
 * crecen, así que en bytes es cosmético; lo que no es cosmético es el patrón,
 * que la próxima caché sin tope hereda tal cual.
 */
describe('el editor de audio recolecta al cerrarse', () => {
  it('clear() suelta todo y dice cuánto soltó', async () => {
    vi.resetModules();
    const { AUDIO_EDITOR_PCM_ENTRIES, createUiAudioCache, sampleCacheKey } = await import(
      '../src/state/sample-gc'
    );
    // Idéntica a la del editor: mismo tope, mismo contador de bytes.
    const pcm = createUiAudioCache<{ left: Float32Array; right: Float32Array }>({
      name: 'editor-pcm',
      capacity: AUDIO_EDITOR_PCM_ENTRIES,
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });
    const buf = () => ({ left: new Float32Array(48000), right: new Float32Array(48000) });
    pcm.set(sampleCacheKey('a', 'ha'), buf());
    pcm.set(sampleCacheKey('b', 'hb'), buf());
    const lleno = pcm.stats();
    expect(lleno.entries).toBe(2);

    // Se cierra la ventana: el único lector de esta caché se fue.
    expect(pcm.clear()).toEqual(lleno);
    expect(pcm.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('el clear va en el desmontaje, NO en el cleanup del efecto que carga', () => {
    const file = readSource('editors/audio/AudioEditor.tsx');
    // Un solo sitio, y con deps vacías: en un `useEffect([sample])` correría en
    // CADA cambio de sample y tiraría justo el par que el tope de recencia
    // existe para conservar (Normalizar y el Ctrl+Z de después).
    expect(file.split('pcmCache.clear()').length - 1).toBe(1);
    expect(file).toMatch(/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*pcmCache\.clear\(\);\s*\},\s*\[\],?\s*\)/);
    const carga = file.slice(file.indexOf('let alive = true;'), file.indexOf('}, [sample]);'));
    expect(carga).not.toContain('pcmCache.clear');
  });
});
