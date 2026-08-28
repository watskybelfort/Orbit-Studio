/**
 * El pre-eco, medido: el encoder contra sí mismo con y sin sub-tramas cortas.
 *
 *   npx tsx tools/qa/opus-transient-ab.ts
 *
 * `opus-quality.ts` compara Orbit con libopus y `opus-spread-ab.ts` compara
 * Orbit consigo mismo cambiando la dispersión. Éste hace lo segundo con la otra
 * decisión: los transitorios. Se codifica la misma señal cambiando UN símbolo
 * del formato y se mira qué pasa.
 *
 * - `off`      — bloques largos siempre y `tf_res` a cero. Es exactamente lo que
 *                hacía el encoder antes de esta tarea: la referencia del A/B.
 * - `tf`       — sin sub-tramas cortas, pero con la resolución tiempo/frecuencia
 *                decidida por banda. Separa cuánto aporta cada mitad, porque son
 *                dos mecanismos distintos que suelen contarse como uno.
 * - `adaptive` — las dos cosas: detector de ataque por trama y resolución por
 *                banda. Es lo que se exporta.
 * - `force`    — sub-tramas cortas SIEMPRE. No es una opción sensata para
 *                exportar; está para poner a prueba el camino de bloque corto
 *                contra ffmpeg sin depender de que el detector se dispare.
 *
 * ## Por qué hay una señal que no está en `opus-bench.ts`
 *
 * Las notas de calidad (SNR y patrón) son promedios sobre la señal entera, y el
 * pre-eco es un fenómeno **local**: unos milisegundos antes de cada golpe. En
 * una señal con contenido continuo queda diluido entre miles de tramas que no
 * tienen nada que ver.
 *
 * Por eso aquí hay un **click aislado en silencio digital**. Ahí el pre-eco no
 * hay que inferirlo de ningún modelo de oído: se lee directamente como la
 * energía que aparece ANTES del golpe, en un tramo donde el original tiene
 * CERO. Cualquier cosa que salga ahí la puso el códec.
 *
 * Los ocho golpes caen a propósito en desplazamientos distintos dentro de su
 * trama (0, 120, 240 … 840 muestras). Un golpe justo en el borde de la trama
 * casi no produce pre-eco —la MDCT larga lo pilla al principio— y mediría de
 * más; el caso malo es el golpe en mitad de la trama, y así están los dos.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';
import {
  transientAnalysis,
  type TransientMode,
} from '../../packages/engine/src/render/opus/transient';
import { OVERLAP, PREEMPH, SIG_SCALE } from '../../packages/engine/src/render/opus/celt-encoder';
import {
  CASOS,
  DURACION,
  MAX_LAG,
  SENALES,
  SR,
  conLibopus,
  decodificar,
  findFfmpeg,
  izquierdo,
  media,
  nombreCaso,
  rng,
} from './opus-bench';
import { alinear, patronDb, snrDb } from './opus-metrics';

const MODOS: TransientMode[] = ['off', 'tf', 'adaptive'];

const ffmpeg = findFfmpeg();

// ── La señal del click ──────────────────────────────────────────────────────

/** Dónde empieza cada golpe, en muestras. */
const GOLPES: number[] = [];
for (let k = 0; k < 8; k++) {
  // Cada 150 ms, y con un desplazamiento distinto dentro de la trama de 960:
  // el golpe pegado al borde es el caso fácil y el de en medio el difícil.
  GOLPES.push(Math.round(0.15 * SR) * (k + 1) + k * 120);
}

/**
 * Clicks secos sobre silencio digital.
 *
 * El golpe es ruido con caída de 1,5 ms: ataque instantáneo y ancho de banda
 * completo, que es lo que peor lleva una MDCT de 20 ms. Entre golpe y golpe hay
 * ceros exactos, y eso es lo que hace medible el pre-eco.
 */
function click(channels: number, seconds: number): Float64Array {
  const n = Math.floor(SR * seconds);
  const mono = new Float64Array(n);
  const r = rng(31337);
  for (const inicio of GOLPES) {
    for (let i = 0; i < Math.floor(0.02 * SR) && inicio + i < n; i++) {
      const t = i / SR;
      mono[inicio + i] = r() * 0.9 * Math.exp(-t / 0.0015);
    }
  }
  if (channels === 1) return mono;
  const out = new Float64Array(n * channels);
  for (let i = 0; i < n; i++) {
    out[i * channels] = mono[i]!;
    out[i * channels + 1] = mono[i]! * 0.8;
  }
  return out;
}

/**
 * Cuánta energía aparece ANTES del golpe, respecto al golpe.
 *
 * Se mide en la ventana de 20 ms (una trama entera) que precede a cada ataque,
 * dejando fuera el último milisegundo —ahí ya empieza la subida de la ventana
 * de la MDCT y no es pre-eco, es el golpe— y se compara con los primeros 5 ms
 * del golpe. Cuanto MÁS NEGATIVO, mejor: es cuánto por debajo del golpe queda
 * la basura que lo precede.
 */
