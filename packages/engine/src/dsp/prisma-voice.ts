/**
 * Voz de Orbit Prisma — el instrumento grande de presets.
 *
 * El kernel NO conoce la librería de sonidos: recibe las capas ya resueltas
 * (`PrismaDef`) y con eso construye la voz, igual que con Nova. Así un preset
 * nuevo no obliga a tocar el motor.
 *
 * Estructura de una voz:
 *
 *   capa 1 ─┐ (n unísonos, cada uno con su detune y su pan)
 *   capa 2 ─┼─→ filtro común (LP/HP/BP/Notch con envolvente y keytrack)
 *   capa 3 ─┤   → drive → tono (graves/agudos) → nivel/pan → salida
 *   capa 4 ─┘
 *
 * Cada capa lleva SU envolvente de amplitud (la del canal escalada por los
 * multiplicadores del preset) y la voz entera comparte la envolvente de
 * modulación y un LFO. Los dos pueden apuntar a tono, cutoff, nivel, wave o
 * pan, que es lo que hace que un mismo montaje de capas dé sonidos distintos.
 *
 * Reglas de la casa que se respetan aquí:
 * - Cero `Math.random()`: el ruido y las fases "aleatorias" salen de un hash
 *   del número de nota, así dos renders del mismo proyecto son idénticos.
 * - Las tablas de onda se calculan UNA vez al cargar el módulo, no por nota.
 * - Las líneas de retardo de la cuerda pulsada vienen de un pool preasignado:
 *   una nota no aloca 10 KB de buffer en mitad del bloque de audio.
 */

import { ADSR } from './env';
import { Biquad, SVF } from './filters';
import { TWO_PI } from './osc';
import { Voice, type VoiceContext } from './voice-base';

// ── Contrato con el compilador ───────────────────────────────────────────────

/** Capa de un preset ya resuelta para el kernel (espejo de PrismaLayer). */
export interface PrismaLayerDef {
  engine: string;
  wave: number;
  level: number;
  pan: number;
  semi: number;
  fine: number;
  attackMul: number;
  decayMul: number;
  releaseMul: number;
  sustainAdd: number;
  cutoffOct: number;
  keyLo: number;
  keyHi: number;
  velTrack: number;
  phase: number;
  params: Record<string, number>;
}

/** Macro del preset: qué mueve, en qué capa (-1 = el canal) y entre qué valores. */
export interface PrismaMacroDef {
  targets: { layer: number; param: string; min: number; max: number }[];
}

