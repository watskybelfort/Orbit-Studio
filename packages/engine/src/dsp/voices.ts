/**
 * Voces de instrumento. Cada voz renderiza SUMANDO al buffer de su pista de
 * mixer; la ganancia L/R (canal vol/pan ya resueltos) la pasa el kernel por
 * bloque, así los cambios en vivo entran sin recrear la voz.
 */

import { DRUM_MAP, midiToHz, sliceRange, zonesForNote, zoneTranspose, type KeymapZone } from '@orbit/core';

import { ADSR, DecayEnv } from './env';
import { Noise, Osc, TWO_PI } from './osc';
import { Biquad, SVF } from './filters';
import { PrismaVoice, type PrismaDef } from './prisma-voice';
import { Voice, type SampleData, type VoiceContext } from './voice-base';

// La base vive en `voice-base.ts` (ver el porqué allí), pero se re-exporta
// desde aquí: el kernel y los tests llevan importándola de `./dsp/voices`
// desde la primera versión y no hay motivo para moverles el suelo.
export { Voice } from './voice-base';
export type { SampleData, VoiceContext } from './voice-base';
export type { PrismaDef, PrismaLayerDef, PrismaMacroDef } from './prisma-voice';

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
  /** Semitonos de afinación del canal: el slide también los tiene que aplicar. */
  private tune: number;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    this.tune = p['tune'] ?? 0;
    this.freq = midiToHz(key + this.tune);
    this.targetFreq = this.freq;
    this.glideCoef = Math.exp(-1 / (Math.max(0.001, p['glide'] ?? 0.06) * sr));
    this.punch = p['punch'] ?? 0.5;
    this.pitchCoef = Math.exp(-1 / (0.02 * sr));
    this.drive = 1 + (p['drive'] ?? 0.45) * 7;
    this.amp.trigger(p['decay'] ?? 1.2, sr);
    this.tone.set(p['tone'] ?? 900, 0.1, sr);
    this.releaseCoef = Math.exp(-1 / (0.05 * sr));
  }

  protected override retune(snap = false): void {
    // Con `tune`: sin él, un 808 afinado -12 st aterrizaba el slide una octava
    // arriba de lo esperado.
    this.targetFreq = midiToHz(this.key + this.tune + this.bend);
    // El portamento del 808 es su carácter: la rueda ARRASTRA la altura, no
    // salta. Salvo al nacer, donde saltar es lo correcto.
    if (snap) this.freq = this.targetFreq;
  }

  override glideTo(key: number, velocity: number): void {
    super.glideTo(key, velocity);
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
      this.phase -= Math.floor(this.phase);
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
  // 'per-sample': el corte lo mueve `filtEnv` muestra a muestra, ya continuo.
  // El one-pole de 5 ms de filters.ts está pensado para el otro llamante (el
  // que empuja un escalón por bloque) y aquí solo sumaba retraso encima del
  // ADSR. `cutoff`/`resonance` se fijan al nacer la voz y no vuelven a
  // moverse, así que esta voz no tiene ningún parámetro por bloque del que
  // hacerse cargo. Ver `CoefSource` en filters.ts.
  private svfL = new SVF('per-sample');
  private wave: number;
  private cutoff: number;
  private resonance: number;
  private envAmount: number;
  private unison: number;
  private baseFreq: number;
  /** Octavas de desplazamiento del canal: la rueda también las respeta. */
  private octave: number;
  /** Último corte con el que se llamó a `svfL.set()` (ver render). */
  private lastCutoff = -1;

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
    this.octave = p['octave'] ?? 0;
    this.baseFreq = midiToHz(key + this.octave * 12);
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

  protected override retune(): void {
    // Los detunes del unísono son razones sobre la fundamental, así que se
    // doblan solos: basta con mover la fundamental.
    this.baseFreq = midiToHz(this.key + this.octave * 12 + this.bend);
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
      // Coeficientes solo cuando el corte se mueve de verdad (> 0.2 %), igual
      // que prisma-voice.ts y AutofilterUnit. La guarda ahorra el `Math.tan`
      // de `set()` cuando `fc` está quieto (release, sustain con envAmount
      // chico), y nada más: está MEDIDO que durante los 5 ms de ataque por
      // defecto `fc` se mueve más de 0.2 % en casi todas las muestras, así que
      // no era —ni podía ser— lo que le devolviera el punch al pluck. Eso lo
      // arregla el `'per-sample'` del SVF de arriba. Son dos cosas distintas y
      // las dos hacen falta.
      if (fc > this.lastCutoff * 1.002 || fc < this.lastCutoff * 0.998) {
        this.lastCutoff = fc;
        this.svfL.set(fc, this.resonance, this.sr);
      }
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
  private octave: number;

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
    this.octave = p['octave'] ?? 0;
    this.baseFreq = midiToHz(key + this.octave * 12);
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

  protected override retune(): void {
    // Las siete razones de detune cuelgan de la fundamental: mover la
    // fundamental dobla el supersaw entero sin deshacer su anchura.
    this.baseFreq = midiToHz(this.key + this.octave * 12 + this.bend);
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
  private octave: number;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    this.octave = p['octave'] ?? 0;
    this.freq = midiToHz(key + this.octave * 12);
    this.ratio = p['ratio'] ?? 2;
    this.index = p['index'] ?? 3;
    this.idxEnv.trigger(p['indexDecay'] ?? 0.4, sr);
    this.env.set(p['attack'] ?? 0.002, p['decay'] ?? 1.2, p['sustain'] ?? 0, p['release'] ?? 0.4, sr);
    this.env.on();
  }

  protected override retune(): void {
    // El modulador cuelga de la portadora por `ratio`, así que el timbre no se
    // mueve al doblar: se dobla la portadora y el índice se mantiene.
    this.freq = midiToHz(this.key + this.octave * 12 + this.bend);
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
  /**
   * Frecuencia tonal del golpe SIN doblar, y el filtro con el que se le da
   * cuerpo. Los dos se guardan porque la rueda de tono los mueve a la vez:
   * una caja doblada sube entera —su seno y su cuerpo de ruido—, no solo el
   * seno. Doblar únicamente la parte tonal dejaría el kit a medias (el tom se
   * mueve, el hat no), que es peor que no doblar.
   */
  private tonalHz = 100;
  private filt: { kind: 'hp' | 'peak'; f: number; gain: number; q: number } | null = null;
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
    // Los `case` de abajo declaran el filtro con estos dos ayudantes en vez de
    // tocar el biquad a pelo: así queda guardado y la rueda puede rehacerlo.
    const highpass = (f: number, q: number) => {
      this.filt = { kind: 'hp', f, gain: 0, q };
      this.useBp = true;
    };
    const peaking = (f: number, gain: number, q: number) => {
      this.filt = { kind: 'peak', f, gain, q };
      this.useBp = true;
    };
    const tone = p['tone'] ?? 0.5;
    const decay = p['decay'] ?? 1;
    const punch = p['punch'] ?? 0.5;
    const kit = Math.round(p['kit'] ?? 0); // 0 trap, 1 boom bap, 2 latin

    switch (this.piece) {
      case 'kick': {
        this.tonalHz = kit === 1 ? 60 : 48 + tone * 20;
        this.pitchEnv = 4 + punch * 6;
        this.pitchCoef = Math.exp(-1 / (0.012 * sr));
        this.amp.trigger((kit === 1 ? 0.25 : 0.45) * decay, sr);
        this.drive = 1 + punch * 2;
        break;
      }
      case 'snare': {
        this.tonalHz = 170 + tone * 60;
        this.pitchEnv = 1.5;
        this.pitchCoef = Math.exp(-1 / (0.01 * sr));
        this.amp.trigger(0.18 * decay, sr);
        highpass(1400, 0.9);
        this.noiseMix = 0.7;
        this.toneMix = 0.5;
        break;
      }
      case 'clap': {
        this.amp.trigger(0.16 * decay, sr);
        peaking(1100, 12, 2.2);
        this.noiseMix = 1;
        this.toneMix = 0;
        this.clapBursts = 3;
        break;
      }
      case 'hat':
      case 'openhat': {
        this.amp.trigger((this.piece === 'hat' ? 0.045 : 0.35) * decay, sr);
        highpass(7000 + tone * 3000, 0.8);
        this.noiseMix = 1;
        this.toneMix = 0;
        break;
      }
      case 'tom': {
        this.tonalHz = 100 + tone * 80;
        this.pitchEnv = 2;
        this.pitchCoef = Math.exp(-1 / (0.03 * sr));
        this.amp.trigger(0.3 * decay, sr);
        break;
      }
      case 'conga': {
        this.tonalHz = 180 + tone * 100;
        this.pitchEnv = 0.8;
        this.pitchCoef = Math.exp(-1 / (0.008 * sr));
        this.amp.trigger((kit === 2 ? 0.22 : 0.15) * decay, sr);
        this.noiseMix = 0.08;
        highpass(2000, 0.7);
        break;
      }
      case 'rim': {
        this.amp.trigger(0.03 * decay, sr);
        peaking(900, 15, 4);
        this.noiseMix = 0.6;
        this.tonalHz = 800;
        this.toneMix = 0.5;
        break;
      }
      case 'shaker': {
        this.amp.trigger(0.09 * decay, sr);
        highpass(5500, 0.8);
        this.noiseMix = 1;
        this.toneMix = 0;
        break;
      }
      case 'crash': {
        this.amp.trigger(1.4 * decay, sr);
        highpass(4500, 0.6);
        this.noiseMix = 1;
        this.toneMix = 0;
        break;
      }
      default: {
        this.amp.trigger(0.2 * decay, sr);
      }
    }
    // Deja el biquad puesto (y la frecuencia resuelta) con la rueda al centro.
    this.retune();
  }

  /**
   * La rueda mueve el golpe ENTERO: la parte tonal y el filtro que le da
   * cuerpo. En un hat no hay seno que doblar —es ruido filtrado, no tiene
   * altura—, pero su banda sí sube, y por eso un kit doblado suena doblado
   * completo en vez de que se muevan tres piezas de nueve.
   *
   * Rehacer los coeficientes del biquad no aloca: es aritmética sobre campos
   * que ya existen, y solo pasa cuando la rueda se mueve o nace una voz.
   */
  protected override retune(): void {
    const ratio = Math.pow(2, this.bend / 12);
    this.baseFreq = this.tonalHz * ratio;
    const f = this.filt;
    if (!f) return;
    // Tope por debajo de Nyquist: doblar +2 octavas un hat de 10 kHz pediría
    // una banda por encima del muestreo, y ahí el biquad se vuelve inestable.
    const hz = Math.min(this.sr * 0.45, Math.max(20, f.f * ratio));
    if (f.kind === 'hp') this.bp.highpass(hz, f.q, this.sr);
    else this.bp.peaking(hz, f.gain, f.q, this.sr);
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
        this.phase -= Math.floor(this.phase);
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
  /**
   * De qué sale `rate`: la razón entre el muestreo de la fuente y el del
   * motor, y los semitonos de transposición SIN la rueda. Guardarlos por
   * separado es lo que deja doblar el tono sin reconstruir la voz — y sin
   * arrastrar el error de ir multiplicando `rate` por razones sucesivas, que
   * al soltar la rueda no vuelve exactamente al sitio.
   */
  private rateBase: number;
  private semisBase: number;
  private env = new ADSR();
  private data: SampleData | null;
  private reverse: boolean;
  private loop: boolean;
  /** +1 normal, -1 fase invertida. */
  private polarity: number;
  private gain: number;
  /** Región de lectura en samples de la FUENTE (start/end del canal). */
  private lo: number;
  private hi: number;
  /** Fades en samples de la fuente (0 = sin fade). */
  private fadeInSrc: number;
  private fadeOutSrc: number;

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
    this.semisBase = (p['pitch'] ?? 0) + (keytrack ? key - 60 : 0);
    const srcRate = this.data?.rate ?? ctx.sr;
    this.rateBase = srcRate / ctx.sr;
    this.rate = this.rateBase * Math.pow(2, this.semisBase / 12);
    this.reverse = (p['reverse'] ?? 0) >= 0.5;
    this.loop = (p['loop'] ?? 0) >= 0.5;
    this.polarity = (p['polarity'] ?? 0) >= 0.5 ? -1 : 1;
    this.gain = p['gain'] ?? 1;

    // Recorte start/end: el "acortar" del sonido. `end` por debajo de `start`
    // no se acepta (dejaría la región del revés y la voz muda).
    const srcLen = this.data?.left.length ?? 0;
    // Con menos de dos muestras no hay interpolación posible: la voz no suena.
    if (srcLen < 2) this.data = null;
    const last = Math.max(0, srcLen - 2);
    const startFrac = Math.min(1, Math.max(0, p['start'] ?? 0));
    const endFrac = Math.min(1, Math.max(0, p['end'] ?? 1));
    // `hi` NUNCA puede pasar de `last`. El `Math.max(this.lo + 1, …)` de antes
    // lo empujaba a `last + 1` con `start` a tope (que es un valor legal de la
    // perilla), y ahí la interpolación lee `d.left[len]` = undefined: NaN en la
    // mezcla. Y un NaN no se queda quieto — el limiter del master, o cualquier
    // filtro IIR, se queda con la ganancia en NaN PARA SIEMPRE y el WAV entero
    // sale a basura (medido: 88 319 muestras de 88 320).
    this.lo = Math.min(last, Math.floor(startFrac * last));
    this.hi = Math.min(last, Math.max(this.lo, Math.floor(endFrac * last)));
    this.pos = this.reverse ? this.hi : this.lo;

    this.fadeInSrc = Math.max(0, p['fadeIn'] ?? 0) * srcRate;
    this.fadeOutSrc = Math.max(0, p['fadeOut'] ?? 0) * srcRate;

    this.env.set(p['attack'] ?? 0.001, 1, 1, p['release'] ?? 0.05, ctx.sr);
    this.env.on();
  }

  protected override retune(): void {
    // En un sampler doblar el tono es leer más rápido o más lento: se recalcula
    // desde la base, nunca escalando el `rate` que ya había.
    this.rate = this.rateBase * Math.pow(2, (this.semisBase + this.bend) / 12);
  }

  noteOff(): void {
    this.releasing = true;
    this.env.off();
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    const d = this.data;
    if (!d) return false;
    const step = this.reverse ? -this.rate : this.rate;
    for (let i = from; i < to; i++) {
      if (this.pos < this.lo || this.pos > this.hi) {
        // Fuera de la región: o vuelve a empezar, o la voz terminó.
        if (!this.loop) return false;
        this.pos = this.reverse ? this.hi : this.lo;
      }
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      const sl = d.left[idx]! * (1 - frac) + d.left[idx + 1]! * frac;
      const srr = d.right[idx]! * (1 - frac) + d.right[idx + 1]! * frac;
      let e = this.env.tick() * this.velocity * this.gain;
      // Los fades se miden en la fuente, así que no cambian al transponer.
      if (this.fadeInSrc > 0) {
        const entered = this.reverse ? this.hi - this.pos : this.pos - this.lo;
        if (entered < this.fadeInSrc) e *= entered / this.fadeInSrc;
      }
      if (this.fadeOutSrc > 0) {
        const left = this.reverse ? this.pos - this.lo : this.hi - this.pos;
        if (left < this.fadeOutSrc) e *= left < 0 ? 0 : left / this.fadeOutSrc;
      }
      e *= this.polarity;
      outL[i]! += sl * e * gainL;
      outR[i]! += srr * e * gainR;
      this.pos += step;
    }
    return this.env.active;
  }
}

// ── Orbit Nova (instrumento de presets) ──────────────────────────────────────

/** Capa de un preset ya resuelta para el kernel. */
export interface NovaLayerDef {
  engine: string;
  params: Record<string, number>;
  gain: number;
  pan: number;
  transpose: number;
}

/** Macro del preset: qué parámetros mueve y entre qué valores. */
export interface NovaMacroDef {
  targets: { layer: number; param: string; min: number; max: number }[];
}

/**
 * Voz de Nova: apila las voces de sus capas y las mezcla.
 *
 * Las perillas fijas del canal (filtro, ataque, release, drive, width, octava)
 * y las dos macros del preset se resuelven AQUÍ, al disparar la nota, sobre
 * una copia de los params de cada capa — el preset nunca se modifica y dos
 * canales con el mismo sonido no se pisan.
 */
export class NovaVoice extends Voice {
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
    defs: NovaLayerDef[],
    macros: NovaMacroDef[],
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

  /**
   * Nova no tiene altura propia: la tienen sus capas. Doblar el preset es
   * doblarlas todas por igual, y cada una lo aplica con su motor (una capa de
   * sampler cambia el ritmo de lectura, una de sinte mueve el oscilador).
   */
  override setBend(semitones: number, snap = false): void {
    super.setBend(semitones, snap);
    for (const l of this.layers) l.voice.setBend(semitones, snap);
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

// ── Orbit Vox (voz por formantes) ────────────────────────────────────────────

/**
 * Formantes de las cinco vocales: tres picos por vocal (Hz) con su ganancia
 * relativa. Son los valores clásicos de voz masculina/neutra; con el filtro
 * resonante encima ya se reconoce la vocal cantada.
 */
const VOWEL_FORMANTS: { f: number; g: number; q: number }[][] = [
  // A
  [
    { f: 700, g: 1, q: 6 },
    { f: 1220, g: 0.5, q: 8 },
    { f: 2600, g: 0.28, q: 10 },
  ],
  // E
  [
    { f: 460, g: 1, q: 6 },
    { f: 1900, g: 0.55, q: 9 },
    { f: 2600, g: 0.3, q: 10 },
  ],
  // I
  [
    { f: 300, g: 1, q: 6 },
    { f: 2200, g: 0.6, q: 10 },
    { f: 3000, g: 0.32, q: 11 },
  ],
  // O
  [
    { f: 480, g: 1, q: 6 },
    { f: 760, g: 0.5, q: 8 },
    { f: 2400, g: 0.16, q: 10 },
  ],
  // U
  [
    { f: 320, g: 1, q: 6 },
    { f: 700, g: 0.42, q: 8 },
    { f: 2300, g: 0.12, q: 10 },
  ],
];

/**
 * Voz sintética por formantes: una fuente rica (pulso glotal aproximado por
 * sierra suavizada + soplo de ruido) pasada por tres campanas resonantes que
 * son las que "dicen" la vocal. Con vibrato lento la voz deja de sonar a
 * máquina; sin él canta demasiado recto para ser creíble.
 */
export class VoxVoice extends Voice {
  private phase = 0;
  private freq: number;
  private env = new ADSR();
  private noise = new Noise();
  private bands: Biquad[] = [];
  private gains: number[] = [];
  private breath: number;
  private vibratoDepth: number;
  private vibratoPhase = 0;
  /** Octavas de desplazamiento del canal: el slide también las aplica. */
  private octave: number;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private velocity: number,
    p: Record<string, number>,
    private sr: number,
  ) {
    super(channelIndex, key, order);
    this.octave = p['octave'] ?? 0;
    this.freq = midiToHz(key + this.octave * 12);
    this.breath = p['breath'] ?? 0.25;
    this.vibratoDepth = (p['vibrato'] ?? 0.3) * 0.03; // hasta ~3 % de altura
    const vowel = Math.min(4, Math.max(0, Math.round(p['vowel'] ?? 0)));
    for (const formant of VOWEL_FORMANTS[vowel]!) {
      const biquad = new Biquad();
      biquad.peaking(formant.f, 14, formant.q, sr);
      this.bands.push(biquad);
      this.gains.push(formant.g);
    }
    this.env.set(p['attack'] ?? 0.08, 0.3, 0.85, p['release'] ?? 0.4, sr);
    this.env.on();
  }

  noteOff(): void {
    this.releasing = true;
    this.env.off();
  }

  protected override retune(): void {
    this.freq = midiToHz(this.key + this.octave * 12 + this.bend);
  }

  render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean {
    for (let i = from; i < to; i++) {
      // Vibrato de 5.2 Hz sobre la altura.
      this.vibratoPhase += (2 * Math.PI * 5.2) / this.sr;
      if (this.vibratoPhase > TWO_PI) this.vibratoPhase -= TWO_PI;
      const f = this.freq * (1 + Math.sin(this.vibratoPhase) * this.vibratoDepth);
      this.phase += f / this.sr;
      this.phase -= Math.floor(this.phase);

      // Pulso glotal: sierra con el filo redondeado (menos alias, más voz).
      const saw = 2 * this.phase - 1;
      const source = saw - saw * saw * saw * 0.3 + this.noise.tick() * this.breath * 0.5;

      let voiced = 0;
      for (let b = 0; b < this.bands.length; b++) {
        voiced += this.bands[b]!.tick(source) * this.gains[b]!;
      }
      const s = voiced * 0.22 * this.env.tick() * this.velocity;
      outL[i]! += s * gainL;
      outR[i]! += s * gainR;
    }
    return this.env.active;
  }
}

// ── Orbit Slicer (un trozo del sample por nota) ──────────────────────────────

/**
 * Trocea un sample en N partes iguales y dispara una por nota, empezando en
 * C3 (36) como un drum rack: la tecla elige el trozo. Es el Fruity Slicer de
 * toda la vida — el pegamento entre un loop y el step sequencer.
 */
export class SlicerVoice extends Voice {
  private pos = 0;
  private end = 0;
  private rate: number;
  private rateBase: number;
  private semisBase: number;
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
    slicePoints?: readonly number[],
  ) {
    super(channelIndex, key, order);
    this.data = sampleId ? ctx.samples.get(sampleId) ?? null : null;
    const len = this.data?.left.length ?? 0;
    // C3 = primer trozo; las teclas de arriba avanzan y se envuelven. Con
    // cortes propios (los del detector de transientes) mandan ellos; sin
    // ellos, el reparto en partes iguales de toda la vida.
    const range = sliceRange(slicePoints, Math.round(key) - 36, p['slices'] ?? 8);
    this.reverse = (p['reverse'] ?? 0) >= 0.5;
    const start = Math.floor(range.start * len);
    const stop = Math.min(len, Math.max(start + 1, Math.floor(range.end * len)));
    this.pos = this.reverse ? stop - 1 : start;
    this.end = this.reverse ? start : stop;
    const srcRate = this.data?.rate ?? ctx.sr;
    this.rateBase = srcRate / ctx.sr;
    this.semisBase = p['pitch'] ?? 0;
    this.rate = this.rateBase * Math.pow(2, this.semisBase / 12);
    this.env.set(p['attack'] ?? 0.002, 1, 1, p['release'] ?? 0.06, ctx.sr);
    this.env.on();
  }

  /**
   * El Slicer no reafina por tecla —la tecla elige el TROZO—, pero la rueda
   * sí lo dobla: es un sampler, y doblar un trozo de loop es lo que se hace
   * para encajarlo con lo de al lado.
   */
  protected override retune(): void {
    this.rate = this.rateBase * Math.pow(2, (this.semisBase + this.bend) / 12);
  }

  noteOff(): void {
    this.releasing = true;
    this.env.off();
  }

  render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean {
    const d = this.data;
    if (!d) return false;
    for (let i = from; i < to; i++) {
      const idx = Math.floor(this.pos);
      if (idx < 0 || idx >= d.left.length - 1) return false;
      // En reversa `end` es el principio del trozo: con `<=` se cortaba justo al
      // llegar y nunca sonaba la primera muestra; con `<` sí suena.
      if (this.reverse ? idx < this.end : idx >= this.end) return false;
      const frac = this.pos - idx;
      const sl = d.left[idx]! * (1 - frac) + d.left[idx + 1]! * frac;
      const sr = d.right[idx]! * (1 - frac) + d.right[idx + 1]! * frac;
      const e = this.env.tick() * this.velocity;
      outL[i]! += sl * e * gainL;
      outR[i]! += sr * e * gainR;
      this.pos += this.reverse ? -this.rate : this.rate;
    }
    return this.env.active;
  }
}

/**
 * Sampler multisample: la nota dispara las zonas del keymap que la cubren.
 *
 * No reimplementa la lectura del sample — la delega en `SamplerVoice`, una por
 * zona. Ese código tiene sus guardas de interpolación bien pagadas (un índice
 * de más produce un NaN que se queda para siempre en el limiter del master y
 * convierte el export entero en basura), y copiarlo para tener dos versiones
 * que se desincronizan es exactamente lo que no hay que hacer.
 *
 * Las capas son UNA voz para el kernel: un acorde de cuatro notas con tres
 * micros cada una no puede contar como doce voces contra el tope.
 */
export class MultiSamplerVoice extends Voice {
  private layers: SamplerVoice[] = [];

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    velocity: number,
    p: Record<string, number>,
    ctx: VoiceContext,
    zones: readonly KeymapZone[],
  ) {
    super(channelIndex, key, order);
    for (const zone of zonesForNote(zones, key, velocity)) {
      // El recorte start/end y los fades del canal NO se aplican: son de un
      // sample concreto y aquí hay veinte de duraciones distintas. Lo que sí
      // manda el canal es la envolvente, el loop, la fase y la ganancia.
      const layerParams: Record<string, number> = {
        ...p,
        keytrack: 0,
        pitch: (p['pitch'] ?? 0) + zoneTranspose(zone, key),
        gain: (p['gain'] ?? 1) * zone.gain,
        start: 0,
        end: 1,
        fadeIn: 0,
        fadeOut: 0,
      };
      this.layers.push(
        new SamplerVoice(channelIndex, key, order, velocity, layerParams, ctx, zone.sampleId),
      );
    }
  }

  noteOff(): void {
    this.releasing = true;
    for (const l of this.layers) l.noteOff();
  }

  /** Las capas del keymap se doblan juntas: es UNA nota, no varias. */
  override setBend(semitones: number, snap = false): void {
    super.setBend(semitones, snap);
    for (const l of this.layers) l.setBend(semitones, snap);
  }

  override dispose(): void {
    for (const l of this.layers) l.dispose();
    this.layers.length = 0;
  }

  render(outL: Float32Array, outR: Float32Array, from: number, to: number, gainL: number, gainR: number): boolean {
    let alive = false;
    for (const l of this.layers) {
      // Se renderizan TODAS aunque una haya terminado antes: cada capa suma lo
      // suyo y la voz vive mientras quede alguna. Cortar en la primera muerta
      // silenciaría a las que aún tienen cola.
      if (l.render(outL, outR, from, to, gainL, gainR)) alive = true;
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
  nova?: { layers: NovaLayerDef[]; macros: NovaMacroDef[] },
  prisma?: PrismaDef,
  slicePoints?: readonly number[],
  keymap?: readonly KeymapZone[],
): Voice {

  switch (kind) {
    case 'nova':
      return nova
        ? new NovaVoice(channelIndex, key, order, velocity, params, ctx, nova.layers, nova.macros)
        : new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
    // Sin preset resuelto (proyecto de otra versión, id desconocido) el canal
    // cae al sinte básico en vez de quedarse mudo.
    case 'prisma':
      return prisma && prisma.layers.length > 0
        ? new PrismaVoice(channelIndex, key, order, velocity, params, ctx, prisma)
        : new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'sub808': return new Sub808Voice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'synth': return new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'supersaw': return new SupersawVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'fm': return new FmVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'drums': return new DrumVoice(channelIndex, key, order, velocity, params, ctx.sr);
    // Con keymap manda el keymap; sin él, el sampler de un solo sample de
    // siempre. Quitar el keymap devuelve el canal exactamente a como estaba.
    case 'sampler':
      return keymap && keymap.length > 0
        ? new MultiSamplerVoice(channelIndex, key, order, velocity, params, ctx, keymap)
        : new SamplerVoice(channelIndex, key, order, velocity, params, ctx, sampleId);

    case 'vox': return new VoxVoice(channelIndex, key, order, velocity, params, ctx.sr);
    case 'slicer': return new SlicerVoice(channelIndex, key, order, velocity, params, ctx, sampleId, slicePoints);
    default: return new SynthVoice(channelIndex, key, order, velocity, params, ctx.sr);
  }
}
