/**
 * Voces de instrumento. Cada voz renderiza SUMANDO al buffer de su pista de
 * mixer; la ganancia L/R (canal vol/pan ya resueltos) la pasa el kernel por
 * bloque, así los cambios en vivo entran sin recrear la voz.
 */

import { DRUM_MAP, midiToHz } from '@orbit/core';
import { ADSR, DecayEnv } from './env';
import { Noise, Osc, TWO_PI } from './osc';
import { Biquad, SVF } from './filters';

export interface SampleData {
  left: Float32Array;
  right: Float32Array;
  rate: number;
}

export interface VoiceContext {
  sr: number;
  samples: Map<string, SampleData>;
  /**
   * Buffers de trabajo del kernel, compartidos por todas las voces (se
   * renderiza una detrás de otra en el mismo hilo). Los usa Flux para saturar
   * la suma de sus capas sin alocar nada por nota.
   */
  scratchL?: Float32Array;
  scratchR?: Float32Array;
}

export abstract class Voice {
  releasing = false;

  constructor(
    public readonly channelIndex: number,
    public key: number,
    public readonly startOrder: number,
  ) {}

  abstract noteOff(): void;
  /** Nota slide: la voz cambia de altura sin retrigger (808). */
  glideTo(key: number, _velocity: number): void {
    this.key = key;
  }
  /**
   * Renderiza [from, to) sumando en outL/outR con las ganancias dadas.
   * Devuelve false cuando la voz terminó (el kernel la recicla).
   */
  abstract render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean;
}

// ── Orbit Sub (808) ──────────────────────────────────────────────────────────

export class Sub808Voice extends Voice {
  private phase = 0;
  private freq: number;
  private targetFreq: number;
  private glideCoef: number;
  private pitchEnv = 1;
  private pitchCoef: number;
  private amp = new DecayEnv();
  private tone = new SVF();
  private drive: number;
  private punch: number;
  private releaseCoef: number;
  private releaseGain = 1;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    const tune = p['tune'] ?? 0;
    this.freq = midiToHz(key + tune);
    this.targetFreq = this.freq;
    this.glideCoef = Math.exp(-1 / (Math.max(0.001, p['glide'] ?? 0.06) * sr));
    this.punch = p['punch'] ?? 0.5;
    this.pitchCoef = Math.exp(-1 / (0.02 * sr));
    this.drive = 1 + (p['drive'] ?? 0.45) * 7;
    this.amp.trigger(p['decay'] ?? 1.2, sr);
    this.tone.set(p['tone'] ?? 900, 0.1, sr);
    this.releaseCoef = Math.exp(-1 / (0.05 * sr));
  }

  override glideTo(key: number, _velocity: number): void {
    this.key = key;
    this.targetFreq = midiToHz(key);
    // Re-dispara la envolvente suavemente para sostener la cola del slide.
    this.releasing = false;
    this.releaseGain = 1;
  }

  noteOff(): void {
    this.releasing = true;
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    const driveNorm = Math.tanh(this.drive * 0.8);
    for (let i = from; i < to; i++) {
      this.freq = this.targetFreq + (this.freq - this.targetFreq) * this.glideCoef;
      this.pitchEnv *= this.pitchCoef;
      const f = this.freq * (1 + this.punch * 3 * this.pitchEnv);
      this.phase += f / this.sr;
      if (this.phase >= 1) this.phase -= 1;
      let s = Math.sin(TWO_PI * this.phase);
      s = Math.tanh(s * this.drive) / driveNorm;
      s = this.tone.tick(s, 0);
      const env = this.amp.tick();
      if (this.releasing) this.releaseGain *= this.releaseCoef;
      const v = s * env * this.releaseGain * this.velocity;
      outL[i]! += v * gainL;
      outR[i]! += v * gainR;
    }
    return this.amp.active && this.releaseGain > 0.0005;
  }
}

// ── Orbit Synth (sustractivo) ────────────────────────────────────────────────

