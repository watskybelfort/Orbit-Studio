/** Utilidades de notas: nombre ↔ MIDI, dB ↔ lineal, escalas. */

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const NAME_TO_SEMITONE: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/**
 * Nombre → MIDI. Convención FL: C5 = 60.
 * Acepta "F2", "A#4", "Bb3".
 */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g][#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`Nota inválida: "${name}"`);
  const pitch = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  const semitone = NAME_TO_SEMITONE[pitch];
  if (semitone === undefined) throw new Error(`Nota inválida: "${name}"`);
  const octave = parseInt(m[2]!, 10);
  return semitone + octave * 12; // C5=60: octava 5 → 60
}

/** MIDI → nombre (convención FL: 60 = C5). */
export function midiToNote(midi: number): string {
  const semitone = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12);
  return `${NAMES[semitone]}${octave}`;
}

/**
 * MIDI → frecuencia. El número MIDI es estándar (60 = do central = 261.63 Hz);
 * la convención FL solo cambia el *nombre* (a 60 lo llama C5).
 */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** dB → ganancia lineal. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Ganancia lineal → dB (floor -96). */
export function gainToDb(gain: number): number {
  return gain <= 0.0000158 ? -96 : 20 * Math.log10(gain);
}

// ── Escalas (resaltado del piano roll) ───────────────────────────────────────

export const SCALES: Record<string, number[]> = {
  'Mayor': [0, 2, 4, 5, 7, 9, 11],
  'Menor natural': [0, 2, 3, 5, 7, 8, 10],
  'Menor armónica': [0, 2, 3, 5, 7, 8, 11],
  'Menor melódica': [0, 2, 3, 5, 7, 9, 11],
  'Dórico': [0, 2, 3, 5, 7, 9, 10],
  'Frigio': [0, 1, 3, 5, 7, 8, 10],
  'Mixolidio': [0, 2, 4, 5, 7, 9, 10],
  'Pent. menor': [0, 3, 5, 7, 10],
  'Pent. mayor': [0, 2, 4, 7, 9],
  'Blues': [0, 3, 5, 6, 7, 10],
};

/** ¿Pertenece `midi` a la escala (root en semitono 0..11)? */
export function inScale(midi: number, root: number, scale: number[]): boolean {
  const rel = (((midi - root) % 12) + 12) % 12;
  return scale.includes(rel);
}
