/**
 * Codificador FLAC propio (sin dependencias): estéreo, 16 o 24 bits,
 * predictores FIXED (orden 0..4) + residuos Rice, bloques de 4096 samples.
 * Compresión típica 40-60% del WAV equivalente, decodificable por cualquier
 * reproductor (ffmpeg, VLC, foobar...). El MD5 del STREAMINFO se deja a 0
 * ("desconocido", permitido por la spec).
 */

export type FlacDepth = 16 | 24;

const BLOCK_SIZE = 4096;
/** Máximo parámetro Rice del método 4-bit (1111 = escape, no lo usamos). */
const MAX_RICE_K = 14;

// ── BitWriter ────────────────────────────────────────────────────────────────

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0; // bytes completos
  private acc = 0; // bits pendientes (MSB primero)
  private nbits = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Escribe `n` bits (0..32) del valor, MSB primero. */
  write(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.acc & 0xff;
        this.acc = 0;
        this.nbits = 0;
      }
    }
  }

  /** Unario: q ceros y un 1. */
  writeUnary(q: number): void {
    while (q >= 32) {
      this.write(0, 32);
      q -= 32;
    }
    this.write(1, q + 1);
  }

  /** Rellena con ceros hasta el siguiente byte. */
  align(): void {
    if (this.nbits > 0) this.write(0, 8 - this.nbits);
  }

  get byteLength(): number {
    return this.len;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** Bytes desde una posición (para CRC del frame en curso). */
  slice(from: number): Uint8Array {
    return this.buf.subarray(from, this.len);
  }
}

// ── CRCs de FLAC ─────────────────────────────────────────────────────────────

/** CRC-8, polinomio 0x07, init 0 (cabecera de frame). */
function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** CRC-16, polinomio 0x8005, init 0 (frame completo). */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]! << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ── Codificación de un subframe ──────────────────────────────────────────────

/** Residuo del predictor fixed de orden N sobre `x` (desde la muestra N). */
function fixedResidual(x: Int32Array, order: number, out: Int32Array): void {
  const n = x.length;
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i]!;
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i - 1] = x[i]! - x[i - 1]!;
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i - 2] = x[i]! - 2 * x[i - 1]! + x[i - 2]!;
      break;
    case 3:
      for (let i = 3; i < n; i++) out[i - 3] = x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!;
      break;
    default:
      for (let i = 4; i < n; i++) {
        out[i - 4] = x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
      }
  }
}

/** Parámetro Rice óptimo aproximado a partir de la media de |residuo|. */
function bestRiceK(res: Int32Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(res[i]!);
  const mean = sum / Math.max(1, n);
  let k = 0;
  while (k < MAX_RICE_K && (1 << (k + 1)) < mean + 1) k++;
  return k;
}

/** Bits estimados de un residuo Rice con parámetro k. */
function riceCost(res: Int32Array, n: number, k: number): number {
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = res[i]!;
    const u = v >= 0 ? v * 2 : -v * 2 - 1;
    bits += (u >>> k) + 1 + k;
  }
  return bits;
}

function writeSubframe(bw: BitWriter, x: Int32Array, depth: FlacDepth): void {
  const n = x.length;

  // ¿Constante? (silencios: subframe CONSTANT de 000000)
  let constant = true;
  for (let i = 1; i < n; i++) {
    if (x[i] !== x[0]) {
      constant = false;
      break;
    }
  }
  if (constant) {
    bw.write(0, 1);
    bw.write(0b000000, 6);
    bw.write(0, 1);
    bw.write(x[0]! & ((1 << depth) - 1) >>> 0, depth);
    return;
  }

  // Mejor orden fixed por coste Rice real.
  const res = new Int32Array(n);
  let bestOrder = 0;
  let bestK = 0;
  let bestBits = Infinity;
  const maxOrder = Math.min(4, n - 1);
  for (let order = 0; order <= maxOrder; order++) {
    fixedResidual(x, order, res);
    const m = n - order;
    const k = bestRiceK(res, m);
    const bits = riceCost(res, m, k) + order * depth;
    if (bits < bestBits) {
      bestBits = bits;
      bestOrder = order;
      bestK = k;
    }
  }

  // Si Rice no compensa (ruido extremo), VERBATIM.
  if (bestBits >= n * depth || bestK > MAX_RICE_K) {
    bw.write(0, 1);
    bw.write(0b000001, 6);
    bw.write(0, 1);
    for (let i = 0; i < n; i++) bw.write(x[i]! & (((1 << depth) - 1) >>> 0), depth);
    return;
  }

  fixedResidual(x, bestOrder, res);
  const m = n - bestOrder;

  bw.write(0, 1);
  bw.write(0b001000 | bestOrder, 6); // FIXED, orden 0..4
  bw.write(0, 1); // sin wasted bits

  // Warm-up: las primeras `order` muestras en crudo.
  for (let i = 0; i < bestOrder; i++) bw.write(x[i]! & (((1 << depth) - 1) >>> 0), depth);

  // Residuo: método Rice 4-bit, partición de orden 0 (una sola partición).
  bw.write(0b00, 2);
  bw.write(0, 4); // partition order 0
  bw.write(bestK, 4);
  for (let i = 0; i < m; i++) {
    const v = res[i]!;
    const u = v >= 0 ? v * 2 : -v * 2 - 1;
    bw.writeUnary(u >>> bestK);
    if (bestK > 0) bw.write(u & ((1 << bestK) - 1), bestK);
  }
}

