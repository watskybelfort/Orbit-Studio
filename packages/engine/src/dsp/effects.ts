/**
 * Unidades de efecto del mixer. Procesan bloques L/R in-place.
 * El dry/wet (mix) lo aplica el kernel; el sidechain llega como buffers aparte.
 * Nada de alocaciones dentro de process().
 */

import type { EffectKind } from '@orbit/core';
import { OrbitConvolver } from './convolver';
import { DelayLine } from './delayline';
import { Allpass1, Biquad, EnvFollower, SVF, timeCoef } from './filters';
import { TWO_PI } from './osc';
import { Reverb } from './reverb';
import { Vinyl } from './vinyl';

export interface EffectUnit {
  setParams(params: Record<string, number>): void;
  setTempo?(bpm: number): void;
  process(
    l: Float32Array,
    r: Float32Array,
    n: number,
    scL: Float32Array | null,
    scR: Float32Array | null,
  ): void;
}

const dbToLin = (db: number) => Math.pow(10, db / 20);

// ── EQ paramétrico ───────────────────────────────────────────────────────────

class EqUnit implements EffectUnit {
  private hpL = new Biquad(); private hpR = new Biquad();
  private lowL = new Biquad(); private lowR = new Biquad();
  private midL = new Biquad(); private midR = new Biquad();
  private highL = new Biquad(); private highR = new Biquad();
  private lpL = new Biquad(); private lpR = new Biquad();
  private useHp = false;
  private useLp = false;

  constructor(private sr: number) {}

  setParams(p: Record<string, number>): void {
    const hp = p['hpFreq'] ?? 20;
    const lp = p['lpFreq'] ?? 20000;
    this.useHp = hp > 22;
    this.useLp = lp < 19500;
    if (this.useHp) { this.hpL.highpass(hp, 0.707, this.sr); this.hpR.copyFrom(this.hpL); }
    if (this.useLp) { this.lpL.lowpass(lp, 0.707, this.sr); this.lpR.copyFrom(this.lpL); }
    this.lowL.lowShelf(p['lowFreq'] ?? 120, p['lowGain'] ?? 0, this.sr);
    this.lowR.copyFrom(this.lowL);
    this.midL.peaking(p['midFreq'] ?? 1000, p['midGain'] ?? 0, p['midQ'] ?? 1, this.sr);
    this.midR.copyFrom(this.midL);
    this.highL.highShelf(p['highFreq'] ?? 6000, p['highGain'] ?? 0, this.sr);
    this.highR.copyFrom(this.highL);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      let a = l[i]!;
      let b = r[i]!;
      if (this.useHp) { a = this.hpL.tick(a); b = this.hpR.tick(b); }
      a = this.lowL.tick(a); b = this.lowR.tick(b);
      a = this.midL.tick(a); b = this.midR.tick(b);
      a = this.highL.tick(a); b = this.highR.tick(b);
      if (this.useLp) { a = this.lpL.tick(a); b = this.lpR.tick(b); }
      l[i] = a; r[i] = b;
    }
  }
}

// ── Compresor (con sidechain opcional) ───────────────────────────────────────

class CompressorUnit implements EffectUnit {
  private env = new EnvFollower();
  private attackCoef = 0;
  private releaseCoef = 0;
  private threshold = -18;
  private ratio = 4;
  private knee = 6;
  private makeupLin = 1;

  constructor(private sr: number) {}

  setParams(p: Record<string, number>): void {
    this.attackCoef = timeCoef(p['attack'] ?? 0.01, this.sr);
    this.releaseCoef = timeCoef(p['release'] ?? 0.15, this.sr);
    this.threshold = p['threshold'] ?? -18;
    this.ratio = Math.max(1, p['ratio'] ?? 4);
    this.knee = p['knee'] ?? 6;
    this.makeupLin = dbToLin(p['makeup'] ?? 0);
  }

  process(l: Float32Array, r: Float32Array, n: number, scL: Float32Array | null, scR: Float32Array | null): void {
    const detL = scL ?? l;
    const detR = scR ?? r;
    for (let i = 0; i < n; i++) {
      const det = Math.max(Math.abs(detL[i]!), Math.abs(detR[i]!));
      const env = this.env.tick(det, this.attackCoef, this.releaseCoef);
      const envDb = env <= 1e-6 ? -120 : 20 * Math.log10(env);
      const over = envDb - this.threshold;
      let gr = 0;
      if (over > this.knee / 2) {
        gr = over * (1 / this.ratio - 1);
      } else if (over > -this.knee / 2) {
        const x = over + this.knee / 2;
        gr = ((1 / this.ratio - 1) * x * x) / (2 * this.knee);
      }
      const g = dbToLin(gr) * this.makeupLin;
      l[i]! *= g;
      r[i]! *= g;
    }
  }
}

