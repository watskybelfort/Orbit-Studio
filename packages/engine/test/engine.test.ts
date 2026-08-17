import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createLfo,
  createPattern,
  defaultEffectParams,
  newId,
  type Lfo,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject, topoOrder } from '../src/compile';
import { KernelCore, MAX_BLOCK, evalLut, invertLut, lfoWave } from '../src/kernel-core';
import { renderProject } from '../src/render/offline';
import { analyzeMix } from '../src/render/analysis';
import { encodeWav } from '../src/render/wav';

function note(start: number, duration: number, key: number, extra: Partial<Note> = {}): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false, ...extra };
}

/** Proyecto demo trap: 808 con slide, drums, supersaw, sidechain y limiter. */
function demoProject(): Project {
  const p = createEmptyProject('Demo trap');
  p.tempo = 140;
  const patternId = p.patternOrder[0]!;

  const sub = createChannel('sub808', 0, 'Sub');
  sub.mixerTrack = 1;
  const drums = createChannel('drums', 1, 'Drums');
  drums.mixerTrack = 2;
  const saw = createChannel('supersaw', 2, 'Saw');
  saw.mixerTrack = 3;
  saw.volume = 0.5;

  applyCommand(p, { type: 'addChannel', channel: sub });
  applyCommand(p, { type: 'addChannel', channel: drums });
  applyCommand(p, { type: 'addChannel', channel: saw });

  // 808: F1 con slide a Ab1
  applyCommand(p, {
    type: 'addNotes', patternId, channelId: sub.id,
    notes: [
      note(0, 1.5, 29),
      note(1.5, 0.5, 32, { slide: true }),
      note(2, 2, 27),
    ],
  });
  // Drums: kick (36), clap (39), hats (42)
  applyCommand(p, {
    type: 'addNotes', patternId, channelId: drums.id,
    notes: [
      note(0, 0.2, 36), note(2, 0.2, 36),
      note(1, 0.2, 39), note(3, 0.2, 39),
      // Hats a 1/16 (el swing FL desplaza los 1/16 impares).
      ...Array.from({ length: 16 }, (_, i) => note(i * 0.25, 0.1, 42, { velocity: 0.5 })),
    ],
  });
  // Saw: acorde
  applyCommand(p, {
    type: 'addNotes', patternId, channelId: saw.id,
    notes: [note(0, 4, 53), note(0, 4, 56), note(0, 4, 60)],
  });

  // Mixer: compresor sidechain (fuente drums) en la pista del saw, limiter en master
  applyCommand(p, {
    type: 'setEffect', trackIndex: 3, slotIndex: 0,
    slot: {
      id: 'slot-sc', kind: 'compressor', enabled: true, mix: 1,
      params: { threshold: -30, ratio: 8, attack: 0.002, release: 0.12, knee: 3, makeup: 0 },
      sidechainSource: 2,
    },
  });
  applyCommand(p, {
    type: 'setEffect', trackIndex: 0, slotIndex: 0,
    slot: {
      id: 'slot-lim', kind: 'limiter', enabled: true, mix: 1,
      params: { gain: 3, ceiling: -0.5, release: 0.05 },
    },
  });

  // Clip en la playlist para modo song
  const trackId = Object.keys(p.playlistTracks)[0]!;
  applyCommand(p, {
    type: 'addClips',
    clips: [{
      id: newId(), kind: 'pattern', playlistTrackId: trackId,
      start: 0, length: 8, muted: false, patternId,
    }],
  });
  return p;
}

