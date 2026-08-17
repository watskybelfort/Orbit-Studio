/**
 * Orbit Convolver: reverb por convolución con IR SINTÉTICA.
 *
 * Nada de archivos de IR: la respuesta se genera aquí (ruido con semilla fija
 * decayendo, filtrado y normalizado por energía), así el .orbit sigue siendo
 * autocontenido y dos renders del mismo proyecto dan el mismo WAV.
 *
 * La convolución es particionada por FFT con overlap-add y línea de retardo en
 * frecuencia (FDL). Las particiones NO son todas de 128: una cola de 8 s a 48 k
 * son 3000 particiones de 128 y eso no cabe en el hilo de audio. Se usan tres
 * etapas — 128, 1024 y 4096 — donde cada etapa cubre desplazamientos de la IR
 * mayores o iguales a su propio bloque, que es justo la condición para que su
 * latencia de bloque quede absorbida por el retardo que ya tiene esa parte de
 * la cola. La etapa de 128 arranca en el desplazamiento 0 y por eso procesa el
 * bloque actual en el acto (sin latencia interna).
 *
 * Medido en esta máquina, cola de 8 s en estéreo: ~5 % de un núcleo, con el
 * peor bloque en 1.6 ms sobre los 2.7 ms que dura un quantum de 128 a 48 k.
 */

import { Fft } from './fft';
import { Noise, TWO_PI } from './osc';

/** Bloque del kernel: la unidad con la que entra y sale el audio. */
export const CONV_BLOCK = 128;

/** Techo de la cola. Más allá el coste de memoria/CPU no compensa. */
export const MAX_IR_SECONDS = 8;

/** Etapas: [tamaño de bloque, nº de particiones]. La última crece con la IR. */
const STAGE_BLOCK_1 = 1024;
const STAGE_BLOCK_2 = 4096;
const STAGE_0_PARTS = STAGE_BLOCK_1 / CONV_BLOCK; // cubre [0, 1024)
const STAGE_1_PARTS = STAGE_BLOCK_2 / STAGE_BLOCK_1 - 1; // cubre [1024, 8192)

// ── Una etapa de la convolución particionada ─────────────────────────────────

/**
 * Convoluciona el trozo de IR [offset, offset + parts*block) con la entrada.
 * Guarda solo la mitad hermítica del espectro (la entrada es real): la mitad
 * superior se reconstruye por simetría antes de la IFFT.
 */
class ConvStage {
  private readonly fft: Fft;
  private readonly size: number; // tamaño FFT = 2 * block
  private readonly bins: number; // block + 1 bins útiles
  private readonly stride: number; // bins * 2 (re/im intercalados)
  private readonly h: Float32Array; // espectros de las particiones de la IR
  private readonly fdl: Float32Array; // espectros de los bloques de entrada
  private readonly workRe: Float32Array;
  private readonly workIm: Float32Array;
  private readonly inBuf: Float32Array; // acumulador de entrada del bloque
  private readonly emit: Float32Array; // salida lista de la etapa
  private readonly carry: Float32Array; // segunda mitad del overlap-add
  private readonly accRe: Float32Array; // suma parcial de X[m-k]·H[k], k>=1
  private readonly accIm: Float32Array;
  /** Particiones que se acumulan por cada sub-bloque de 128 muestras. */
  private readonly perSub: number;
  /** true solo para la etapa que empieza en el desplazamiento 0. */
  private readonly immediate: boolean;
  private head: number;
  private pos = 0;
  private macCursor = 0;

