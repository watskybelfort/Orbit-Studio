/**
 * Renderizar un fixture y sacarle la huella. Lo comparten el test
 * (`golden.test.ts`), el actualizador (`tools/qa/golden-update.ts`) y el
 * experimento de mordida (`tools/qa/golden-bite.ts`), para que los tres midan
 * exactamente lo mismo: si el test renderizara distinto que el actualizador,
 * la línea base sería de otro sonido que el comparado.
 */

import { createHash } from 'node:crypto';
import { renderProject } from '../../src/render/offline';
import { encodeOpusFile } from '../../src/render/opus/encoder';
import {
  GOLDEN_FIXTURES,
  GOLDEN_OPUS_FIXTURES,
  GOLDEN_SR,
  type GoldenFixture,
  type OpusFixture,
} from './fixtures';
import { fingerprint, type Fingerprint } from './fingerprint';

function render(f: GoldenFixture, sampleRate: number): ReturnType<typeof renderProject> {
  return renderProject(f.build(), {
    sampleRate,
    tailSeconds: f.tailSeconds,
    ...(f.samples ? { samples: f.samples() } : null),
  });
}

export function renderFixture(f: GoldenFixture): Fingerprint {
  const res = render(f, GOLDEN_SR);
  return fingerprint(res.left, res.right, res.sampleRate);
}

/** Huella de un `.opus`: los bytes del flujo, que o son iguales o no lo son. */
export interface OpusFingerprint {
  hash: string;
  bytes: number;
}

/**
 * CELT trabaja a 48 kHz. El render de la fuente se hace directamente a esa
 * frecuencia —no se remuestrea un render de 44,1— porque un remuestreador en
 * medio metería su propio sonido entre el motor y el encoder, y entonces el
 * fixture ya no diría de cuál de los dos vino un cambio.
 */
export const OPUS_SR = 48000;

export function encodeFixture(f: OpusFixture): OpusFingerprint {
  const source = GOLDEN_FIXTURES.find((x) => x.name === f.source);
  if (!source) throw new Error(`El fixture Opus "${f.name}" apunta a "${f.source}", que no existe.`);
  const res = render(source, OPUS_SR);
  const n = Math.min(res.left.length, res.right.length);
  const pcm = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    pcm[i * 2] = res.left[i]!;
    pcm[i * 2 + 1] = res.right[i]!;
  }
  const file = encodeOpusFile(pcm, { channels: 2, bitrate: f.bitrate });
  return { hash: createHash('sha256').update(file).digest('hex'), bytes: file.length };
}

export function encodeAll(): Record<string, OpusFingerprint> {
  const out: Record<string, OpusFingerprint> = {};
  for (const f of GOLDEN_OPUS_FIXTURES) out[f.name] = encodeFixture(f);
  return out;
}

export function renderAll(only?: readonly string[]): Record<string, Fingerprint> {
  const out: Record<string, Fingerprint> = {};
  for (const f of GOLDEN_FIXTURES) {
    if (only && only.length > 0 && !only.includes(f.name)) continue;
    out[f.name] = renderFixture(f);
  }
  return out;
}

/** Forma del archivo de línea base. */
export interface Baseline {
  /**
   * Versión del FORMATO del archivo, no del sonido. Sube solo si cambia la
   * estructura (otra métrica, otro número de ventanas): un archivo viejo leído
   * con un lector nuevo compararía peras con manzanas sin avisar.
   */
  formatVersion: number;
  /** Versión del producto cuyo sonido se fijó. Informativa, para el diff. */
  orbitVersion: string;
  /** Cuándo se regeneró, y con qué runtime — sirve para depurar un hash raro. */
  recordedAt: string;
  recordedOn: { platform: string; arch: string; node: string; v8: string };
  /**
   * El motivo que se dio al aceptar el último diff de sonido. Vive DENTRO del
   * archivo a propósito: el mensaje de commit se pierde en cuanto alguien lee
   * el JSON suelto, y entonces «por qué suena así» deja de tener respuesta.
   */
  accepted?: string;
  fixtures: Record<string, { covers: string } & Fingerprint>;
  /** El encoder Opus: bytes, sin tolerancia posible (ver `fixtures.ts`). */
  opus: Record<string, { covers: string } & OpusFingerprint>;
}

export const BASELINE_FORMAT_VERSION = 1;

export function fixtureCovers(name: string): string {
  return GOLDEN_FIXTURES.find((f) => f.name === name)?.covers ?? '(fixture desconocido)';
}
