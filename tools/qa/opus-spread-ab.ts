/**
 * La dispersión, medida: el encoder contra sí mismo con la decisión cambiada.
 *
 *   npx tsx tools/qa/opus-spread-ab.ts
 *
 * `opus-quality.ts` compara Orbit con libopus. Éste compara Orbit con Orbit, y
 * existe por una razón concreta: **validar la medida perceptual antes de usarla
 * para decidir nada**.
 *
 * Se codifica la misma señal tres veces, cambiando UN símbolo del formato:
 *
 * - `none`    — sin rotación de dispersión. El PVQ deja los pulsos donde caen,
 *               así que una banda de ruido se reconstruye como cuatro silbidos.
 * - `normal`  — la constante de siempre, la que lleva el encoder desde que
 *               existe.
 * - `adaptive`— decidida por trama según la planitud de cada banda
 *               (`spreadingDecision`, portado de la referencia).
 *
 * La rotación de dispersión es **ortogonal**: conserva la norma, así que la
 * energía del error apenas cambia. Por eso `none` contra `normal` es el caso de
 * control perfecto: sabemos que suena distinto (por algo está en el formato) y
 * sabemos que la SNR no puede verlo. Si la medida de patrón tampoco lo ve, la
 * medida no sirve y no hay que creerse nada de lo que diga después.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fft } from '../../packages/engine/src/dsp/fft';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';
import type { SpreadMode } from '../../packages/engine/src/render/opus/spread';
import {
  CASOS,
  DURACION,
  MAX_LAG,
  SENALES,
  decodificar,
  findFfmpeg,
  izquierdo,
  media,
  nombreCaso,
} from './opus-bench';
import { alinear, patronDb, snrDb } from './opus-metrics';

const MODOS: SpreadMode[] = ['none', 'normal', 'adaptive'];

const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-ab-'));

interface Fila {
  senal: string;
  caso: string;
  snr: Record<string, number>;
  patron: Record<string, number>;
}

const filas: Fila[] = [];

// ── El mecanismo, medido aparte de la nota ──────────────────────────────────
//
// La planitud espectral (media geométrica partido media aritmética de las
// potencias de los bins) vale 1 para ruido y tiende a 0 para un tono. Sobre las
// bandas altas de una señal de ruido enseña, sin intermediarios, lo que hace la
// dispersión: si la reconstrucción sale mucho menos plana que el original, es
// que la banda de aire ha vuelto convertida en silbidos.
const NF = 2048;
const fftPlanitud = new Fft(NF);
const ventana = new Float64Array(NF);
for (let n = 0; n < NF; n++) ventana[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (NF - 1)));
/** Bordes de las bandas de CELT, en bins de 200 Hz. */
const EBANDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 34, 40, 48, 60, 78, 100];

function planitudPorBanda(x: Float64Array, desde: number, tramas: number): Float64Array {
  const re = new Float32Array(NF);
  const im = new Float32Array(NF);
  const df = 48000 / NF;
  const out = new Float64Array(EBANDS.length - 1);
  for (let t = 0; t < tramas; t++) {
    const off = desde + t * 1024;
    for (let n = 0; n < NF; n++) {
      re[n] = (x[off + n] ?? 0) * ventana[n]!;
      im[n] = 0;
    }
    fftPlanitud.forward(re, im);
    for (let b = 0; b < out.length; b++) {
      const k0 = Math.max(1, Math.round((EBANDS[b]! * 200) / df));
      const k1 = Math.min(NF / 2, Math.round((EBANDS[b + 1]! * 200) / df));
      if (k1 - k0 < 8) continue;
      let logs = 0;
      let suma = 0;
      for (let k = k0; k < k1; k++) {
        const v = re[k]! * re[k]! + im[k]! * im[k]! + 1e-30;
        logs += Math.log(v);
        suma += v;
      }
      out[b] = out[b]! + Math.exp(logs / (k1 - k0)) / (suma / (k1 - k0)) / tramas;
    }
  }
  return out;
}