  constructor(
    readonly block: number,
    readonly parts: number,
    offset: number,
    ir: Float32Array,
    irLength: number,
  ) {
    this.size = block * 2;
    this.bins = block + 1;
    this.stride = this.bins * 2;
    this.fft = new Fft(this.size);
    this.h = new Float32Array(parts * this.stride);
    this.fdl = new Float32Array(parts * this.stride);
    this.workRe = new Float32Array(this.size);
    this.workIm = new Float32Array(this.size);
    this.inBuf = new Float32Array(block);
    this.emit = new Float32Array(block);
    this.carry = new Float32Array(block);
    this.accRe = new Float32Array(this.bins);
    this.accIm = new Float32Array(this.bins);
    this.perSub = Math.max(1, Math.ceil(((parts - 1) * CONV_BLOCK) / block));
    this.immediate = offset === 0;
    this.head = parts - 1;

    // Espectro de cada partición de la IR (mitad alta rellena a cero: es lo
    // que convierte la convolución circular de la FFT en lineal).
    for (let k = 0; k < parts; k++) {
      const start = offset + k * block;
      this.workRe.fill(0);
      this.workIm.fill(0);
      const count = Math.min(block, Math.max(0, irLength - start));
      for (let j = 0; j < count; j++) this.workRe[j] = ir[start + j]!;
      this.fft.forward(this.workRe, this.workIm);
      const base = k * this.stride;
      for (let b = 0; b < this.bins; b++) {
        this.h[base + b * 2] = this.workRe[b]!;
        this.h[base + b * 2 + 1] = this.workIm[b]!;
      }
    }
  }

  /** Suma su aportación de CONV_BLOCK muestras sobre `out`. Sin alocar. */
  process(x: Float32Array, out: Float32Array): void {
    if (this.immediate) {
      // Etapa de cabeza: el bloque que acaba de entrar ya sale en este mismo
      // bloque, por eso el efecto no añade latencia propia.
      for (let i = 0; i < CONV_BLOCK; i++) this.inBuf[i] = x[i]!;
      this.spreadMac();
      this.compute();
      for (let i = 0; i < CONV_BLOCK; i++) out[i] = out[i]! + this.emit[i]!;
      return;
    }
    // Etapas de cola: emiten lo calculado al cerrar su bloque anterior; ese
    // desfase de un bloque es justo el desplazamiento de IR que cubren.
    const p = this.pos;
    for (let i = 0; i < CONV_BLOCK; i++) {
      out[i] = out[i]! + this.emit[p + i]!;
      this.inBuf[p + i] = x[i]!;
    }
    this.pos = p + CONV_BLOCK;
    this.spreadMac();
    if (this.pos >= this.block) {
      this.pos = 0;
      this.compute();
    }
  }

  /**
   * Reparte las multiplicaciones de las particiones viejas por los sub-bloques
   * de 128. Se puede porque sus espectros ya estaban en la FDL desde el cierre
   * anterior: solo la partición 0 necesita el bloque que acaba de entrar. Sin
   * esto, el cierre de la etapa larga se comía de golpe varias veces el
   * presupuesto de un quantum y eso es un corte de audio.
   */
  private spreadMac(): void {
    const parts = this.parts;
    if (parts <= 1) return;
    const { bins, stride, h, fdl, accRe, accIm } = this;
    let j = this.macCursor;
    const end = Math.min(parts - 1, j + this.perSub);
    for (; j < end; j++) {
      const xo = ((this.head - j + parts) % parts) * stride;
      const ho = (j + 1) * stride;
      for (let b = 0; b < bins; b++) {
        const xr = fdl[xo + b * 2]!;
        const xi = fdl[xo + b * 2 + 1]!;
        const hr = h[ho + b * 2]!;
        const hi = h[ho + b * 2 + 1]!;
        accRe[b] = accRe[b]! + xr * hr - xi * hi;
        accIm[b] = accIm[b]! + xr * hi + xi * hr;
      }
    }
    this.macCursor = j;
  }