export interface PrismaDef {
  layers: PrismaLayerDef[];
  macros: PrismaMacroDef[];
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Hash determinista 0..1 (fases y semillas "aleatorias" reproducibles). */
function hashUnit(n: number): number {
  let x = Math.imul(n | 0, 1103515245) + 12345;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x / 4294967295;
}

const midiToHz = (key: number): number => 440 * Math.pow(2, (key - 69) / 12);

/** Semitonos → multiplicador de frecuencia (exp es más rápido que pow). */
const semiRatio = (semis: number): number => Math.exp(semis * 0.05776226504666211);

// ── Tablas de onda ───────────────────────────────────────────────────────────
// Cinco formas por síntesis aditiva, cada una en cuatro versiones con distinto
// límite de armónicos. Elegir la versión según la frecuencia es lo que evita el
// alias en las notas agudas sin apagar las graves.

const TABLE_SIZE = 2048;
const TABLE_MASK = TABLE_SIZE - 1;
const SHAPES = 5;
const MIP_HARMONICS = [128, 48, 16, 5];
const MIPS = MIP_HARMONICS.length;
/** Avance de fase máximo de cada mip (dt = freq/sr): 0.5/armónicos. */
const MIP_DT = [0.5 / 128, 0.5 / 48, 0.5 / 16];

/** Amplitud del armónico k (1-based) de cada forma. 0 = no suena. */
function harmonicAmp(shape: number, k: number): number {
  switch (shape) {
    case 0: // seno
      return k === 1 ? 1 : 0;
    case 1: // triángulo
      return k % 2 === 1 ? (((k - 1) / 2) % 2 === 0 ? 1 : -1) / (k * k) : 0;
    case 2: // sierra
      return 1 / k;
    case 3: // cuadrada
      return k % 2 === 1 ? 1 / k : 0;
    default: // dientes: armónicos que caen despacio, áspera y presente
      return 1 / Math.sqrt(k);
  }
}

function buildTables(): Float32Array[] {
  const tables: Float32Array[] = [];
  for (let shape = 0; shape < SHAPES; shape++) {
    for (let mip = 0; mip < MIPS; mip++) {
      const limit = MIP_HARMONICS[mip]!;
      const table = new Float32Array(TABLE_SIZE);
      let peak = 0;
      for (let i = 0; i < TABLE_SIZE; i++) {
        const ph = (i / TABLE_SIZE) * TWO_PI;
        let s = 0;
        for (let k = 1; k <= limit; k++) {
          const amp = harmonicAmp(shape, k);
          if (amp !== 0) s += amp * Math.sin(ph * k);
        }
        table[i] = s;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
      if (peak > 0) {
        for (let i = 0; i < TABLE_SIZE; i++) table[i] = table[i]! / peak;
      }
      tables.push(table);
    }
  }
  return tables;
}

const TABLES = buildTables();

/** Mip adecuado para un avance de fase dado. Tres comparaciones, sin división. */
function mipFor(dt: number): number {
  if (dt <= MIP_DT[0]!) return 0;
  if (dt <= MIP_DT[1]!) return 1;
  if (dt <= MIP_DT[2]!) return 2;
  return 3;
}

/** Lectura interpolada de una tabla (phase 0..1). */
function readTable(shape: number, mip: number, phase: number): number {
  const table = TABLES[shape * MIPS + mip]!;
  const x = phase * TABLE_SIZE;
  const i = x | 0;
  const f = x - i;
  const a = table[i & TABLE_MASK]!;
  const b = table[(i + 1) & TABLE_MASK]!;
  return a + (b - a) * f;
}

/** Lectura con morph continuo entre formas: `wave` 0..1 recorre las cinco. */
function readMorph(wave: number, mip: number, phase: number): number {
  const w = wave * (SHAPES - 1);
  const lo = w | 0;
  if (lo >= SHAPES - 1) return readTable(SHAPES - 1, mip, phase);
  const f = w - lo;
  const a = readTable(lo, mip, phase);
  return f === 0 ? a : a + (readTable(lo + 1, mip, phase) - a) * f;
}

// ── Pool de líneas de retardo (cuerda pulsada) ───────────────────────────────
// Karplus–Strong necesita un buffer del tamaño de un periodo. Alocarlo por nota
// dentro del bloque de audio sería justo lo que la casa prohíbe, así que hay un
// pool fijo: si se agota, la capa cae al motor de tabla y no se nota más que en
// el timbre.

const PLUCK_MAX = 2400; // ~20 Hz a 48 kHz
const PLUCK_POOL_SIZE = 48;
const PLUCK_POOL: Float32Array[] = Array.from(
  { length: PLUCK_POOL_SIZE },
  () => new Float32Array(PLUCK_MAX),
);
let pluckFree = PLUCK_POOL_SIZE;

function takePluckLine(): Float32Array | null {
  return pluckFree > 0 ? PLUCK_POOL[--pluckFree]! : null;
}

function giveBackPluckLine(line: Float32Array): void {
  if (pluckFree < PLUCK_POOL_SIZE) PLUCK_POOL[pluckFree++] = line;
}

/** Cuántas líneas quedan libres (los tests comprueban que se devuelven). */
export function pluckLinesFree(): number {
  return pluckFree;
}

// ── Osciladores ──────────────────────────────────────────────────────────────

/**
 * Un oscilador de una capa. `tick` recibe el avance de fase ya modulado y el
 * `wave` efectivo, así el motor no vuelve a mirar los params por sample.
 */
interface PrismaOsc {
  tick(dt: number, wave: number): number;
  /** Devuelve recursos prestados (solo la cuerda pulsada tiene). */
  dispose(): void;
}

/** Tabla de ondas con morph. El motor base de casi todo. */
class WtOsc implements PrismaOsc {
  private phase: number;

  constructor(phase: number) {
    this.phase = phase;
  }

  tick(dt: number, wave: number): number {
    const t = this.phase;
    this.phase += dt;
    this.phase -= Math.floor(this.phase);
    return readMorph(wave, mipFor(dt), t);
  }

  dispose(): void {}
}

/**
 * Pulso de ancho variable: dos sierras band-limited restadas. `wave` es el
 * duty (0.5 = cuadrada); moverlo con un LFO da el PWM de toda la vida.
 */
class PulseOsc implements PrismaOsc {
  private phase: number;

  constructor(phase: number) {
    this.phase = phase;
  }

  tick(dt: number, wave: number): number {
    const t = this.phase;
    this.phase += dt;
    this.phase -= Math.floor(this.phase);
    const duty = clamp(0.06 + wave * 0.88, 0.02, 0.98);
    const mip = mipFor(dt);
    let t2 = t + duty;
    if (t2 >= 1) t2 -= 1;
    return (readTable(2, mip, t) - readTable(2, mip, t2)) * 0.6;
  }

  dispose(): void {}
}

/** Ruido por un pasa-banda que sigue a la tecla: aire, caja, hats, viento. */
class NoiseOsc implements PrismaOsc {
  private state: number;
  private svf = new SVF();
  private res: number;
  private lastCenter = 0;

  constructor(seed: number, q: number, private readonly sr: number) {
    this.state = (seed | 0) || 1;
    // El spec del preset habla en Q (0.3..12); el SVF quiere res 0..1.
    this.res = clamp((q - 0.5) / 9.5, 0, 1);
  }

  private white(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return (this.state / 0x7fffffff) * 0.999;
  }

  tick(dt: number, wave: number): number {
    // El centro sube con `wave` y con la nota tocada: dos octavas por debajo
    // hasta cinco por encima. Los coeficientes solo se recalculan cuando el
    // centro se mueve de verdad (> 1 %), no en cada sample.
    const center = clamp(dt * this.sr * Math.pow(2, -2 + wave * 7), 40, this.sr * 0.45);
    if (center > this.lastCenter * 1.01 || center < this.lastCenter * 0.99) {
      this.lastCenter = center;
      this.svf.set(center, this.res, this.sr);
    }
    return this.svf.tick(this.white(), 2) * 2.2;
  }

  dispose(): void {}
}

/** FM de dos operadores con realimentación; `wave` es el índice. */
class FmOsc implements PrismaOsc {
  private carrier: number;
  private modPhase: number;
  private last = 0;

  constructor(
    phase: number,
    private readonly ratio: number,
    private readonly feedback: number,
  ) {
    this.carrier = phase;
    this.modPhase = phase;
  }

  tick(dt: number, wave: number): number {
    this.modPhase += dt * this.ratio;
    if (this.modPhase >= 1) this.modPhase -= 1;
    const mod = Math.sin(TWO_PI * this.modPhase + this.last * this.feedback * 4);
    this.last = mod;
    this.carrier += dt;
    if (this.carrier >= 1) this.carrier -= 1;
    return Math.sin(TWO_PI * this.carrier + mod * wave * 10);
  }

  dispose(): void {}
}

/**
 * Cuerda pulsada (Karplus–Strong): un golpe de ruido dando vueltas por una
 * línea de retardo del largo de un periodo, con un filtro que la va apagando.
 * `wave` es el brillo de la púa; `damp` cuánto dura.
 */
class PluckOsc implements PrismaOsc {
  private line: Float32Array | null;
  private fallback: WtOsc | null;
  private len = 2;
  private pos = 0;
  private last = 0;
  private damp: number;
  private primed = false;
  private seed: number;

  constructor(seed: number, damp: number, phase: number) {
    this.line = takePluckLine();
    this.fallback = this.line ? null : new WtOsc(phase);
    this.damp = clamp01(damp);
    this.seed = (seed | 0) || 1;
  }

  private white(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x | 0;
    return (this.seed / 0x7fffffff) * 0.999;
  }

  tick(dt: number, wave: number): number {
    const line = this.line;
    if (!line) return this.fallback!.tick(dt, 0.35);
    if (!this.primed) {
      // El largo se fija con la primera frecuencia: una cuerda no cambia de
      // tamaño a mitad de nota (eso sería un glide, no una cuerda).
      this.len = clamp(Math.round(dt > 0 ? 1 / dt : PLUCK_MAX), 2, PLUCK_MAX);
      const bright = clamp01(wave);
      let smoothed = 0;
      for (let i = 0; i < this.len; i++) {
        const n = this.white();
        // Más brillo = menos suavizado en la excitación.
        smoothed = n * (0.3 + bright * 0.7) + smoothed * (0.7 - bright * 0.7);
        line[i] = smoothed;
      }
      this.pos = 0;
      this.last = 0;
      this.primed = true;
    }
    const current = line[this.pos]!;
    // Media móvil de dos muestras: pasa-bajos suave que apaga los agudos antes
    // que los graves, como una cuerda de verdad.
    const filtered = (current + this.last) * 0.5;
    this.last = current;
    line[this.pos] = filtered * (0.9995 - this.damp * 0.02);
    this.pos++;
    if (this.pos >= this.len) this.pos = 0;
    return current;
  }

  dispose(): void {
    if (this.line) {
      giveBackPluckLine(this.line);
      this.line = null;
    }
  }
}

/** Aditivo de registros tipo órgano; `wave` va abriendo los tiradores. */
const ORGAN_PARTIALS = [1, 2, 3, 4, 6, 8];

class OrganOsc implements PrismaOsc {
  private phase: number;
  private perc: number;
  private percEnv = 1;
  private percCoef: number;

  constructor(phase: number, perc: number, sr: number) {
    this.phase = phase;
    this.perc = clamp01(perc);
    this.percCoef = Math.exp(-1 / (0.12 * sr));
  }

  tick(dt: number, wave: number): number {
    this.phase += dt;
    this.phase -= Math.floor(this.phase);
    const mip = mipFor(dt);
    let s = 0;
    let norm = 0;
    for (let i = 0; i < ORGAN_PARTIALS.length; i++) {
      // Cada registro entra cuando `wave` lo alcanza: la perilla se recorre
      // como los tiradores de un Hammond, no como un filtro.
      const reach = clamp01(wave * ORGAN_PARTIALS.length - i + 0.5);
      if (reach <= 0) continue;
      const k = ORGAN_PARTIALS[i]!;
      const amp = reach / k;
      let ph = this.phase * k;
      ph -= ph | 0;
      s += readTable(0, mip, ph) * amp;
      norm += amp;
    }
    if (norm > 0) s /= norm;
    if (this.perc > 0.001) {
      this.percEnv *= this.percCoef;
      let ph = this.phase * 4;
      ph -= ph | 0;
      s += readTable(0, mip, ph) * this.percEnv * this.perc * 0.5;
    }
    return s;
  }

  dispose(): void {}
}

/**
 * Campana/metal: parciales inarmónicos con decaimientos distintos. Los ratios
 * son los clásicos de campana tubular; `inharm` los estira y `wave` decide
 * cuántos se oyen.
 */
const BELL_RATIOS = [1, 2.76, 5.4, 8.93, 13.34, 18.64, 24.2, 30.6];

class BellOsc implements PrismaOsc {
  private readonly count: number;
  private readonly stretch: number;
  private readonly phases: Float64Array;
  private readonly amps: Float64Array;
  private readonly coefs: Float64Array;

  constructor(phase: number, partials: number, inharm: number, sr: number) {
    this.count = clamp(Math.round(partials), 2, BELL_RATIOS.length) | 0;
    this.stretch = 1 + clamp01(inharm) * 0.6;
    this.phases = new Float64Array(this.count);
    this.amps = new Float64Array(this.count);
    this.coefs = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.phases[i] = (phase + i * 0.317) % 1;
      this.amps[i] = 1 / (1 + i * 1.1);
      // Los parciales agudos se apagan antes: eso es lo que hace "campana".
      this.coefs[i] = Math.exp(-1 / (sr * (1.6 / (1 + i * 0.9))));
    }
  }

  tick(dt: number, wave: number): number {
    const heard = 1 + wave * (this.count - 1);
    let s = 0;
    let norm = 0;
    for (let i = 0; i < this.count; i++) {
      if (i > heard) break;
      const ratio = 1 + (BELL_RATIOS[i]! - 1) * this.stretch;
      let ph = this.phases[i]! + dt * ratio;
      ph -= ph | 0;
      this.phases[i] = ph;
      const amp = this.amps[i]! * clamp01(heard - i);
      this.amps[i] = this.amps[i]! * this.coefs[i]!;
      s += Math.sin(TWO_PI * ph) * amp;
      norm += amp;
    }
    return norm > 0 ? s / (norm < 0.35 ? 0.35 : norm) : 0;
  }

  dispose(): void {}
}

/** Formantes vocales: `wave` recorre A → E → I → O → U. */
const VOWELS: number[][] = [
  [700, 1220, 2600],
  [460, 1900, 2600],
  [300, 2200, 3000],
  [480, 760, 2400],
  [320, 700, 2300],
];
const VOWEL_GAINS = [1, 0.5, 0.28];

class FormantOsc implements PrismaOsc {
  private phase: number;
  private readonly bands = [new Biquad(), new Biquad(), new Biquad()];
  private lastStep = -1;

