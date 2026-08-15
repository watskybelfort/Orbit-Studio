/** Codificador WAV: 16-bit, 24-bit o float32. */

export type WavDepth = 16 | 24 | 32;

export function encodeWav(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  depth: WavDepth = 16,
): Uint8Array {
  const nFrames = left.length;
  const isFloat = depth === 32;
  const bytesPerSample = depth / 8;
  const blockAlign = bytesPerSample * 2;
  const dataSize = nFrames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, isFloat ? 3 : 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, depth, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < nFrames; i++) {
    for (const ch of [left, right]) {
      const x = Math.max(-1, Math.min(1, ch[i]!));
      if (isFloat) {
        v.setFloat32(off, x, true);
      } else if (depth === 24) {
        const s = Math.round(x * 8388607);
        v.setUint8(off, s & 0xff);
        v.setUint8(off + 1, (s >> 8) & 0xff);
        v.setUint8(off + 2, (s >> 16) & 0xff);
      } else {
        v.setInt16(off, Math.round(x * 32767), true);
      }
      off += bytesPerSample;
    }
  }
  return new Uint8Array(buf);
}
