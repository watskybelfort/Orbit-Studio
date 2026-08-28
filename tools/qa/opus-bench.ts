/**
 * Lo que comparten los bancos de Opus: las señales de prueba y ffmpeg.
 *
 * Vive aparte porque hay dos bancos que necesitan exactamente lo mismo y
 * duplicarlo sería duplicar el experimento: `opus-quality.ts` mide Orbit contra
 * libopus, y `opus-spread-ab.ts` mide Orbit contra sí mismo con una decisión
 * cambiada. Si las señales no fueran LAS MISMAS, los dos números no se podrían
 * poner uno al lado del otro.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SR = 48000;

/** Encuentra ffmpeg: en el PATH o donde lo deja winget en Windows. */
export function findFfmpeg(): string {
  const candidates = [
    'ffmpeg',
    join(
      process.env['LOCALAPPDATA'] ?? '',
      'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0-full_build/bin/ffmpeg.exe',
    ),
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // siguiente
    }
  }
  throw new Error('no se encontró ffmpeg; sin él esta medida no vale nada');
}

/** PRNG determinista: dos pasadas del banco tienen que dar el mismo número. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}

export interface Senal {
  nombre: string;
  /** Qué pone a prueba (sale en el informe: un número sin motivo no dice nada). */
  porque: string;
  hacer(channels: number, seconds: number): Float64Array;
}

/** Entrelaza un generador mono en N canales, con el derecho algo distinto. */
function estereo(mono: Float64Array, channels: number): Float64Array {
  if (channels === 1) return mono;
  const out = new Float64Array(mono.length * channels);
  for (let i = 0; i < mono.length; i++) {
    out[i * channels] = mono[i]!;
    // El derecho retrasado y algo más bajo: dos canales idénticos no ponen a
    // prueba nada del estéreo (mid/side lo resuelve con el lado a cero).
    out[i * channels + 1] = (mono[Math.max(0, i - 13)] ?? 0) * 0.8;
  }
  return out;
}

export const SENALES: Senal[] = [
  {
    nombre: 'acorde',
    porque: 'tonal puro: mide la resolución de frecuencia',
    hacer(channels, seconds) {
      const n = Math.floor(SR * seconds);
      const mono = new Float64Array(n);
      const parciales = [220, 277.18, 329.63, 440, 554.37];
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
        let v = 0;
        for (let k = 0; k < parciales.length; k++) {
          v += Math.sin(2 * Math.PI * parciales[k]! * t) * (0.3 / (k + 1));
        }
        mono[i] = v * env;
      }
      return estereo(mono, channels);
    },
  },
  {
    nombre: 'percusion',
    porque: 'transitorios secos: es donde duele no detectarlos',
    hacer(channels, seconds) {
      const n = Math.floor(SR * seconds);
      const mono = new Float64Array(n);
      const r = rng(7);
      // Golpes cada 125 ms: ataque instantáneo y caída rápida, que es
      // exactamente lo que un bloque largo de MDCT emborrona hacia atrás.
      for (let golpe = 0; golpe * 0.125 < seconds; golpe++) {
        const inicio = Math.floor(golpe * 0.125 * SR);
        const grave = golpe % 2 === 0;
        for (let i = 0; i < Math.floor(0.09 * SR) && inicio + i < n; i++) {
          const t = i / SR;
          const env = Math.exp(-t / (grave ? 0.05 : 0.012));
          const cuerpo = grave
            ? Math.sin(2 * Math.PI * 62 * t) * 0.8
            : r() * 0.55 + Math.sin(2 * Math.PI * 190 * t) * 0.2;
          mono[inicio + i] = (mono[inicio + i] ?? 0) + cuerpo * env;
        }
      }
      return estereo(mono, channels);
    },
  },
  {
    nombre: 'ruido-rosa',
    porque: 'sin tono al que agarrarse: mide el reparto entre bandas',
    hacer(channels, seconds) {
      const n = Math.floor(SR * seconds);
      const mono = new Float64Array(n);
      const r = rng(99);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < n; i++) {
        const w = r();
        // Filtro de Voss-McCartney abreviado: espectro con pendiente -3 dB/oct.
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        mono[i] = (b0 + b1 + b2 + w * 0.1848) * 0.16;
      }
      return estereo(mono, channels);
    },
  },
  {
    nombre: 'mezcla',
    porque: 'lo que de verdad se exporta: tono, golpes y aire a la vez',
    hacer(channels, seconds) {
      const n = Math.floor(SR * seconds);
      const acorde = SENALES[0]!.hacer(1, seconds);
      const perc = SENALES[1]!.hacer(1, seconds);
      const ruido = SENALES[2]!.hacer(1, seconds);
      const mono = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        mono[i] = (acorde[i] ?? 0) * 0.6 + (perc[i] ?? 0) * 0.5 + (ruido[i] ?? 0) * 0.25;
      }
      return estereo(mono, channels);
    },
  },
];

/** El canal izquierdo de un buffer entrelazado. */
export function izquierdo(pcm: Float64Array, channels: number): Float64Array {
  const out = new Float64Array(Math.floor(pcm.length / channels));
  for (let i = 0; i < out.length; i++) out[i] = pcm[i * channels]!;
  return out;
}

/** Decodifica a f32 con ffmpeg y devuelve el canal izquierdo. */
export function decodificar(
  ffmpeg: string,
  dir: string,
  path: string,
  channels: number,
  etiqueta: string,
): Float64Array {
  const raw = join(dir, `${etiqueta}.f32`);
  execFileSync(ffmpeg, ['-y', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', raw], {
    stdio: 'pipe',
  });
  const bytes = readFileSync(raw);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  const out = new Float64Array(Math.floor(floats.length / channels));
  for (let i = 0; i < out.length; i++) out[i] = floats[i * channels]!;
  return out;
}

/** Codifica con libopus (el listón) al mismo bitrate. */
export function conLibopus(
  ffmpeg: string,
  dir: string,
  pcm: Float64Array,
  channels: number,
  bitrate: number,
  etiqueta: string,
): string {
  const crudo = join(dir, `${etiqueta}.in.f32`);
  const salida = join(dir, `${etiqueta}.libopus.opus`);
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i]!;
  writeFileSync(crudo, Buffer.from(f32.buffer));
  execFileSync(
    ffmpeg,
    ['-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(channels), '-i', crudo,
      '-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'off', '-application', 'audio', salida],
    { stdio: 'pipe' },
  );
  return salida;
}

/** Los casos del banco: canales y bitrate. */
export const CASOS: { channels: number; bitrate: number }[] = [
  { channels: 1, bitrate: 32000 },
  { channels: 1, bitrate: 64000 },
  { channels: 2, bitrate: 64000 },
  { channels: 2, bitrate: 96000 },
  { channels: 2, bitrate: 128000 },
];

export const DURACION = 1.5;
/** Retardo de búsqueda: libopus mete ~6,5 ms y el contenedor su pre-skip. */
export const MAX_LAG = 1600;

export function nombreCaso(channels: number, bitrate: number): string {
  return `${channels === 1 ? 'mono' : 'estéreo'} ${bitrate / 1000}k`;
}

export const media = (xs: number[]): number =>
  xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