export class SynthVoice extends Voice {
  private oscs: Osc[] = [];
  private detunes: number[] = [];
  private ampEnv = new ADSR();
  private filtEnv = new ADSR();
  private svfL = new SVF();
  private wave: number;
  private cutoff: number;
  private resonance: number;
  private envAmount: number;
  private unison: number;
  private baseFreq: number;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    this.wave = p['wave'] ?? 0;
    this.cutoff = p['cutoff'] ?? 4000;
    this.resonance = p['resonance'] ?? 0.2;
    this.envAmount = p['envAmount'] ?? 0.4;
    this.unison = Math.min(5, Math.max(1, Math.round(p['unison'] ?? 1)));
    const detune = p['detune'] ?? 0.1;
    this.baseFreq = midiToHz(key + (p['octave'] ?? 0) * 12);
    for (let i = 0; i < this.unison; i++) {
      this.oscs.push(new Osc(i / this.unison));
      const spread = this.unison === 1 ? 0 : (i / (this.unison - 1)) * 2 - 1;
      this.detunes.push(Math.pow(2, (spread * detune * 50) / 1200));
    }
    this.ampEnv.set(p['attack'] ?? 0.005, p['decay'] ?? 0.3, p['sustain'] ?? 0.7, p['release'] ?? 0.25, sr);
    this.filtEnv.set(p['attack'] ?? 0.005, (p['decay'] ?? 0.3) * 1.4, 0.2, p['release'] ?? 0.25, sr);
    this.ampEnv.on();
    this.filtEnv.on();
  }

  noteOff(): void {
    this.releasing = true;
    this.ampEnv.off();
    this.filtEnv.off();
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    const norm = 1 / Math.sqrt(this.unison);
    for (let i = from; i < to; i++) {
      const fe = this.filtEnv.tick();
      const fc = this.cutoff * Math.pow(2, this.envAmount * 4 * fe);
      this.svfL.set(fc, this.resonance, this.sr);
      let s = 0;
      for (let o = 0; o < this.unison; o++) {
        const dt = (this.baseFreq * this.detunes[o]!) / this.sr;
        s += this.oscs[o]!.tick(this.wave, dt);
      }
      s = this.svfL.tick(s * norm, 0);
      const v = s * this.ampEnv.tick() * this.velocity * 0.6;
      outL[i]! += v * gainL;
      outR[i]! += v * gainR;
    }
    return this.ampEnv.active;
  }
}

// ── Orbit Saw (supersaw 7 osc) ───────────────────────────────────────────────

const SS_DETUNE = [-1, -0.64, -0.27, 0, 0.27, 0.64, 1];
const SS_PAN = [-1, 0.7, -0.4, 0, 0.4, -0.7, 1];

export class SupersawVoice extends Voice {
  private oscs: Osc[] = [];
  private ratios: number[] = [];
  private env = new ADSR();
  private svfL = new SVF();
  private svfR = new SVF();
  private blend: number;
  private width: number;
  private baseFreq: number;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    const detune = p['detune'] ?? 0.4;
    this.blend = p['blend'] ?? 0.7;
    this.width = p['width'] ?? 0.8;
    this.baseFreq = midiToHz(key + (p['octave'] ?? 0) * 12);
    for (let i = 0; i < 7; i++) {
      this.oscs.push(new Osc((i * 0.618) % 1));
      this.ratios.push(Math.pow(2, (SS_DETUNE[i]! * detune * 60) / 1200));
    }
    this.env.set(p['attack'] ?? 0.01, 1, 1, p['release'] ?? 0.4, sr);
    this.env.on();
    const cutoff = p['cutoff'] ?? 8000;
    this.svfL.set(cutoff, 0.1, sr);
    this.svfR.set(cutoff, 0.1, sr);
  }

  noteOff(): void {
    this.releasing = true;
    this.env.off();
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    for (let i = from; i < to; i++) {
      let sl = 0;
      let sr_ = 0;
      for (let o = 0; o < 7; o++) {
        const dt = (this.baseFreq * this.ratios[o]!) / this.sr;
        const s = this.oscs[o]!.tick(0, dt) * (o === 3 ? 1 : this.blend);
        const pan = SS_PAN[o]! * this.width;
        sl += s * (1 - Math.max(0, pan));
        sr_ += s * (1 + Math.min(0, pan));
      }
      const e = this.env.tick() * this.velocity * 0.22;
      outL[i]! += this.svfL.tick(sl, 0) * e * gainL;
      outR[i]! += this.svfR.tick(sr_, 0) * e * gainR;
    }
    return this.env.active;
  }
}

// ── Orbit FM (2 operadores) ──────────────────────────────────────────────────

