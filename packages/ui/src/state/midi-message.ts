/**
 * Interpretación de los bytes que llegan por Web MIDI y los ajustes con los
 * que Orbit los trata: qué canal se escucha, cuántas octavas se transpone y
 * qué curva de pulsación se aplica.
 *
 * Vive aparte del cableado (`live-input.ts`) a propósito: esto es aritmética
 * pura sobre tres bytes y se prueba sin controlador, sin navegador y sin
 * audio. Lo que se puede probar así es justo lo que más se rompe — un teclado
 * que manda note-on con velocidad 0 en vez de note-off, un pedal que manda
 * 0x7F cuando lo pisas, un pitch bend que hay que rearmar de dos bytes de 7
 * bits, y las tres o cuatro formas de decir "suéltalo todo".
 */

/** Un mensaje MIDI ya entendido. Los canales van 1..16, como en el hardware. */
export type MidiEvent =
  | { kind: 'noteOn'; channel: number; key: number; velocity: number }
  | { kind: 'noteOff'; channel: number; key: number }
  /** Control continuo; `value` ya viene normalizado a 0..1. */
  | { kind: 'cc'; channel: number; controller: number; value: number }
  /** Rueda de tono, bipolar (-1 abajo del todo, 0 centrada, +1 arriba). */
  | { kind: 'pitchBend'; channel: number; value: number }
  /** Pedal de sostenido (CC 64), ya resuelto a pisado/suelto. */
  | { kind: 'sustain'; channel: number; down: boolean }
  /** "Suéltalo todo" (CC 120/123 y el panic de algunos teclados). */
  | { kind: 'allNotesOff'; channel: number };

/** Controlador del pedal de sostenido en el estándar. */
export const CC_SUSTAIN = 64;
/** Rueda de modulación: el destino por defecto cuando se aprende un mando. */
export const CC_MOD_WHEEL = 1;

/**
 * Traduce los bytes crudos. Devuelve `null` para todo lo que Orbit no usa
 * (reloj, SysEx, program change…) en vez de intentar adivinar: un mensaje mal
 * entendido dispara una nota que nadie va a soltar.
 */
export function parseMidiMessage(data: Uint8Array | readonly number[]): MidiEvent | null {
  if (data.length < 2) return null;
  const status = data[0]! & 0xf0;
  // Los mensajes de sistema (0xF0…0xFF) no llevan canal en el nibble bajo.
  if (status === 0xf0) return null;
  const channel = (data[0]! & 0x0f) + 1;
  const d1 = data[1]! & 0x7f;

  switch (status) {
    case 0x90: {
      if (data.length < 3) return null;
      const velocity = data[2]! & 0x7f;
      // Un note-on con velocidad 0 ES un note-off: medio hardware del mundo
      // lo manda así para poder usar running status.
      if (velocity === 0) return { kind: 'noteOff', channel, key: d1 };
      return { kind: 'noteOn', channel, key: d1, velocity: velocity / 127 };
    }
    case 0x80:
      return { kind: 'noteOff', channel, key: d1 };
    case 0xb0: {
      if (data.length < 3) return null;
      const value = (data[2]! & 0x7f) / 127;
      // 120 = all sound off, 123 = all notes off. Los dos significan lo mismo
      // para nosotros: soltar lo que esté sonando de ese canal.
      if (d1 === 120 || d1 === 123) return { kind: 'allNotesOff', channel };
      // El pedal es un interruptor con histéresis en la mitad: hay pedales
      // continuos que mandan la carrera entera y no solo 0 y 127.
      if (d1 === CC_SUSTAIN) return { kind: 'sustain', channel, down: value >= 0.5 };
      return { kind: 'cc', channel, controller: d1, value };
    }
    case 0xe0: {
      if (data.length < 3) return null;
      // 14 bits en dos bytes de 7: LSB primero. Centro = 8192.
      const raw = ((data[2]! & 0x7f) << 7) | d1;
      return { kind: 'pitchBend', channel, value: (raw - 8192) / 8192 };
    }
    default:
      return null;
  }
}

/** Curvas de pulsación. `fixed` ignora la dinámica del teclado. */
export type VelocityCurve = 'soft' | 'linear' | 'hard' | 'fixed';

export const VELOCITY_CURVES: { id: VelocityCurve; label: string }[] = [
  { id: 'soft', label: 'Suave' },
  { id: 'linear', label: 'Lineal' },
  { id: 'hard', label: 'Dura' },
  { id: 'fixed', label: 'Fija' },
];

export function isVelocityCurve(v: unknown): v is VelocityCurve {
  return v === 'soft' || v === 'linear' || v === 'hard' || v === 'fixed';
}

/**
 * Aplica la curva a una velocidad 0..1. `soft` sube las flojas (teclados de
 * acción ligera, o tocar de noche), `hard` las baja, `fixed` las iguala.
 */
export function applyVelocityCurve(velocity: number, curve: VelocityCurve): number {
  const v = Math.min(1, Math.max(0, velocity));
  switch (curve) {
    case 'soft':
      return Math.pow(v, 0.6);
    case 'hard':
      return Math.pow(v, 1.7);
    case 'fixed':
      return 0.8;
    default:
      return v;
  }
}

/** ¿Escuchamos este canal? `listen` 0 = omni (todos). */
export function channelMatches(messageChannel: number, listen: number): boolean {
  return listen === 0 || listen === messageChannel;
}

/**
 * Transpone una nota por octavas. Devuelve `null` si se sale del rango MIDI:
 * mejor que no suene a que suene otra por culpa de un módulo.
 */
export function transposeKey(key: number, octaves: number): number | null {
  const out = key + octaves * 12;
  return out < 0 || out > 127 ? null : out;
}