// ── Limiter lookahead ────────────────────────────────────────────────────────

const LOOKAHEAD = 64;

class LimiterUnit implements EffectUnit {
  private dl = new DelayLine(LOOKAHEAD + 4);
  private dr = new DelayLine(LOOKAHEAD + 4);
  private envGain = 1;
  private releaseCoef = 0;
  private gainIn = 1;
  private ceilingLin = dbToLin(-0.3);

  constructor(private sr: number) {}

  setParams(p: Record<string, number>): void {
    this.gainIn = dbToLin(p['gain'] ?? 0);
    this.ceilingLin = dbToLin(p['ceiling'] ?? -0.3);
    this.releaseCoef = timeCoef(p['release'] ?? 0.05, this.sr);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const inL = l[i]! * this.gainIn;
      const inR = r[i]! * this.gainIn;
      const peak = Math.max(Math.abs(inL), Math.abs(inR), 1e-9);
      const target = Math.min(1, this.ceilingLin / peak);
      if (target < this.envGain) this.envGain = target; // ataque instantáneo
      else this.envGain = target + (this.envGain - target) * this.releaseCoef;
      const outL = this.dl.read(LOOKAHEAD);
      const outR = this.dr.read(LOOKAHEAD);
      this.dl.write(inL);
      this.dr.write(inR);
      l[i] = outL * this.envGain;
      r[i] = outR * this.envGain;
    }
  }
}

// ── Reverb ───────────────────────────────────────────────────────────────────

class ReverbUnit implements EffectUnit {
  private rv: Reverb;
  private out: [number, number] = [0, 0];

  constructor(private sr: number) {
    this.rv = new Reverb(sr);
  }

  setParams(p: Record<string, number>): void {
    this.rv.set(p['size'] ?? 0.6, p['damp'] ?? 0.4, p['width'] ?? 1, p['predelay'] ?? 0.02, this.sr);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      this.rv.tick(l[i]!, r[i]!, this.out);
      l[i] = this.out[0];
      r[i] = this.out[1];
    }
  }
}

// ── Convolver (reverb por convolución con IR sintética) ──────────────────────

class ConvolverUnit implements EffectUnit {
  private cv: OrbitConvolver;

  constructor(sr: number) {
    this.cv = new OrbitConvolver(sr);
  }

  setParams(p: Record<string, number>): void {
    // La IR solo se regenera si cambia size/decay/damp (lo hace OrbitConvolver);
    // predelay y width son proceso, no cola.
    this.cv.set(
      p['size'] ?? 0.6,
      p['decay'] ?? 1.8,
      p['damp'] ?? 0.45,
      p['predelay'] ?? 0.02,
      p['width'] ?? 1,
    );
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    this.cv.process(l, r, n);
  }
}

// ── Vinilo (lo-fi de disco) ──────────────────────────────────────────────────

class VinylUnit implements EffectUnit {
  private vy: Vinyl;

  constructor(sr: number) {
    this.vy = new Vinyl(sr);
  }

  setParams(p: Record<string, number>): void {
    this.vy.set(
      p['crackle'] ?? 0.35,
      p['noise'] ?? 0.3,
      p['wow'] ?? 0.3,
      p['flutter'] ?? 0.25,
      p['tone'] ?? 8000,
    );
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    this.vy.process(l, r, n);
  }
}

// ── Delay sincronizado ───────────────────────────────────────────────────────

const DELAY_BEATS = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2];

class DelayUnit implements EffectUnit {
  private dl: DelayLine;
  private dr: DelayLine;
  private fbFilterL = new Biquad();
  private fbFilterR = new Biquad();
  private delaySamples = 12000;
  private feedback = 0.4;
  private pingpong = true;
  private bpm = 140;
  private timeIndex = 4;

  constructor(private sr: number) {
    this.dl = new DelayLine(sr * 4);
    this.dr = new DelayLine(sr * 4);
  }

  setTempo(bpm: number): void {
    this.bpm = bpm;
    this.recalc();
  }

  private recalc(): void {
    const beats = DELAY_BEATS[Math.round(this.timeIndex)] ?? 0.75;
    this.delaySamples = Math.min(this.sr * 4 - 2, beats * (60 / this.bpm) * this.sr);
  }