describe('compilador', () => {
  it('topoOrder: fuentes antes que destinos, master al final', () => {
    const order = topoOrder([
      { routeTo: null, sends: [] },      // 0 master
      { routeTo: 0, sends: [{ target: 2 }] }, // 1 → master + send a 2
      { routeTo: 0, sends: [] },         // 2 → master
    ]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order[order.length - 1]).toBe(0);
  });

  it('song mode: recorta notas a la ventana del clip y aplica swing', () => {
    const p = demoProject();
    p.swing = 0.5;
    const c = compileProject(p, { mode: 'song' });
    expect(c.events.length).toBeGreaterThan(10);
    expect(c.lengthBeats).toBe(8);
    // Los 1/16 impares del hat van desplazados por el swing (los pares, no).
    const hats = c.events.filter((e) => e.key === 42).sort((a, b) => a.start - b.start);
    expect(hats[0]!.start).toBeCloseTo(0, 5);
    expect(hats[1]!.start).toBeCloseTo(0.25 + 0.5 * 0.125, 5);
    expect(hats[2]!.start).toBeCloseTo(0.5, 5);
  });

  it('pattern mode: longitud redondeada a compás', () => {
    const p = demoProject();
    const c = compileProject(p, { mode: 'pattern', patternId: p.patternOrder[0]! });
    expect(c.lengthBeats).toBe(4);
  });

  it('mute de canal lo saca del render (audible=false)', () => {
    const p = demoProject();
    const chId = p.channelOrder[2]!;
    applyCommand(p, { type: 'patchChannel', channelId: chId, patch: { mute: true } });
    const c = compileProject(p, { mode: 'song' });
    expect(c.channels[2]!.audible).toBe(false);
  });
});

describe('render offline', () => {
  it('suena, sin NaN, sin clipping, y es determinista', () => {
    const p = demoProject();
    const compiled = compileProject(p, { mode: 'song' });
    const a = renderProject(compiled, { sampleRate: 44100, tailSeconds: 0.5 });
    const b = renderProject(compiled, { sampleRate: 44100, tailSeconds: 0.5 });

    expect(a.left.length).toBeGreaterThan(44100 * 3);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < a.left.length; i++) {
      const s = a.left[i]!;
      expect(Number.isNaN(s)).toBe(false);
      peak = Math.max(peak, Math.abs(s));
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / a.left.length);
    expect(peak).toBeGreaterThan(0.05); // hay señal
    expect(peak).toBeLessThanOrEqual(1.0); // limiter en master
    expect(rms).toBeGreaterThan(0.005);

    // Determinismo byte a byte.
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
    expect(Buffer.from(a.right.buffer).equals(Buffer.from(b.right.buffer))).toBe(true);
  });

  it('el sidechain agacha el saw cuando golpea el kick', () => {
    const p = demoProject();
    // Sin limiter en master: compensaría el ducking y taparía la medida.
    applyCommand(p, { type: 'setEffect', trackIndex: 0, slotIndex: 0, slot: null });
    const withSc = renderProject(compileProject(p, { mode: 'song' }), {
      sampleRate: 44100, tailSeconds: 0,
    });
    // Sin sidechain: mismo proyecto con el slot desactivado.
    applyCommand(p, {
      type: 'patchEffect', trackIndex: 3, slotIndex: 0, patch: { enabled: false },
    });
    const without = renderProject(compileProject(p, { mode: 'song' }), {
      sampleRate: 44100, tailSeconds: 0,
    });
    const rms = (x: Float32Array, from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += x[i]! * x[i]!;
      return Math.sqrt(s / (to - from));
    };
    // Ventana justo tras el kick del beat 0 (~0..60 ms).
    const win = Math.floor(0.06 * 44100);
    expect(rms(withSc.left, 0, win)).toBeLessThan(rms(without.left, 0, win));
  });

  it('analyzeMix devuelve LUFS y bandas coherentes', () => {
    const p = demoProject();
    const r = renderProject(compileProject(p, { mode: 'song' }), { sampleRate: 44100 });
    const m = analyzeMix(r.left, r.right, 44100);
    expect(m.lufsIntegrated).toBeGreaterThan(-40);
    expect(m.lufsIntegrated).toBeLessThan(0);
    expect(m.peakDb).toBeLessThanOrEqual(0);
    expect(m.bands.low).toBeGreaterThan(-30); // hay low-end (808)
    expect(Math.abs(m.stereoCorrelation)).toBeLessThanOrEqual(1);
  });

  it('encodeWav produce un RIFF válido', () => {
    const l = new Float32Array(1000).fill(0.5);
    const wav = encodeWav(l, l, 44100, 16);
    expect(wav.length).toBe(44 + 1000 * 4);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
  });
});

