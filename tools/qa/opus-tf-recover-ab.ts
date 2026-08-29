/**
 * Recuperar el acorde: los pesos `importance[]` del Viterbi contra el apagado
 * por tonalidad, medidos en el banco entero.
 *
 *   npx tsx tools/qa/opus-tf-recover-ab.ts
 *
 * La v3.5 dejó el patrón medio en −0,26 dB pero con el acorde en estéreo
 * retrocediendo (peor caso −10,99 dB, acorde estéreo 128k). El diagnóstico —de
 * `opus-transient-ab.ts` y de la auditoría anterior— ya está hecho: el detector
 * de transitorios dispara falsos positivos en el 5–8 % de las tramas del acorde,
 * porque cinco parciales armónicos batiendo entre sí hacen fluctuar la energía
 * de 2,5 ms de verdad, cruzando el umbral fijo. Éste es el A/B que decide qué
 * hacer con eso, entre dos caminos:
 *
 * - `importancia` — pesa el desacuerdo de cada banda en el Viterbi de
 *   `tfAnalysis` por cuánto sobresale del suelo de ruido (`bandImportance`,
 *   puerto de `dynalloc_analysis` en `celt_encoder.c`). No toca el detector: dado
 *   un falso positivo, intenta que la resolución de frecuencia sobreviva de
 *   todos modos en las bandas con parciales aislados.
 * - `tonal`      — no deja que un disparo DÉBIL del detector cuente como
 *   transitorio si la trama tiene periodicidad fuerte (la ganancia que ya
 *   calcula el postfiltro). Ataca la causa: si nunca se marca como transitoria,
 *   no hace falta recuperar nada después.
 * - `ambas`      — las dos activas a la vez.
 *
 * `base` (las dos apagadas) es la v3.5 tal cual, la referencia del A/B.
 *
 * Lo que manda para decidir es `opus-quality.ts`: la peor cifra de patrón del
 * banco (hoy −10,99, acorde estéreo 128k) sin perder la media (hoy −0,26). Este
 * script mide eso mismo pero con las CUATRO variantes lado a lado, más el
 * detalle de cuántas tramas dispara el detector en el acorde con y sin el
 * apagado por tonalidad, que es la causa que hay que mover.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';
import type { TfWeightMode } from '../../packages/engine/src/render/opus/celt-encoder';
import { OVERLAP, PREEMPH, SIG_SCALE } from '../../packages/engine/src/render/opus/celt-encoder';
import { transientAnalysis, type TonalGate } from '../../packages/engine/src/render/opus/transient';
import {
  CASOS,
  DURACION,
  MAX_LAG,
  SENALES,
  conLibopus,
  decodificar,
  findFfmpeg,
  izquierdo,
  media,
  nombreCaso,
} from './opus-bench';
import { patronDb, snrDb } from './opus-metrics';

interface Variante {
  nombre: string;
  tfWeight: TfWeightMode;
  tonalGate: boolean;
}

const VARIANTES: Variante[] = [
  { nombre: 'base', tfWeight: 'plano', tonalGate: false },
  { nombre: 'importancia', tfWeight: 'importancia', tonalGate: false },
  { nombre: 'imp-larga', tfWeight: 'importancia-larga', tonalGate: false },
  { nombre: 'tonal', tfWeight: 'plano', tonalGate: true },
  { nombre: 'ambas', tfWeight: 'importancia-larga', tonalGate: true },
];

const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-tfrec-'));

const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

try {
  // ── 1. Cuántas tramas dispara el detector en el acorde ────────────────────
  //
  // Sin pasar por el encoder: se reproduce el mismo troceado, pre-énfasis y
  // postfiltro (aproximado con el gain1 real del encoder no hace falta aquí,
  // basta con ver si `tonal` baja el conteo de disparos en la señal que
  // interesa). Esto es la causa; la sección 2 es el efecto.
  console.log('\n══ 1. Disparos del detector en el acorde, con y sin el apagado por tonalidad ══');
  console.log('   (aproximado: aquí no se reproduce el postfiltro real, así que esto sólo');
  console.log('   sirve para ver el ORDEN del efecto, no el número exacto que ve el encoder.)\n');
  {
    const acorde = SENALES[0]!;
    for (const channels of [1, 2]) {
      const pcm = acorde.hacer(channels, DURACION);
      const total = Math.floor(pcm.length / channels);
      const frameSize = 960;
      const historia = new Float64Array(OVERLAP * channels);
      const mem = new Float64Array(channels);
      const analisis = new Float64Array((frameSize + OVERLAP) * channels);
      let tramas = 0;
      let golpesSinGate = 0;
      let golpesConGate = 0;
      for (let start = 0; start < total; start += frameSize) {
        for (let c = 0; c < channels; c++) {
          const base = c * (frameSize + OVERLAP);
          analisis.set(historia.subarray(c * OVERLAP, (c + 1) * OVERLAP), base);
          let m = mem[c]!;
          for (let i = 0; i < frameSize; i++) {
            const x = (pcm[(start + i) * channels + c] ?? 0) * SIG_SCALE;
            analisis[base + OVERLAP + i] = x + m;
            m = -PREEMPH * x;
          }
          mem[c] = m;
          historia.set(
            analisis.subarray(base + frameSize, base + frameSize + OVERLAP),
            c * OVERLAP,
          );
        }
        tramas++;
        if (transientAnalysis(analisis, frameSize + OVERLAP, channels).isTransient) golpesSinGate++;
        // Con el gate activo y una ganancia alta fija (0,5): el acorde es
        // justo el caso de periodicidad fuerte que el gate quiere cazar.
        const tonal: TonalGate = { gain1: 0.5, activo: true };
        if (transientAnalysis(analisis, frameSize + OVERLAP, channels, tonal).isTransient) {
          golpesConGate++;
        }
      }
      console.log(
        `   ${channels === 1 ? 'mono   ' : 'estéreo'}  sin gate ${golpesSinGate}/${tramas}` +
        `   con gate ${golpesConGate}/${tramas}`,
      );
    }
  }

  // ── 2. El A/B sobre el banco entero, contra libopus ───────────────────────
  console.log('\n══ 2. Las cuatro variantes contra libopus, banco entero ══\n');
  interface Fila {
    senal: string;
    caso: string;
    patron: Record<string, number>;
    snr: Record<string, number>;
    libopus: number;
  }
  const filas: Fila[] = [];

  for (const senal of SENALES) {
    console.log(` · ${senal.nombre} — ${senal.porque}`);
    console.log(
      `   ${'caso'.padEnd(13)}` +
      VARIANTES.map((v) => v.nombre.padStart(13)).join('') +
      'libopus'.padStart(10),
    );
    for (const { channels, bitrate } of CASOS) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const fila: Fila = {
        senal: senal.nombre,
        caso: nombreCaso(channels, bitrate),
        patron: {},
        snr: {},
        libopus: 0,
      };
      for (const v of VARIANTES) {
        const et = `${senal.nombre}-${channels}-${bitrate}-${v.nombre}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, {
            channels,
            bitrate,
            frameSize: 960,
            tfWeight: v.tfWeight,
            tonalGate: v.tonalGate,
          }),
        );
        const salida = decodificar(ffmpeg, dir, path, channels, et);
        fila.patron[v.nombre] = patronDb(original, salida, 48000, MAX_LAG);
        fila.snr[v.nombre] = snrDb(original, salida, MAX_LAG);
      }
      const lib = decodificar(
        ffmpeg,
        dir,
        conLibopus(ffmpeg, dir, pcm, channels, bitrate, `${senal.nombre}-${channels}-${bitrate}`),
        channels,
        `${senal.nombre}-${channels}-${bitrate}-lib`,
      );
      fila.libopus = patronDb(original, lib, 48000, MAX_LAG);
      filas.push(fila);
      console.log(
        `   ${fila.caso.padEnd(13)}` +
        VARIANTES.map((v) => fila.patron[v.nombre]!.toFixed(2).padStart(13)).join('') +
        fila.libopus.toFixed(2).padStart(10),
      );
    }
  }

  // ── 3. Resumen: distancia a libopus por variante, media y peor caso ───────
  console.log('\n── Resumen: distancia a libopus (patrón), por variante ──\n');
  for (const v of VARIANTES) {
    const d = filas.map((f) => f.patron[v.nombre]! - f.libopus);
    const peorIdx = d.indexOf(Math.min(...d));
    const peorFila = filas[peorIdx]!;
    console.log(
      `   ${v.nombre.padEnd(13)} media ${signo(media(d)).padStart(7)} dB` +
      `   peor ${signo(Math.min(...d)).padStart(7)} dB  (${peorFila.senal} ${peorFila.caso})`,
    );
  }

  console.log('\n── Resumen: sólo el acorde (la señal que retrocedió) ──\n');
  const acordeFilas = filas.filter((f) => f.senal === 'acorde');
  for (const v of VARIANTES) {
    const d = acordeFilas.map((f) => f.patron[v.nombre]! - f.libopus);
    console.log(
      `   ${v.nombre.padEnd(13)} media ${signo(media(d)).padStart(7)} dB   peor ${signo(Math.min(...d)).padStart(7)} dB`,
    );
  }

  console.log('\n── Resumen: sólo la percusión (lo que no se puede estropear) ──\n');
  const percFilas = filas.filter((f) => f.senal === 'percusion');
  for (const v of VARIANTES) {
    const d = percFilas.map((f) => f.patron[v.nombre]! - f.libopus);
    console.log(
      `   ${v.nombre.padEnd(13)} media ${signo(media(d)).padStart(7)} dB   peor ${signo(Math.min(...d)).padStart(7)} dB`,
    );
  }
  console.log('');
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