try {
  for (const senal of SENALES) {
    console.log(`\n· ${senal.nombre} — ${senal.porque}`);
    console.log(
      `  ${''.padEnd(12)}  ${'SNR (dB)'.padStart(26)}   ${'patrón (dB)'.padStart(26)}`,
    );
    console.log(
      `  ${'caso'.padEnd(12)}  ` +
      MODOS.map((m) => m.padStart(8)).join(' ') +
      '   ' +
      MODOS.map((m) => m.padStart(8)).join(' '),
    );
    for (const { channels, bitrate } of CASOS) {
      const caso = nombreCaso(channels, bitrate);
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const fila: Fila = { senal: senal.nombre, caso, snr: {}, patron: {} };

      for (const modo of MODOS) {
        const etiqueta = `${senal.nombre}-${channels}-${bitrate}-${modo}`;
        const path = join(dir, `${etiqueta}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, spread: modo }),
        );
        const salida = decodificar(ffmpeg, dir, path, channels, etiqueta);
        fila.snr[modo] = snrDb(original, salida, MAX_LAG);
        fila.patron[modo] = patronDb(original, salida, 48000, MAX_LAG);
      }
      filas.push(fila);
      console.log(
        `  ${caso.padEnd(12)}  ` +
        MODOS.map((m) => fila.snr[m]!.toFixed(2).padStart(8)).join(' ') +
        '   ' +
        MODOS.map((m) => fila.patron[m]!.toFixed(2).padStart(8)).join(' '),
      );
    }
  }
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function resumen(campo: 'snr' | 'patron'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MODOS) out[m] = media(filas.map((f) => f[campo][m]!));
  return out;
}

const snr = resumen('snr');
const patron = resumen('patron');
const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

console.log('\n── Resumen (media de las 20 combinaciones) ──');
for (const m of MODOS) {
  console.log(`  ${m.padEnd(9)} SNR ${snr[m]!.toFixed(2).padStart(6)} dB   patrón ${patron[m]!.toFixed(2).padStart(6)} dB`);
}

console.log('\n── Lo que hay que leer ──');
console.log(
  `  control  (normal − none)      SNR ${signo(snr['normal']! - snr['none']!).padStart(6)} dB` +
  `   patrón ${signo(patron['normal']! - patron['none']!).padStart(6)} dB`,
);
console.log(
  `  decisión (adaptive − normal)  SNR ${signo(snr['adaptive']! - snr['normal']!).padStart(6)} dB` +
  `   patrón ${signo(patron['adaptive']! - patron['normal']!).padStart(6)} dB`,
);

// El peor caso importa tanto como la media: una decisión que gana de media y
// hunde una señal concreta no entra.
const peorPatron = Math.min(...filas.map((f) => f.patron['adaptive']! - f.patron['normal']!));
const peorSnr = Math.min(...filas.map((f) => f.snr['adaptive']! - f.snr['normal']!));
console.log(
  `  la peor de las 20 (adaptive − normal)  SNR ${signo(peorSnr).padStart(6)} dB` +
  `   patrón ${signo(peorPatron).padStart(6)} dB`,
);
console.log(
  '\n  El control es lo que valida la medida: `none` contra `normal` es el mismo\n' +
  '  error repartido de otra forma, así que la SNR no puede separarlos y la de\n' +
  '  patrón sí tiene que hacerlo. Si el control sale en cero por los dos lados,\n' +
  '  la medida perceptual no está midiendo lo que dice.\n',
);

// ── Y el mecanismo, para no tener que creerse la nota ───────────────────────
//
// La nota dice CUÁNTO cambia; esto dice QUÉ cambia, y sin modelo de oído por
// medio. Si la copia sale bastante menos plana que el original en las bandas de
// arriba, es que el aire ha vuelto convertido en silbidos.
const dirP = mkdtempSync(join(tmpdir(), 'orbit-opus-plan-'));
try {
  const senal = SENALES[2]!; // ruido rosa: todo el espectro y nada tonal
  const channels = 2;
  const bitrate = 64000;
  const pcm = senal.hacer(channels, DURACION);
  const original = izquierdo(pcm, channels);
  const plan: Record<string, Float64Array> = {
    original: planitudPorBanda(original, 24000, 20),
  };
  for (const modo of MODOS) {
    const et = `plan-${modo}`;
    const path = join(dirP, `${et}.opus`);
    writeFileSync(path, encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, spread: modo }));
    const salida = decodificar(ffmpeg, dirP, path, channels, et);
    const { lag, ganancia } = alinear(original, salida, MAX_LAG);
    const n = Math.min(original.length, salida.length - lag);
    const al = new Float64Array(n);
    for (let i = 0; i < n; i++) al[i] = ganancia * salida[i + lag]!;
    plan[modo] = planitudPorBanda(al, 24000, 20);
  }
  console.log(`── Planitud espectral por banda (${senal.nombre}, estéreo ${bitrate / 1000}k) ──`);
  console.log('  1 = ruido, 0 = un tono. Si la copia sale menos plana, hay silbidos.');
  console.log(`  banda        Hz      original${MODOS.map((m) => m.padStart(9)).join('')}`);
  for (let b = 13; b < EBANDS.length - 1; b++) {
    const f0 = EBANDS[b]! * 200;
    const f1 = EBANDS[b + 1]! * 200;
    console.log(
      `  ${String(b).padStart(5)}  ${String(f0).padStart(5)}-${String(f1).padEnd(6)} ` +
      plan['original']![b]!.toFixed(4).padStart(8) +
      MODOS.map((m) => plan[m]![b]!.toFixed(4).padStart(9)).join(''),
    );
  }
  console.log('');
} finally {
  if (existsSync(dirP)) rmSync(dirP, { recursive: true, force: true });
}
