/**
 * El estéreo del reparto, medido: intensidad y estéreo dual, cada uno por su
 * cuenta y los dos juntos.
 *
 *   npx tsx tools/qa/opus-stereo-ab.ts
 *
 * Es el cuarto A/B de este encoder, con el mismo método que `opus-spread-ab.ts`,
 * `opus-transient-ab.ts` y `opus-postfilter-ab.ts`: la misma señal, el mismo
 * bitrate, y una sola decisión cambiada.
 *
 * - `off`       — dos canales completos en todas las bandas. Es lo que hacía el
 *                 encoder antes de esta pieza: la referencia del A/B.
 * - `intensity` — por encima de un corte, una sola forma con su panorama.
 * - `dual`      — cada canal por su cuenta, sin girar a mid/side.
 * - `adaptive`  — lo que se exporta.
 *
 * ## Los dos canales, no sólo el izquierdo
 *
 * El banco de calidad mide el canal izquierdo, y para casi todo da igual. Para
 * ESTO no: la intensidad es literalmente un cambio en la relación entre los dos
 * canales, así que medir sólo uno vería el beneficio —los bits liberados— y la
 * mitad del coste. Aquí se miden los dos y se informa del peor.
 *
 * ## Y dos señales de control, porque el banco no tiene ninguna
 *
 * Las cuatro señales del banco hacen el canal derecho retrasando el izquierdo 13
 * muestras: en las bandas agudas eso son varios ciclos de desfase, o sea dos
 * canales que NO llevan lo mismo. Es un caso legítimo pero es uno solo, y las
 * dos decisiones de esta pieza viven justo en los extremos de ese eje. Así que
 * se añaden los dos extremos:
 *
 * - **pegados** — el mismo material en los dos canales con distinto nivel (una
 *   fuente centrada o paneada, que es la mitad de cualquier mezcla).
 * - **repartidos** — dos fuentes distintas, una en cada canal.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeOpusFile,
  encodeOpusPackets,
} from '../../packages/engine/src/render/opus/encoder';
import type { StereoMode } from '../../packages/engine/src/render/opus/stereo';
import { NB_BANDS } from '../../packages/engine/src/render/opus/tables';
import {
  CASOS,
  DURACION,
  MAX_LAG,
  SENALES,
  conLibopus,
  findFfmpeg,
  media,
  nombreCaso,
} from './opus-bench';
import { crearEstadoLector, leerCabeceraCelt } from './opus-celt-header';
import { alinear, patronDb, snrDb } from './opus-metrics';

const MODOS: StereoMode[] = ['off', 'intensity', 'dual', 'adaptive'];
const ESTEREO = CASOS.filter((c) => c.channels === 2);

const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-st-'));

const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const signo4 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}`;

/** Decodifica con ffmpeg y devuelve LOS DOS canales. */
function decodificarAmbos(path: string, etiqueta: string): Float64Array[] {
  const raw = join(dir, `${etiqueta}.f32`);
  execFileSync(ffmpeg, ['-y', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', raw], {
    stdio: 'pipe',
  });
  const bytes = readFileSync(raw);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  const n = Math.floor(floats.length / 2);
  const izq = new Float64Array(n);
  const der = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    izq[i] = floats[2 * i]!;
    der[i] = floats[2 * i + 1]!;
  }
  return [izq, der];
}

/** Los dos canales de un buffer entrelazado. */
function canales(pcm: Float64Array): Float64Array[] {
  const n = Math.floor(pcm.length / 2);
  const izq = new Float64Array(n);
  const der = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    izq[i] = pcm[2 * i]!;
    der[i] = pcm[2 * i + 1]!;
  }
  return [izq, der];
}

// ── Las señales de control ──────────────────────────────────────────────────

interface Control {
  nombre: string;
  porque: string;
  hacer(seconds: number): Float64Array;
}

function entrelazar(izq: Float64Array, der: Float64Array): Float64Array {
  const out = new Float64Array(izq.length * 2);
  for (let i = 0; i < izq.length; i++) {
    out[2 * i] = izq[i]!;
    out[2 * i + 1] = der[i] ?? 0;
  }
  return out;
}