  setParams(p: Record<string, number>): void {
    this.timeIndex = p['time'] ?? 4;
    this.feedback = p['feedback'] ?? 0.4;
    this.pingpong = (p['pingpong'] ?? 1) >= 0.5;
    const f = p['filter'] ?? 3500;
    this.fbFilterL.lowpass(f, 0.707, this.sr);
    this.fbFilterR.copyFrom(this.fbFilterL);
    this.recalc();
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const tapL = this.fbFilterL.tick(this.dl.read(this.delaySamples));
      const tapR = this.fbFilterR.tick(this.dr.read(this.delaySamples));
      if (this.pingpong) {
        this.dl.write(l[i]! * 0.5 + r[i]! * 0.5 + tapR * this.feedback);
        this.dr.write(tapL * this.feedback);
      } else {
        this.dl.write(l[i]! + tapL * this.feedback);
        this.dr.write(r[i]! + tapR * this.feedback);
      }
      l[i] = tapL;
      r[i] = tapR;
    }
  }
}

// ── Chorus / Flanger ─────────────────────────────────────────────────────────

class ChorusUnit implements EffectUnit {
  private lines: DelayLine[] = [];
  private phases: number[] = [];
  private rate = 0.8;
  private depth = 0.5;
  private voices = 3;

  constructor(private sr: number) {
    for (let i = 0; i < 6; i++) {
      this.lines.push(new DelayLine(Math.ceil(sr * 0.06)));
      this.phases.push(i / 6);
    }
  }

  setParams(p: Record<string, number>): void {
    this.rate = p['rate'] ?? 0.8;
    this.depth = p['depth'] ?? 0.5;
    this.voices = Math.min(6, Math.max(2, Math.round(p['voices'] ?? 3)));
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const inc = this.rate / this.sr;
    const base = 0.014 * this.sr;
    const mod = 0.008 * this.sr * this.depth;
    for (let i = 0; i < n; i++) {
      const mono = (l[i]! + r[i]!) * 0.5;
      let outL = 0;
      let outR = 0;
      for (let v = 0; v < this.voices; v++) {
        const line = this.lines[v]!;
        const ph = this.phases[v]!;
        const d = base + mod * Math.sin(TWO_PI * ph);
        const s = line.read(d);
        line.write(mono);
        if (v % 2 === 0) outL += s;
        else outR += s;
        this.phases[v] = (ph + inc * (1 + v * 0.07)) % 1;
      }
      const norm = 2 / this.voices;
      l[i] = outL * norm + (this.voices <= 2 ? outR * norm : 0);
      r[i] = outR * norm + (this.voices <= 2 ? outL * norm : 0);
    }
  }
}

class FlangerUnit implements EffectUnit {
  private dl: DelayLine;
  private dr: DelayLine;
  private phase = 0;
  private rate = 0.3;
  private depth = 0.6;
  private feedback = 0.5;
  private fbL = 0;
  private fbR = 0;

  constructor(private sr: number) {
    this.dl = new DelayLine(Math.ceil(sr * 0.02));
    this.dr = new DelayLine(Math.ceil(sr * 0.02));
  }

  setParams(p: Record<string, number>): void {
    this.rate = p['rate'] ?? 0.3;
    this.depth = p['depth'] ?? 0.6;
    this.feedback = p['feedback'] ?? 0.5;
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const inc = this.rate / this.sr;
    for (let i = 0; i < n; i++) {
      const lfo = 0.5 + 0.5 * Math.sin(TWO_PI * this.phase);
      const d = (0.001 + 0.007 * this.depth * lfo) * this.sr;
      const tapL = this.dl.read(d);
      const tapR = this.dr.read(d * 1.02);
      this.dl.write(l[i]! + this.fbL * this.feedback);
      this.dr.write(r[i]! + this.fbR * this.feedback);
      this.fbL = tapL;
      this.fbR = tapR;
      l[i] = l[i]! + tapL;
      r[i] = r[i]! + tapR;
      this.phase = (this.phase + inc) % 1;
    }
  }
}

// ── Phaser ───────────────────────────────────────────────────────────────────

class PhaserUnit implements EffectUnit {
  private apsL: Allpass1[] = [];
  private apsR: Allpass1[] = [];
  private phase = 0;
  private rate = 0.4;
  private depth = 0.7;
  private stages = 4;
  private feedback = 0.3;
  private fbL = 0;
  private fbR = 0;