// ── Kernel: medidores por pista y tap del scope ──────────────────────────────

/** Proyecto sintético mínimo: un solo canal (synth) enrutado a la pista dada. */
function singleTrackProject(mixerTrack: number) {
  const p = createEmptyProject('Kernel');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('synth', 0, 'Lead');
  ch.mixerTrack = mixerTrack;
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(0, 4, 60)] });
  return compileProject(p, { mode: 'pattern', patternId });
}

/** Procesa `blocks` bloques del kernel en modo offline (descarta el audio). */
function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

describe('kernel: medidores y scope', () => {
  it('meterFrame: RMS por pista — señal en su pista, cero en las demás', () => {
    const compiled = singleTrackProject(1);
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: compiled });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 60);
    const frame = core.meterFrame();
    expect(frame.rms.length).toBe(compiled.mixer.length);
    expect(frame.rms[1]!).toBeGreaterThan(0); // la pista con la nota suena
    expect(frame.rms[2]!).toBe(0); // pista sin señal
    // El master también acumula (la pista 1 desemboca ahí) y masterRms sigue vivo.
    expect(frame.rms[0]!).toBeGreaterThan(0);
    expect(frame.masterRms[0]).toBeGreaterThan(0);
    // Emitir el frame resetea los acumuladores: sin procesar más, el RMS vuelve a 0.
    expect(core.meterFrame().rms[1]!).toBe(0);
  });

  it('setScope con trackIndex tapea esa pista (una pista muda da scope en silencio)', () => {
    const compiled = singleTrackProject(1);
    const energia = (xs: Float32Array) => {
      let s = 0;
      for (const v of xs) s += Math.abs(v);
      return s;
    };

    // Tap de la pista 1 (con señal): el scope trae samples.
    const a = new KernelCore(44100);
    a.handleMessage({ type: 'snapshot', project: compiled });
    a.handleMessage({ type: 'setScope', enabled: true, trackIndex: 1 });
    a.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(a, 60);
    const fa = a.meterFrame();
    expect(fa.scope).toBeDefined();
    expect(energia(fa.scope!)).toBeGreaterThan(0);

    // Tap de la pista 2 (sin señal): el frame trae scope, pero en silencio.
    const b = new KernelCore(44100);
    b.handleMessage({ type: 'snapshot', project: compiled });
    b.handleMessage({ type: 'setScope', enabled: true, trackIndex: 2 });
    b.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(b, 60);
    const fb = b.meterFrame();
    expect(fb.scope).toBeDefined();
    expect(energia(fb.scope!)).toBe(0);

    // Compatibilidad: sin trackIndex el tap es el master (que sí lleva señal).
    const c = new KernelCore(44100);
    c.handleMessage({ type: 'snapshot', project: compiled });
    c.handleMessage({ type: 'setScope', enabled: true });
    c.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(c, 60);
    expect(energia(c.meterFrame().scope!)).toBeGreaterThan(0);
  });
});

describe('kernel: metrónomo', () => {
  /** Proyecto compilado vacío (solo mixer): el único audio es el click. */
  function emptyCompiled() {
    const p = createEmptyProject('Metro');
    p.tempo = 120;
    return compileProject(p, { mode: 'pattern', patternId: p.patternOrder[0]! });
  }

  it('suena desde el primer bloque (incluido el beat 0) y por beat', () => {
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: emptyCompiled() });
    core.handleMessage({ type: 'setMetronome', enabled: true });
    core.handleMessage({ type: 'play', fromBeat: 0 });

    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK);
    // El click del beat 0 tiene que estar en el PRIMER bloque.
    let first = 0;
    for (const v of l) first = Math.max(first, Math.abs(v));
    expect(first).toBeGreaterThan(0.2);

    // A 120 BPM el beat 1 cae en el sample 22050: procesa hasta pasarlo y
    // verifica que alrededor hay un click nuevo (pico alto tras el ataque).
    const spBeat = (60 / 120) * 44100; // samples por beat
    const blocksToBeat1 = Math.floor(spBeat / MAX_BLOCK) - 1;
    runBlocks(core, blocksToBeat1);
    let nearBeat1 = 0;
    for (let i = 0; i < 4; i++) {
      core.process(l, r, MAX_BLOCK);
      for (const v of l) nearBeat1 = Math.max(nearBeat1, Math.abs(v));
    }
    expect(nearBeat1).toBeGreaterThan(0.2);
  });

  it('sin metrónomo el proyecto vacío es silencio absoluto', () => {
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: emptyCompiled() });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      core.process(l, r, MAX_BLOCK);
      for (const v of l) peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBe(0);
  });
});