  constructor(phase: number, private readonly sr: number) {
    this.phase = phase;
  }

  private setVowel(wave: number): void {
    const w = wave * (VOWELS.length - 1);
    const lo = Math.min(VOWELS.length - 1, w | 0);
    const hi = Math.min(VOWELS.length - 1, lo + 1);
    const f = w - lo;
    for (let b = 0; b < 3; b++) {
      const freq = VOWELS[lo]![b]! + (VOWELS[hi]![b]! - VOWELS[lo]![b]!) * f;
      this.bands[b]!.peaking(freq, 14, 7 + b * 2, this.sr);
    }
  }

  tick(dt: number, wave: number): number {
    // Recalcular las tres campanas por sample sería tirar CPU: la vocal solo
    // se mueve cuando alguien la mueve, y con paso de 1/64 no se oye escalón.
    const step = (wave * 64) | 0;
    if (step !== this.lastStep) {
      this.lastStep = step;
      this.setVowel(step / 64);
    }
    this.phase += dt;
    this.phase -= Math.floor(this.phase);
    // Pulso glotal: sierra con el filo redondeado (menos alias, más voz).
    const saw = readTable(2, mipFor(dt), this.phase);
    const source = saw - saw * saw * saw * 0.3;
    let s = 0;
    for (let b = 0; b < 3; b++) s += this.bands[b]!.tick(source) * VOWEL_GAINS[b]!;
    return s * 0.6;
  }

