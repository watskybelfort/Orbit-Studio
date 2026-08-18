/**
 * Compresión del streaming del master: IMA ADPCM, 4 bits por muestra.
 *
 * El stream de v1.8 viajaba CRUDO (Int16 mono: ~1,4 Mbit/s a 44,1 kHz). Sobra
 * para una LAN y molesta para todo lo demás. Un encoder Opus propio es un
 * proyecto aparte —el de FLAC ya costó lo suyo y aquello es sin pérdida—, así
 * que aquí va lo que sí cabe hacer bien: ADPCM, 4:1, sin tablas gigantes ni
 * ventanas ni retardo. La calidad es la de una escucha de referencia, que es
 * exactamente para lo que existe este stream.
 *
 * Es el ADPCM de IMA/DVI de toda la vida: se transmite la DIFERENCIA con la
 * predicción anterior en pasos que crecen y menguan según lo que va pasando.
 * Cada trozo se codifica desde cero (predictor a 0), así que un paquete
 * perdido no arrastra al siguiente — en un stream en vivo eso importa más que
 * el par de bits que costaría.
 */

/** Tamaño del paso según el índice (tabla estándar IMA). */
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73,
  80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
  2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

/** Cuánto se mueve el índice del paso según el nibble transmitido. */
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];

function clampIndex(index: number): number {
  return index < 0 ? 0 : index > 88 ? 88 : index;
}

function clampSample(value: number): number {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value;
}

/**
 * Int16 → nibbles empaquetados (dos muestras por byte). El predictor arranca
 * en 0 y no viaja: el decodificador arranca igual, así que cada trozo es
 * independiente.
 */
export function encodeAdpcm(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(samples.length / 2));
  let predictor = 0;
  let index = 0;

  for (let i = 0; i < samples.length; i++) {
    const step = STEP_TABLE[index]!;
    let diff = samples[i]! - predictor;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    // Los tres bits de magnitud, en cuartos de paso (mismo orden que el decoder).
    let delta = step >> 3;
    if (diff >= step) {
      code |= 4;
      diff -= step;
      delta += step;
    }
    if (diff >= step >> 1) {
      code |= 2;
      diff -= step >> 1;
      delta += step >> 1;
    }
    if (diff >= step >> 2) {
      code |= 1;
      delta += step >> 2;
    }
    predictor = clampSample(predictor + ((code & 8) !== 0 ? -delta : delta));
    index = clampIndex(index + INDEX_TABLE[code & 7]!);

    // Primer nibble en los bits bajos: así lo espera el decodificador.
    if ((i & 1) === 0) out[i >> 1] = code;
    else out[i >> 1] = (out[i >> 1]! | (code << 4)) & 0xff;
  }
  return out;
}

/** Nibbles → Int16. `count` es cuántas muestras había (el último byte sobra). */
export function decodeAdpcm(packed: Uint8Array, count: number): Int16Array {
  const out = new Int16Array(count);
  let predictor = 0;
  let index = 0;

  for (let i = 0; i < count; i++) {
    const byte = packed[i >> 1] ?? 0;
    const code = (i & 1) === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
    const step = STEP_TABLE[index]!;
    let delta = step >> 3;
    if ((code & 4) !== 0) delta += step;
    if ((code & 2) !== 0) delta += step >> 1;
    if ((code & 1) !== 0) delta += step >> 2;
    predictor = clampSample(predictor + ((code & 8) !== 0 ? -delta : delta));
    index = clampIndex(index + INDEX_TABLE[code & 7]!);
    out[i] = predictor;
  }
  return out;
}

/** Bytes que ocupa un trozo de N muestras ya comprimido. */
export function adpcmBytes(samples: number): number {
  return Math.ceil(samples / 2);
}
