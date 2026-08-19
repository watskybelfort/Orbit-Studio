/**
 * Loop v1: el bloque en el que el loop da la vuelta.
 *
 * Las NOTAS ya se disparaban en dos tramos (`triggerRange` se llama dos veces),
 * pero los clips de audio recorrían el bloque como si fuese un tramo contiguo y
 * reconstruían su arranque con `this.posBeats - blockBeats`. Al envolver,
 * `posBeats` ya es el beat de DESPUÉS del salto, así que esa resta apunta a un
 * tramo que nadie ha tocado: las muestras que quedaban por delante del salto se
 * perdían. Con un loop de 4 beats a 120 BPM (88 200 muestras, que no es
 * múltiplo de 128) el hueco crecía vuelta a vuelta —8, 16, 24… hasta 128— y se
 * oía un corte en CADA vuelta.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import type { CompiledProject } from '../src/protocol';

const SR = 44100;
/** A 120 BPM un beat es medio segundo: 22 050 muestras. */
const SAMPLES_PER_BEAT = SR / 2;

/** Un clip de audio de `beats` beats en el master, leyendo el sample `dc`. */
function clipProject(beats: number, sampleId = 'dc'): CompiledProject {
  const p = createEmptyProject('Loop');
  p.tempo = 120;
  const trackId = Object.values(p.playlistTracks).find(
    (t) => t.arrangementId === p.activeArrangementId,
  )!.id;
  applyCommand(p, {
    type: 'registerSample',
    sample: {
      id: sampleId,
      name: sampleId,
      path: `qa:${sampleId}`,
      hash: 'x',
      duration: SAMPLE_SECONDS,
    },
  });
  applyCommand(p, {
    type: 'addClips',
    clips: [
      {
        id: 'clip1',
        kind: 'audio',
        playlistTrackId: trackId,
        start: 0,
        length: beats,
        muted: false,
        sampleId,
      },
    ],
  });
  return compileProject(p, { mode: 'song' });
}

/** Segundos de sample: más largo que cualquier clip de aquí. */
const SAMPLE_SECONDS = 10;

/**
 * `dc`: corriente continua a 1 — cualquier bajón es un HUECO.
 * `ramp`: rampa lineal 0→1 — cada instante del sample tiene un valor distinto,
 * así que leer por donde no toca se ve como un salto de nivel. Hace falta
 * porque con el DC un error de POSICIÓN es invisible: todo vale lo mismo.
 */
function samples(): Record<string, { left: Float32Array; right: Float32Array; rate: number }> {
  const n = SR * SAMPLE_SECONDS;
  const dc = new Float32Array(n).fill(1);
  const ramp = new Float32Array(n);
  for (let i = 0; i < n; i++) ramp[i] = i / n;
  return {
    dc: { left: dc, right: dc.slice(), rate: SR },
    ramp: { left: ramp, right: ramp.slice(), rate: SR },
  };
}

interface LoopRun {
  loopStart: number;
  loopEnd: number;
  laps: number;
  metronome?: boolean;
  project: CompiledProject;
}

/** Corre el kernel en loop y devuelve el canal izquierdo entero. */
function runLooped(opts: LoopRun): Float32Array {
  const core = new KernelCore(SR);
  for (const [id, s] of Object.entries(samples())) {
    core.handleMessage({
      type: 'loadSample',
      sampleId: id,
      left: s.left,
      right: s.right,
      sampleRate: s.rate,
    });
  }
  core.handleMessage({ type: 'snapshot', project: opts.project });
  core.handleMessage({ type: 'setLoop', start: opts.loopStart, end: opts.loopEnd, enabled: true });
  if (opts.metronome) core.handleMessage({ type: 'setMetronome', enabled: true });
  core.handleMessage({ type: 'play', fromBeat: opts.loopStart });

  const lapSamples = (opts.loopEnd - opts.loopStart) * SAMPLES_PER_BEAT;
  // Un bloque menos que las vueltas pedidas: así el recorrido termina SIEMPRE
  // dentro de la última vuelta y no se cuela el arranque de la siguiente.
  const blocks = Math.max(1, Math.floor((lapSamples * opts.laps) / MAX_BLOCK) - 1);
  const out = new Float32Array(blocks * MAX_BLOCK);
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < blocks; b++) {
    core.process(l, r, MAX_BLOCK);
    out.set(l, b * MAX_BLOCK);
  }
  core.dispose();
  return out;
}

