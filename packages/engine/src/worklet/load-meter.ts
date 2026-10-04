/**
 * Tiempo de DSP / tiempo de audio disponible. Se agrega un cuarto de segundo
 * de bloques porque AudioWorkletGlobalScope en Chromium no ofrece performance:
 * Date.now tiene resolución de milisegundos y un bloque suele costar menos.
 * currentTime/currentFrame miden audio programado, no tiempo de procesamiento.
 * Solo escalares por bloque; reloj inyectable para comprobar la medida.
 */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

export class KernelLoadMeter {
  private workMs = 0;
  private audioMs = 0;
  private lastLoad = 0;
  private hasWindow = false;

  constructor(private readonly rate: number, private readonly clock: () => number = nowMs) {}

  begin(): number { return this.clock(); }

  end(start: number, frames: number): void {
    const elapsed = this.clock() - start;
    // Date puede retroceder al corregir la hora del sistema.
    if (Number.isFinite(elapsed)) this.workMs += Math.max(0, elapsed);
    this.audioMs += frames * 1000 / this.rate;
    if (this.audioMs >= 250) {
      this.lastLoad = this.ratio();
      this.hasWindow = true;
      this.workMs = 0;
      this.audioMs = 0;
    }
  }

  get load(): number { return this.hasWindow ? this.lastLoad : this.ratio(); }

  private ratio(): number {
    return this.audioMs > 0 ? Math.min(1, this.workMs / this.audioMs) : 0;
  }
}