export class FmVoice extends Voice {
  private carPhase = 0;
  private modPhase = 0;
  private env = new ADSR();
  private idxEnv = new DecayEnv();
  private freq: number;
  private ratio: number;
  private index: number;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    this.freq = midiToHz(key + (p['octave'] ?? 0) * 12);
    this.ratio = p['ratio'] ?? 2;
    this.index = p['index'] ?? 3;
    this.idxEnv.trigger(p['indexDecay'] ?? 0.4, sr);
    this.env.set(p['attack'] ?? 0.002, p['decay'] ?? 1.2, p['sustain'] ?? 0, p['release'] ?? 0.4, sr);
    this.env.on();
  }

  noteOff(): void {
    this.releasing = true;
    this.env.off();
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    const dtC = this.freq / this.sr;
    const dtM = (this.freq * this.ratio) / this.sr;
    for (let i = from; i < to; i++) {
      this.modPhase = (this.modPhase + dtM) % 1;
      this.carPhase = (this.carPhase + dtC) % 1;
      const mod = Math.sin(TWO_PI * this.modPhase) * this.index * this.idxEnv.tick();
      const s = Math.sin(TWO_PI * this.carPhase + mod);
      const v = s * this.env.tick() * this.velocity * 0.6;
      outL[i]! += v * gainL;
      outR[i]! += v * gainR;
    }
    return this.env.active;
  }
}

// ── Orbit Drums (kit sintetizado) ────────────────────────────────────────────

export class DrumVoice extends Voice {
  private piece: string;
  private t = 0;
  private amp = new DecayEnv();
  private pitchEnv = 1;
  private pitchCoef = 1;
  private baseFreq = 100;
  private phase = 0;
  private noise: Noise;
  private bp = new Biquad();
  private useBp = false;
  private noiseMix = 0;
  private toneMix = 1;
  private clapBursts = 0;
  private drive = 1;
  private done = false;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    this.piece = DRUM_MAP[key] ?? 'kick';
    this.noise = new Noise(0x9e3779b1 ^ (key * 2654435761));
    const tone = p['tone'] ?? 0.5;
    const decay = p['decay'] ?? 1;
    const punch = p['punch'] ?? 0.5;
    const kit = Math.round(p['kit'] ?? 0); // 0 trap, 1 boom bap, 2 latin

    switch (this.piece) {
      case 'kick': {
        this.baseFreq = kit === 1 ? 60 : 48 + tone * 20;
        this.pitchEnv = 4 + punch * 6;
        this.pitchCoef = Math.exp(-1 / (0.012 * sr));
        this.amp.trigger((kit === 1 ? 0.25 : 0.45) * decay, sr);
        this.drive = 1 + punch * 2;
        break;
      }
      case 'snare': {
        this.baseFreq = 170 + tone * 60;
        this.pitchEnv = 1.5;
        this.pitchCoef = Math.exp(-1 / (0.01 * sr));
        this.amp.trigger(0.18 * decay, sr);
        this.useBp = true;
        this.bp.highpass(1400, 0.9, sr);
        this.noiseMix = 0.7;
        this.toneMix = 0.5;
        break;
      }
      case 'clap': {
        this.amp.trigger(0.16 * decay, sr);
        this.useBp = true;
        this.bp.peaking(1100, 12, 2.2, sr);
        this.noiseMix = 1;
        this.toneMix = 0;
        this.clapBursts = 3;
        break;
      }
      case 'hat':
      case 'openhat': {
        this.amp.trigger((this.piece === 'hat' ? 0.045 : 0.35) * decay, sr);
        this.useBp = true;
        this.bp.highpass(7000 + tone * 3000, 0.8, sr);
        this.noiseMix = 1;
        this.toneMix = 0;
        break;
      }
      case 'tom': {
        this.baseFreq = 100 + tone * 80;
        this.pitchEnv = 2;
        this.pitchCoef = Math.exp(-1 / (0.03 * sr));
        this.amp.trigger(0.3 * decay, sr);
        break;
      }
      case 'conga': {
        this.baseFreq = 180 + tone * 100;
        this.pitchEnv = 0.8;
        this.pitchCoef = Math.exp(-1 / (0.008 * sr));
        this.amp.trigger((kit === 2 ? 0.22 : 0.15) * decay, sr);
        this.noiseMix = 0.08;
        this.useBp = true;
        this.bp.highpass(2000, 0.7, sr);
        break;
      }
      case 'rim': {
        this.amp.trigger(0.03 * decay, sr);
        this.useBp = true;
        this.bp.peaking(900, 15, 4, sr);
        this.noiseMix = 0.6;
        this.baseFreq = 800;
        this.toneMix = 0.5;
        break;
      }
      case 'shaker': {
        this.amp.trigger(0.09 * decay, sr);
        this.useBp = true;
        this.bp.highpass(5500, 0.8, sr);
        this.noiseMix = 1;
        this.toneMix = 0;
        break;
      }
      case 'crash': {
        this.amp.trigger(1.4 * decay, sr);
        this.useBp = true;
        this.bp.highpass(4500, 0.6, sr);
        this.noiseMix = 1;
        this.toneMix = 0;
        break;
      }
      default: {
        this.amp.trigger(0.2 * decay, sr);
      }
    }
  }

  noteOff(): void {
    // Percusión one-shot: ignora note-off (salvo openhat → choke rápido).
    if (this.piece === 'openhat') this.amp.trigger(0.02, this.sr);
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    if (this.done) return false;
    for (let i = from; i < to; i++) {
      this.pitchEnv *= this.pitchCoef;
      let s = 0;
      if (this.toneMix > 0) {
        const f = this.baseFreq * (1 + this.pitchEnv);
        this.phase += f / this.sr;
        if (this.phase >= 1) this.phase -= 1;
        s += Math.sin(TWO_PI * this.phase) * this.toneMix;
      }
      if (this.noiseMix > 0) {
        let nz = this.noise.tick();
        if (this.useBp) nz = this.bp.tick(nz);
        s += nz * this.noiseMix;
      }
      let env = this.amp.tick();
      // Clap: ráfagas retriggeadas cada ~11 ms.
      if (this.clapBursts > 0) {
        this.t++;
        if (this.t % Math.floor(0.011 * this.sr) === 0 && this.clapBursts > 1) {
          this.amp.trigger(0.16, this.sr);
          this.clapBursts--;
        }
        env = Math.min(1, env * 1.2);
      }
      if (this.drive > 1) s = Math.tanh(s * this.drive);
      const v = s * env * this.velocity;
      outL[i]! += v * gainL;
      outR[i]! += v * gainR;
    }
    if (!this.amp.active && this.clapBursts <= 1) this.done = true;
    return !this.done;
  }
}