  private compute(): void {
    const { size, bins, stride, block, h, fdl, workRe, workIm, accRe, accIm } = this;
    // 1) Espectro del bloque de entrada → primera posición de la FDL.
    workRe.set(this.inBuf);
    workRe.fill(0, block);
    workIm.fill(0);
    this.fft.forward(workRe, workIm);
    this.head = (this.head + 1) % this.parts;
    const base = this.head * stride;
    for (let b = 0; b < bins; b++) {
      fdl[base + b * 2] = workRe[b]!;
      fdl[base + b * 2 + 1] = workIm[b]!;
    }
    // 2) Solo falta la partición 0 (la única que usa el bloque recién entrado):
    // el resto de la suma ya viene repartida en el acumulador.
    for (let b = 0; b < bins; b++) {
      const xr = workRe[b]!;
      const xi = workIm[b]!;
      const hr = h[b * 2]!;
      const hi = h[b * 2 + 1]!;
      accRe[b] = accRe[b]! + xr * hr - xi * hi;
      accIm[b] = accIm[b]! + xr * hi + xi * hr;
    }
    for (let b = 0; b < bins; b++) {
      workRe[b] = accRe[b]!;
      workIm[b] = accIm[b]!;
    }
    accRe.fill(0);
    accIm.fill(0);
    this.macCursor = 0;
    // 3) Espejo hermítico (bins 0..block salen del acumulador, el resto por
    // simetría) y vuelta al tiempo.
    for (let b = 1; b < block; b++) {
      workRe[size - b] = workRe[b]!;
      workIm[size - b] = -workIm[b]!;
    }
    this.fft.inverse(workRe, workIm);
    // 4) Overlap-add: la cola del bloque anterior cae sobre este.
    for (let j = 0; j < block; j++) {
      this.emit[j] = workRe[j]! + this.carry[j]!;
      this.carry[j] = workRe[block + j]!;
    }
  }

  clear(): void {
    this.fdl.fill(0);
    this.emit.fill(0);
    this.carry.fill(0);
    this.inBuf.fill(0);
    this.accRe.fill(0);
    this.accIm.fill(0);
    this.pos = 0;
    this.macCursor = 0;
    this.head = this.parts - 1;
  }
}

// ── Convolución mono ─────────────────────────────────────────────────────────

/** Convolucionador mono por particiones. Consume y produce bloques de 128. */
export class PartitionedConvolver {
  private stages: ConvStage[] = [];

  /** Carga la IR y reconstruye las etapas. Asigna: NUNCA desde process(). */
  setIr(ir: Float32Array, length: number): void {
    const len = Math.min(length, ir.length);
    const stages: ConvStage[] = [];
    if (len > 0) {
      const p0 = Math.min(STAGE_0_PARTS, Math.ceil(len / CONV_BLOCK));
      stages.push(new ConvStage(CONV_BLOCK, p0, 0, ir, len));
      if (len > STAGE_BLOCK_1) {
        const p1 = Math.min(
          STAGE_1_PARTS,
          Math.ceil((len - STAGE_BLOCK_1) / STAGE_BLOCK_1),
        );
        stages.push(new ConvStage(STAGE_BLOCK_1, p1, STAGE_BLOCK_1, ir, len));
      }
      if (len > STAGE_BLOCK_2) {
        const p2 = Math.ceil((len - STAGE_BLOCK_2) / STAGE_BLOCK_2);
        stages.push(new ConvStage(STAGE_BLOCK_2, p2, STAGE_BLOCK_2, ir, len));
      }
    }
    this.stages = stages;
  }

  /** `inBuf` y `out` deben ser arrays distintos de CONV_BLOCK muestras. */
  processBlock(inBuf: Float32Array, out: Float32Array): void {
    out.fill(0, 0, CONV_BLOCK);
    for (let s = 0; s < this.stages.length; s++) {
      this.stages[s]!.process(inBuf, out);
    }
  }

  clear(): void {
    for (let s = 0; s < this.stages.length; s++) this.stages[s]!.clear();
  }
}

// ── IR sintética ─────────────────────────────────────────────────────────────

/** Semillas fijas y distintas por canal: eso descorrelaciona L/R. */
const IR_SEED_L = 0x51a9b3;
const IR_SEED_R = 0x2c7d61;

/** Reflexiones tempranas por canal (más de estas ya suena a flanger). */
const ER_TAPS = 7;

