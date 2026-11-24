/**
 * Altura medida de los bombos de fábrica (nota MIDI con decimales, C5 = 60):
 * pico del espectro entre 30 y 150 Hz en el cuerpo del golpe (30-250 ms tras
 * el ataque). Sale de medir los WAV que genera `generate/generate.ts`; si un
 * bombo se regenera con otra afinación, hay que volver a medirlo.
 *
 * Sirve para afinar el bombo a la tonalidad del beat: un bombo en La natural
 * debajo de un Fa frigio, o un cuarto de tono por encima del La del bajo,
 * bate contra el 808 (lo midió el crítico: batidos de 32-113 cents).
 */
export const DRUM_PITCH: Readonly<Record<string, number>> = {
  'drums/boombap/kick-01': 34.57,
  'drums/boombap/kick-02': 34.57,
  'drums/boombap/kick-03': 34.57,
  'drums/neoperreo/kick-01': 33.16,
  'drums/neoperreo/kick-02': 32.74,
  'drums/reggaeton/kick-01': 33.47,
  'drums/reggaeton/kick-02': 33.98,
  'drums/trap/kick-01': 32.41,
  'drums/trap/kick-02': 34.57,
  'drums/trap/kick-03': 33.37,
};

/**
 * Semitonos (con decimales) que hay que mover un bombo para que su altura
 * caiga en la tónica o la quinta de la tonalidad: el movimiento más corto,
 * nunca más de 3,5 semitonos (más allá el golpe cambia de carácter).
 */
export function kickTune(pitch: number, keyRoot: number): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const target of [keyRoot, keyRoot + 7]) {
    let d = (((target - pitch) % 12) + 12) % 12;
    if (d > 6) d -= 12;
    if (Math.abs(d) < bestAbs) {
      bestAbs = Math.abs(d);
      best = d;
    }
  }
  return bestAbs <= 3.5 ? Math.round(best * 100) / 100 : 0;
}