// ── Orbit Sampler ────────────────────────────────────────────────────────────

export class SamplerVoice extends Voice {
  private pos: number;
  private rate: number;
  private env = new ADSR();
  private data: SampleData | null;
  private reverse: boolean;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    ctx: VoiceContext,
    sampleId: string | undefined,
  ) {
    super(channelIndex, key, order);
    this.data = sampleId ? ctx.samples.get(sampleId) ?? null : null;
    const keytrack = (p['keytrack'] ?? 1) >= 0.5;
    const semis = (p['pitch'] ?? 0) + (keytrack ? key - 60 : 0);
    const srcRate = this.data?.rate ?? ctx.sr;
    this.rate = (srcRate / ctx.sr) * Math.pow(2, semis / 12);
    this.reverse = (p['reverse'] ?? 0) >= 0.5;
    const len = this.data?.left.length ?? 0;
    const startFrac = p['start'] ?? 0;
    this.pos = this.reverse ? len - 1 - startFrac * len : startFrac * len;
    this.env.set(p['attack'] ?? 0.001, 1, 1, p['release'] ?? 0.05, ctx.sr);
    this.env.on();
  }

  noteOff(): void {
    this.releasing = true;
    this.env.off();
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    const d = this.data;
    if (!d) return false;
    const len = d.left.length;
    for (let i = from; i < to; i++) {
      const idx = Math.floor(this.pos);
      if (idx < 0 || idx >= len - 1) return false;
      const frac = this.pos - idx;
      const sl = d.left[idx]! * (1 - frac) + d.left[idx + 1]! * frac;
      const srr = d.right[idx]! * (1 - frac) + d.right[idx + 1]! * frac;
      const e = this.env.tick() * this.velocity;
      outL[i]! += sl * e * gainL;
      outR[i]! += srr * e * gainR;
      this.pos += this.reverse ? -this.rate : this.rate;
    }
    return this.env.active;
  }
}

// ── Orbit Flux (instrumento de presets) ──────────────────────────────────────

/** Capa de un preset ya resuelta para el kernel. */
export interface FluxLayerDef {
  engine: string;
  params: Record<string, number>;
  gain: number;
  pan: number;
  transpose: number;
}

/** Macro del preset: qué parámetros mueve y entre qué valores. */
export interface FluxMacroDef {
  targets: { layer: number; param: string; min: number; max: number }[];
}

/**
 * Voz de Flux: apila las voces de sus capas y las mezcla.
 *
 * Las perillas fijas del canal (filtro, ataque, release, drive, width, octava)
 * y las dos macros del preset se resuelven AQUÍ, al disparar la nota, sobre
 * una copia de los params de cada capa — el preset nunca se modifica y dos
 * canales con el mismo sonido no se pisan.
 */
