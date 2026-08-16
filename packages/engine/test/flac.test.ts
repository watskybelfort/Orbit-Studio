/**
 * Round-trip del codificador FLAC: un mini-decodificador aquí mismo parsea el
 * subset que emite encodeFlac (frames de blocksize fijo, canales L/R
 * independientes, subframes CONSTANT/VERBATIM/FIXED con Rice de partición 0)
 * y los samples deben salir BIT-EXACTOS respecto a la cuantización de entrada.
 */

import { describe, expect, it } from 'vitest';
import { encodeFlac, type FlacDepth } from '../src/render/flac';

// ── Mini-decodificador del subset de Orbit ───────────────────────────────────

class BitReader {
  private pos = 0; // bit absoluto
  constructor(private bytes: Uint8Array) {}

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3]!;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v >>> 0;
  }

  readUnary(): number {
    let q = 0;
    while (this.read(1) === 0) q++;
    return q;
  }

  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }

  get byteOffset(): number {
    return this.pos >> 3;
  }

  get atEnd(): boolean {
    return this.byteOffset >= this.bytes.length;
  }
}

function signExtend(v: number, bits: number): number {
  return v >= 1 << (bits - 1) ? v - (1 << bits) : v;
}

interface DecodedFlac {
  sampleRate: number;
  channels: number;
  depth: number;
  totalSamples: number;
  left: number[];
  right: number[];
}

function decodeOrbitFlac(bytes: Uint8Array): DecodedFlac {
  const br = new BitReader(bytes);
  expect(String.fromCharCode(br.read(8), br.read(8), br.read(8), br.read(8))).toBe('fLaC');

  // STREAMINFO (único bloque de metadatos que emitimos, marcado como último).
  expect(br.read(1)).toBe(1); // last-metadata-block
  expect(br.read(7)).toBe(0); // tipo STREAMINFO
  expect(br.read(24)).toBe(34);
  const minBlock = br.read(16);
  const maxBlock = br.read(16);
  expect(minBlock).toBe(maxBlock);
  br.read(24); // min frame size
  br.read(24); // max frame size
  const sampleRate = br.read(20);
  const channels = br.read(3) + 1;
  const depth = br.read(5) + 1;
  const totalSamples = br.read(4) * 0x100000000 + br.read(32);
  for (let i = 0; i < 16; i++) br.read(8); // MD5

  const left: number[] = [];
  const right: number[] = [];

  const readSubframe = (n: number): number[] => {
    expect(br.read(1)).toBe(0); // padding
    const type = br.read(6);
    expect(br.read(1)).toBe(0); // sin wasted bits
    const out: number[] = [];
    if (type === 0b000000) {
      const v = signExtend(br.read(depth), depth);
      for (let i = 0; i < n; i++) out.push(v);
      return out;
    }
    if (type === 0b000001) {
      for (let i = 0; i < n; i++) out.push(signExtend(br.read(depth), depth));
      return out;
    }
    expect(type & 0b111000).toBe(0b001000); // FIXED
    const order = type & 0b000111;
    expect(order).toBeLessThanOrEqual(4);
    for (let i = 0; i < order; i++) out.push(signExtend(br.read(depth), depth));
    expect(br.read(2)).toBe(0b00); // método Rice 4-bit
    expect(br.read(4)).toBe(0); // partición de orden 0
    const k = br.read(4);
    for (let i = 0; i < n - order; i++) {
      const q = br.readUnary();
      const u = (q << k) | (k > 0 ? br.read(k) : 0);
      const res = u % 2 === 0 ? u / 2 : -(u + 1) / 2;
      const j = out.length;
      let v = res;
      if (order === 1) v = res + out[j - 1]!;
      else if (order === 2) v = res + 2 * out[j - 1]! - out[j - 2]!;
      else if (order === 3) v = res + 3 * out[j - 1]! - 3 * out[j - 2]! + out[j - 3]!;
      else if (order === 4) {
        v = res + 4 * out[j - 1]! - 6 * out[j - 2]! + 4 * out[j - 3]! - out[j - 4]!;
      }
      out.push(v);
    }
    return out;
  };

  while (left.length < totalSamples && !br.atEnd) {
    expect(br.read(14)).toBe(0b11111111111110); // sync
    expect(br.read(1)).toBe(0);
    expect(br.read(1)).toBe(0); // blocksize fijo
    expect(br.read(4)).toBe(0b0111); // blocksize en 16 bits
    expect(br.read(4)).toBe(0b0000); // sample rate del STREAMINFO
    expect(br.read(4)).toBe(0b0001); // L/R independientes
    br.read(3); // sample size
    expect(br.read(1)).toBe(0);
    // Número de frame (UTF-8 extendido): salta los bytes de continuación.
    const first = br.read(8);
    let extra = 0;
    for (let m = 0x80; first & m; m >>= 1) extra++;
    if (extra > 0) extra--;
    for (let i = 0; i < extra; i++) expect(br.read(8) & 0xc0).toBe(0x80);
    const blockSize = br.read(16) + 1;
    br.read(8); // CRC-8 (no verificado aquí)

    left.push(...readSubframe(blockSize));
    right.push(...readSubframe(blockSize));
    br.align();
    br.read(16); // CRC-16
  }

  return { sampleRate, channels, depth, totalSamples, left, right };
}