  constructor(private sr: number) {
    for (let i = 0; i < 8; i++) {
      this.apsL.push(new Allpass1());
      this.apsR.push(new Allpass1());
    }
  }

  setParams(p: Record<string, number>): void {
    this.rate = p['rate'] ?? 0.4;
    this.depth = p['depth'] ?? 0.7;
    this.stages = Math.min(8, Math.max(2, Math.round(p['stages'] ?? 4)));
    this.feedback = p['feedback'] ?? 0.3;
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const inc = this.rate / this.sr;
    for (let i = 0; i < n; i++) {
      const lfo = 0.5 + 0.5 * Math.sin(TWO_PI * this.phase);
      const f = 300 * Math.pow(10, this.depth * lfo);
      for (let s = 0; s < this.stages; s++) {
        this.apsL[s]!.set(f * (1 + s * 0.15), this.sr);
        this.apsR[s]!.set(f * (1 + s * 0.15) * 1.03, this.sr);
      }
      let a = l[i]! + this.fbL * this.feedback;
      let b = r[i]! + this.fbR * this.feedback;
      for (let s = 0; s < this.stages; s++) {
        a = this.apsL[s]!.tick(a);
        b = this.apsR[s]!.tick(b);
      }
      this.fbL = a;
      this.fbR = b;
      l[i] = l[i]! + a;
      r[i] = r[i]! + b;
      this.phase = (this.phase + inc) % 1;
    }
  }
}

// ── Distorsión / Bitcrush ────────────────────────────────────────────────────

class DistortionUnit implements EffectUnit {
  private toneL = new Biquad();
  private toneR = new Biquad();
  private drive = 0.4;
  private mode = 0;
  private output = 1;

  constructor(private sr: number) {}

  setParams(p: Record<string, number>): void {
    this.drive = p['drive'] ?? 0.4;
    this.mode = Math.round(p['mode'] ?? 0);
    this.output = p['output'] ?? 1;
    this.toneL.lowpass(p['tone'] ?? 4000, 0.707, this.sr);
    this.toneR.copyFrom(this.toneL);
  }

  private shape(x: number): number {
    const k = 1 + this.drive * 24;
    switch (this.mode) {
      case 1: {
        const y = x * k * 0.5;
        return Math.max(-1, Math.min(1, y));
      }
      case 2: {
        let y = x * k * 0.4;
        // Foldback simple
        y = Math.abs(((y + 1) % 4) - 2) - 1;
        return y;
      }
      default:
        return Math.tanh(x * k) / Math.tanh(k * 0.25);
    }
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      l[i] = this.toneL.tick(this.shape(l[i]!)) * this.output * 0.5;
      r[i] = this.toneR.tick(this.shape(r[i]!)) * this.output * 0.5;
    }
  }
}

class BitcrushUnit implements EffectUnit {
  private bits = 8;
  private down = 4;
  private counter = 0;
  private holdL = 0;
  private holdR = 0;

  setParams(p: Record<string, number>): void {
    this.bits = Math.max(2, Math.round(p['bits'] ?? 8));
    this.down = Math.max(1, Math.round(p['downsample'] ?? 4));
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const levels = Math.pow(2, this.bits - 1);
    for (let i = 0; i < n; i++) {
      if (this.counter === 0) {
        this.holdL = Math.round(l[i]! * levels) / levels;
        this.holdR = Math.round(r[i]! * levels) / levels;
      }
      this.counter = (this.counter + 1) % this.down;
      l[i] = this.holdL;
      r[i] = this.holdR;
    }
  }
}

// ── Autofilter ───────────────────────────────────────────────────────────────

class AutofilterUnit implements EffectUnit {
  private svfL = new SVF();
  private svfR = new SVF();
  private follower = new EnvFollower();
  private phase = 0;
  private type = 0;
  private cutoff = 1200;
  private resonance = 0.4;
  private lfoRate = 2;
  private lfoAmount = 0;
  private envAmount = 0;
  private attackCoef: number;
  private releaseCoef: number;

  constructor(private sr: number) {
    this.attackCoef = timeCoef(0.005, sr);
    this.releaseCoef = timeCoef(0.12, sr);
  }