  dispose(): void {}
}

/** Seno grave con caída de tono y saturación: el sub/808 de la casa. */
class SubOsc implements PrismaOsc {
  private phase: number;
  private drop = 1;
  private readonly dropCoef: number;

  constructor(phase: number, sr: number) {
    this.phase = phase;
    this.dropCoef = Math.exp(-1 / (0.018 * sr));
  }

  tick(dt: number, wave: number): number {
    this.drop *= this.dropCoef;
    this.phase += dt * (1 + this.drop * 1.2);
    this.phase -= Math.floor(this.phase);
    const s = Math.sin(TWO_PI * this.phase);
    const k = 1 + wave * 9;
    return Math.tanh(s * k) / Math.tanh(k);
  }

  dispose(): void {}
}

function createOsc(
  def: PrismaLayerDef,
  seed: number,
  phase: number,
  sr: number,
): PrismaOsc {
  const p = def.params;
  switch (def.engine) {
    case 'pulse': return new PulseOsc(phase);
    case 'noise': return new NoiseOsc(seed, p['q'] ?? 3, sr);
    case 'fm': return new FmOsc(phase, p['ratio'] ?? 2, clamp01(p['feedback'] ?? 0));
    case 'pluck': return new PluckOsc(seed, p['damp'] ?? 0.4, phase);
    case 'organ': return new OrganOsc(phase, p['perc'] ?? 0, sr);
    case 'bell': return new BellOsc(phase, p['partials'] ?? 5, p['inharm'] ?? 0.4, sr);
    case 'formant': return new FormantOsc(phase, sr);
    case 'sub': return new SubOsc(phase, sr);
    default: return new WtOsc(phase);
  }
}

// ── Capa viva ────────────────────────────────────────────────────────────────

interface LiveUnit {
  osc: PrismaOsc;
  /** Multiplicador de frecuencia de este unísono (detune). */
  ratio: number;
  gainL: number;
  gainR: number;
}

interface LiveLayer {
  units: LiveUnit[];
  env: ADSR;
  /** Desplazamiento de wave propio de la capa, centrado en 0.5. */
  wave: number;
  level: number;
  /** Ratio de frecuencia de la capa (semis + fine). */
  ratio: number;
  /** Coeficiente del pasa-bajos de un polo de la capa; 0 = sin filtro. */
  lpCoef: number;
  lpL: number;
  lpR: number;
}

// ── Destinos de modulación ───────────────────────────────────────────────────

const MOD_PITCH = 0;
const MOD_CUTOFF = 1;
const MOD_LEVEL = 2;
const MOD_WAVE = 3;

/** Oscilador del LFO por voz (bipolar -1..1). */
function lfoWave(shape: number, phase: number): number {
  const ph = phase - Math.floor(phase);
  switch (shape | 0) {
    case 1:
      return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 2:
      return 2 * ph - 1;
    case 3:
      return ph < 0.5 ? 1 : -1;
    case 4:
      return hashUnit(Math.floor(phase)) * 2 - 1;
    default:
      return Math.sin(TWO_PI * ph);
  }
}

// ── La voz ───────────────────────────────────────────────────────────────────

/** Techo de osciladores por voz: capas × unísono nunca pasa de aquí. */
const MAX_UNITS = 12;

export class PrismaVoice extends Voice {
  private readonly sr: number;
  private readonly layers: LiveLayer[] = [];
  private readonly modEnv = new ADSR();
  private readonly filtL = new SVF();
  private readonly filtR = new SVF();
  private readonly toneLowL = new Biquad();
  private readonly toneLowR = new Biquad();
  private readonly toneHighL = new Biquad();
  private readonly toneHighR = new Biquad();