export class FluxVoice extends Voice {
  private layers: { voice: Voice; gainL: number; gainR: number }[] = [];
  private drive: number;
  private driveK = 1;
  private driveComp = 1;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    velocity: number,
    p: Record<string, number>,
    private ctx: VoiceContext,
    defs: FluxLayerDef[],
    macros: FluxMacroDef[],
  ) {
    super(channelIndex, key, order);
    const filter = p['filter'] ?? 0.5;
    const attack = p['attack'] ?? 0.5;
    const release = p['release'] ?? 0.5;
    const width = p['width'] ?? 0.5;
    const octave = Math.round(p['octave'] ?? 0);
    this.drive = p['drive'] ?? 0;
    if (this.drive > 0.001) {
      this.driveK = 1 + this.drive * 9;
      this.driveComp = 1 / Math.tanh(this.driveK);
    }
    // Factores exponenciales: 0.5 (centro) = tal cual lo dejó el preset.
    const filterMul = Math.pow(2, (filter - 0.5) * 4);
    const attackMul = Math.pow(2, (attack - 0.5) * 4);
    const releaseMul = Math.pow(2, (release - 0.5) * 4);
    const panScale = width * 2;

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const params: Record<string, number> = { ...def.params };
      // Macros del preset (macro1, macro2) antes que las perillas fijas: así
      // el filtro del canal sigue mandando sobre lo que la macro deje.
      for (let m = 0; m < macros.length; m++) {
        const value = p[`macro${m + 1}`] ?? 0.5;
        for (const t of macros[m]!.targets) {
          if (t.layer !== -1 && t.layer !== i) continue;
          params[t.param] = t.min + (t.max - t.min) * value;
        }
      }
      if (params['cutoff'] !== undefined) params['cutoff'] *= filterMul;
      if (params['tone'] !== undefined) params['tone'] *= filterMul;
      if (params['attack'] !== undefined) params['attack'] *= attackMul;
      if (params['release'] !== undefined) params['release'] *= releaseMul;
      else if (params['decay'] !== undefined) params['decay'] *= releaseMul;

      const layerKey = key + def.transpose + octave * 12;
      const voice = createVoice(def.engine, channelIndex, layerKey, order, velocity, params, ctx);
      const pan = Math.max(-1, Math.min(1, def.pan * panScale));
      this.layers.push({
        voice,
        gainL: def.gain * Math.cos(((pan + 1) / 4) * Math.PI) * 1.414,
        gainR: def.gain * Math.sin(((pan + 1) / 4) * Math.PI) * 1.414,
      });
    }
  }

  noteOff(): void {
    this.releasing = true;
    for (const l of this.layers) l.voice.noteOff();
  }

  override glideTo(key: number, velocity: number): void {
    super.glideTo(key, velocity);
    for (const l of this.layers) l.voice.glideTo(key, velocity);
  }

  render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean {
    let alive = false;
    const sl = this.ctx.scratchL;
    const sr = this.ctx.scratchR;
    // Sin drive las capas suman directas al bus: ni copia ni buffer intermedio.
    if (this.drive <= 0.001 || !sl || !sr) {
      for (const l of this.layers) {
        alive = l.voice.render(outL, outR, from, to, gainL * l.gainL, gainR * l.gainR) || alive;
      }
      return alive;
    }
    sl.fill(0, from, to);
    sr.fill(0, from, to);
    for (const l of this.layers) {
      alive = l.voice.render(sl, sr, from, to, l.gainL, l.gainR) || alive;
    }
    const k = this.driveK;
    const comp = this.driveComp;
    for (let i = from; i < to; i++) {
      outL[i]! += Math.tanh(sl[i]! * k) * comp * gainL;
      outR[i]! += Math.tanh(sr[i]! * k) * comp * gainR;
    }
    return alive;
  }
}

// ── Fábrica ──────────────────────────────────────────────────────────────────

export function createVoice(
  kind: string,
  channelIndex: number,
  key: number,
  order: number,
  velocity: number,
  params: Record<string, number>,
  ctx: VoiceContext,
  sampleId?: string,
  flux?: { layers: FluxLayerDef[]; macros: FluxMacroDef[] },
): Voice {
  switch (kind) {
    case 'flux':
      return flux
        ? new FluxVoice(channelIndex, key, order, velocity, params, ctx, flux.layers, flux.macros)
        : new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'sub808': return new Sub808Voice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'synth': return new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'supersaw': return new SupersawVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'fm': return new FmVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'drums': return new DrumVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'sampler': return new SamplerVoice(channelIndex, key, order, velocity, params, ctx, sampleId);
    default: return new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
  }
}