function preEcoDb(x: Float64Array, lag: number, ganancia: number): number {
  const antesDesde = Math.round(0.02 * SR);
  const antesHasta = Math.round(0.001 * SR);
  const golpeHasta = Math.round(0.005 * SR);
  let antes = 0;
  let nAntes = 0;
  let golpe = 0;
  let nGolpe = 0;
  for (const inicio of GOLPES) {
    for (let i = inicio - antesDesde; i < inicio - antesHasta; i++) {
      const v = ganancia * (x[i + lag] ?? 0);
      antes += v * v;
      nAntes++;
    }
    for (let i = inicio; i < inicio + golpeHasta; i++) {
      const v = ganancia * (x[i + lag] ?? 0);
      golpe += v * v;
      nGolpe++;
    }
  }
  if (nAntes === 0 || nGolpe === 0 || golpe <= 0) return NaN;
  return 10 * Math.log10(antes / nAntes / (golpe / nGolpe) + 1e-30);
}

/**
 * Cuántas tramas dispara el detector, sin pasar por el encoder.
 *
 * Se reproduce aquí el mismo troceado y el mismo pre-énfasis que hace
 * `celtEncodeFrame` —son cuatro líneas— para poder contar sin tener que sacar
 * un contador por la API del encoder, que no pinta nada en producción.
 */
function tramasTransitorias(
  pcm: Float64Array,
  channels: number,
  frameSize: number,
): { total: number; golpes: number } {
  const total = Math.floor(pcm.length / channels);
  const historia = new Float64Array(OVERLAP * channels);
  const mem = new Float64Array(channels);
  const analisis = new Float64Array((frameSize + OVERLAP) * channels);
  let tramas = 0;
  let golpes = 0;
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
      historia.set(analisis.subarray(base + frameSize, base + frameSize + OVERLAP), c * OVERLAP);
    }
    tramas++;
    if (transientAnalysis(analisis, frameSize + OVERLAP, channels).isTransient) golpes++;
  }
  return { total: tramas, golpes };
}