  /** Frecuencia de la nota con la que nació (base del glide). */
  private readonly bornFreq: number;
  /**
   * Transposición del canal (octava + semis + fino) como multiplicador, fijada
   * UNA vez al nacer. Antes se recalculaba en cada `glideTo` dividiendo por
   * `this.key`, que ya era la tecla del slide anterior: del segundo slide en
   * adelante se aplicaba el intervalo previo como desafinación y la voz se
   * quedaba clavada en la nota del primero.
   */
  private readonly tuneRatio: number;
  private freq: number;
  private targetFreq: number;
  private readonly glideCoef: number;

  private readonly cutoff: number;
  private readonly resonance: number;
  private readonly filterType: number;
  private readonly filterEnv: number;
  private readonly keytrackMul: number;
  private readonly filterOn: boolean;
  private lastCutoff = -1;

  private readonly modAmount: number;
  private readonly modTarget: number;
  private readonly lfoShape: number;
  private readonly lfoInc: number;
  private readonly lfoAmount: number;
  private readonly lfoTarget: number;
  private readonly lfoDelaySamples: number;
  private lfoPhase = 0;
  private lfoAge = 0;

  private readonly velGain: number;
  private readonly level: number;
  private readonly width: number;
  private readonly wave: number;
  private readonly driveK: number;
  private readonly driveComp: number;
  private readonly hasDrive: boolean;
  private readonly hasTone: boolean;

