/**
 * Codificación MP3 con lamejs. El paquete no exporta nada usable (las tres
 * entradas cuelgan Mp3Encoder del objeto de la función global o referencian
 * símbolos rotos), así que se carga la fuente minificada con ?raw y se
 * instancia una vez en un scope propio.
 */

import lameSource from 'lamejs/lame.min.js?raw';

interface Mp3EncoderInstance {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}

type Mp3EncoderCtor = new (channels: number, sampleRate: number, kbps: number) => Mp3EncoderInstance;

let ctor: Mp3EncoderCtor | null = null;

function mp3Ctor(): Mp3EncoderCtor {
  if (!ctor) {
    // El script define `function lamejs(){…}` y la llama; Mp3Encoder queda
    // colgado del propio objeto de la función. Se devuelve esa función.
    const factory = new Function(`${lameSource}; return lamejs;`) as () => {
      Mp3Encoder: Mp3EncoderCtor;
    };
    ctor = factory().Mp3Encoder;
  }
  return ctor;
}

export function encodeMp3(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  kbps = 192,
): Uint8Array {
  const Encoder = mp3Ctor();
  const enc = new Encoder(2, sampleRate, kbps);
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