// ── 1. El pre-eco del click ─────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-tr-'));
try {
  console.log('\n══ 1. Un click aislado en silencio: el pre-eco leído directo ══');
  console.log('   Energía media en los 20 ms ANTERIORES a cada golpe, respecto al');
  console.log('   golpe. Más negativo = menos basura antes del ataque.\n');
  console.log(
    `   ${'caso'.padEnd(13)}` +
    MODOS.map((m) => m.padStart(9)).join('') +
    'libopus'.padStart(10) +
    'original'.padStart(11),
  );

  const preEco: Record<string, number[]> = { libopus: [] };
  for (const m of MODOS) preEco[m] = [];

  for (const { channels, bitrate } of CASOS) {
    const pcm = click(channels, DURACION);
    const original = izquierdo(pcm, channels);
    const fila: Record<string, number> = {};
    for (const modo of MODOS) {
      const et = `click-${channels}-${bitrate}-${modo}`;
      const path = join(dir, `${et}.opus`);
      writeFileSync(
        path,
        encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, transient: modo }),
      );
      const salida = decodificar(ffmpeg, dir, path, channels, et);
      const { lag, ganancia } = alinear(original, salida, MAX_LAG);
      fila[modo] = preEcoDb(salida, lag, ganancia);
      preEco[modo]!.push(fila[modo]!);
    }
    const lib = decodificar(
      ffmpeg,
      dir,
      conLibopus(ffmpeg, dir, pcm, channels, bitrate, `click-${channels}-${bitrate}`),
      channels,
      `click-${channels}-${bitrate}-lib`,
    );
    const al = alinear(original, lib, MAX_LAG);
    fila['libopus'] = preEcoDb(lib, al.lag, al.ganancia);
    preEco['libopus']!.push(fila['libopus']!);
    const orig = preEcoDb(original, 0, 1);

    console.log(
      `   ${nombreCaso(channels, bitrate).padEnd(13)}` +
      MODOS.map((m) => fila[m]!.toFixed(1).padStart(9)).join('') +
      fila['libopus']!.toFixed(1).padStart(10) +
      orig.toFixed(1).padStart(11),
    );
  }

  console.log(
    `\n   media        ` +
    MODOS.map((m) => media(preEco[m]!).toFixed(1).padStart(9)).join('') +
    media(preEco['libopus']!).toFixed(1).padStart(10),
  );
  const ganado = media(preEco['adaptive']!) - media(preEco['off']!);
  console.log(
    `   adaptive − off = ${ganado.toFixed(1)} dB de pre-eco ` +
    `(negativo = hay menos)\n`,
  );

  // ── 2. Cuántas tramas se detectan ─────────────────────────────────────────
  console.log('══ 2. Cuántas tramas dispara el detector ══');
  console.log('   Si dispara en todo, no es un detector: es un interruptor.\n');
  const conClick = [...SENALES, { nombre: 'click', porque: 'el caso extremo', hacer: click }];
  for (const senal of conClick) {
    const linea: string[] = [];
    for (const channels of [1, 2]) {
      const { total, golpes } = tramasTransitorias(senal.hacer(channels, DURACION), channels, 960);
      linea.push(`${channels === 1 ? 'mono' : 'est.'} ${golpes}/${total}`);
    }
    console.log(`   ${senal.nombre.padEnd(12)} ${linea.join('   ')}`);
  }

  // ── 3. El A/B sobre el banco ──────────────────────────────────────────────
  console.log('\n══ 3. A/B sobre las señales del banco ══');
  interface Fila {
    senal: string;
    caso: string;
    snr: Record<string, number>;
    patron: Record<string, number>;
  }
  const filas: Fila[] = [];
  for (const senal of SENALES) {
    console.log(`\n · ${senal.nombre} — ${senal.porque}`);
    console.log(
      `   ${'caso'.padEnd(13)}${'SNR (dB)'.padStart(27)}   ${'patrón (dB)'.padStart(27)}`,
    );
    console.log(
      `   ${''.padEnd(13)}` +
      MODOS.map((m) => m.padStart(9)).join('') +
      '   ' +
      MODOS.map((m) => m.padStart(9)).join(''),
    );
    for (const { channels, bitrate } of CASOS) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const fila: Fila = { senal: senal.nombre, caso: nombreCaso(channels, bitrate), snr: {}, patron: {} };
      for (const modo of MODOS) {
        const et = `${senal.nombre}-${channels}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, transient: modo }),
        );
        const salida = decodificar(ffmpeg, dir, path, channels, et);
        fila.snr[modo] = snrDb(original, salida, MAX_LAG);
        fila.patron[modo] = patronDb(original, salida, 48000, MAX_LAG);
      }
      filas.push(fila);
      console.log(
        `   ${fila.caso.padEnd(13)}` +
        MODOS.map((m) => fila.snr[m]!.toFixed(2).padStart(9)).join('') +
        '   ' +
        MODOS.map((m) => fila.patron[m]!.toFixed(2).padStart(9)).join(''),
      );
    }
  }

  const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  console.log('\n── Resumen (media de las 20 combinaciones) ──');
  for (const m of MODOS) {
    console.log(
      `   ${m.padEnd(9)} SNR ${media(filas.map((f) => f.snr[m]!)).toFixed(2).padStart(6)} dB` +
      `   patrón ${media(filas.map((f) => f.patron[m]!)).toFixed(2).padStart(6)} dB`,
    );
  }
  for (const [a, b] of [['tf', 'off'], ['adaptive', 'off'], ['adaptive', 'tf']] as const) {
    const dSnr = media(filas.map((f) => f.snr[a]! - f.snr[b]!));
    const dPat = media(filas.map((f) => f.patron[a]! - f.patron[b]!));
    const peor = Math.min(...filas.map((f) => f.patron[a]! - f.patron[b]!));
    console.log(
      `   ${`${a} − ${b}`.padEnd(20)} SNR ${signo(dSnr).padStart(7)} dB` +
      `   patrón ${signo(dPat).padStart(7)} dB   la peor de las 20 ${signo(peor)} dB`,
    );
  }

  // ── 4. El camino de bloque corto, contra ffmpeg ───────────────────────────
  //
  // La pregunta que ninguna nota de calidad contesta: ¿el intercalado de las
  // sub-tramas y el reparto de bits que lleva detrás son los que espera un
  // decodificador de verdad? Con `force` van cortas TODAS las tramas, así que
  // si la correlación y la ganancia salen bien, el camino es correcto — y si
  // estuviera mal, saldría ruido sin dar ningún error.
  console.log('\n══ 4. El camino de bloque corto contra ffmpeg (transient=force) ══');
  console.log('   Todas las tramas cortas. Correlación y ganancia contra el original.\n');
  let malos = 0;
  for (const { channels, bitrate } of CASOS) {
    for (const senal of SENALES) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const et = `force-${senal.nombre}-${channels}-${bitrate}`;
      const path = join(dir, `${et}.opus`);
      writeFileSync(
        path,
        encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, transient: 'force' }),
      );
      const salida = decodificar(ffmpeg, dir, path, channels, et);
      const { correlacion, ganancia, lag } = alinear(original, salida, MAX_LAG);
      // El listón es bajo A PROPÓSITO. Aquí no se mide calidad —forzar bloques
      // cortos en ruido rosa a 32k es la peor idea posible y baja la
      // correlación de verdad—, se mide si el paquete está BIEN ESCRITO. Y un
      // paquete descolocado no da 0,88: da 0,0 y ruido, porque a partir del
      // símbolo que sobra o falta los dos lados leen cosas distintas.
      const ok = correlacion > 0.8 && ganancia > 0.7 && ganancia < 1.3;
      if (!ok) malos++;
      console.log(
        `   ${ok ? 'ok  ' : 'FALLA'} ${senal.nombre.padEnd(11)} ${nombreCaso(channels, bitrate).padEnd(13)}` +
        ` correlación=${correlacion.toFixed(4)}  ganancia=${ganancia.toFixed(3)}  retardo=${lag}`,
      );
    }
  }
  console.log(
    malos === 0
      ? '\n   El camino de bloque corto es correcto: ffmpeg lo reconstruye entero.\n'
      : `\n   ${malos} caso(s) mal: el bloque corto NO está bien escrito.\n`,
  );
  if (malos > 0) process.exitCode = 1;
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
