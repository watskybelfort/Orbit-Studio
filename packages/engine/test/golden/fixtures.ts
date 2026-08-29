/**
 * El banco de renders del golden: un proyecto por familia de sonido.
 *
 * Reglas que cumple TODO lo de este archivo, porque son las que hacen que el
 * golden sirva de algo:
 *
 * 1. **Nada aleatorio.** `newId()` es nanoid — dos ejecuciones dan ids
 *    distintos, y los ids llegan a decidir el orden de las voces cuando dos
 *    notas empiezan en el mismo beat. Aquí todos los ids se escriben a mano
 *    (`id()`), así que el proyecto es byte a byte el mismo en cada corrida.
 * 2. **Ningún parámetro por defecto se da por supuesto.** Cada fixture fija
 *    explícitamente lo que quiere medir. Si mañana cambia un `default` de
 *    `params.ts`, el golden salta —que es exactamente lo que debe pasar: un
 *    default es sonido.
 * 3. **Cortos.** Entre 1 y 3 s de render por fixture: el banco entero tiene
 *    que caber en el `npm test` de la CI sin que nadie lo empiece a saltar.
 * 4. **Cada fixture existe por un cambio de sonido concreto.** El comentario
 *    de cada uno dice cuál. Un fixture que no cubre nada es peso muerto que
 *    alguien acabará borrando.
 */

import {
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultEffectParams,
  type EffectSlot,
  type Lfo,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject } from '../../src/compile';
import type { CompiledProject } from '../../src/protocol';
import type { SampleData } from '../../src/dsp/voices';

export const GOLDEN_SR = 44100;

/**
 * Ids deterministas: el banco no puede depender de nanoid (ver regla 1).
 *
 * Hay DOS contadores a propósito. `id()` numera lo que se construye al cargar
 * el módulo (las notas y los slots de efecto de las definiciones de abajo):
 * es monótono y el orden de evaluación del módulo lo fija. `buildId()` numera
 * lo que se construye DENTRO de `build()`, y se pone a cero en cada llamada —
 * si no, llamar dos veces a `build()` daría dos proyectos con ids distintos y
 * el propio banco dejaría de ser reproducible dentro de un mismo proceso, que
 * es justo la primera propiedad que el test comprueba. Los prefijos separados
 * (`b-`) garantizan que los dos espacios no se pisen.
 */