  setParams(p: Record<string, number>): void {
    this.type = Math.round(p['type'] ?? 0);
    this.cutoff = p['cutoff'] ?? 1200;
    this.resonance = p['resonance'] ?? 0.4;
    this.lfoRate = p['lfoRate'] ?? 2;
    this.lfoAmount = p['lfoAmount'] ?? 0;
    this.envAmount = p['envAmount'] ?? 0;
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const inc = this.lfoRate / this.sr;
    for (let i = 0; i < n; i++) {
      const det = Math.max(Math.abs(l[i]!), Math.abs(r[i]!));
      const env = this.follower.tick(det, this.attackCoef, this.releaseCoef);
      const lfo = Math.sin(TWO_PI * this.phase);
      // Modulación en octavas alrededor del cutoff base.
      const octaves = this.lfoAmount * 2 * lfo + this.envAmount * 3 * Math.min(1, env * 2);
      const fc = this.cutoff * Math.pow(2, octaves);
      this.svfL.set(fc, this.resonance, this.sr);
      this.svfR.set(fc, this.resonance, this.sr);
      l[i] = this.svfL.tick(l[i]!, this.type);
      r[i] = this.svfR.tick(r[i]!, this.type);
      this.phase = (this.phase + inc) % 1;
    }
  }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

class GateUnit implements EffectUnit {
  private follower = new EnvFollower();
  private gain = 1;
  private thresholdLin = dbToLin(-40);
  private attackCoef = 0;
  private releaseCoef = 0;
  private detCoefA: number;
  private detCoefR: number;

  constructor(private sr: number) {
    this.detCoefA = timeCoef(0.0005, sr);
    this.detCoefR = timeCoef(0.05, sr);
    this.attackCoef = timeCoef(0.002, sr);
    this.releaseCoef = timeCoef(0.1, sr);
  }

  setParams(p: Record<string, number>): void {
    this.thresholdLin = dbToLin(p['threshold'] ?? -40);
    this.attackCoef = timeCoef(p['attack'] ?? 0.002, this.sr);
    this.releaseCoef = timeCoef(p['release'] ?? 0.1, this.sr);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const det = Math.max(Math.abs(l[i]!), Math.abs(r[i]!));
      const env = this.follower.tick(det, this.detCoefA, this.detCoefR);
      const target = env >= this.thresholdLin ? 1 : 0;
      const coef = target > this.gain ? this.attackCoef : this.releaseCoef;
      this.gain = target + (this.gain - target) * coef;
      l[i]! *= this.gain;
      r[i]! *= this.gain;
    }
  }
}

// ── Utilidades estéreo ───────────────────────────────────────────────────────

class StereoUnit implements EffectUnit {
  private sideHpL = new Biquad();
  private width = 1;
  private gain = 1;
  private monoBelow = 110;

  constructor(private sr: number) {
    this.sideHpL.highpass(110, 0.707, sr);
  }

  setParams(p: Record<string, number>): void {
    this.width = p['width'] ?? 1;
    this.gain = p['gain'] ?? 1;
    this.monoBelow = p['monoBelow'] ?? 110;
    if (this.monoBelow > 1) this.sideHpL.highpass(this.monoBelow, 0.707, this.sr);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const mid = (l[i]! + r[i]!) * 0.5;
      let side = (l[i]! - r[i]!) * 0.5 * this.width;
      // Low-end mono: el componente side pierde los graves.
      if (this.monoBelow > 1) side = this.sideHpL.tick(side);
      l[i] = (mid + side) * this.gain;
      r[i] = (mid - side) * this.gain;
    }
  }
}

class PassthroughUnit implements EffectUnit {
  setParams(): void {}
  process(): void {}
}

// ── Fábrica ──────────────────────────────────────────────────────────────────

export function createEffect(kind: EffectKind, sr: number): EffectUnit {
  switch (kind) {
    case 'eq': return new EqUnit(sr);
    case 'compressor': return new CompressorUnit(sr);
    case 'limiter': return new LimiterUnit(sr);
    case 'reverb': return new ReverbUnit(sr);
    case 'convolver': return new ConvolverUnit(sr);
    case 'vinyl': return new VinylUnit(sr);
    case 'delay': return new DelayUnit(sr);
    case 'chorus': return new ChorusUnit(sr);
    case 'flanger': return new FlangerUnit(sr);
    case 'phaser': return new PhaserUnit(sr);
    case 'distortion': return new DistortionUnit(sr);
    case 'bitcrush': return new BitcrushUnit();
    case 'autofilter': return new AutofilterUnit(sr);
    case 'gate': return new GateUnit(sr);
    case 'stereo': return new StereoUnit(sr);
    case 'analyzer': return new PassthroughUnit();
    // Los plugins JS los instancia el kernel desde su registro (makePluginUnit);
    // si llega aquí (plugin sin registrar), el slot pasa el audio limpio.
    case 'plugin': return new PassthroughUnit();
  }
}
