/**
 * Orbit Vinyl: el sabor de un disco — chasquidos, ruido de superficie, el
 * rumble del plato y la deriva de tono (wow/flutter) de un motor que nunca gira
 * perfecto.
 *
 * Todo el ruido sale de generadores con semilla propia (xorshift de `osc.ts`),
 * nunca de Math.random: dos renders del mismo proyecto tienen que dar EXACTAMENTE
 * el mismo WAV. Por lo mismo los generadores se consultan en cada muestra aunque
 * el nivel esté a cero — así el flujo de ruido no depende de dónde estén las
 * perillas.
 */

import { DelayLine } from './delayline';
import { Biquad, timeCoef } from './filters';
import { Noise, TWO_PI } from './osc';

/** 33⅓ rpm = 0.5556 vueltas por segundo: el wow de un plato va a ese ritmo. */
const WOW_HZ = 0.5556;
/** Flutter: dos componentes para que no suene a LFO puro. */
const FLUTTER_HZ = 7.3;
const FLUTTER2_HZ = 11.7;
/** Profundidades máximas de la modulación (segundos de retardo). */
const WOW_MAX = 0.004;
const FLUTTER_MAX = 0.00025;
/**
 * Chasquidos por segundo con `crackle` al máximo. Más que esto deja de ser un
 * disco sucio y pasa a ser un ruido continuo.
 */
const CRACKLE_DENSITY = 420;
/** Cola de un chasquido: por encima de esto deja de ser un tic y es un golpe. */
const CRACKLE_TAU = 0.0012;

export class Vinyl {
  private readonly dlL: DelayLine;
  private readonly dlR: DelayLine;
  // Semillas distintas por canal y por función: nada correlacionado.
  private readonly hissL = new Noise(0x1f3a5b);
  private readonly hissR = new Noise(0x7c2d19);
  private readonly rumbleL = new Noise(0x3b91e7);
  private readonly rumbleR = new Noise(0x62af4d);
  private readonly trigL = new Noise(0x0d47c3);
  private readonly trigR = new Noise(0x59e082);
  private readonly clickL = new Noise(0x24b7f1);
  private readonly clickR = new Noise(0x486d0b);
  private readonly hissHpL = new Biquad();
  private readonly hissHpR = new Biquad();
  private readonly rumbleLpL = new Biquad();
  private readonly rumbleLpR = new Biquad();
  private readonly clickHpL = new Biquad();
  private readonly clickHpR = new Biquad();
  private readonly toneL = new Biquad();
  private readonly toneR = new Biquad();
  private readonly crackleCoef: number;

  private wowPhase = 0;
  private flutPhase = 0.31;
  private flut2Phase = 0.67;
  private clickEnvL = 0;
  private clickEnvR = 0;

  private wowDepth = 0;
  private flutDepth = 0;
  private baseDelay = 2;
  private hissGain = 0;
  private rumbleGain = 0;
  private crackleProb = 0;
  private crackleAmp = 0;

  constructor(private readonly sr: number) {
    const max = Math.ceil(sr * 0.02);
    this.dlL = new DelayLine(max);
    this.dlR = new DelayLine(max);
    // El siseo de superficie no tiene graves (esos son el rumble) ni brillo de
    // más: el paso bajo global (`tone`) le corta arriba.
    this.hissHpL.highpass(260, 0.707, sr);
    this.hissHpR.copyFrom(this.hissHpL);
    this.rumbleLpL.lowpass(55, 0.707, sr);
    this.rumbleLpR.copyFrom(this.rumbleLpL);
    // Un chasquido es un tic, no un golpe: fuera todo lo que esté por debajo.
    this.clickHpL.highpass(1200, 0.707, sr);
    this.clickHpR.copyFrom(this.clickHpL);
    this.toneL.lowpass(12000, 0.707, sr);
    this.toneR.copyFrom(this.toneL);
    this.crackleCoef = timeCoef(CRACKLE_TAU, sr);
  }

