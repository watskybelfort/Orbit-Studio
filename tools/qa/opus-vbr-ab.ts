/**
 * El VBR por trama, medido: el encoder contra sí mismo con el reparto plano y
 * con el reparto movido.
 *
 *   npx tsx tools/qa/opus-vbr-ab.ts
 *
 * Es el quinto A/B de este encoder, con el mismo método que los cuatro
 * anteriores: la misma señal, el mismo bitrate, una sola decisión cambiada.
 *
 * - `off`      — todas las tramas con los mismos bytes. Es lo que hacía el
 *                encoder antes de esta pieza: la referencia del A/B.
 * - `adaptive` — el presupuesto se mueve de las tramas tapadas a las
 *                descubiertas, y el silencio digital cuesta lo mínimo.
 *
 * ## Aquí hay una comprobación que los otros A/B no necesitaban
 *
 * **El tamaño.** Las otras cuatro decisiones cambian qué se escribe dentro de un
 * paquete de tamaño fijo, así que la comparación es justa por construcción. Ésta
 * cambia el tamaño de cada paquete, y un VBR que gaste de más ganaría calidad
 * comprando bits — que no es afinar nada. Por eso la primera tabla lleva los
 * bytes de los dos lados, y tienen que salir iguales.
 *
 * ## Y una señal que el banco no tiene
 *
 * Las cuatro del banco suenan sin parar de principio a fin. Lo que sale de un
 * DAW no: hay compases vacíos, colas que se apagan y entradas. El control
 * `compases` es eso — golpes con silencio DIGITAL en medio—, que es donde el
 * reparto plano tira paquetes enteros describiendo la nada.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeOpusFile,
  encodeOpusPackets,
} from '../../packages/engine/src/render/opus/encoder';
import { vbrDemandas, type VbrMode } from '../../packages/engine/src/render/opus/vbr';
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
} from './opus-bench';
import { alinear, patronDb, snrDb } from './opus-metrics';

const MODOS: VbrMode[] = ['off', 'adaptive'];
const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-vbr-'));

const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const signo4 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}`;

/** Golpes con compases vacíos: lo que de verdad exporta un DAW. */
function compases(channels: number, seconds: number): Float64Array {
  const n = Math.floor(SR * seconds);
  const out = new Float64Array(n * channels);
  // Un golpe cada 250 ms y silencio digital entre medias a partir de los 120 ms.
  for (let golpe = 0; golpe * 0.25 < seconds; golpe++) {
    const inicio = Math.floor(golpe * 0.25 * SR);
    const largo = Math.floor(0.12 * SR);
    for (let i = 0; i < largo && inicio + i < n; i++) {
      const t = i / SR;
      const env = Math.exp(-t / 0.03);
      const v =
        (Math.sin(2 * Math.PI * 70 * t) * 0.7 + Math.sin(2 * Math.PI * 210 * t) * 0.2) * env;
      for (let c = 0; c < channels; c++) {
        out[(inicio + i) * channels + c] = v * (c === 1 ? 0.85 : 1);
      }
    }
  }
  return out;
}

const TODAS: { nombre: string; porque: string; hacer: (c: number, s: number) => Float64Array }[] = [
  ...SENALES.map((s) => ({ nombre: s.nombre, porque: s.porque, hacer: s.hacer.bind(s) })),
  {
    nombre: 'compases',
    porque: 'golpes con compases VACÍOS: donde el reparto plano paga por nada',
    hacer: compases,
  },
];

interface Fila {
  senal: string;
  caso: string;
  patron: Record<string, number>;
  snr: Record<string, number>;
  bytes: Record<string, number>;
}