  private alive = true;
  private disposed = false;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    velocity: number,
    channelParams: Record<string, number>,
    ctx: VoiceContext,
    def: PrismaDef,
  ) {
    super(channelIndex, key, order);
    const sr = ctx.sr;
    this.sr = sr;

    // 1) Macros del preset sobre COPIAS: el preset no se toca nunca y dos
    //    canales con el mismo sonido no se pisan.
    const p: Record<string, number> = { ...channelParams };
    const defs: PrismaLayerDef[] = def.layers.map((l) => ({ ...l, params: { ...l.params } }));
    for (let m = 0; m < def.macros.length; m++) {
      const value = clamp01(p[`macro${m + 1}`] ?? 0.5);
      for (const t of def.macros[m]!.targets) {
        const v = t.min + (t.max - t.min) * value;
        if (t.layer < 0) {
          p[t.param] = v;
          continue;
        }
        const layer = defs[t.layer];
        if (!layer) continue;
        // Campo de la capa si existe; si no, parámetro propio del motor.
        if (Object.prototype.hasOwnProperty.call(layer, t.param)) {
          (layer as unknown as Record<string, number>)[t.param] = v;
        } else {
          layer.params[t.param] = v;
        }
      }
    }

    // 2) Perillas del canal.
    const octave = Math.round(p['octave'] ?? 0);
    this.wave = clamp01(p['wave'] ?? 0.5);
    this.level = p['level'] ?? 1;
    this.width = clamp(p['width'] ?? 1, 0, 2);
    const velSens = clamp01(p['velSens'] ?? 0.6);
    this.velGain = 1 - velSens + velSens * clamp01(velocity);

    this.tuneRatio = semiRatio(octave * 12 + (p['semi'] ?? 0) + (p['fine'] ?? 0) / 100);
    this.bornFreq = midiToHz(key) * this.tuneRatio;
    this.freq = this.bornFreq;
    this.targetFreq = this.bornFreq;
    const glide = Math.max(0, p['glide'] ?? 0);
    this.glideCoef = glide < 0.0005 ? 0 : Math.exp(-1 / (glide * sr));

    this.cutoff = clamp(p['cutoff'] ?? 20000, 20, 20000);
    this.resonance = clamp01(p['resonance'] ?? 0.15);
    this.filterType = clamp(Math.round(p['filterType'] ?? 0), 0, 3);
    this.filterEnv = clamp(p['filterEnv'] ?? 0, -1, 1);
    const keytrack = clamp01(p['keytrack'] ?? 0);
    // Keytrack: el filtro sube con la tecla tomando C5 (60) como referencia.
    this.keytrackMul = keytrack === 0 ? 1 : semiRatio((key - 60) * keytrack);
    // Un LP totalmente abierto y sin resonancia no hace nada audible: mejor no
    // gastar el filtro en cada sample.
    this.filterOn =
      this.filterType !== 0 || this.cutoff < 19000 || this.resonance > 0.02 || this.filterEnv !== 0;

    this.modAmount = clamp(p['modAmount'] ?? 0, -1, 1);
    this.modTarget = clamp(Math.round(p['modTarget'] ?? 1), 0, 4);
    this.modEnv.set(
      Math.max(0.0005, p['modAttack'] ?? 0.005),
      Math.max(0.001, p['modDecay'] ?? 0.4),
      clamp01(p['modSustain'] ?? 0),
      Math.max(0.001, p['modRelease'] ?? 0.3),
      sr,
    );
    this.modEnv.on();

    this.lfoShape = clamp(Math.round(p['lfoShape'] ?? 0), 0, 4);
    this.lfoInc = Math.max(0.01, p['lfoRate'] ?? 5) / sr;
    this.lfoAmount = clamp01(p['lfoAmount'] ?? 0);
    this.lfoTarget = clamp(Math.round(p['lfoTarget'] ?? 0), 0, 4);
    this.lfoDelaySamples = Math.max(0, p['lfoDelay'] ?? 0) * sr;

    const drive = clamp01(p['drive'] ?? 0);
    this.hasDrive = drive > 0.001;
    this.driveK = 1 + drive * 9;
    this.driveComp = this.hasDrive ? 1 / Math.tanh(this.driveK) : 1;

    const bass = p['bass'] ?? 0;
    const treble = p['treble'] ?? 0;
    this.hasTone = bass !== 0 || treble !== 0;
    if (this.hasTone) {
      this.toneLowL.lowShelf(180, bass, sr);
      this.toneLowR.copyFrom(this.toneLowL);
      this.toneHighL.highShelf(3500, treble, sr);
      this.toneHighR.copyFrom(this.toneHighL);
    }

    // 3) Capas audibles en esta tecla, con el unísono repartido para no pasar
    //    del techo de osciladores.
    const unison = clamp(Math.round(p['unison'] ?? 1), 1, 8);
    const uniDetune = clamp01(p['uniDetune'] ?? 0.25);
    const uniWidth = clamp01(p['uniWidth'] ?? 0.6);
    const audible = defs.filter((l) => key >= l.keyLo && key <= l.keyHi);
    const perLayer = Math.max(
      1,
      Math.min(unison, Math.floor(MAX_UNITS / Math.max(1, audible.length))),
    );

    const attack = Math.max(0.0005, p['attack'] ?? 0.005);
    const decay = Math.max(0.001, p['decay'] ?? 0.6);
    const sustain = clamp01(p['sustain'] ?? 0.8);
    const release = Math.max(0.001, p['release'] ?? 0.3);

    for (let li = 0; li < audible.length; li++) {
      const d = audible[li]!;
      const env = new ADSR();
      env.set(
        Math.max(0.0005, attack * d.attackMul),
        Math.max(0.001, decay * d.decayMul),
        clamp01(sustain + d.sustainAdd),
        Math.max(0.001, release * d.releaseMul),
        sr,
      );
      env.on();

      const layerPan = clamp(d.pan * this.width, -1, 1);
      const units: LiveUnit[] = [];
      for (let u = 0; u < perLayer; u++) {
        const spread = perLayer === 1 ? 0 : (u / (perLayer - 1)) * 2 - 1;
        const seed = (order * 9176 + li * 613 + u * 71 + key) | 0;
        const phase = d.phase < 0 ? hashUnit(seed) : (d.phase + u * 0.37) % 1;
        // El unísono se abanica alrededor del pan de la capa sin salirse.
        const pan = clamp(layerPan + spread * uniWidth * (1 - Math.abs(layerPan)), -1, 1);
        const angle = ((pan + 1) / 4) * Math.PI;
        units.push({
          osc: createOsc(d, seed, phase, sr),
          // uniDetune 1 = ±50 cents.
          ratio: semiRatio((spread * uniDetune * 50) / 100),
          gainL: Math.cos(angle) * 1.414,
          gainR: Math.sin(angle) * 1.414,
        });
      }

      const cutoffMul = d.cutoffOct === 0 ? 1 : Math.pow(2, d.cutoffOct);
      const layerVel = 1 - d.velTrack + d.velTrack * clamp01(velocity);
      this.layers.push({
        units,
        env,
        wave: d.wave - 0.5,
        level: (d.level * layerVel) / Math.sqrt(perLayer),
        ratio: semiRatio(d.semi + d.fine / 100),
        lpCoef:
          cutoffMul === 1
            ? 0
            : Math.exp((-2 * Math.PI * Math.min(this.cutoff * cutoffMul, sr * 0.45)) / sr),
        lpL: 0,
        lpR: 0,
      });
    }
  }