describe('kernel: time-stretch de clips de audio', () => {
  /** Proyecto en modo SONG con un solo clip de audio del sample dado. */
  function audioClipProject(stretch: boolean) {
    const p = createEmptyProject('Stretch');
    p.tempo = 120; // 0.5 s por beat
    const trackId = Object.values(p.playlistTracks).find(
      (t) => t.arrangementId === p.activeArrangementId,
    )!.id;
    applyCommand(p, {
      type: 'registerSample',
      sample: { id: 'tone', name: 'tone', path: 'qa:tone', hash: 'x', duration: 0.5 },
    });
    applyCommand(p, {
      type: 'addClips',
      clips: [
        {
          id: 'clip1',
          kind: 'audio',
          playlistTrackId: trackId,
          start: 0,
          length: 2, // 1.0 s a 120 BPM — el doble del sample
          muted: false,
          sampleId: 'tone',
          audioStretch: stretch,
        },
      ],
    });
    return compileProject(p, { mode: 'song' });
  }

  /** Sample de 440 Hz, 0.5 s, con micro-fades para evitar clicks. */
  function toneSample() {
    const n = Math.round(0.5 * 44100);
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 200) * Math.min(1, (n - i) / 200);
      left[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100) * env;
    }
    return new Map([['tone', { left, right: left.slice(), rate: 44100 }]]);
  }

  function rms(xs: Float32Array, from: number, to: number): number {
    let s = 0;
    for (let i = from; i < to; i++) s += xs[i]! * xs[i]!;
    return Math.sqrt(s / Math.max(1, to - from));
  }

  /** Frecuencia estimada por cruces por cero ascendentes. */
  function estimateFreq(xs: Float32Array, from: number, to: number, sr: number): number {
    let crossings = 0;
    for (let i = from + 1; i < to; i++) {
      if (xs[i - 1]! <= 0 && xs[i]! > 0) crossings++;
    }
    return crossings / ((to - from) / sr);
  }

  it('con stretch el sample llena el clip y conserva el pitch (~440 Hz)', () => {
    const res = renderProject(audioClipProject(true), { samples: toneSample(), tailSeconds: 0 });
    const sr = res.sampleRate;
    // Sin stretch esta ventana sería silencio (el sample dura 0.5 s).
    expect(rms(res.left, Math.round(0.7 * sr), Math.round(0.9 * sr))).toBeGreaterThan(0.05);
    const f = estimateFreq(res.left, Math.round(0.6 * sr), Math.round(0.9 * sr), sr);
    expect(f).toBeGreaterThan(400);
    expect(f).toBeLessThan(480);
  });

  it('sin stretch el sample suena a velocidad natural y termina a los 0.5 s', () => {
    const res = renderProject(audioClipProject(false), { samples: toneSample(), tailSeconds: 0 });
    const sr = res.sampleRate;
    expect(rms(res.left, Math.round(0.1 * sr), Math.round(0.4 * sr))).toBeGreaterThan(0.05);
    expect(rms(res.left, Math.round(0.7 * sr), Math.round(0.9 * sr))).toBeLessThan(0.001);
  });
});