/** Tramos seguidos por debajo de `floor` (en valor absoluto), a partir de `from`. */
function silentRuns(xs: Float32Array, floor: number, from: number): { at: number; len: number }[] {
  const runs: { at: number; len: number }[] = [];
  let i = from;
  while (i < xs.length) {
    if (Math.abs(xs[i]!) >= floor) {
      i++;
      continue;
    }
    const at = i;
    while (i < xs.length && Math.abs(xs[i]!) < floor) i++;
    runs.push({ at, len: i - at });
  }
  return runs;
}

/** Muestra en la que arranca cada ráfaga de sonido (los clicks van separados). */
function onsets(xs: Float32Array, gate: number): number[] {
  const found: number[] = [];
  let quiet = xs.length;
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i]!) >= gate) {
      if (quiet > SR * 0.1) found.push(i);
      quiet = 0;
    } else {
      quiet++;
    }
  }
  return found;
}

/** El nivel al que suena el DC (no se ata al fader del master). */
function levelOf(xs: Float32Array): number {
  let level = 0;
  for (let i = 0; i < xs.length; i++) level = Math.max(level, Math.abs(xs[i]!));
  return level;
}

describe('loop: clips de audio en la vuelta', () => {
  it('no deja ni un hueco al envolver, vuelta tras vuelta', () => {
    const out = runLooped({ project: clipProject(4), loopStart: 0, loopEnd: 4, laps: 4 });
    // El clip es DC=1: cualquier bajón es un hueco. Se salta el primer bloque
    // (arranque) y se mide contra la mitad del nivel real.
    const level = levelOf(out);
    expect(level).toBeGreaterThan(0.5);
    expect(silentRuns(out, level * 0.5, MAX_BLOCK)).toEqual([]);
  });

  it('con región que no empieza en 0, antes del salto suena el FINAL de la región', () => {
    // loopStart = 2 obliga a que el tramo de después del salto arranque en un
    // beat que no es cero. Ahí el cálculo viejo no dejaba un hueco (el clip
    // sigue habiendo audio) sino algo peor de ver: leía por donde no tocaba, un
    // salto ATRÁS de hasta un bloque. Con la rampa se mide directamente.
    const laps = 3;
    const out = runLooped({
      project: clipProject(8, 'ramp'),
      loopStart: 2,
      loopEnd: 6,
      laps,
    });
    // La rampa vale t / SAMPLE_SECONDS, y el beat b del clip cae en t = b / 2 s:
    // el beat 2 vale 0.10 y el beat 6, 0.30.
    const lap = 4 * SAMPLES_PER_BEAT;
    for (let k = 1; k < laps; k++) {
      const w = lap * k;
      // Justo ANTES del salto tiene que sonar el final de la región (0.30), no
      // el principio (0.10), que es lo que devolvía la cuenta vieja.
      expect(out[w - 1]! / out[w + 64]!).toBeGreaterThan(2.5);
    }
  });

  it('la señal sigue entera en la última vuelta (el hueco no se tapó apagando el clip)', () => {
    const out = runLooped({ project: clipProject(4), loopStart: 0, loopEnd: 4, laps: 4 });
    const lap = 4 * SAMPLES_PER_BEAT;
    const from = Math.round(lap * 3.4);
    const to = Math.round(lap * 3.6);
    let sum = 0;
    for (let i = from; i < to; i++) sum += Math.abs(out[i]!);
    expect(sum / (to - from)).toBeGreaterThan(0.5);
  });

  /**
   * El metrónomo comparte el troceado, pero su fórmula vieja se cancelaba sola:
   * `posBeats - blockBeats + i·spb` cruza el cero justo en la muestra del salto,
   * así que los clicks ya caían donde tocaba. Esto NO falla sin el arreglo — es
   * la red que impide que el troceado nuevo los descoloque.
   */
  it('el metrónomo sigue clavando un click por beat, también al envolver', () => {
    const p = createEmptyProject('Click');
    p.tempo = 120;
    const laps = 3;
    const out = runLooped({
      project: compileProject(p, { mode: 'song' }),
      loopStart: 0,
      loopEnd: 4,
      laps,
      metronome: true,
    });
    const found = onsets(out, 0.02);
    expect(found).toHaveLength(4 * laps);
    // Y en la rejilla exacta: un beat cada 22 050 muestras, sin deriva.
    for (let k = 0; k < found.length; k++) {
      expect(found[k]).toBe(k * SAMPLES_PER_BEAT);
    }
  });
});