let idSeq = 0;
function id(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq.toString(36).padStart(4, '0')}`;
}

let buildSeq = 0;
function resetBuildIds(): void {
  buildSeq = 0;
}
function buildId(prefix: string): string {
  buildSeq += 1;
  return `b-${prefix}-${buildSeq.toString(36).padStart(4, '0')}`;
}

/** Piezas del kit por altura MIDI (DRUM_MAP en core). */
const KICK = 36;
const RIM = 37;
const SNARE = 38;
const CLAP = 39;
const HAT = 42;
const OPENHAT = 46;
const TOM = 45;
const CONGA = 48;
const CRASH = 49;
const SHAKER = 70;

function note(
  start: number,
  duration: number,
  key: number,
  extra: Partial<Note> = {},
): Note {
  return {
    id: id('n'),
    start,
    duration,
    key,
    velocity: 0.9,
    pan: 0,
    slide: false,
    ...extra,
  };
}

function fx(kind: EffectSlot['kind'], params: Record<string, number> = {}, mix = 1): EffectSlot {
  return {
    id: id('fx'),
    kind,
    enabled: true,
    mix,
    params: { ...defaultEffectParams(kind), ...params },
  };
}

/**
 * Esqueleto común: proyecto vacío, tempo fijo y un canal del kind pedido en la
 * pista de mixer 1. El tempo NO se hereda del default de `createEmptyProject`
 * a propósito (regla 2): que alguien cambie el tempo por defecto no debe
 * mover el golden por sorpresa, tiene que moverlo porque este archivo lo diga.
 */
function base(title: string, tempo = 140): { project: Project; patternId: string } {
  resetBuildIds();
  const project = createEmptyProject(title);
  project.id = buildId('proj');
  project.tempo = tempo;
  project.swing = 0;
  // `createEmptyProject` reparte nanoids por patrones, arreglos y pistas de
  // playlist. Ninguno llega al audio, pero dejarlos sueltos convierte «el
  // proyecto es determinista» en «creemos que esos ids no importan». Se
  // renombran todos y deja de ser una creencia.
  const patternId = buildId('pat');
  const pattern = project.patterns[project.patternOrder[0]!]!;
  delete project.patterns[pattern.id];
  pattern.id = patternId;
  project.patterns[patternId] = pattern;
  project.patternOrder = [patternId];
  return { project, patternId };
}

function addChannel(
  project: Project,
  kind: Parameters<typeof createChannel>[0],
  params: Record<string, number>,
  extra: Partial<ReturnType<typeof createChannel>> = {},
): ReturnType<typeof createChannel> {
  const ch = createChannel(kind, 0, kind);
  ch.id = buildId('ch');
  ch.mixerTrack = 1;
  ch.volume = 0.78;
  Object.assign(ch.params, params);
  Object.assign(ch, extra);
  applyCommand(project, { type: 'addChannel', channel: ch });
  return ch;
}

// ── Samples deterministas ────────────────────────────────────────────────────

/**
 * Un sample sintético reproducible: cuatro trozos de amplitud creciente sobre
 * una fundamental de 220 Hz, con el canal derecho desfasado para que el
 * fixture tenga imagen estéreo real (si L y R fueran idénticos, la
 * correlación estéreo del fingerprint sería siempre 1 y no mediría nada).
 */
export function goldenSample(): Map<string, SampleData> {
  const n = GOLDEN_SR; // 1 s
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const slice = Math.floor((i / n) * 4);
    const amp = 0.15 + slice * 0.2;
    const t = (2 * Math.PI * 220 * i) / GOLDEN_SR;
    left[i] = Math.sin(t) * amp;
    right[i] = Math.sin(t + 0.7) * amp * 0.85;
  }
  return new Map([['golden-sample', { left, right, rate: GOLDEN_SR }]]);
}

// ── El banco ─────────────────────────────────────────────────────────────────

export interface GoldenFixture {
  /** Clave estable en `baseline.json`. Renombrar = perder la línea base. */
  readonly name: string;
  /** Qué cambio de sonido cubre. Sale en el informe cuando el fixture falla. */
  readonly covers: string;
  readonly tailSeconds: number;
  build(): CompiledProject;
  /** Samples que necesita el render (sampler/slicer). */
  samples?(): Map<string, SampleData>;
}

/** Un canal solo, en modo patrón, con la cadena de inserts que se le pida. */
function instrument(
  name: string,
  covers: string,
  kind: Parameters<typeof createChannel>[0],
  params: Record<string, number>,
  notes: Note[],
  opts: { tail?: number; tempo?: number; extra?: Partial<ReturnType<typeof createChannel>> } = {},
): GoldenFixture {
  return {
    name,
    covers,
    tailSeconds: opts.tail ?? 0.5,
    build() {
      const { project, patternId } = base(name, opts.tempo);
      const ch = addChannel(project, kind, params, opts.extra);
      applyCommand(project, { type: 'addNotes', patternId, channelId: ch.id, notes });
      return compileProject(project, { mode: 'pattern', patternId });
    },
  };
}

/**
 * Un efecto (o una cadena) sobre una fuente fija.
 *
 * La fuente es SIEMPRE la misma —un 808 seco con un hat encima— para que la
 * diferencia entre dos fixtures de efecto sea el efecto y nada más. Lleva
 * grave y agudo a propósito: un efecto que solo toca una punta del espectro
 * (el low-end mono del `stereo`, el `tone` del vinilo) tiene que tener algo
 * que morder en su banda.
 */
function effectRig(
  name: string,
  covers: string,
  slots: (EffectSlot | null)[],
  opts: { tail?: number; lfo?: (trackIndex: number) => Lfo } = {},
): GoldenFixture {
  return {
    name,
    covers,
    tailSeconds: opts.tail ?? 1.5,
    build() {
      const { project, patternId } = base(name);
      const sub = addChannel(project, 'sub808', {
        tune: 0, decay: 1.2, drive: 0.45, glide: 0.06, punch: 0.5, tone: 900,
      });
      const drums = addChannel(project, 'drums', { kit: 0, tone: 0.5, decay: 1, punch: 0.5 });
      drums.mixerTrack = 1;
      applyCommand(project, {
        type: 'addNotes',
        patternId,
        channelId: sub.id,
        notes: [note(0, 1.5, 33), note(2, 1.5, 36)],
      });
      applyCommand(project, {
        type: 'addNotes',
        patternId,
        channelId: drums.id,
        notes: [
          note(0, 0.1, KICK), note(1, 0.1, HAT), note(1.5, 0.1, SNARE),
          note(2.5, 0.1, HAT), note(3, 0.1, HAT), note(3.5, 0.1, OPENHAT),
        ],
      });
      slots.forEach((slot, slotIndex) => {
        if (slot) applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex, slot });
      });
      if (opts.lfo) {
        const lfo = opts.lfo(1);
        project.lfos[lfo.id] = lfo;
      }
      return compileProject(project, { mode: 'pattern', patternId });
    },
  };
}

export const GOLDEN_FIXTURES: readonly GoldenFixture[] = [
  // ── Instrumentos ───────────────────────────────────────────────────────────

  // El sonido de la casa: 808 con glide. Pasa por Sub808Voice (SVF `tone` +
  // DecayEnv + el glide one-pole) y por el low-end mono del master.
  instrument(
    'inst-sub808-glide',
    'Sub808Voice: glide, pitch env, SVF de tone, saturación',
    'sub808',
    { tune: 0, decay: 1.4, drive: 0.55, glide: 0.09, punch: 0.6, tone: 1100 },
    [
      note(0, 1.75, 33),
      note(2, 1, 40, { slide: true }),
      note(3, 1, 36, { slide: true }),
    ],
    { tail: 1.5 },
  ),

  // SynthVoice con envAmount alto y resonancia: es el camino que recorre la
  // guarda de umbral del 0,2 % de la v3.6 (voices.ts:177) muestra a muestra.
  instrument(
    'inst-synth-sweep',
    'SynthVoice: guarda de 0,2 % en el recálculo de coeficientes + SVF resonante',
    'synth',
    {
      wave: 0, cutoff: 400, resonance: 0.75, envAmount: 0.9,
      attack: 0.005, decay: 0.6, sustain: 0.5, release: 0.4,
      unison: 3, detune: 0.15, octave: 0,
    },
    [note(0, 1.5, 48), note(2, 1.5, 55)],
  ),

  instrument(
    'inst-supersaw-chord',
    'SupersawVoice: 7 osciladores, reparto estéreo y filtro',
    'supersaw',
    { detune: 0.5, blend: 0.7, cutoff: 6000 },
    [note(0, 2.5, 52), note(0, 2.5, 55), note(0, 2.5, 59)],
  ),

  instrument(
    'inst-fm-bell',
    'FmVoice: índice de modulación y envolvente del operador',
    'fm',
    {},
    [note(0, 1.5, 64), note(2, 1.5, 71)],
  ),

  // Los tres kits, por separado: `kit` cambia filtros y envolventes de CADA
  // pieza, así que un solo fixture de drums taparía dos tercios del motor.
  ...[0, 1, 2].map((kit) =>
    instrument(
      `inst-drums-kit${kit}`,
      `DrumVoice kit ${kit}: ruido filtrado (hat/clap/crash), Biquad y SVF por pieza`,
      'drums',
      { kit, tone: 0.5, decay: 1, punch: 0.55 },
      [
        note(0, 0.1, KICK), note(0, 0.1, CRASH),
        note(0.5, 0.1, HAT), note(1, 0.1, SNARE), note(1, 0.1, CLAP),
        note(1.5, 0.1, HAT), note(1.75, 0.1, RIM),
        note(2, 0.1, KICK), note(2.5, 0.1, OPENHAT), note(2.75, 0.1, SHAKER),
        note(3, 0.1, SNARE), note(3.25, 0.1, TOM), note(3.5, 0.1, CONGA),
      ],
      { tail: 1.5 },
    ),
  ),

  instrument(
    'inst-vox-vowels',
    'VoxVoice: formantes por vocal, aire y vibrato',
    'vox',
    { vowel: 0, breath: 0.35, vibrato: 0.4, attack: 0.06, release: 0.5, octave: 0 },
    [note(0, 1, 60), note(1.25, 1, 64), note(2.5, 1, 67)],
  ),

  instrument(
    'inst-nova-default',
    'NovaVoice con el preset por defecto: el motor de presets entero',
    'nova',
    {},
    [note(0, 1.5, 48), note(2, 1.5, 55)],
  ),

  instrument(
    'inst-prisma-default',
    'PrismaVoice con el preset por defecto: capas, ruido por hash y pluck',
    'prisma',
    {},
    [note(0, 1.5, 48), note(2, 1.5, 55)],
  ),

  {
    name: 'inst-sampler-pitched',
    covers: 'SamplerVoice: interpolación, transposición y envolvente',
    tailSeconds: 0.5,
    samples: goldenSample,
    build() {
      const { project, patternId } = base('inst-sampler-pitched');
      const ch = addChannel(project, 'sampler', {}, { sampleId: 'golden-sample' });
      applyCommand(project, {
        type: 'addNotes',
        patternId,
        channelId: ch.id,
        notes: [note(0, 1, 60), note(1.5, 1, 67), note(3, 1, 55)],
      });
      return compileProject(project, { mode: 'pattern', patternId });
    },
  },

  {
    name: 'inst-slicer-loop',
    covers: 'SlicerVoice: reparto de trozos y ventanas de ataque/release',
    tailSeconds: 0.5,
    samples: goldenSample,
    build() {
      const { project, patternId } = base('inst-slicer-loop');
      const ch = addChannel(
        project,
        'slicer',
        { slices: 8, attack: 0.002 },
        { sampleId: 'golden-sample' },
      );
      applyCommand(project, {
        type: 'addNotes',
        patternId,
        channelId: ch.id,
        notes: [0, 1, 2, 3, 4, 5].map((i) => note(i * 0.5, 0.45, 48 + i)),
      });
      return compileProject(project, { mode: 'pattern', patternId });
    },
  },

  // ── Efectos ────────────────────────────────────────────────────────────────

  // v3.5: el flush de denormales de la reverb. La cola larga es justo el tramo
  // donde el estado recursivo se hunde hacia cero.
  effectRig(
    'fx-reverb',
    'v3.5: anti-denormal de reverb.ts (cola larga)',
    [fx('reverb', { size: 0.75, damp: 0.35, width: 1, predelay: 0.03 }, 0.5)],
    { tail: 3 },
  ),

  effectRig(
    'fx-convolver',
    'Convolver: IR sintética determinista y convolución particionada',
    [fx('convolver', { size: 0.7, decay: 2.2, damp: 0.45, predelay: 0.02, width: 1 }, 0.45)],
    { tail: 3 },
  ),

  // El caso documentado: al meter el flush de denormales, el vinilo dejó de
  // dar silencio exacto bit a bit y un test tuvo que pasar de `toBe(0)` a
  // `toBeLessThan(6e-8)`. Ese cambio no lo destapó ningún golden porque no
  // había ninguno. Ahora lo hay.
  effectRig(
    'fx-vinyl',
    'v3.6: el vinilo dejó de dar silencio exacto (crackle/wow/flutter deterministas)',
    [fx('vinyl', { crackle: 0.45, noise: 0.35, wow: 0.35, flutter: 0.3, tone: 7000 })],
    { tail: 2 },
  ),

  // El sonido del delay: ping-pong, realimentación filtrada, tiempo por
  // división. Ojo con lo que este fixture NO fija: el flush de denormales del
  // lazo de DelayUnit. Se comprobó —perturbando `ANTI_DENORMAL` en effects.ts
  // diez veces— que flanger y phaser saltan y el delay no, y la razón es que
  // su línea de retardo es un Float32Array: mientras quede señal audible en
  // ella, sumarle 1e-20 se pierde entero en el redondeo. Esa DC solo se nota
  // tras un silencio de ~65 s con este feedback, y un golden de 65 s por
  // fixture no lo corre nadie. Lo que sí fija ese flush es
  // `dsp-denormal.test.ts`, que mira el estado del filtro en vez del audio —
  // que es la herramienta correcta para una propiedad de CPU, no de sonido.
  effectRig(
    'fx-delay',
    'El sonido del delay: ping-pong, realimentación filtrada y filtro de repeticiones',
    [fx('delay', { time: 3, feedback: 0.75, pingpong: 1, filter: 4000 }, 0.5)],
    { tail: 3 },
  ),

  effectRig(
    'fx-flanger',
    'v3.6: anti-denormal en FlangerUnit (línea de retardo Float32Array)',
    [fx('flanger', { rate: 0.35, depth: 0.7, feedback: 0.8 }, 0.6)],
    { tail: 2.5 },
  ),

  effectRig(
    'fx-phaser',
    'v3.6: anti-denormal en PhaserUnit + Allpass1',
    [fx('phaser', { rate: 0.45, depth: 0.8, stages: 6, feedback: 0.7 }, 0.6)],
    { tail: 2.5 },
  ),

  // v3.6: la otra mitad de la guarda del 0,2 % vive en AutofilterUnit. Con el
  // LFO al máximo el corte se mueve en CADA muestra, que es el caso en el que
  // la guarda decide si recalcula o no.
  effectRig(
    'fx-autofilter',
    'v3.6: guarda de 0,2 % en AutofilterUnit + SVF barrido por LFO',
    [fx('autofilter', {
      type: 0, cutoff: 800, resonance: 0.7, lfoRate: 3.5, lfoAmount: 0.9, envAmount: 0.5,
    })],
  ),

  // v3.5: el suavizado de coeficientes (COEF_SMOOTH_SECONDS en filters.ts).
  // Sin un parámetro EN MOVIMIENTO el suavizado es un no-op numérico (el
  // objetivo ya es el valor vivo), así que este fixture automatiza el EQ con
  // un LFO: es el único sitio del banco donde la rampa de 5 ms se oye.
  effectRig(
    'fx-eq-smoothing',
    'v3.5: suavizado de coeficientes de Biquad con el EQ en movimiento (LFO)',
    [fx('eq', {
      hpFreq: 45, lowGain: 4, lowFreq: 90, midGain: -6, midFreq: 1200, midQ: 3,
      highGain: 5, highFreq: 7000, lpFreq: 15000,
    })],
    {
      lfo: (trackIndex) => ({
        id: buildId('lfo'),
        target: { kind: 'effect', trackIndex, slotIndex: 0, param: 'midFreq' },
        shape: 'sine',
        rateBeats: 2,
        amount: 0.85,
        phase: 0,
        enabled: true,
      }),
    },
  ),

  // Biquad como StripEq: el EQ de pista que corre en CADA canal del mixer.
  // Aquí se toca desde la pista, no desde un slot de efecto.
  {
    name: 'fx-strip-eq',
    covers: 'v3.6: Biquad como StripEq — el EQ de pista de cada canal del mixer',
    tailSeconds: 1.5,
    build() {
      const { project, patternId } = base('fx-strip-eq');
      const drums = addChannel(project, 'drums', { kit: 0, tone: 0.6, decay: 1.1, punch: 0.5 });
      applyCommand(project, {
        type: 'addNotes',
        patternId,
        channelId: drums.id,
        notes: [
          note(0, 0.1, KICK), note(0.5, 0.1, HAT), note(1, 0.1, SNARE),
          note(1.5, 0.1, HAT), note(2, 0.1, KICK), note(2.5, 0.1, OPENHAT),
          note(3, 0.1, SNARE), note(3.5, 0.1, HAT),
        ],
      });
      const track = project.mixer[1]!;
      track.eqLow = 5;
      track.eqMid = -7;
      track.eqHigh = 6;
      return compileProject(project, { mode: 'pattern', patternId });
    },
  },

  effectRig(
    'fx-distortion-bitcrush',
    'Saturación y bitcrush: la parte no lineal de la cadena',
    [
      fx('distortion', { drive: 0.6, tone: 5000, mode: 0, output: 0.9 }, 0.7),
      fx('bitcrush', { bits: 6, downsample: 6 }, 0.5),
    ],
  ),

  effectRig(
    'fx-chorus-gate',
    'Chorus (balance de voces) y gate (envolvente con umbral)',
    [
      fx('chorus', { rate: 0.9, depth: 0.6, voices: 4 }, 0.5),
      fx('gate', { threshold: -32, attack: 0.002, release: 0.12 }),
    ],
  ),

  // La cadena de master de verdad: compresor + EQ + estéreo + limiter. Es la
  // que decide el sonido de CUALQUIER export, así que si algo se mueve aquí se
  // mueve en todo lo que salga del programa.
  effectRig(
    'fx-master-chain',
    'Cadena de master: compresor, EQ, ancho estéreo con low-end mono y limiter',
    [
      fx('compressor', {
        threshold: -20, ratio: 4, attack: 0.008, release: 0.14, knee: 6, makeup: 3,
      }),
      fx('eq', {
        hpFreq: 30, lowGain: 2, lowFreq: 100, midGain: -2, midFreq: 900, midQ: 1.2,
        highGain: 3, highFreq: 8000, lpFreq: 18000,
      }),
      fx('stereo', { width: 1.4, gain: 1, monoBelow: 110 }),
      fx('limiter', { gain: 4, ceiling: -0.3, release: 0.06 }),
    ],
  ),
];

/** Índice por nombre, para `golden:update --only`. */
export function fixtureByName(name: string): GoldenFixture | undefined {
  return GOLDEN_FIXTURES.find((f) => f.name === name);
}

// ── El encoder Opus ──────────────────────────────────────────────────────────

/**
 * El encoder es la otra mitad de los nueve cambios de sonido sin fijar: los
 * transitorios y el postfiltro de la v3.5, y el pesado del Viterbi por
 * importancia espectral de la v3.6. No cabe en un fixture de render porque su
 * salida no son muestras, son BYTES de un flujo entrópico — y ahí la única
 * comparación que significa algo es la igualdad exacta: en un bitstream
 * codificado con rango no existe «casi igual», un bit distinto es otro
 * archivo. Por eso estos fixtures no llevan métricas con tolerancia; llevan el
 * hash de los bytes y su longitud.
 *
 * La fuente es un render del propio banco a 48 kHz —la frecuencia a la que
 * trabaja CELT, sin remuestrear— para que esto cubra el camino real del
 * export (motor → encoder) y no un tono de laboratorio.
 *
 * ── Por qué son DOS y no tres ───────────────────────────────────────────────
 *
 * Había un tercero, `opus-drums` (percusión, la fuente del detector de
 * transitorios). Se quitó, y las dos mitades de esa decisión están medidas:
 *
 * **No era portable.** Con el MISMO PCM de entrada —idéntico bit a bit en las
 * cinco plataformas probadas— el flujo de la percusión salía distinto:
 * 262 bytes de 38 640 entre V8 12 y V8 13, y 234 entre x64 y arm64. Los
 * tamaños de paquete no cambiaban, o sea que el reparto de bits era el mismo;
 * lo que cambiaba era el CONTENIDO de algunas tramas. Un transitorio deja al
 * detector justo sobre su umbral, y ahí un último bit decide si la trama va en
 * bloques cortos o largos. Un golden sobre esa señal no fija el encoder: fija
 * la versión de V8, y rompería en la próxima subida de Node — con lo que
 * acabaría saltado, que es la única forma de que un golden no sirva de nada.
 *
 * **Y no cubría nada que los otros dos no cubran.** Medido perturbando los
 * tres cambios de sonido reales del encoder, uno a uno (ver `docs/GOLDEN.md`):
 *
 *   cambio                          drums  chord  sub
 *   ------------------------------- -----  -----  ---
 *   umbral de transitorios (v3.5)     no     no   SÍ
 *   ganancia del postfiltro (v3.5)    SÍ     SÍ   SÍ
 *   pesado del Viterbi (v3.6)         SÍ     SÍ   no
 *
 * Las dos veces que `opus-drums` salta, `opus-chord` salta con él. Quitarlo no
 * abre ningún agujero; dejarlo abría uno peor.
 *
 * `opus-chord` y `opus-sub` sí se midieron idénticos byte a byte en las cinco
 * plataformas (win32/linux, x64/arm64, V8 11, 12 y 13): son, de hecho, lo más
 * portable de todo el banco.
 */
export interface OpusFixture {
  readonly name: string;
  readonly covers: string;
  /** Fixture de render que hace de fuente. */
  readonly source: string;
  readonly bitrate: number;
}

export const GOLDEN_OPUS_FIXTURES: readonly OpusFixture[] = [
  // Un acorde sostenido: el caso tonal que el pesado del Viterbi por
  // importancia espectral de la v3.6 vino a recuperar.
  {
    name: 'opus-chord',
    covers: 'v3.6: Viterbi por importancia espectral, y postfiltro, sobre material tonal',
    source: 'inst-supersaw-chord',
    bitrate: 96000,
  },
  // 808 y graves: el postfiltro de la v3.5 actúa sobre la periodicidad, que es
  // lo que un sub sostenido tiene de sobra.
  {
    name: 'opus-sub',
    covers: 'v3.5: umbral de transitorios y postfiltro sobre material grave sostenido',
    source: 'inst-sub808-glide',
    bitrate: 64000,
  },
];