describe('kernel: plugins JS y cambio cuantizado', () => {
  it('un plugin JS registrado procesa el audio de su slot (y uno roto hace bypass)', () => {
    const build = () => {
      const p = createEmptyProject('Plug');
      p.tempo = 120;
      const patternId = p.patternOrder[0]!;
      const ch = createChannel('synth', 0, 'Lead');
      ch.mixerTrack = 1;
      applyCommand(p, { type: 'addChannel', channel: ch });
      applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(0, 4, 60)] });
      applyCommand(p, {
        type: 'setEffect',
        trackIndex: 1,
        slotIndex: 0,
        slot: { id: 'slot-plug', kind: 'plugin', enabled: true, mix: 1, params: {}, pluginId: 'mute' },
      });
      return compileProject(p, { mode: 'pattern', patternId });
    };

    // Plugin "mute": multiplica por 0 — su pista debe quedar en silencio.
    const a = new KernelCore(44100);
    a.handleMessage({
      type: 'registerPlugin',
      pluginId: 'mute',
      code: 'function createEffect(sr){ return { process(l, r, n){ for(let i=0;i<n;i++){ l[i]=0; r[i]=0; } } }; }',
    });
    a.handleMessage({ type: 'snapshot', project: build() });
    a.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(a, 60);
    expect(a.meterFrame().rms[1]!).toBe(0);

    // Plugin que LANZA en process: bypass automático, el audio sobrevive.
    const b = new KernelCore(44100);
    b.handleMessage({
      type: 'registerPlugin',
      pluginId: 'mute',
      code: 'function createEffect(sr){ return { process(){ throw new Error("boom"); } }; }',
    });
    b.handleMessage({ type: 'snapshot', project: build() });
    b.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(b, 60);
    expect(b.meterFrame().rms[1]!).toBeGreaterThan(0);

    // Sin plugin registrado: el slot no existe como unidad → audio intacto.
    const c = new KernelCore(44100);
    c.handleMessage({ type: 'snapshot', project: build() });
    c.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(c, 60);
    expect(c.meterFrame().rms[1]!).toBeGreaterThan(0);
  });

  it('queueSnapshot entra exactamente al cerrar el loop (cambio cuantizado)', () => {
    const mk = (withNotes: boolean, length: number) => {
      const p = createEmptyProject('Live');
      p.tempo = 120;
      const patternId = p.patternOrder[0]!;
      const pat = p.patterns[patternId]!;
      pat.length = length;
      const ch = createChannel('synth', 0, 'Lead');
      ch.mixerTrack = 1;
      applyCommand(p, { type: 'addChannel', channel: ch });
      if (withNotes) {
        applyCommand(p, {
          type: 'addNotes',
          patternId,
          channelId: ch.id,
          notes: [note(0, 1, 60), note(1, 1, 60), note(2, 1, 60), note(3, 1, 60)],
        });
      }
      return compileProject(p, { mode: 'pattern', patternId });
    };

    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: mk(true, 4) }); // A: 4 beats con notas
    core.handleMessage({ type: 'play', fromBeat: 0 });
    const blocksPerBeat = Math.ceil((0.5 * 44100) / MAX_BLOCK); // 120 BPM
    runBlocks(core, blocksPerBeat); // ~beat 1, sonando
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);

    core.handleMessage({ type: 'queueSnapshot', project: mk(false, 8) }); // B: vacío, 8 beats
    // Antes del cierre del loop A sigue sonando (la cola NO interrumpe).
    runBlocks(core, blocksPerBeat * 2); // ~beat 3
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
    // Cruzando el beat 4 el snapshot B entra: posBeats salta al inicio y ya
    // no se disparan notas (B está vacío) — tras el release queda silencio.
    runBlocks(core, blocksPerBeat * 3); // cruza el wrap y avanza ~2 beats de B
    expect(core.posBeats).toBeLessThan(4);
    runBlocks(core, blocksPerBeat * 2);
    core.meterFrame();
    runBlocks(core, blocksPerBeat);
    expect(core.meterFrame().rms[1]!).toBeLessThan(0.001);
  });
});

