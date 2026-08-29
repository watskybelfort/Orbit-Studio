/**
 * Suavizado de coeficientes (SVF/Biquad/Allpass1): al automatizar un corte
 * —una curva que barre, un LFO sobre un EQ, la perilla girando— el kernel
 * llama a `setParams()` una vez por bloque (MAX_BLOCK = 128 muestras, ver
 * kernel-core.ts). Antes del suavizado eso aplicaba el coeficiente nuevo de
 * golpe: una discontinuidad real en la respuesta del filtro, cada 128
 * muestras, que se oye como zipper noise. Estos tests comprueban dos cosas:
 * que el coeficiente VIVO se desliza hacia el objetivo en vez de saltar, y
 * que un barrido con automatización por bloque no deja una firma de "borde
 * de bloque" en la señal de salida.
 *
 * Y la otra mitad, que es la que se rompe sin que nadie se entere: hay un
 * SEGUNDO tipo de llamante —el que ya calcula el valor muestra a muestra— para
 * el que este mismo suavizado es solo retraso. Ese pide `'per-sample'` al
 * construir el filtro (ver `CoefSource` en filters.ts) y aquí se comprueba que
 * de verdad no desliza, que el modo por defecto NO cambió, y que `copyFrom` no
 * le devuelve el suavizado a un biquad `'per-sample'` por la puerta de atrás.
 */
import { describe, expect, it } from 'vitest';
import { Allpass1, Biquad, SVF } from '../src/dsp/filters';

const SR = 48000;
/** MAX_BLOCK del kernel: el tamaño de bloque real con el que automation llama a setParams(). */
const BLOCK = 128;

/**
 * Segunda diferencia (curvatura discreta) muestra a muestra. Para una señal
 * continua es pequeña y varía suave; un salto de coeficiente de golpe la
 * dispara puntualmente. Devuelve el pico de curvatura EN los bordes de
 * bloque (muestras 0 y 1 de cada bloque, donde el nuevo coeficiente empieza
 * a actuar) contra el percentil 99 de la curvatura en el resto de la señal
 * — la línea de base "normal" de un barrido continuo, sin verse arrastrada
 * por los picos naturales de una senoidal.
 */
function boundaryCurvatureRatio(out: Float32Array, blockSize: number): number {
  const n = out.length;
  const boundary: number[] = [];
  const interior: number[] = [];
  for (let i = 2; i < n; i++) {
    const d2 = Math.abs(out[i]! - 2 * out[i - 1]! + out[i - 2]!);
    const rel = i % blockSize;
    if (rel === 0 || rel === 1) boundary.push(d2);
    else interior.push(d2);
  }
  interior.sort((a, b) => a - b);
  const p99 = interior[Math.floor(interior.length * 0.99)]!;
  const maxBoundary = Math.max(...boundary);
  return maxBoundary / Math.max(p99, 1e-12);
}

/** Barre `setCoef` (un cutoff por bloque, como automation) y filtra un seno fijo. */
function sweepBlocks(
  totalBlocks: number,
  inputHz: number,
  setCoef: (cutoffHz: number) => void,
  tick: (x: number) => number,
): Float32Array {
  const n = BLOCK * totalBlocks;
  const out = new Float32Array(n);
  for (let block = 0; block < totalBlocks; block++) {
    const t = block / totalBlocks;
    const cutoff = 250 * Math.pow(9000 / 250, t);
    setCoef(cutoff); // un setParams() por bloque, igual que la automatización real
    for (let i = 0; i < BLOCK; i++) {
      const idx = block * BLOCK + i;
      const x = Math.sin((2 * Math.PI * inputHz * idx) / SR) * 0.5;
      out[idx] = tick(x);
    }
  }
  return out;
}