  noteOff(): void {
    this.releasing = true;
    this.modEnv.off();
    for (const l of this.layers) l.env.off();
  }

  /**
   * Nota slide/legato: la voz cambia de altura sin retrigger. Se conserva la
   * relación entre la frecuencia de nacimiento y la tecla original, así la
   * octava y el fino del canal siguen aplicando después del salto.
   */
  override glideTo(key: number, velocity: number): void {
    super.glideTo(key, velocity);
    this.targetFreq = midiToHz(key) * this.tuneRatio;
    if (this.glideCoef === 0) this.freq = this.targetFreq;
    this.releasing = false;
  }

  render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean {
    if (!this.alive) return false;
    const layers = this.layers;
    const nLayers = layers.length;
    if (nLayers === 0) {
      this.alive = false;
      this.dispose();
      return false;
    }

    const sr = this.sr;
    const modOn = this.modAmount !== 0;
    const lfoOn = this.lfoAmount > 0.0005;
    const outGain = this.level * this.velGain * 0.5;
    let died = false;

    for (let i = from; i < to; i++) {
      // Glide hacia la nota destino (mono/legato).
      if (this.glideCoef !== 0 && this.freq !== this.targetFreq) {
        this.freq = this.targetFreq + (this.freq - this.targetFreq) * this.glideCoef;
      }

      // La envolvente de modulación avanza SIEMPRE: la usa también el filtro.
      const modEnvValue = this.modEnv.tick();
      const mod = modOn ? modEnvValue * this.modAmount : 0;

      let lfo = 0;
      if (lfoOn) {
        this.lfoAge++;
        if (this.lfoAge >= this.lfoDelaySamples) {
          this.lfoPhase += this.lfoInc;
          lfo = lfoWave(this.lfoShape, this.lfoPhase) * this.lfoAmount;
        }
      }

      let pitchMod = 0;
      let cutoffMod = 0;
      let levelMod = 0;
      let waveMod = 0;
      let panMod = 0;
      if (mod !== 0) {
        if (this.modTarget === MOD_PITCH) pitchMod += mod * 24;
        else if (this.modTarget === MOD_CUTOFF) cutoffMod += mod;
        else if (this.modTarget === MOD_LEVEL) levelMod += mod;
        else if (this.modTarget === MOD_WAVE) waveMod += mod;
        else panMod += mod;
      }
      if (lfo !== 0) {
        if (this.lfoTarget === MOD_PITCH) pitchMod += lfo * 12;
        else if (this.lfoTarget === MOD_CUTOFF) cutoffMod += lfo;
        else if (this.lfoTarget === MOD_LEVEL) levelMod += lfo;
        else if (this.lfoTarget === MOD_WAVE) waveMod += lfo;
        else panMod += lfo;
      }

      const freq = pitchMod === 0 ? this.freq : this.freq * semiRatio(pitchMod);
      const waveBase = this.wave - 0.5 + waveMod;

      // Suma de capas.
      let sumL = 0;
      let sumR = 0;
      let anyLayerAlive = false;
      for (let li = 0; li < nLayers; li++) {
        const layer = layers[li]!;
        const env = layer.env.tick();
        if (!layer.env.active) continue;
        anyLayerAlive = true;
        const dt = (freq * layer.ratio) / sr;
        const wave = clamp01(0.5 + waveBase + layer.wave);
        let l = 0;
        let r = 0;
        const units = layer.units;
        for (let u = 0; u < units.length; u++) {
          const unit = units[u]!;
          const s = unit.osc.tick(dt * unit.ratio, wave);
          l += s * unit.gainL;
          r += s * unit.gainR;
        }
        if (layer.lpCoef !== 0) {
          const k = layer.lpCoef;
          layer.lpL = l * (1 - k) + layer.lpL * k;
          layer.lpR = r * (1 - k) + layer.lpR * k;
          l = layer.lpL;
          r = layer.lpR;
        }
        const amp = env * layer.level;
        sumL += l * amp;
        sumR += r * amp;
      }
      if (!anyLayerAlive) {
        died = true;
        break;
      }

      // Filtro común de la voz.
      if (this.filterOn) {
        const shift = cutoffMod + this.filterEnv * modEnvValue;
        const target =
          shift === 0
            ? this.cutoff * this.keytrackMul
            : clamp(this.cutoff * this.keytrackMul * semiRatio(shift * 72), 20, 20000);
        // Coeficientes solo cuando el corte se mueve de verdad (> 0.2 %).
        if (target > this.lastCutoff * 1.002 || target < this.lastCutoff * 0.998) {
          this.lastCutoff = target;
          this.filtL.set(target, this.resonance, sr);
          this.filtR.set(target, this.resonance, sr);
        }
        if (this.filterType === 3) {
          // Notch = entrada menos la banda pasante.
          sumL -= this.filtL.tick(sumL, 2);
          sumR -= this.filtR.tick(sumR, 2);
        } else {
          sumL = this.filtL.tick(sumL, this.filterType);
          sumR = this.filtR.tick(sumR, this.filterType);
        }
      }

      if (this.hasDrive) {
        sumL = Math.tanh(sumL * this.driveK) * this.driveComp;
        sumR = Math.tanh(sumR * this.driveK) * this.driveComp;
      }
      if (this.hasTone) {
        sumL = this.toneHighL.tick(this.toneLowL.tick(sumL));
        sumR = this.toneHighR.tick(this.toneLowR.tick(sumR));
      }

      let amp = outGain;
      if (levelMod !== 0) amp *= clamp(1 + levelMod, 0, 2);
      if (panMod !== 0) {
        const pan = clamp(panMod, -1, 1);
        sumL *= 1 - (pan > 0 ? pan : 0);
        sumR *= 1 + (pan < 0 ? pan : 0);
      }
      outL[i]! += sumL * amp * gainL;
      outR[i]! += sumR * amp * gainR;
    }

    if (died) {
      this.alive = false;
      this.dispose();
    }
    return this.alive;
  }

  /** Devuelve al pool las líneas de retardo prestadas. Idempotente. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const l of this.layers) {
      for (const u of l.units) u.osc.dispose();
    }
  }
}
