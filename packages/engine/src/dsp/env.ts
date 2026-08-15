/** ADSR: ataque lineal, decay/release exponenciales. */

const enum Stage {
  Idle,
  Attack,
  Decay,
  Sustain,
  Release,
  Done,
}

export class ADSR {
  private stage: Stage = Stage.Idle;
  private value = 0;
  private attackInc = 0;
  private decayCoef = 0;
  private releaseCoef = 0;
  private sustain = 0.7;

  set(attack: number, decay: number, sustain: number, release: number, sr: number): void {
    this.attackInc = 1 / Math.max(1, attack * sr);
    this.decayCoef = Math.exp(-1 / Math.max(1, decay * sr * 0.25));
    this.releaseCoef = Math.exp(-1 / Math.max(1, release * sr * 0.25));
    this.sustain = sustain;
  }

  on(): void {
    this.stage = Stage.Attack;
  }

  off(): void {
    if (this.stage !== Stage.Idle && this.stage !== Stage.Done) {
      this.stage = Stage.Release;
    }
  }

  get active(): boolean {
    return this.stage !== Stage.Done && this.stage !== Stage.Idle;
  }

  tick(): number {
    switch (this.stage) {
      case Stage.Attack:
        this.value += this.attackInc;
        if (this.value >= 1) {
          this.value = 1;
          this.stage = Stage.Decay;
        }
        break;
      case Stage.Decay:
        this.value = this.sustain + (this.value - this.sustain) * this.decayCoef;
        if (this.value - this.sustain < 0.001) this.stage = Stage.Sustain;
        break;
      case Stage.Sustain:
        this.value = this.sustain;
        if (this.sustain <= 0.0005) this.stage = Stage.Done;
        break;
      case Stage.Release:
        this.value *= this.releaseCoef;
        if (this.value < 0.0005) {
          this.value = 0;
          this.stage = Stage.Done;
        }
        break;
      default:
        return 0;
    }
    return this.value;
  }
}

/** Envolvente de un solo decay exponencial (percusión). */
export class DecayEnv {
  private value = 0;
  private coef = 0;

  trigger(coefOrTime: number, sr?: number): void {
    this.value = 1;
    this.coef = sr !== undefined
      ? Math.exp(-1 / Math.max(1, coefOrTime * sr * 0.25))
      : coefOrTime;
  }

  tick(): number {
    this.value *= this.coef;
    return this.value;
  }

  get active(): boolean {
    return this.value > 0.0005;
  }
}