/** Cuantización de referencia (idéntica a la del encoder y al WAV de Orbit). */
function quantize(x: Float32Array, depth: FlacDepth): number[] {
  const scale = depth === 16 ? 32767 : 8388607;
  return [...x].map((v) => Math.round(Math.max(-1, Math.min(1, v)) * scale));
}

// ── Señales de prueba ────────────────────────────────────────────────────────

function makeSignal(n: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let noise = 12345;
  for (let i = 0; i < n; i++) {
    noise = (noise * 1103515245 + 12345) & 0x7fffffff;
    const rnd = noise / 0x7fffffff - 0.5;
    left[i] = 0.6 * Math.sin((2 * Math.PI * 220 * i) / 44100) + 0.02 * rnd;
    right[i] = 0.5 * Math.sin((2 * Math.PI * 331 * i) / 44100 + 1) + 0.02 * rnd;
  }
  return { left, right };
}

describe('encodeFlac', () => {
  it('round-trip bit-exacto a 16 bits con frame parcial al final', () => {
    const n = 4096 * 2 + 1234; // dos frames completos + uno parcial
    const { left, right } = makeSignal(n);
    const flac = encodeFlac(left, right, 44100, 16);

    const dec = decodeOrbitFlac(flac);
    expect(dec.sampleRate).toBe(44100);
    expect(dec.channels).toBe(2);
    expect(dec.depth).toBe(16);
    expect(dec.totalSamples).toBe(n);
    expect(dec.left).toEqual(quantize(left, 16));
    expect(dec.right).toEqual(quantize(right, 16));
  });

  it('round-trip bit-exacto a 24 bits', () => {
    const n = 4096 + 100;
    const { left, right } = makeSignal(n);
    const flac = encodeFlac(left, right, 96000, 24);

    const dec = decodeOrbitFlac(flac);
    expect(dec.depth).toBe(24);
    expect(dec.sampleRate).toBe(96000);
    expect(dec.left).toEqual(quantize(left, 24));
    expect(dec.right).toEqual(quantize(right, 24));
  });

  it('silencio usa subframes CONSTANT y comprime fuerte', () => {
    const n = 4096 * 4;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const flac = encodeFlac(left, right, 44100, 16);

    const dec = decodeOrbitFlac(flac);
    expect(dec.left).toEqual(new Array(n).fill(0));
    expect(dec.right).toEqual(new Array(n).fill(0));
    // 4 frames de silencio deben ocupar poquísimo frente a los 64 KB del WAV.
    expect(flac.length).toBeLessThan(300);
  });

  it('material tonal comprime por debajo del tamaño WAV equivalente', () => {
    const n = 4096 * 4;
    const { left, right } = makeSignal(n);
    const flac = encodeFlac(left, right, 44100, 16);
    const wavBytes = n * 2 * 2; // datos PCM 16-bit estéreo
    expect(flac.length).toBeLessThan(wavBytes * 0.9);
  });

  it('ruido blanco a fondo no revienta (cae a VERBATIM si Rice no compensa)', () => {
    const n = 5000;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    let noise = 999;
    for (let i = 0; i < n; i++) {
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      left[i] = (noise / 0x7fffffff) * 2 - 1;
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      right[i] = (noise / 0x7fffffff) * 2 - 1;
    }
    const flac = encodeFlac(left, right, 48000, 16);
    const dec = decodeOrbitFlac(flac);
    expect(dec.left).toEqual(quantize(left, 16));
    expect(dec.right).toEqual(quantize(right, 16));
  });
});