// ── Cabeceras ────────────────────────────────────────────────────────────────

/** Número de frame en el UTF-8 extendido de FLAC (hasta 2^36). */
function writeFrameNumber(bw: BitWriter, num: number): void {
  if (num < 0x80) {
    bw.write(num, 8);
  } else if (num < 0x800) {
    bw.write(0xc0 | (num >>> 6), 8);
    bw.write(0x80 | (num & 0x3f), 8);
  } else if (num < 0x10000) {
    bw.write(0xe0 | (num >>> 12), 8);
    bw.write(0x80 | ((num >>> 6) & 0x3f), 8);
    bw.write(0x80 | (num & 0x3f), 8);
  } else if (num < 0x200000) {
    bw.write(0xf0 | (num >>> 18), 8);
    bw.write(0x80 | ((num >>> 12) & 0x3f), 8);
    bw.write(0x80 | ((num >>> 6) & 0x3f), 8);
    bw.write(0x80 | (num & 0x3f), 8);
  } else {
    bw.write(0xf8 | (num >>> 24), 8);
    bw.write(0x80 | ((num >>> 18) & 0x3f), 8);
    bw.write(0x80 | ((num >>> 12) & 0x3f), 8);
    bw.write(0x80 | ((num >>> 6) & 0x3f), 8);
    bw.write(0x80 | (num & 0x3f), 8);
  }
}

const SAMPLE_SIZE_CODE: Record<FlacDepth, number> = { 16: 0b100, 24: 0b110 };

// ── API ──────────────────────────────────────────────────────────────────────

export function encodeFlac(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  depth: FlacDepth = 16,
): Uint8Array {
  const nFrames = left.length;
  const scale = depth === 16 ? 32767 : 8388607;

  // Cuantización idéntica al WAV de Orbit (clamp + round).
  const li = new Int32Array(nFrames);
  const ri = new Int32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    li[i] = Math.round(Math.max(-1, Math.min(1, left[i]!)) * scale);
    ri[i] = Math.round(Math.max(-1, Math.min(1, right[i]!)) * scale);
  }

  const bw = new BitWriter();

  // fLaC + STREAMINFO (último bloque de metadatos).
  bw.write(0x66, 8); // f
  bw.write(0x4c, 8); // L
  bw.write(0x61, 8); // a
  bw.write(0x43, 8); // C
  bw.write(1, 1); // last-metadata-block
  bw.write(0, 7); // tipo 0 = STREAMINFO
  bw.write(34, 24); // longitud
  bw.write(BLOCK_SIZE, 16); // min blocksize
  bw.write(BLOCK_SIZE, 16); // max blocksize
  bw.write(0, 24); // min framesize desconocido
  bw.write(0, 24); // max framesize desconocido
  bw.write(sampleRate, 20);
  bw.write(1, 3); // canales - 1
  bw.write(depth - 1, 5);
  bw.write(Math.floor(nFrames / 0x100000000), 4); // total samples (36 bits)
  bw.write(nFrames >>> 0, 32);
  for (let i = 0; i < 16; i++) bw.write(0, 8); // MD5 desconocido

  // Frames.
  const chL = new Int32Array(BLOCK_SIZE);
  const chR = new Int32Array(BLOCK_SIZE);
  let frameNo = 0;
  for (let pos = 0; pos < nFrames; pos += BLOCK_SIZE, frameNo++) {
    const n = Math.min(BLOCK_SIZE, nFrames - pos);
    const xL = n === BLOCK_SIZE ? chL : new Int32Array(n);
    const xR = n === BLOCK_SIZE ? chR : new Int32Array(n);
    for (let i = 0; i < n; i++) {
      xL[i] = li[pos + i]!;
      xR[i] = ri[pos + i]!;
    }

    const frameStart = bw.byteLength;
    bw.write(0b11111111111110, 14); // sync
    bw.write(0, 1); // reservado
    bw.write(0, 1); // blocking strategy: blocksize fijo
    bw.write(0b0111, 4); // blocksize: 16 bits al final de la cabecera
    bw.write(0b0000, 4); // sample rate: del STREAMINFO
    bw.write(0b0001, 4); // 2 canales independientes (L/R)
    bw.write(SAMPLE_SIZE_CODE[depth], 3);
    bw.write(0, 1); // reservado
    writeFrameNumber(bw, frameNo);
    bw.write(n - 1, 16);
    bw.write(crc8(bw.slice(frameStart)), 8);

    writeSubframe(bw, xL, depth);
    writeSubframe(bw, xR, depth);
    bw.align();
    bw.write(crc16(bw.slice(frameStart)), 16);
  }

  return bw.bytes();
}
