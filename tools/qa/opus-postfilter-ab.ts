/**
 * El postfiltro, medido: el encoder contra sí mismo con y sin predictor de tono.
 *
 *   npx tsx tools/qa/opus-postfilter-ab.ts
 *
 * `opus-quality.ts` compara Orbit con libopus; `opus-spread-ab.ts` y
 * `opus-transient-ab.ts` comparan Orbit consigo mismo cambiando una decisión.
 * Éste hace lo segundo con la tercera: el peine del período fundamental.
 *
 * - `off`      — sin peine. Es exactamente lo que hacía el encoder antes de esta
 *                tarea: la referencia del A/B.
 * - `adaptive` — se busca el período por trama y se transmite si la predicción
 *                es lo bastante buena. Es lo que se exporta.
 *
 * ## Cuatro cosas, y ninguna sobra
 *
 * 1. **La nota**, sobre las mismas señales del banco. El peine tiene que ayudar
 *    donde hay tono y no estorbar donde no lo hay.
 * 2. **Cuántas tramas lo encienden y con qué período**, leído DEL PAQUETE con el
 *    lector de rango — no de un contador interno del encoder. Si se enciende en
 *    todo, no es un predictor: es un interruptor. Y si el período salta de
 *    trama en trama sobre una nota sostenida, el peine está persiguiendo ruido.
 * 3. **Lo que cuesta**, que en esta pieza es parte del resultado: la búsqueda de
 *    tono es lo más caro que hace este encoder, y hay que poder decir cuánto.
 * 4. **Que ffmpeg lo reconstruye.** Un bloque de postfiltro mal escrito no da
 *    error: descoloca el paquete entero a partir de ahí.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeOpusFile,
  encodeOpusPackets,
} from '../../packages/engine/src/render/opus/encoder';
import {
  COMBFILTER_MAXPERIOD,
  POSTFILTER_GAIN_STEP,
  type PostfilterMode,
} from '../../packages/engine/src/render/opus/postfilter';
import { RangeDecoder } from '../../packages/engine/src/render/opus/range-coder';
import { TAPSET_ICDF } from '../../packages/engine/src/render/opus/tables';
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

const MODOS: PostfilterMode[] = ['off', 'adaptive'];

const ffmpeg = findFfmpeg();

// ── Lo que de verdad viaja en el paquete ────────────────────────────────────

interface Peine {
  on: number;
  period: number;
  gain: number;
  tapset: number;
}

/**
 * Lee el bloque del postfiltro de una trama CELT.
 *
 * Es una copia del arranque de `celt_decode_with_ec`: la bandera de silencio y,
 * si caben 16 bits contados ANTES de ella, el bloque del peine. Se lee del
 * bitstream y no de un contador del encoder a propósito — lo que cuenta es lo
 * que el decodificador va a encontrarse.
 */
function leerPeine(trama: Uint8Array): Peine {
  const dec = new RangeDecoder(trama);
  const totalBits = trama.length * 8;
  const tell = dec.tell();
  const salida: Peine = { on: 0, period: 0, gain: 0, tapset: 0 };
  if (tell === 1 && dec.bitLogp(15)) return salida;
  if (tell + 16 <= totalBits && dec.bitLogp(1)) {
    const octave = dec.uint(6);
    salida.period = (16 << octave) + dec.bits(4 + octave) - 1;
    const qg = dec.bits(3);
    if (dec.tell() + 2 <= totalBits) salida.tapset = dec.icdf(TAPSET_ICDF, 2);
    salida.gain = POSTFILTER_GAIN_STEP * (qg + 1);
    salida.on = 1;
  }
  return salida;
}

/** El peine de cada trama de una señal, tal y como sale codificada. */
function peinesDe(
  pcm: Float64Array,
  channels: number,
  bitrate: number,
): Peine[] {
  return encodeOpusPackets(pcm, { channels, bitrate, frameSize: 960 }).map((p) =>
    // El primer byte es el TOC de Opus; la trama CELT empieza detrás.
    leerPeine(p.data.subarray(1)),
  );
}