describe('kernel: LFOs por parametro', () => {
  /** Nota sostenida en la pista 1 + un LFO sobre el volumen de esa pista. */
  function lfoProject(patch: Partial<Lfo> = {}) {
    const p = createEmptyProject('LFO');
    p.tempo = 120; // 1 beat = 0.5 s
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('synth', 0, 'Lead');
    ch.mixerTrack = 1;
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(0, 4, 60)] });
    applyCommand(p, {
      type: 'addLfos',
      lfos: [
        {
          ...createLfo({ kind: 'mixer', trackIndex: 1, param: 'volume' }),
          shape: 'square',
          rateBeats: 1,
          amount: 1,
          ...patch,
        },
      ],
    });
    return compileProject(p, { mode: 'pattern', patternId });
  }

  function rmsOf(xs: Float32Array, from: number, to: number): number {
    let s = 0;
    for (let i = from; i < to; i++) s += xs[i]! * xs[i]!;
    return Math.sqrt(s / Math.max(1, to - from));
  }

  it('la LUT del parametro va y vuelve (curva exponencial incluida)', () => {
    const p = createEmptyProject('LUT');
    applyCommand(p, {
      type: 'setEffect',
      trackIndex: 1,
      slotIndex: 0,
      slot: {
        id: 'fx',
        kind: 'autofilter',
        enabled: true,
        mix: 1,
        params: defaultEffectParams('autofilter'),
      },
    });
    applyCommand(p, {
      type: 'addLfos',
      lfos: [createLfo({ kind: 'effect', trackIndex: 1, slotIndex: 0, param: 'cutoff' })],
    });
    const lut = compileProject(p, { mode: 'song' }).lfos[0]!.lut;
    // cutoff es exponencial 40..18000 Hz: el error de ida y vuelta debe ser < 0.1 %.
    for (const norm of [0, 0.13, 0.5, 0.77, 1]) {
      expect(invertLut(lut, evalLut(lut, norm))).toBeCloseTo(norm, 3);
    }
    // Y la tabla es monotona creciente.
    for (let i = 1; i < lut.length; i++) expect(lut[i]!).toBeGreaterThan(lut[i - 1]!);
  });

  it('una cuadrada sobre el volumen abre y cierra la pista a tiempo', () => {
    const res = renderProject(lfoProject(), { tailSeconds: 0 });
    const sr = res.sampleRate;
    // Medio beat arriba (volumen x2), medio beat abajo (silencio), 0.25 s cada uno.
    expect(rmsOf(res.left, Math.round(0.05 * sr), Math.round(0.2 * sr))).toBeGreaterThan(0.02);
    expect(rmsOf(res.left, Math.round(0.3 * sr), Math.round(0.45 * sr))).toBeLessThan(0.001);
    expect(rmsOf(res.left, Math.round(0.55 * sr), Math.round(0.7 * sr))).toBeGreaterThan(0.02);
  });

  it('la fase sale de la posicion: dos renders son identicos sample a sample', () => {
    const a = renderProject(lfoProject({ shape: 'sine', amount: 0.6 }), { tailSeconds: 0 });
    const b = renderProject(lfoProject({ shape: 'sine', amount: 0.6 }), { tailSeconds: 0 });
    expect(a.left.length).toBe(b.left.length);
    for (let i = 0; i < a.left.length; i += 997) expect(a.left[i]!).toBe(b.left[i]!);
  });

  it('sample & hold da escalones estables dentro de cada ciclo', () => {
    const core = new KernelCore(44100);
    core.handleMessage({
      type: 'snapshot',
      project: lfoProject({ shape: 'random', amount: 1, rateBeats: 2 }),
    });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    // Dentro de un ciclo el valor no cambia: el LFO es escalonado, no una rampa.
    const first = lfoWave(4, 0.1);
    expect(lfoWave(4, 0.9)).toBe(first);
    expect(lfoWave(4, 1.1)).not.toBe(first);
    for (let i = 0; i < 40; i++) core.process(l, r, MAX_BLOCK);
    expect(Number.isFinite(core.meterFrame().rms[1]!)).toBe(true);
  });

  it('si mueves la perilla el LFO adopta el valor nuevo como base', () => {
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: lfoProject({ shape: 'sine', amount: 0.05 }) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 40);
    const loud = core.meterFrame().rms[1]!;
    expect(loud).toBeGreaterThan(0);
    // Bajar el fader a casi cero debe oirse: el LFO no puede reimponer su base.
    core.handleMessage({ type: 'mixerParam', trackIndex: 1, key: 'volume', value: 0.02 });
    runBlocks(core, 40);
    expect(core.meterFrame().rms[1]!).toBeLessThan(loud * 0.2);
  });
});