  /** crackle/noise/wow/flutter 0..1, tone en Hz. */
  set(crackle: number, noise: number, wow: number, flutter: number, tone: number): void {
    const cr = Math.min(1, Math.max(0, crackle));
    const ns = Math.min(1, Math.max(0, noise));
    this.wowDepth = Math.min(1, Math.max(0, wow)) * WOW_MAX * this.sr;
    this.flutDepth = Math.min(1, Math.max(0, flutter)) * FLUTTER_MAX * this.sr;
    // El retardo base es solo el margen que necesita la modulación: sin wow ni
    // flutter el efecto no mete latencia que no haga falta.
    this.baseDelay = 2 + this.wowDepth + this.flutDepth;
    this.hissGain = ns * 0.035;
    this.rumbleGain = ns * 0.6;
    this.crackleProb = (cr * CRACKLE_DENSITY) / this.sr;
    this.crackleAmp = cr * 0.12;
    this.toneL.lowpass(tone, 0.707, this.sr);
    this.toneR.copyFrom(this.toneL);
  }

  /** Procesa in-place. Cero alocaciones. */
  process(l: Float32Array, r: Float32Array, n: number): void {
    const wowInc = WOW_HZ / this.sr;
    const flutInc = FLUTTER_HZ / this.sr;
    const flut2Inc = FLUTTER2_HZ / this.sr;
    const prob = this.crackleProb;
    for (let i = 0; i < n; i++) {
      // El wow/flutter es del PLATO, no del canal: la misma desviación de
      // velocidad para L y R, o el estéreo se abriría solo.
      const mod =
        this.wowDepth * Math.sin(TWO_PI * this.wowPhase) +
        this.flutDepth *
          (0.72 * Math.sin(TWO_PI * this.flutPhase) +
            0.28 * Math.sin(TWO_PI * this.flut2Phase));
      const d = this.baseDelay + mod;
      let a = this.dlL.read(d);
      let b = this.dlR.read(d);
      this.dlL.write(l[i]!);
      this.dlR.write(r[i]!);

      // Superficie: siseo + rumble del motor.
      a += this.hissHpL.tick(this.hissL.tick()) * this.hissGain;
      b += this.hissHpR.tick(this.hissR.tick()) * this.hissGain;
      a += this.rumbleLpL.tick(this.rumbleL.tick()) * this.rumbleGain;
      b += this.rumbleLpR.tick(this.rumbleR.tick()) * this.rumbleGain;

      // Chasquidos: sorteo por muestra (Poisson pobre pero convincente). La
      // amplitud sale del mismo sorteo, así el flujo no depende de la rama.
      const uL = 0.5 + 0.5 * this.trigL.tick();
      if (uL < prob) this.clickEnvL = this.crackleAmp * (0.3 + (0.7 * uL) / prob);
      const uR = 0.5 + 0.5 * this.trigR.tick();
      if (uR < prob) this.clickEnvR = this.crackleAmp * (0.3 + (0.7 * uR) / prob);
      a += this.clickHpL.tick(this.clickL.tick() * this.clickEnvL);
      b += this.clickHpR.tick(this.clickR.tick() * this.clickEnvR);
      this.clickEnvL = this.clickEnvL > 1e-6 ? this.clickEnvL * this.crackleCoef : 0;
      this.clickEnvR = this.clickEnvR > 1e-6 ? this.clickEnvR * this.crackleCoef : 0;

      // Ancho de banda de la cadena: aguja + previo no llegan arriba.
      l[i] = this.toneL.tick(a);
      r[i] = this.toneR.tick(b);

      this.wowPhase += wowInc;
      if (this.wowPhase >= 1) this.wowPhase -= 1;
      this.flutPhase += flutInc;
      if (this.flutPhase >= 1) this.flutPhase -= 1;
      this.flut2Phase += flut2Inc;
      if (this.flut2Phase >= 1) this.flut2Phase -= 1;
    }
  }

  clear(): void {
    this.dlL.clear();
    this.dlR.clear();
    this.toneL.reset();
    this.toneR.reset();
    this.hissHpL.reset();
    this.hissHpR.reset();
    this.rumbleLpL.reset();
    this.rumbleLpR.reset();
    this.clickHpL.reset();
    this.clickHpR.reset();
    this.clickEnvL = 0;
    this.clickEnvR = 0;
  }
}
