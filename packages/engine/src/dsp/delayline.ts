/** Línea de retardo circular con lectura fraccional (interp lineal). */

export class DelayLine {
  private buf: Float32Array;
  private mask: number;
  private w = 0;

  constructor(maxSamples: number) {
    let size = 1;
    while (size < maxSamples) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /** Lee `delay` samples atrás (fraccional). Llamar ANTES de write del sample actual. */
  read(delay: number): number {
    const d = Math.max(1, delay);
    const i = Math.floor(d);
    const frac = d - i;
    const r0 = (this.w - i + this.buf.length) & this.mask;
    const r1 = (r0 - 1 + this.buf.length) & this.mask;
    return this.buf[r0]! * (1 - frac) + this.buf[r1]! * frac;
  }

  clear(): void {
    this.buf.fill(0);
  }
}