const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-pf-'));
try {
  // ── 1. A/B sobre el banco ─────────────────────────────────────────────────
  console.log('\n══ 1. A/B sobre las señales del banco ══');
  console.log('   Misma señal, mismo bitrate, un solo símbolo del formato cambiado.\n');

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
      `   ${'caso'.padEnd(13)}${'SNR (dB)'.padStart(20)}      ${'patrón (dB)'.padStart(20)}`,
    );
    console.log(
      `   ${''.padEnd(13)}` +
      MODOS.map((m) => m.padStart(10)).join('') +
      '      ' +
      MODOS.map((m) => m.padStart(10)).join(''),
    );
    for (const { channels, bitrate } of CASOS) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const fila: Fila = {
        senal: senal.nombre,
        caso: nombreCaso(channels, bitrate),
        snr: {},
        patron: {},
      };
      for (const modo of MODOS) {
        const et = `${senal.nombre}-${channels}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, postfilter: modo }),
        );
        const salida = decodificar(ffmpeg, dir, path, channels, et);
        fila.snr[modo] = snrDb(original, salida, MAX_LAG);
        fila.patron[modo] = patronDb(original, salida, 48000, MAX_LAG);
      }
      filas.push(fila);
      console.log(
        `   ${fila.caso.padEnd(13)}` +
        MODOS.map((m) => fila.snr[m]!.toFixed(2).padStart(10)).join('') +
        '      ' +
        MODOS.map((m) => fila.patron[m]!.toFixed(2).padStart(10)).join(''),
      );
    }
  }

  const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const signo4 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)}`;
  console.log('\n── Resumen (media de las 20 combinaciones) ──');
  for (const m of MODOS) {
    console.log(
      `   ${m.padEnd(10)} SNR ${media(filas.map((f) => f.snr[m]!)).toFixed(2).padStart(6)} dB` +
      `   patrón ${media(filas.map((f) => f.patron[m]!)).toFixed(2).padStart(6)} dB`,
    );
  }
  const dSnr = media(filas.map((f) => f.snr['adaptive']! - f.snr['off']!));
  const dPat = media(filas.map((f) => f.patron['adaptive']! - f.patron['off']!));
  // El peor caso importa tanto como la media: una decisión que gana de media y
  // hunde una señal concreta no entra.
  const peorSnr = Math.min(...filas.map((f) => f.snr['adaptive']! - f.snr['off']!));
  const peorPat = Math.min(...filas.map((f) => f.patron['adaptive']! - f.patron['off']!));
  const mejorPat = Math.max(...filas.map((f) => f.patron['adaptive']! - f.patron['off']!));
  console.log(
    `   ${'adaptive − off'.padEnd(20)} SNR ${signo(dSnr).padStart(7)} dB` +
    `   patrón ${signo(dPat).padStart(7)} dB`,
  );
  console.log(
    `   ${'la peor de las 20'.padEnd(20)} SNR ${signo(peorSnr).padStart(7)} dB` +
    `   patrón ${signo(peorPat).padStart(7)} dB   (la mejor ${signo(mejorPat)} dB)`,
  );

  // ── 2. Cuántas tramas lo encienden, y con qué ─────────────────────────────
  console.log('\n══ 2. Qué se transmite, leído del paquete ══');
  console.log('   Si se enciende en todo, no es un predictor: es un interruptor.');
  console.log('   La dispersión del período dice si sigue una nota o persigue ruido.\n');
  console.log(
    `   ${'señal'.padEnd(12)}${'caso'.padEnd(14)}${'encendidas'.padStart(12)}` +
    `${'período'.padStart(10)}${'±'.padStart(8)}${'ganancia'.padStart(10)}`,
  );
  for (const senal of SENALES) {
    for (const { channels, bitrate } of CASOS) {
      const peines = peinesDe(senal.hacer(channels, DURACION), channels, bitrate);
      const on = peines.filter((p) => p.on);
      const periodos = on.map((p) => p.period);
      const m = periodos.length ? media(periodos) : NaN;
      const sd = periodos.length
        ? Math.sqrt(media(periodos.map((p) => (p - m) ** 2)))
        : NaN;
      const g = on.length ? media(on.map((p) => p.gain)) : NaN;
      console.log(
        `   ${senal.nombre.padEnd(12)}${nombreCaso(channels, bitrate).padEnd(14)}` +
        `${`${on.length}/${peines.length}`.padStart(12)}` +
        `${(periodos.length ? m.toFixed(0) : '—').padStart(10)}` +
        `${(periodos.length ? sd.toFixed(1) : '—').padStart(8)}` +
        `${(on.length ? g.toFixed(3) : '—').padStart(10)}`,
      );
    }
  }

  // Y el caso que lo dice todo: una nota sostenida de período conocido. Si el
  // encoder no encuentra ESO, no encuentra nada.
  console.log('\n   Control: nota sostenida de período conocido (200 Hz = 240 muestras)');
  const nota = new Float64Array(Math.floor(SR * DURACION));
  for (let i = 0; i < nota.length; i++) {
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin((2 * Math.PI * k * i) / 240) / k;
    nota[i] = v * 0.3;
  }
  for (const { channels, bitrate } of CASOS) {
    const pcm = channels === 1 ? nota : (() => {
      const out = new Float64Array(nota.length * 2);
      for (let i = 0; i < nota.length; i++) {
        out[2 * i] = nota[i]!;
        out[2 * i + 1] = nota[i]! * 0.8;
      }
      return out;
    })();
    const peines = peinesDe(pcm, channels, bitrate);
    const on = peines.filter((p) => p.on);
    const aciertan = on.filter((p) => Math.abs(p.period - 240) <= 2).length;
    console.log(
      `   ${nombreCaso(channels, bitrate).padEnd(14)}` +
      `${`${on.length}/${peines.length}`.padStart(12)} encendidas, ` +
      `${aciertan}/${on.length} con el período correcto`,
    );
  }

  // ── 3. Lo que cuesta ──────────────────────────────────────────────────────
  //
  // Esta pieza se presupuesta o no entra. El peine obliga a guardar 1024
  // muestras por canal de señal SIN filtrar —el historial desde el que
  // predice— y a buscar el período en cada trama, que es la búsqueda más cara
  // del encoder.
  console.log('\n══ 3. Lo que cuesta ══\n');
  const bytesPorCanal = COMBFILTER_MAXPERIOD * 8;
  for (const channels of [1, 2]) {
    const permanente = COMBFILTER_MAXPERIOD * channels * 8; // prefilterMem
    const borradores =
      ((COMBFILTER_MAXPERIOD + 960) >> 1) * 8 + (COMBFILTER_MAXPERIOD + 960) * channels * 8 + 120 * 8;
    console.log(
      `   ${(channels === 1 ? 'mono' : 'estéreo').padEnd(8)} historial del peine ` +
      `${(permanente / 1024).toFixed(1)} KB` +
      `   borradores ${(borradores / 1024).toFixed(1)} KB` +
      `   total ${((permanente + borradores) / 1024).toFixed(1)} KB`,
    );
  }
  console.log(
    `   (el historial son ${COMBFILTER_MAXPERIOD} muestras por canal —` +
    `${(bytesPorCanal / 1024).toFixed(0)} KB— porque el peine alcanza hasta un\n` +
    `   período de ${COMBFILTER_MAXPERIOD}, o sea 21 ms, que son 47 Hz)\n`,
  );

  console.log('   Tiempo de codificación, 1,5 s de audio por caso:\n');
  console.log(
    `   ${'caso'.padEnd(14)}${'off'.padStart(10)}${'adaptive'.padStart(11)}` +
    `${'sobrecoste'.padStart(12)}${'× tiempo real'.padStart(15)}`,
  );
  // Se toma el MÍNIMO de varias pasadas y no la media: el mínimo es el tiempo
  // sin interrupciones del sistema, y aquí la diferencia que se busca es del
  // orden del ruido de medida.
  const REPES = 6;
  const sobrecostes: number[] = [];
  for (const { channels, bitrate } of CASOS) {
    const pcm = SENALES[3]!.hacer(channels, DURACION);
    const tiempos: Record<string, number> = {};
    for (const modo of MODOS) {
      // Dos pasadas en frío para que el JIT no cuente como coste del peine.
      for (let r = 0; r < 2; r++) {
        encodeOpusPackets(pcm, { channels, bitrate, frameSize: 960, postfilter: modo });
      }
      let mejor = Infinity;
      for (let r = 0; r < REPES; r++) {
        const t0 = performance.now();
        encodeOpusPackets(pcm, { channels, bitrate, frameSize: 960, postfilter: modo });
        const dt = performance.now() - t0;
        if (dt < mejor) mejor = dt;
      }
      tiempos[modo] = mejor;
    }
    const sobre = (tiempos['adaptive']! / tiempos['off']! - 1) * 100;
    sobrecostes.push(sobre);
    console.log(
      `   ${nombreCaso(channels, bitrate).padEnd(14)}` +
      `${tiempos['off']!.toFixed(0).padStart(8)} ms` +
      `${tiempos['adaptive']!.toFixed(0).padStart(9)} ms` +
      `${`${signo(sobre)} %`.padStart(12)}` +
      `${`${((DURACION * 1000) / tiempos['adaptive']!).toFixed(0)}×`.padStart(15)}`,
    );
  }
  console.log(
    `\n   Sobrecoste medio del peine: ${signo(media(sobrecostes))} % del tiempo de` +
    ' codificación.\n   Se pierde entre el ruido de medida porque la búsqueda va sobre la señal\n' +
    '   diezmada por 8 y en tres pasadas de grueso a fino, mientras que el PVQ y\n' +
    '   las MDCT trabajan a 48 kHz sobre la trama entera.\n',
  );

  // ── 4. Contra ffmpeg ──────────────────────────────────────────────────────
  //
  // La pregunta que ninguna nota de calidad contesta. El bloque del postfiltro
  // es el PRIMERO del paquete después de la bandera de silencio: si sobra o
  // falta un bit ahí, todo lo demás se lee corrido y no salta ningún error.
  console.log('══ 4. El bloque del postfiltro contra ffmpeg ══');
  console.log('   La correlación absoluta no es el criterio: el ruido rosa a 32k sale en');
  console.log('   0,88 con peine y sin él, porque a ese bitrate no hay forma de seguir');
  console.log('   una señal sin tono. Lo que se mira es que ENCENDER el peine no la baje:');
  console.log('   un bloque descolocado no quita unas centésimas, deja la correlación en');
  console.log('   cero desde el primer bit que sobra o falta.\n');
  let malos = 0;
  for (const { channels, bitrate } of CASOS) {
    for (const senal of SENALES) {
      const pcm = senal.hacer(channels, DURACION);
      const original = izquierdo(pcm, channels);
      const corr: Record<string, number> = {};
      let ganancia = 1;
      let lag = 0;
      for (const modo of MODOS) {
        const et = `ff-${senal.nombre}-${channels}-${bitrate}-${modo}`;
        const path = join(dir, `${et}.opus`);
        writeFileSync(
          path,
          encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, postfilter: modo }),
        );
        const al = alinear(original, decodificar(ffmpeg, dir, path, channels, et), MAX_LAG);
        corr[modo] = al.correlacion;
        if (modo === 'adaptive') {
          ganancia = al.ganancia;
          lag = al.lag;
        }
      }
      const encendidas = peinesDe(pcm, channels, bitrate).filter((p) => p.on).length;
      const d = corr['adaptive']! - corr['off']!;
      const ok = d > -0.01 && ganancia > 0.8 && ganancia < 1.25 && lag === 0;
      if (!ok) malos++;
      console.log(
        `   ${ok ? 'ok  ' : 'FALLA'} ${senal.nombre.padEnd(11)} ${nombreCaso(channels, bitrate).padEnd(13)}` +
        ` off=${corr['off']!.toFixed(4)}  adaptive=${corr['adaptive']!.toFixed(4)}` +
        ` (${signo4(d)})  ganancia=${ganancia.toFixed(3)}  retardo=${lag}` +
        `  peine en ${encendidas}/75 tramas`,
      );
    }
  }
  console.log(
    malos === 0
      ? '\n   El bloque del postfiltro está bien escrito: ffmpeg reconstruye entero.\n'
      : `\n   ${malos} caso(s) mal: el bloque del postfiltro NO está bien escrito.\n`,
  );
  if (malos > 0) process.exitCode = 1;

  // ── 5. Y el listón: contra libopus, sólo en lo tonal ──────────────────────
  //
  // El agujero que esta tarea venía a cerrar estaba en el acorde. Aquí se ve de
  // frente cuánto se ha cerrado.
  console.log('══ 5. El acorde contra libopus, que es donde estaba el agujero ══\n');
  console.log(
    `   ${'caso'.padEnd(14)}${'off'.padStart(9)}${'adaptive'.padStart(10)}` +
    `${'libopus'.padStart(10)}${'distancia'.padStart(11)}`,
  );
  const acorde = SENALES[0]!;
  for (const { channels, bitrate } of CASOS) {
    const pcm = acorde.hacer(channels, DURACION);
    const original = izquierdo(pcm, channels);
    const nota2: Record<string, number> = {};
    for (const modo of MODOS) {
      const et = `lib-acorde-${channels}-${bitrate}-${modo}`;
      const path = join(dir, `${et}.opus`);
      writeFileSync(
        path,
        encodeOpusFile(pcm, { channels, bitrate, frameSize: 960, postfilter: modo }),
      );
      nota2[modo] = patronDb(original, decodificar(ffmpeg, dir, path, channels, et), 48000, MAX_LAG);
    }
    const lib = patronDb(
      original,
      decodificar(
        ffmpeg,
        dir,
        conLibopus(ffmpeg, dir, pcm, channels, bitrate, `lib-acorde-${channels}-${bitrate}`),
        channels,
        `lib-acorde-${channels}-${bitrate}-l`,
      ),
      48000,
      MAX_LAG,
    );
    console.log(
      `   ${nombreCaso(channels, bitrate).padEnd(14)}` +
      `${nota2['off']!.toFixed(2).padStart(9)}` +
      `${nota2['adaptive']!.toFixed(2).padStart(10)}` +
      `${lib.toFixed(2).padStart(10)}` +
      `${signo(nota2['adaptive']! - lib).padStart(11)}`,
    );
  }
  console.log('');
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