function renderIrChannel(
  out: Float32Array,
  sr: number,
  size: number,
  rt60: number,
  damp: number,
  seed: number,
): void {
  const n = out.length;
  const noise = new Noise(seed);
  const jitter = new Noise(seed ^ 0x5bf03635);
  // -60 dB justo al cumplirse `decay`: eso es la RT60 de la sala.
  const decayPerSample = Math.exp(-6.907755 / Math.max(1, rt60 * sr));
  // La energía no entra de golpe: una sala grande tarda más en difundirse.
  const build = Math.max(1, Math.floor(sr * (0.004 + 0.055 * size)));
  // damp=0 deja pasar hasta 20 kHz, damp=1 cierra en 400 Hz.
  const fcOpen = Math.min(sr * 0.45, 400 * Math.pow(50, 1 - damp));
  // Reflexiones tempranas: taps discretos con espaciado NO armónico (si fueran
  // periódicos sonarían a peine) que entran en la misma cadena que la cola, así
  // comparten envolvente y damping. `size` los aleja: es la sensación de sala.
  const first = 0.004 + 0.026 * size;
  const erIdx = new Int32Array(ER_TAPS);
  const erGain = new Float32Array(ER_TAPS);
  let erPos = 0;
  for (let j = 0; j < ER_TAPS; j++) {
    const gap = first * (0.7 + 0.5 * j) * (1 + jitter.tick() * 0.3);
    erPos += Math.max(1, Math.round(gap * sr));
    erIdx[j] = erPos;
    // Polaridad alterna: dos paredes seguidas no devuelven el mismo signo.
    erGain[j] = 2.6 * Math.pow(0.74, j) * (j % 2 === 0 ? 1 : -1);
  }
  let tap = 0;
  let env = 1;
  let lp = 0;
  let coef = 1 - Math.exp((-TWO_PI * fcOpen) / sr);
  for (let i = 0; i < n; i++) {
    // El corte cae con la cola: los agudos de una sala mueren antes que los
    // graves. Se recalcula cada 64 muestras (esto es construcción, no audio).
    if ((i & 63) === 0) {
      const fc = fcOpen * (0.35 + 0.65 * env);
      coef = 1 - Math.exp((-TWO_PI * fc) / sr);
    }
    const grow = i < build ? i / build : 1;
    let src = noise.tick() * grow * grow;
    if (tap < ER_TAPS && erIdx[tap]! === i) {
      src += erGain[tap]!;
      tap++;
    }
    lp += coef * (src * env - lp);
    out[i] = lp;
    env *= decayPerSample;
  }
  // Bloqueo de DC: el ruido con envolvente arrastra offset y eso se oiría como
  // un golpe de subgraves en cada disparo del reverb.
  const hc = Math.exp((-TWO_PI * 22) / sr);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < n; i++) {
    const x = out[i]!;
    prevOut = hc * (prevOut + x - prevIn);
    prevIn = x;
    out[i] = prevOut;
  }
  // Normalización por ENERGÍA (no por pico): así el nivel del wet no depende
  // del decay ni de dónde caiga el pico aleatorio de la cola.
  let energy = 0;
  for (let i = 0; i < n; i++) energy += out[i]! * out[i]!;
  if (energy > 1e-20) {
    const g = 1 / Math.sqrt(energy);
    for (let i = 0; i < n; i++) out[i] = out[i]! * g;
  }
}

/**
 * IR estéreo sintética. Cada canal queda con energía 1 (suma de cuadrados),
 * que es lo que mantiene el wet al nivel del dry sea cual sea la cola.
 */
export function buildSyntheticIr(
  sr: number,
  size: number,
  decay: number,
  damp: number,
): { l: Float32Array; r: Float32Array } {
  const rt60 = Math.min(MAX_IR_SECONDS, Math.max(0.05, decay));
  const len = Math.max(CONV_BLOCK, Math.round(rt60 * sr));
  const l = new Float32Array(len);
  const r = new Float32Array(len);
  const sz = Math.min(1, Math.max(0, size));
  const dp = Math.min(1, Math.max(0, damp));
  renderIrChannel(l, sr, sz, rt60, dp, IR_SEED_L);
  renderIrChannel(r, sr, sz, rt60, dp, IR_SEED_R);
  return { l, r };
}

// ── Reverb de convolución estéreo ────────────────────────────────────────────

