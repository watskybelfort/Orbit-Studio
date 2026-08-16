/** Codificación MP3 con lamejs (bloques de 1152 samples, 16-bit intermedio). */

import lamejs from 'lamejs/lame.min.js';

export function encodeMp3(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  kbps = 192,
): Uint8Array {
  const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps);
  const BLOCK = 1152;
  const l16 = new Int16Array(BLOCK);
  const r16 = new Int16Array(BLOCK);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const n = Math.min(BLOCK, left.length - i);
    for (let j = 0; j < n; j++) {
      l16[j] = Math.max(-32768, Math.min(32767, Math.round(left[i + j]! * 32767)));
      r16[j] = Math.max(-32768, Math.min(32767, Math.round(right[i + j]! * 32767)));
    }
    const chunk = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
    if (chunk.length > 0) parts.push(new Uint8Array(chunk.buffer.slice(0, chunk.length)));
  }
  const tail = enc.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail.buffer.slice(0, tail.length)));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