const CONTROLES: Control[] = [
  {
    nombre: 'pegados',
    porque: 'una fuente paneada: la diferencia entre canales es sólo de nivel',
    hacer(seconds) {
      const mono = SENALES[3]!.hacer(1, seconds);
      const der = new Float64Array(mono.length);
      for (let i = 0; i < mono.length; i++) der[i] = mono[i]! * 0.75;
      return entrelazar(mono, der);
    },
  },
  {
    nombre: 'repartidos',
    porque: 'dos fuentes distintas, una en cada canal: el mid/side no ahorra nada',
    hacer(seconds) {
      return entrelazar(SENALES[1]!.hacer(1, seconds), SENALES[2]!.hacer(1, seconds));
    },
  },
];

// ── Lo que de verdad viaja en el paquete ────────────────────────────────────

interface Reparto {
  intensidad: number[];
  dual: number[];
  codedBands: number[];
  /** Tramas de silencio: no llevan reparto y no cuentan para nada de esto. */
  mudas: number;
}

/**
 * Recorre las tramas de una señal codificada y saca lo que el DECODIFICADOR lee
 * de cada una, no lo que el codificador creía haber puesto. Ver
 * `opus-celt-header.ts`.
 */
function repartoDe(pcm: Float64Array, bitrate: number, modo: StereoMode): Reparto {
  const lector = crearEstadoLector(2);
  const salida: Reparto = { intensidad: [], dual: [], codedBands: [], mudas: 0 };
  for (const p of encodeOpusPackets(pcm, { channels: 2, bitrate, frameSize: 960, stereo: modo })) {
    // El primer byte es el TOC de Opus; la trama CELT empieza detrás.
    const cab = leerCabeceraCelt(p.data.subarray(1), lector, 3, 2);
    // Una trama de silencio se acaba en la bandera: no lleva ni asignador ni
    // parámetros de estéreo. Contarla aquí sería contar un cero que nadie
    // escribió — y con el VBR, que le da el mínimo del formato, son unas
    // cuantas.
    if (cab.silencio) {
      salida.mudas++;
      continue;
    }
    salida.intensidad.push(cab.intensity);
    salida.dual.push(cab.dualStereo);
    salida.codedBands.push(cab.codedBands);
  }
  return salida;
}

interface Fila {
  senal: string;
  caso: string;
  /** Nota del peor de los dos canales, por modo. */
  patron: Record<string, number>;
  snr: Record<string, number>;
}

/** Mide una señal estéreo en los cuatro modos. Devuelve la fila. */
function medir(nombre: string, pcm: Float64Array, bitrate: number, prefijo: string): Fila {
  const original = canales(pcm);
  const fila: Fila = { senal: nombre, caso: nombreCaso(2, bitrate), patron: {}, snr: {} };
  for (const modo of MODOS) {
    const et = `${prefijo}-${nombre}-${bitrate}-${modo}`;
    const path = join(dir, `${et}.opus`);
    writeFileSync(path, encodeOpusFile(pcm, { channels: 2, bitrate, frameSize: 960, stereo: modo }));
    const salida = decodificarAmbos(path, et);
    // El PEOR de los dos canales: la intensidad se paga en uno de ellos, y una
    // media taparía justo lo que hay que ver.
    fila.patron[modo] = Math.min(
      patronDb(original[0]!, salida[0]!, 48000, MAX_LAG),
      patronDb(original[1]!, salida[1]!, 48000, MAX_LAG),
    );
    fila.snr[modo] = Math.min(
      snrDb(original[0]!, salida[0]!, MAX_LAG),
      snrDb(original[1]!, salida[1]!, MAX_LAG),
    );
  }
  return fila;
}

function resumen(titulo: string, filas: Fila[]): void {
  console.log(`\n── ${titulo} ──`);
  for (const m of MODOS) {
    const d = filas.map((f) => f.patron[m]! - f.patron['off']!);
    const dS = filas.map((f) => f.snr[m]! - f.snr['off']!);
    console.log(
      `   ${m.padEnd(10)} patrón ${media(filas.map((f) => f.patron[m]!)).toFixed(2).padStart(6)} dB` +
      `   Δ ${signo(media(d)).padStart(6)}   peor ${signo(Math.min(...d)).padStart(6)}` +
      `   mejor ${signo(Math.max(...d)).padStart(6)}` +
      `   ·  SNR Δ ${signo(media(dS)).padStart(6)}`,
    );
  }
}