/**
 * Envuelve dos convolucionadores (uno por canal, IRs descorrelacionadas) con
 * predelay y width. Devuelve SOLO el wet: el dry/wet lo mezcla el kernel.
 * Introduce 128 muestras de latencia (2.7 ms a 48 k) porque necesita el bloque
 * completo; en un reverb eso es predelay de más, inaudible.
 */
export class OrbitConvolver {
  private readonly convL = new PartitionedConvolver();
  private readonly convR = new PartitionedConvolver();
  private readonly inL = new Float32Array(CONV_BLOCK);
  private readonly inR = new Float32Array(CONV_BLOCK);
  private readonly outL = new Float32Array(CONV_BLOCK);
  private readonly outR = new Float32Array(CONV_BLOCK);
  /** Predelay propio: cambiarlo no obliga a regenerar la IR. */
  private readonly preL: Float32Array;
  private readonly preR: Float32Array;
  private preIdx = 0;
  private preSamples = 0;
  private fill = 0;
  private width = 1;
  private lastSize = -1;
  private lastDecay = -1;
  private lastDamp = -1;

  constructor(private readonly sr: number) {
    const maxPre = Math.max(2, Math.ceil(0.25 * sr) + 1);
    this.preL = new Float32Array(maxPre);
    this.preR = new Float32Array(maxPre);
  }

  /**
   * size/damp/width 0..1, decay en segundos, predelay en segundos.
   * La IR solo se regenera si cambia algo que la define, y esos tres valores se
   * redondean a una rejilla: construir la IR cuesta las FFTs de toda la cola, y
   * si alguien automatiza `decay` esto se llamaría en cada bloque. El paso de la
   * rejilla (1/32 y 50 ms) queda por debajo de lo que se oye.
   */
  set(size: number, decay: number, damp: number, predelay: number, width: number): void {
    const sz = Math.round(size * 32) / 32;
    const dc = Math.round(decay * 20) / 20;
    const dp = Math.round(damp * 32) / 32;
    if (sz !== this.lastSize || dc !== this.lastDecay || dp !== this.lastDamp) {
      this.lastSize = sz;
      this.lastDecay = dc;
      this.lastDamp = dp;
      const ir = buildSyntheticIr(this.sr, sz, dc, dp);
      this.convL.setIr(ir.l, ir.l.length);
      this.convR.setIr(ir.r, ir.r.length);
      this.outL.fill(0);
      this.outR.fill(0);
    }
    this.width = Math.min(1, Math.max(0, width));
    this.preSamples = Math.min(
      this.preL.length - 1,
      Math.max(0, Math.floor(predelay * this.sr)),
    );
  }

  /** Escribe el wet sobre l/r. Cero alocaciones. */
  process(l: Float32Array, r: Float32Array, n: number): void {
    const pre = this.preL.length;
    const w1 = this.width / 2 + 0.5;
    const w2 = (1 - this.width) / 2;
    for (let i = 0; i < n; i++) {
      // Escribir ANTES de leer: con predelay 0 hay que devolver la muestra de
      // ahora, no dar una vuelta entera al anillo.
      this.preL[this.preIdx] = l[i]!;
      this.preR[this.preIdx] = r[i]!;
      const rd = (this.preIdx - this.preSamples + pre) % pre;
      const dl = this.preL[rd]!;
      const dr = this.preR[rd]!;
      this.preIdx = (this.preIdx + 1) % pre;

      const f = this.fill;
      this.inL[f] = dl;
      this.inR[f] = dr;
      const wl = this.outL[f]!;
      const wr = this.outR[f]!;
      l[i] = wl * w1 + wr * w2;
      r[i] = wr * w1 + wl * w2;
      this.fill = f + 1;
      if (this.fill >= CONV_BLOCK) {
        this.fill = 0;
        this.convL.processBlock(this.inL, this.outL);
        this.convR.processBlock(this.inR, this.outR);
      }
    }
  }

  clear(): void {
    this.convL.clear();
    this.convR.clear();
    this.preL.fill(0);
    this.preR.fill(0);
    this.outL.fill(0);
    this.outR.fill(0);
    this.preIdx = 0;
    this.fill = 0;
  }
}