describe('Biquad: coeficientes suavizados', () => {
  it('primed: el primer diseño se aplica de una, sin fundido de entrada', () => {
    // Caso one-shot (K-weighting de analysis.ts, tono recién creado en un
    // efecto nuevo): no debe haber rampa de entrada, el filtro responde
    // correctamente desde la muestra 0.
    const bq = new Biquad();
    bq.lowpass(1000, 0.707, SR);
    const b0AtStart = bq.b0;
    bq.tick(0);
    expect(bq.b0).toBeCloseTo(b0AtStart, 12);
  });

  it('un rediseño (automatización) se desliza en el tiempo: el coeficiente vivo no salta de golpe', () => {
    const bq = new Biquad();
    bq.lowpass(500, 0.707, SR);
    for (let i = 0; i < 50; i++) bq.tick(0);
    const before = bq.b0;
    bq.lowpass(8000, 0.707, SR); // simula un setParams() de automatización
    // Inmediatamente después de pedir el nuevo diseño, el coeficiente VIVO
    // todavía no se movió: solo cambia dentro de tick(), muestra a muestra.
    expect(bq.b0).toBe(before);
    for (let i = 0; i < 3000; i++) bq.tick(0); // ~62 ms a 48 kHz: sobra para asentar (tau = 5 ms)
    const ref = new Biquad().lowpass(8000, 0.707, SR);
    expect(bq.b0).toBeCloseTo(ref.b0, 4);
    expect(bq.a1).toBeCloseTo(ref.a1, 4);
  });

  it('barrido de corte automatizado por bloque: sin discontinuidad en el borde de bloque', () => {
    const bq = new Biquad();
    bq.lowpass(250, 0.9, SR);
    const out = sweepBlocks(
      12,
      300,
      (cutoff) => bq.lowpass(cutoff, 0.9, SR),
      (x) => bq.tick(x),
    );
    const ratio = boundaryCurvatureRatio(out, BLOCK);
    // Con la misma fórmula RBJ pero SIN interpolar (coeficiente de golpe),
    // este barrido mide ~23x el percentil 99 de curvatura interior — un pico
    // de dos órdenes de magnitud, clarísimamente audible. Suavizado debe
    // quedar dentro del ruido normal del barrido.
    expect(ratio).toBeLessThan(3);
  });
});

describe('SVF: coeficientes suavizados', () => {
  it('primed: el primer set() se aplica de una', () => {
    const svf = new SVF();
    svf.set(1000, 0.4, SR);
    const out0 = svf.tick(1, 0);
    // Con el filtro recién configurado, la primera muestra ya debe reflejar
    // el punto de operación pedido (no arranca en g=0/k=1 por defecto).
    const ref = new SVF();
    ref.set(1000, 0.4, SR);
    const outRef = ref.tick(1, 0);
    expect(out0).toBeCloseTo(outRef, 10);
  });

  it('un rediseño (automatización) se desliza en el tiempo: g/k no saltan de golpe', () => {
    // g y k son privados; se leen vía `any` para comprobar la trayectoria
    // directamente, igual que se comprueba b0 en Biquad (que sí es público).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svf = new SVF() as any;
    svf.set(500, 0.3, SR);
    for (let i = 0; i < 50; i++) svf.tick(0, 0);
    const gBefore = svf.g;
    svf.set(6000, 0.3, SR); // salto grande de cutoff, simula automatización
    // Inmediatamente después de pedir el nuevo diseño, g todavía no se movió.
    expect(svf.g).toBe(gBefore);
    for (let i = 0; i < 3000; i++) svf.tick(0, 0); // ~62 ms: sobra para asentar (tau = 5 ms)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = new SVF() as any;
    ref.set(6000, 0.3, SR);
    expect(svf.g).toBeCloseTo(ref.g, 4);
  });

  it('barrido de corte automatizado por bloque: sin discontinuidad en el borde de bloque', () => {
    const svf = new SVF();
    svf.set(250, 0.4, SR);
    const out = sweepBlocks(
      12,
      300,
      (cutoff) => svf.set(cutoff, 0.4, SR),
      (x) => svf.tick(x, 0),
    );
    const ratio = boundaryCurvatureRatio(out, BLOCK);
    expect(ratio).toBeLessThan(3);
  });
});