function tabla(filas: Fila[]): void {
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}` +
    MODOS.map((m) => m.padStart(10)).join(''),
  );
  for (const f of filas) {
    console.log(
      `   ${f.senal.padEnd(12)}${f.caso.padEnd(14)}` +
      MODOS.map((m) => f.patron[m]!.toFixed(2).padStart(10)).join(''),
    );
  }
}

try {
  // ── 1. A/B sobre el banco ─────────────────────────────────────────────────
  console.log('\n══ 1. A/B sobre las señales del banco ══');
  console.log('   Sólo los casos estéreo: en mono estas dos decisiones no existen y el');
  console.log('   paquete sale byte a byte idéntico (se comprueba abajo).');
  console.log('   La nota es la del PEOR de los dos canales.\n');

  const banco: Fila[] = [];
  for (const senal of SENALES) {
    for (const { bitrate } of ESTEREO) {
      banco.push(medir(senal.nombre, senal.hacer(2, DURACION), bitrate, 'b'));
    }
  }
  tabla(banco);
  resumen('Resumen del banco (12 combinaciones)', banco);

  // ── 2. Los controles ──────────────────────────────────────────────────────
  console.log('\n══ 2. Los dos extremos del eje que el banco no tiene ══\n');
  const controles: Fila[] = [];
  for (const c of CONTROLES) {
    console.log(` · ${c.nombre} — ${c.porque}`);
    for (const { bitrate } of ESTEREO) {
      controles.push(medir(c.nombre, c.hacer(DURACION), bitrate, 'c'));
    }
  }
  console.log('');
  tabla(controles);
  resumen('Resumen de los controles (6 combinaciones)', controles);

  // ── 3. Qué se transmite, leído del paquete ────────────────────────────────
  console.log('\n══ 3. Qué se transmite, leído del paquete ══');
  console.log('   `intensidad` es la primera banda que va con una sola forma; si sale');
  console.log('   igual que `codedBands` es que está apagada en esa trama. Se lee con el');
  console.log('   lector de rango, recorriendo la cabecera entera — no de un contador.\n');
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}${'intensidad'.padStart(12)}` +
    `${'apagada'.padStart(10)}${'codedBands'.padStart(12)}${'dual'.padStart(8)}`,
  );
  const todas: { nombre: string; hacer: (s: number) => Float64Array }[] = [
    ...SENALES.map((s) => ({ nombre: s.nombre, hacer: (d: number) => s.hacer(2, d) })),
    ...CONTROLES.map((c) => ({ nombre: c.nombre, hacer: (d: number) => c.hacer(d) })),
  ];
  for (const s of todas) {
    for (const { bitrate } of ESTEREO) {
      const pcm = s.hacer(DURACION);
      const r = repartoDe(pcm, bitrate, 'adaptive');
      const apagadas = r.intensidad.filter((v, i) => v >= r.codedBands[i]!).length;
      const usadas = r.intensidad.filter((v, i) => v < r.codedBands[i]!);
      const d = repartoDe(pcm, bitrate, 'dual');
      const dual = d.dual.filter((v) => v === 1).length;
      console.log(
        `   ${s.nombre.padEnd(12)}${nombreCaso(2, bitrate).padEnd(14)}` +
        `${(usadas.length ? media(usadas).toFixed(1) : '—').padStart(12)}` +
        `${`${apagadas}/${r.intensidad.length}`.padStart(10)}` +
        `${media(r.codedBands).toFixed(1).padStart(12)}` +
        `${`${dual}/${d.dual.length}`.padStart(8)}`,
      );
    }
  }

  // ── 4. En mono no cambia nada ─────────────────────────────────────────────
  console.log('\n══ 4. En mono el paquete sale idéntico ══\n');
  let monoIguales = true;
  for (const senal of SENALES) {
    for (const bitrate of [32000, 64000]) {
      const pcm = senal.hacer(1, DURACION);
      const a = encodeOpusFile(pcm, { channels: 1, bitrate, frameSize: 960, stereo: 'off' });
      const b = encodeOpusFile(pcm, { channels: 1, bitrate, frameSize: 960, stereo: 'adaptive' });
      if (a.length !== b.length || !a.every((v, i) => v === b[i])) monoIguales = false;
    }
  }
  console.log(
    monoIguales
      ? '   ok   los 8 archivos mono salen byte a byte iguales con y sin la decisión.\n'
      : '   FALLA  la decisión de estéreo está tocando el camino mono.\n',
  );
  if (!monoIguales) process.exitCode = 1;

  // ── 5. Contra ffmpeg ──────────────────────────────────────────────────────
  //
  // El símbolo de intensidad va DENTRO del asignador de bits, entre la bandera
  // de bandas saltadas y el bit de estéreo dual. Escribir ahí un número que el
  // decodificador no espere no quita unas centésimas de correlación: descoloca
  // todo lo que viene detrás.
  console.log('══ 5. Los dos símbolos contra ffmpeg ══\n');
  let malos = 0;
  for (const { bitrate } of ESTEREO) {
    for (const s of todas) {
      const pcm = s.hacer(DURACION);
      const original = canales(pcm)[0]!;
      const corr: Record<string, number> = {};
      let ganancia = 1;
      let lag = 0;
      for (const modo of MODOS) {
        const et = `ff-${s.nombre}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, { channels: 2, bitrate, frameSize: 960, stereo: modo }),
        );
        const al = alinear(original, decodificarAmbos(path, et)[0]!, MAX_LAG);
        corr[modo] = al.correlacion;
        if (modo === 'adaptive') {
          ganancia = al.ganancia;
          lag = al.lag;
        }
      }
      const d = corr['adaptive']! - corr['off']!;
      const ok = d > -0.01 && ganancia > 0.8 && ganancia < 1.25 && lag === 0;
      if (!ok) malos++;
      console.log(
        `   ${ok ? 'ok  ' : 'FALLA'} ${s.nombre.padEnd(12)} ${nombreCaso(2, bitrate).padEnd(13)}` +
        ` off=${corr['off']!.toFixed(4)}  intensity=${corr['intensity']!.toFixed(4)}` +
        `  dual=${corr['dual']!.toFixed(4)}  adaptive=${corr['adaptive']!.toFixed(4)}` +
        ` (${signo4(d)})  ganancia=${ganancia.toFixed(3)}  retardo=${lag}`,
      );
    }
  }
  console.log(
    malos === 0
      ? '\n   Los dos símbolos están bien escritos: ffmpeg reconstruye entero.\n'
      : `\n   ${malos} caso(s) mal: el estéreo NO está bien escrito.\n`,
  );
  if (malos > 0) process.exitCode = 1;

  // ── 6. Y el listón: contra libopus, en estéreo ────────────────────────────
  console.log('══ 6. Contra libopus, que también usa intensidad a estos bitrates ══\n');
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}${'off'.padStart(9)}` +
    `${'adaptive'.padStart(10)}${'libopus'.padStart(10)}${'distancia'.padStart(11)}`,
  );
  for (const senal of SENALES) {
    for (const { bitrate } of ESTEREO) {
      const pcm = senal.hacer(2, DURACION);
      const original = canales(pcm)[0]!;
      const nota: Record<string, number> = {};
      for (const modo of ['off', 'adaptive'] as StereoMode[]) {
        const et = `lib-${senal.nombre}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, { channels: 2, bitrate, frameSize: 960, stereo: modo }),
        );
        nota[modo] = patronDb(original, decodificarAmbos(path, et)[0]!, 48000, MAX_LAG);
      }
      const lib = patronDb(
        original,
        decodificarAmbos(
          conLibopus(ffmpeg, dir, pcm, 2, bitrate, `lib-${senal.nombre}-${bitrate}`),
          `lib-${senal.nombre}-${bitrate}-d`,
        )[0]!,
        48000,
        MAX_LAG,
      );
      console.log(
        `   ${senal.nombre.padEnd(12)}${nombreCaso(2, bitrate).padEnd(14)}` +
        `${nota['off']!.toFixed(2).padStart(9)}${nota['adaptive']!.toFixed(2).padStart(10)}` +
        `${lib.toFixed(2).padStart(10)}${signo(nota['adaptive']! - lib).padStart(11)}`,
      );
    }
  }
  console.log(`\n   (${NB_BANDS} bandas en total; la intensidad nunca baja del corte por bitrate)\n`);
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
