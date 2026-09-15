/**
 * Dejar un render presentable y escribirlo como WAV.
 *
 * Es el trozo que NO depende de qué suena: normalizar a -1 dBFS, cortar la
 * cola muerta, el fade anti-click, escribir mono cuando el contenido es mono y
 * releer el pico del archivo para verificar. Vivía dentro de `generate.ts`
 * —el generador del pack de fábrica— y salió aquí al aparecer el SEGUNDO
 * generador (`warehouse.ts`): son las reglas de la casa sobre cómo queda un
 * sonido del pack, y dos copias de esas reglas se separan a la primera de
 * cambio.
 *
 * Funciones puras + `encodeWavMono`: ni fs ni rutas. Quien escribe en disco es
 * cada generador, que es el que sabe dónde va su pack.
 */

/** Pico absoluto de un par L/R. */
export function pico(l: Float32Array, r: Float32Array): number {
  let p = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]!);
    const b = Math.abs(r[i]!);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

/** Normaliza in-place al pico objetivo (dBFS). */
export function normalizar(l: Float32Array, r: Float32Array, objetivoDb = -1): void {
  const p = pico(l, r);
  if (p <= 1e-6) throw new Error('Render en silencio: no se puede normalizar');
  const g = Math.pow(10, objetivoDb / 20) / p;
  for (let i = 0; i < l.length; i++) {
    l[i] = l[i]! * g;
    r[i] = r[i]! * g;
  }
}

/** Recorta el silencio final bajo el umbral, dejando margen. */
export function recortarCola(
  l: Float32Array,
  r: Float32Array,
  sr: number,
  umbralDb = -60,
  margenSec = 0.05,
): [Float32Array, Float32Array] {
  const umbral = Math.pow(10, umbralDb / 20);
  let ultimo = -1;
  for (let i = l.length - 1; i >= 0; i--) {
    if (Math.abs(l[i]!) > umbral || Math.abs(r[i]!) > umbral) {
      ultimo = i;
      break;
    }
  }
  if (ultimo < 0) throw new Error('Render bajo el umbral de recorte en toda su duración');
  const fin = Math.min(l.length, ultimo + 1 + Math.round(margenSec * sr));
  return [l.slice(0, fin), r.slice(0, fin)];
}

/** Fade-out lineal de `ms` al final (anti-click). */
export function fadeOut(l: Float32Array, r: Float32Array, sr: number, ms = 5): void {
  const n = Math.min(l.length, Math.round((ms / 1000) * sr));
  const desde = l.length - n;
  for (let i = 0; i < n; i++) {
    const g = 1 - (i + 1) / n;
    l[desde + i] = l[desde + i]! * g;
    r[desde + i] = r[desde + i]! * g;
  }
}

/**
 * ¿Contenido mono? El paneo del kernel usa cos/sin(π/4), que difieren en
 * 1 ulp, así que se compara con tolerancia (-100 dB), no bit a bit.
 */
export function esMono(l: Float32Array, r: Float32Array): boolean {
  for (let i = 0; i < l.length; i++) {
    if (Math.abs(l[i]! - r[i]!) > 1e-5) return false;
  }
  return true;
}

/** WAV 16-bit mono (el encoder del engine solo hace estéreo). */
export function encodeWavMono(x: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = x.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < x.length; i++) {
    v.setInt16(off, Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), true);
    off += 2;
  }
  return new Uint8Array(buf);
}

/**
 * Pico de un WAV 16-bit ya escrito, en dBFS. Se relee del DISCO a propósito:
 * comprobar el Float32Array que acabamos de normalizar solo diría que la
 * normalización sabe multiplicar; releer el archivo dice que lo que se guardó
 * suena.
 */
export function picoDeWavDb(buf: Buffer): number {
  const ascii = (off: number, n: number) => buf.toString('ascii', off, off + n);
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('No es un WAV RIFF');
  let off = 12;
  let bits = 16;
  let peak = 0;
  while (off + 8 <= buf.length) {
    const id = ascii(off, 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`Se esperaba 16-bit, hay ${bits}`);
      const fin = Math.min(buf.length, off + 8 + size);
      for (let i = off + 8; i + 1 < fin; i += 2) {
        const s = Math.abs(buf.readInt16LE(i)) / 32768;
        if (s > peak) peak = s;
      }
    }
    off += 8 + size + (size % 2);
  }
  return peak <= 0 ? -Infinity : 20 * Math.log10(peak);
}