describe('Allpass1: coeficientes suavizados', () => {
  it('primed: el primer set() se aplica de una', () => {
    const ap = new Allpass1();
    ap.set(1000, SR);
    const a0 = ap.a;
    ap.tick(0);
    expect(ap.a).toBeCloseTo(a0, 12);
  });

  it('un rediseño se desliza en el tiempo (el coeficiente vive siempre en (-1,1): interpolar en crudo no puede pasar por un valor inestable)', () => {
    const ap = new Allpass1();
    ap.set(300, SR);
    for (let i = 0; i < 50; i++) ap.tick(0);
    const before = ap.a;
    ap.set(9000, SR);
    expect(ap.a).toBe(before); // no se mueve hasta el próximo tick()
    for (let i = 0; i < 3000; i++) ap.tick(0);
    const ref = new Allpass1();
    ref.set(9000, SR);
    expect(ap.a).toBeCloseTo(ref.a, 4);
    expect(Math.abs(ap.a)).toBeLessThan(1); // nunca sale del rango estable
  });
});

describe('CoefSource: los dos tipos de llamante, y que no se contagien', () => {
  it("SVF 'per-sample': el objetivo es el valor vivo desde el primer tick, sin rampa", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svf = new SVF('per-sample') as any;
    svf.set(500, 0.3, SR);
    for (let i = 0; i < 50; i++) svf.tick(0, 0);
    svf.set(6000, 0.3, SR); // el salto que en modo por bloque tardaría ~5 ms
    svf.tick(0, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = new SVF('per-sample') as any;
    ref.set(6000, 0.3, SR);
    ref.tick(0, 0);
    expect(svf.g).toBe(ref.g);
    expect(svf.k).toBe(ref.k);
  });

  it('el modo por defecto sigue siendo el de por bloque (nadie hereda el atajo sin pedirlo)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svf = new SVF() as any;
    svf.set(500, 0.3, SR);
    for (let i = 0; i < 50; i++) svf.tick(0, 0);
    svf.set(6000, 0.3, SR);
    svf.tick(0, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref = new SVF('per-sample') as any;
    ref.set(6000, 0.3, SR);
    ref.tick(0, 0);
    // Todavía muy lejos del objetivo: está deslizando, que es lo que tiene que
    // hacer cuando el valor viene en escalones de bloque.
    expect(svf.g).toBeLessThan(ref.g * 0.5);
  });

  it("Biquad 'per-sample': el coeficiente vivo es el objetivo desde el primer tick", () => {
    const bq = new Biquad('per-sample');
    bq.lowpass(500, 0.707, SR);
    for (let i = 0; i < 50; i++) bq.tick(0);
    bq.lowpass(8000, 0.707, SR);
    bq.tick(0);
    const ref = new Biquad('per-sample').lowpass(8000, 0.707, SR);
    ref.tick(0);
    expect(bq.b0).toBe(ref.b0);
    expect(bq.a1).toBe(ref.a1);
  });

  it("copyFrom no le devuelve el suavizado a un biquad 'per-sample'", () => {
    // El par L/R se sincroniza con copyFrom, y copiar el `smoothCoef` de un
    // hermano por bloque volvería a meter la rampa sin que se note en ningún
    // sitio: el bug silencioso exacto que este modo viene a evitar.
    const porBloque = new Biquad().lowpass(500, 0.707, SR);
    for (let i = 0; i < 50; i++) porBloque.tick(0);
    const porMuestra = new Biquad('per-sample');
    porMuestra.copyFrom(porBloque);
    porMuestra.lowpass(8000, 0.707, SR);
    porMuestra.tick(0);
    const ref = new Biquad('per-sample').lowpass(8000, 0.707, SR);
    ref.tick(0);
    expect(porMuestra.b0).toBe(ref.b0);
  });
});
