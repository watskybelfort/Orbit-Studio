/** Reverb estéreo tipo Freeverb: 8 combs LP + 4 allpass por canal. */

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const REF_SR = 44100;

class Comb {
  private buf: Float32Array;
  private idx = 0;
  private filterStore = 0;
  feedback = 0.84;
  damp = 0.2;

  constructor(size: number) {
    this.buf = new Float32Array(size);
  }

  tick(x: number): number {
    const out = this.buf[this.idx]!;
    this.filterStore = out * (1 - this.damp) + this.filterStore * this.damp;
    this.buf[this.idx] = x + this.filterStore * this.feedback;
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }

  clear(): void {
    this.buf.fill(0);
    this.filterStore = 0;
  }
}

class AllpassFV {
  private buf: Float32Array;
  private idx = 0;

  constructor(size: number) {
    this.buf = new Float32Array(size);
  }

  tick(x: number): number {
    const bufOut = this.buf[this.idx]!;
    const out = bufOut - x;
    this.buf[this.idx] = x + bufOut * 0.5;
    this.idx = (this.idx + 1) % this.buf.length;
    return out;
  }

  clear(): void {
    this.buf.fill(0);
  }
}

export class Reverb {
  private combsL: Comb[];
  private combsR: Comb[];
  private apL: AllpassFV[];
  private apR: AllpassFV[];
  private preDelayL: Float32Array;
  private preDelayR: Float32Array;
  private preIdx = 0;
  private preSamples = 0;
  width = 1;

  constructor(sr: number) {
    const scale = sr / REF_SR;
    this.combsL = COMB_TUNING.map((n) => new Comb(Math.round(n * scale)));
    this.combsR = COMB_TUNING.map((n) => new Comb(Math.round((n + STEREO_SPREAD) * scale)));
    this.apL = ALLPASS_TUNING.map((n) => new AllpassFV(Math.round(n * scale)));
    this.apR = ALLPASS_TUNING.map((n) => new AllpassFV(Math.round((n + STEREO_SPREAD) * scale)));
    const maxPre = Math.ceil(0.25 * sr);
    this.preDelayL = new Float32Array(maxPre);
    this.preDelayR = new Float32Array(maxPre);
  }

  /** size/damp/width 0..1, predelay en segundos. */
  set(size: number, damp: number, width: number, predelay: number, sr: number): void {
    const feedback = 0.7 + size * 0.28;
    const d = damp * 0.8;
    for (const c of this.combsL) { c.feedback = feedback; c.damp = d; }
    for (const c of this.combsR) { c.feedback = feedback; c.damp = d; }
    this.width = width;
    this.preSamples = Math.min(this.preDelayL.length - 1, Math.floor(predelay * sr));
  }

  /** Procesa un sample; devuelve [wetL, wetR] en `out`. */
  tick(inL: number, inR: number, out: [number, number]): void {
    // Pre-delay: se ESCRIBE antes de leer. Al revés, con predelay = 0 el índice
    // de lectura coincide con el de escritura y se leía la muestra de hace una
    // vuelta entera del anillo — 250 ms de retardo donde no se pidió ninguno.
    const n = this.preDelayL.length;
    this.preDelayL[this.preIdx] = inL;
    this.preDelayR[this.preIdx] = inR;
    const readIdx = (this.preIdx - this.preSamples + n) % n;
    const dl = this.preDelayL[readIdx]!;
    const dr = this.preDelayR[readIdx]!;
    this.preIdx = (this.preIdx + 1) % n;

    const input = (dl + dr) * 0.015;
    let outL = 0;
    let outR = 0;
    for (let i = 0; i < 8; i++) {
      outL += this.combsL[i]!.tick(input);
      outR += this.combsR[i]!.tick(input);
    }
    for (let i = 0; i < 4; i++) {
      outL = this.apL[i]!.tick(outL);
      outR = this.apR[i]!.tick(outR);
    }
    const wet1 = this.width / 2 + 0.5;
    const wet2 = (1 - this.width) / 2;
    out[0] = outL * wet1 + outR * wet2;
    out[1] = outR * wet1 + outL * wet2;
  }

  clear(): void {
    for (const c of this.combsL) c.clear();
    for (const c of this.combsR) c.clear();
    for (const a of this.apL) a.clear();
    for (const a of this.apR) a.clear();
    this.preDelayL.fill(0);
    this.preDelayR.fill(0);
  }
}
