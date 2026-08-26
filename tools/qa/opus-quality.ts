/**
 * Cuánto se pierde por bit: el encoder de Orbit contra libopus, señal a señal.
 *
 *   npx tsx tools/qa/opus-quality.ts
 *
 * `opus-verify.ts` responde a la pregunta binaria —¿lo abre alguien que no
 * seamos nosotros?— y esa ya está contestada. Esta responde a la otra: **¿cómo
 * de bien lo hace?**, que es la que hay que poder contestar antes de tocar una
 * sola decisión del codificador. Afinar sin medir es cambiar cosas.
 *
 * El método es el mismo por los dos lados, y eso es lo que lo hace justo: la
 * MISMA señal se codifica con Orbit y con libopus al MISMO bitrate, las dos se
 * decodifican con ffmpeg, y las dos se comparan con el original alineando el
 * retardo y la ganancia óptima. Lo que sale es relación señal/ruido en dB y la
 * distancia a libopus.
 *
 * **La SNR es un apaño y conviene saberlo.** Opus es un códec perceptual: tira
 * bits donde el oído no llega, así que un archivo con menos SNR puede sonar
 * mejor. Sirve igualmente para lo que se usa aquí —comparar dos versiones del
 * MISMO encoder, con el mismo modelo, cambiando una decisión— y para saber si
 * la distancia a libopus se acorta o se ensancha. Lo que NO se puede hacer es
 * leer un número suelto y llamarlo calidad.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';

const SR = 48000;

function findFfmpeg(): string {
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
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}

interface Senal {
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

const SENALES: Senal[] = [
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

const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-q-'));

/** Decodifica a f32 con ffmpeg y devuelve el canal izquierdo. */
function decodificar(path: string, channels: number, etiqueta: string): Float64Array {
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
function conLibopus(pcm: Float64Array, channels: number, bitrate: number, etiqueta: string): string {
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

/**
 * Relación señal/ruido en dB, alineando retardo y ganancia óptima.
 *
 * La ganancia se ajusta a propósito: un códec puede salir un pelo más alto o
 * más bajo y eso no es ruido, es un factor de escala. Sin quitarlo, la medida
 * castigaría algo que no se oye.
 */
function snrDb(original: Float64Array, decodificado: Float64Array, maxLag: number): number {
  let mejor = -Infinity;
  const n = Math.min(original.length, decodificado.length) - maxLag;
  if (n <= 0) return NaN;
  for (let lag = 0; lag <= maxLag; lag++) {
    let ab = 0;
    let bb = 0;
    for (let i = 0; i < n; i++) {
      const b = decodificado[i + lag]!;
      ab += original[i]! * b;
      bb += b * b;
    }
    if (bb <= 0) continue;
    const g = ab / bb;
    let senal = 0;
    let error = 0;
    for (let i = 0; i < n; i++) {
      const a = original[i]!;
      const d = a - g * decodificado[i + lag]!;
      senal += a * a;
      error += d * d;
    }
    const db = 10 * Math.log10(senal / (error + 1e-30));
    if (db > mejor) mejor = db;
  }
  return mejor;
}

const CASOS: { channels: number; bitrate: number }[] = [
  { channels: 1, bitrate: 32000 },
  { channels: 1, bitrate: 64000 },
  { channels: 2, bitrate: 64000 },
  { channels: 2, bitrate: 96000 },
  { channels: 2, bitrate: 128000 },
];

const DURACION = 1.5;
/** Retardo de búsqueda: libopus mete ~6,5 ms y el contenedor su pre-skip. */
const MAX_LAG = 1600;

interface Fila {
  senal: string;
  caso: string;
  orbit: number;
  libopus: number;
}

const filas: Fila[] = [];

try {
  for (const senal of SENALES) {
    console.log(`\n· ${senal.nombre} — ${senal.porque}`);
    for (const { channels, bitrate } of CASOS) {
      const caso = `${channels === 1 ? 'mono' : 'estéreo'} ${bitrate / 1000}k`;
      const pcm = senal.hacer(channels, DURACION);
      const etiqueta = `${senal.nombre}-${channels}-${bitrate}`;

      const nuestro = join(dir, `${etiqueta}.orbit.opus`);
      writeFileSync(nuestro, encodeOpusFile(pcm, { channels, bitrate, frameSize: 960 }));

      const original = new Float64Array(Math.floor(pcm.length / channels));
      for (let i = 0; i < original.length; i++) original[i] = pcm[i * channels]!;

      const a = snrDb(original, decodificar(nuestro, channels, `${etiqueta}-o`), MAX_LAG);
      const b = snrDb(
        original,
        decodificar(conLibopus(pcm, channels, bitrate, etiqueta), channels, `${etiqueta}-l`),
        MAX_LAG,
      );
      filas.push({ senal: senal.nombre, caso, orbit: a, libopus: b });
      const brecha = a - b;
      console.log(
        `  ${caso.padEnd(12)} Orbit ${a.toFixed(2).padStart(6)} dB · ` +
        `libopus ${b.toFixed(2).padStart(6)} dB · ` +
        `${brecha >= 0 ? '+' : ''}${brecha.toFixed(2)} dB`,
      );
    }
  }
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const media = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
const brechas = filas.map((f) => f.orbit - f.libopus);
console.log(`\n── Resumen ──`);
console.log(`  SNR media Orbit   ${media(filas.map((f) => f.orbit)).toFixed(2)} dB`);
console.log(`  SNR media libopus ${media(filas.map((f) => f.libopus)).toFixed(2)} dB`);
console.log(`  Distancia media   ${media(brechas).toFixed(2)} dB (negativo = por detrás)`);
console.log(`  La peor           ${Math.min(...brechas).toFixed(2)} dB`);
console.log(
  '\n  Recordatorio: la SNR es un apaño. Opus es perceptual y un archivo con\n' +
  '  menos SNR puede sonar mejor. Vale para comparar dos versiones del mismo\n' +
  '  encoder y para ver si la distancia se acorta, no como nota de calidad.\n',
);