try {
  // ── 1. A/B sobre el banco, con los tamaños al lado ────────────────────────
  console.log('\n══ 1. A/B sobre las señales del banco, y el control ══');
  console.log('   Los bytes van en la tabla porque sin ellos el A/B no significa nada:');
  console.log('   mover el presupuesto sólo vale si el archivo mide lo mismo.\n');

  const filas: Fila[] = [];
  for (const senal of TODAS) {
    console.log(` · ${senal.nombre} — ${senal.porque}`);
    for (const { channels, bitrate } of CASOS) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const fila: Fila = {
        senal: senal.nombre,
        caso: nombreCaso(channels, bitrate),
        patron: {},
        snr: {},
        bytes: {},
      };
      for (const modo of MODOS) {
        const et = `${senal.nombre}-${channels}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(path, encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, vbr: modo }));
        fila.bytes[modo] = encodeOpusPackets(pcm, {
          channels,
          bitrate,
          frameSize: 960,
          vbr: modo,
        }).reduce((s, p) => s + p.data.length, 0);
        const salida = decodificar(ffmpeg, dir, path, channels, et);
        fila.patron[modo] = patronDb(original, salida, 48000, MAX_LAG);
        fila.snr[modo] = snrDb(original, salida, MAX_LAG);
      }
      filas.push(fila);
    }
  }

  console.log('');
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}${'patrón off'.padStart(11)}` +
    `${'adaptive'.padStart(10)}${'Δ'.padStart(8)}${'SNR Δ'.padStart(9)}` +
    `${'bytes'.padStart(9)}${'Δ tamaño'.padStart(11)}`,
  );
  for (const f of filas) {
    const dTam = (f.bytes['adaptive']! / f.bytes['off']! - 1) * 100;
    console.log(
      `   ${f.senal.padEnd(12)}${f.caso.padEnd(14)}` +
      `${f.patron['off']!.toFixed(2).padStart(11)}${f.patron['adaptive']!.toFixed(2).padStart(10)}` +
      `${signo(f.patron['adaptive']! - f.patron['off']!).padStart(8)}` +
      `${signo(f.snr['adaptive']! - f.snr['off']!).padStart(9)}` +
      `${String(f.bytes['adaptive']).padStart(9)}${`${signo(dTam)} %`.padStart(11)}`,
    );
  }

  const delBanco = filas.filter((f) => f.senal !== 'compases');
  const resumen = (titulo: string, xs: Fila[]): void => {
    const d = xs.map((f) => f.patron['adaptive']! - f.patron['off']!);
    const dS = xs.map((f) => f.snr['adaptive']! - f.snr['off']!);
    const dT = xs.map((f) => (f.bytes['adaptive']! / f.bytes['off']! - 1) * 100);
    console.log(
      `   ${titulo.padEnd(30)} patrón Δ ${signo(media(d)).padStart(6)}` +
      `   peor ${signo(Math.min(...d)).padStart(6)}   mejor ${signo(Math.max(...d)).padStart(6)}` +
      `   ·  SNR Δ ${signo(media(dS)).padStart(6)}` +
      `   ·  tamaño ${signo(media(dT)).padStart(6)} %`,
    );
  };
  console.log('\n── Resumen ──');
  resumen(`las ${delBanco.length} del banco`, delBanco);
  resumen(`el control de compases (${filas.length - delBanco.length})`, filas.filter((f) => f.senal === 'compases'));

  // ── 2. Cómo queda el plan ─────────────────────────────────────────────────
  console.log('\n══ 2. Cómo reparte, trama a trama ══');
  console.log('   `mudas` son las tramas de silencio digital, que se llevan el mínimo del');
  console.log('   formato. `rango` es el reparto de la trama más pobre a la más rica, en');
  console.log('   porcentaje del reparto plano: si sale 100–100, el VBR no está haciendo');
  console.log('   nada en esa señal — que es lo correcto en una señal estacionaria.\n');
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}${'mudas'.padStart(9)}` +
    `${'sombra media'.padStart(14)}${'rango'.padStart(16)}`,
  );
  for (const senal of TODAS) {
    for (const { channels, bitrate } of CASOS) {
      const pcm = senal.hacer(channels, DURACION);
      const paquetes = encodeOpusPackets(pcm, { channels, bitrate, frameSize: 960, vbr: 'adaptive' });
      const demandas = vbrDemandas(pcm, 960, channels);
      const base =
        encodeOpusPackets(pcm, { channels, bitrate, frameSize: 960, vbr: 'off' })[0]!.data.length;
      const vivas = paquetes.filter((_, i) => !demandas[i]!.muda).map((p) => p.data.length);
      const mudas = demandas.filter((d) => d.muda).length;
      const sombras = demandas.filter((d) => !d.muda).map((d) => d.sombra);
      console.log(
        `   ${senal.nombre.padEnd(12)}${nombreCaso(channels, bitrate).padEnd(14)}` +
        `${`${mudas}/${demandas.length}`.padStart(9)}` +
        `${(sombras.length ? media(sombras).toFixed(1) : '—').padStart(12)} dB` +
        `${`${((Math.min(...vivas) / base) * 100).toFixed(0)}–${((Math.max(...vivas) / base) * 100).toFixed(0)} %`.padStart(16)}`,
      );
    }
  }

  // ── 3. Contra ffmpeg ──────────────────────────────────────────────────────
  //
  // La pregunta que ninguna nota de calidad contesta. Aquí lo que cambia es el
  // TAMAÑO del paquete, y de ese tamaño salen las condiciones de «esto cabe» que
  // deciden qué símbolos se transmiten. Si los dos lados no lo vieran igual, el
  // paquete se leería corrido sin que saltara ningún error.
  console.log('\n══ 3. El reparto movido contra ffmpeg ══\n');
  let malos = 0;
  for (const { channels, bitrate } of CASOS) {
    for (const senal of TODAS) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const corr: Record<string, number> = {};
      let ganancia = 1;
      let lag = 0;
      for (const modo of MODOS) {
        const et = `ff-${senal.nombre}-${channels}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(path, encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, vbr: modo }));
        const al = alinear(original, decodificar(ffmpeg, dir, path, channels, et), MAX_LAG);
        corr[modo] = al.correlacion;
        if (modo === 'adaptive') {
          ganancia = al.ganancia;
          lag = al.lag;
        }
      }
      const d = corr['adaptive']! - corr['off']!;
      // El retardo se admite hasta una muestra, y sólo aquí: en `compases`, casi
      // la mitad del archivo es silencio digital, así que el pico de correlación
      // sale plano y una muestra arriba o abajo es ruido de medida. Lo que
      // descartaría un paquete descolocado no es un retardo de una muestra: es
      // una correlación por los suelos, y ésa sí se mira.
      const ok = d > -0.02 && ganancia > 0.8 && ganancia < 1.25 && lag <= 1;
      if (!ok) malos++;
      console.log(
        `   ${ok ? 'ok  ' : 'FALLA'} ${senal.nombre.padEnd(12)} ${nombreCaso(channels, bitrate).padEnd(13)}` +
        ` off=${corr['off']!.toFixed(4)}  adaptive=${corr['adaptive']!.toFixed(4)}` +
        ` (${signo4(d)})  ganancia=${ganancia.toFixed(3)}  retardo=${lag}`,
      );
    }
  }
  console.log(
    malos === 0
      ? '\n   Las tramas de tamaño variable las lee ffmpeg enteras.\n'
      : `\n   ${malos} caso(s) mal: el reparto por trama rompe algo.\n`,
  );
  if (malos > 0) process.exitCode = 1;

  // ── 4. Y el listón ────────────────────────────────────────────────────────
  console.log('══ 4. Contra libopus, que en este banco va en CBR ══\n');
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}${'off'.padStart(9)}` +
    `${'adaptive'.padStart(10)}${'libopus'.padStart(10)}${'distancia'.padStart(11)}`,
  );
  for (const senal of SENALES) {
    for (const { channels, bitrate } of CASOS) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const fila = filas.find(
        (f) => f.senal === senal.nombre && f.caso === nombreCaso(channels, bitrate),
      )!;
      const lib = patronDb(
        original,
        decodificar(
          ffmpeg,
          dir,
          conLibopus(ffmpeg, dir, pcm, channels, bitrate, `lib-${senal.nombre}-${channels}-${bitrate}`),
          channels,
          `lib-${senal.nombre}-${channels}-${bitrate}-d`,
        ),
        48000,
        MAX_LAG,
      );
      console.log(
        `   ${senal.nombre.padEnd(12)}${nombreCaso(channels, bitrate).padEnd(14)}` +
        `${fila.patron['off']!.toFixed(2).padStart(9)}` +
        `${fila.patron['adaptive']!.toFixed(2).padStart(10)}` +
        `${lib.toFixed(2).padStart(10)}` +
        `${signo(fila.patron['adaptive']! - lib).padStart(11)}`,
      );
    }
  }
  console.log('');
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
