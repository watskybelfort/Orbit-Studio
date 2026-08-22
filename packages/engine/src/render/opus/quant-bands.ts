/**
 * Cuantización de todas las bandas: donde se junta todo lo anterior.
 *
 * Ésta es la función que de verdad escribe el audio. Recibe las bandas ya
 * normalizadas y el reparto de bits, y por cada banda decide cómo gastarlos.
 * Tiene tres mecanismos que merecen explicarse porque no son obvios:
 *
 * ## 1. Partir la banda
 *
 * Una palabra de PVQ no puede pasar de 32 bits (`fitsIn32`). Cuando una banda
 * necesitaría más, **se parte en dos mitades** y se manda el ángulo entre ellas;
 * cada mitad se cuantiza por separado, y el proceso se repite — una banda puede
 * acabar en ocho trozos. No es una optimización: sin esto, las bandas anchas con
 * muchos bits sencillamente no se pueden codificar.
 *
 * ## 2. El ángulo, que hace de estéreo y de partición a la vez
 *
 * El mismo parámetro (`itheta`) sirve para dos cosas distintas: en estéreo dice
 * cuánto hay de mid y cuánto de side; en mono dice cómo se reparte la energía
 * entre las dos mitades de la banda. Por eso el código de partición y el de
 * estéreo son el mismo — y por eso una banda estéreo de dos muestras tiene un
 * caso especial, donde el side cabe en **un solo bit de signo**.
 *
 * ## 3. El relleno cuando no quedan bits
 *
 * Si a una banda no le tocan pulsos, no se deja en silencio: se rellena. Con
 * ruido, si no hay de dónde copiar, o **plegando el espectro** de las bandas
 * graves ya codificadas, que es lo que hace que los agudos de un archivo a
 * bitrate bajo suenen a algo en vez de desaparecer. Es lo mismo que hace la
 * energía por su lado: nunca dejar un hueco.
 *
 * ---
 * Port de `quant_band` y `quant_all_bands` de `celt/bands.c` de la
 * implementación de referencia de la RFC 6716 (rama de coma flotante).
 * Copyright 1994-2011 IETF Trust, Xiph.Org, Skype Limited, Octasic,
 * Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell,
 * Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import {
  BIT_DEINTERLEAVE_TABLE,
  BIT_INTERLEAVE_TABLE,
  bitexactCos,
  bitexactLog2Tan,
  celtLcgRand,
  computeQn,
  deinterleaveHadamard,
  fracMul16,
  haar1,
  intensityStereo,
  interleaveHadamard,
  isqrt32,
  stereoItheta,
  stereoMerge,
  stereoSplit,
} from './band-ops';
import type { RangeDecoder, RangeEncoder } from './range-coder';
import {
  MAX_PULSES,
  QTHETA_OFFSET,
  QTHETA_OFFSET_TWOPHASE,
  bitsToPulses,
  getPulses,
  pulsesToBits,
  type PulseCache,
} from './rate';
import { BITRES } from './tables';
import { SPREAD_AGGRESSIVE, algQuant, algUnquant, renormaliseVector } from './vq';

/** Un trozo de señal: array más desplazamiento, porque las particiones comparten buffer. */
interface Slice {
  data: Float64Array;
  at: number;
}

/** Estado que comparten todas las bandas de la trama. */
export interface QuantContext {
  encode: boolean;
  enc: RangeEncoder | null;
  dec: RangeDecoder | null;
  ebands: readonly number[];
  bands: number;
  cache: PulseCache;
  logN: Int32Array;
  spread: number;
  intensity: number;
  bandE: Float64Array;
  /** Bits que quedan, en octavos. Se va descontando. */
  remainingBits: number;
  /** Semilla del generador de ruido. Los dos lados la arrastran igual. */
  seed: number;
}

function tellFrac(ctx: QuantContext): number {
  return ctx.encode ? ctx.enc!.tellFrac() : ctx.dec!.tellFrac();
}

function rawBits(ctx: QuantContext, value: number, count: number): number {
  if (ctx.encode) {
    ctx.enc!.bits(value, count);
    return value;
  }
  return ctx.dec!.bits(count);
}

interface BandParams {
  band: number;
  x: Slice;
  y: Slice | null;
  n: number;
  b: number;
  blocks: number;
  tfChange: number;
  lowband: Slice | null;
  lm: number;
  lowbandOut: Slice | null;
  level: number;
  gain: number;
  lowbandScratch: Slice | null;
  fill: number;
}

/**
 * Cuantiza una banda (o una partición de ella). Se llama a sí misma al partir.
 *
 * Devuelve la máscara de colapso: qué sub-bloques recibieron energía.
 */
export function quantBand(ctx: QuantContext, params: BandParams): number {
  const { band, x, lm: lmIn, level, lowbandOut } = params;
  let { y, n, b, blocks, lowband, lm, gain, fill } = {
    ...params,
    lm: lmIn,
  };
  // `tfChange` NO es de sólo lectura: el bucle de división temporal lo va
  // subiendo, y es el valor YA MODIFICADO el que viaja a las particiones.
  let tfChange = params.tfChange;

  const n0 = n;
  let nB = n;
  let b0 = blocks;
  let timeDivide = 0;
  let recombine = 0;
  let inv = 0;
  let mid = 0;
  let side = 0;
  let cm = 0;

  const longBlocks = b0 === 1;
  nB = Math.floor(nB / blocks);
  let nB0 = nB;

  const stereo = y !== null;
  let split = stereo;

  // Una sola muestra: no hay forma que elegir, sólo el signo.
  if (n === 1) {
    let slice: Slice | null = x;
    for (let c = 0; c < 1 + (stereo ? 1 : 0); c++) {
      let sign = 0;
      if (ctx.remainingBits >= 1 << BITRES) {
        sign = ctx.encode ? (slice!.data[slice!.at]! < 0 ? 1 : 0) : 0;
        sign = rawBits(ctx, sign, 1);
        ctx.remainingBits -= 1 << BITRES;
        b -= 1 << BITRES;
      }
      slice!.data[slice!.at] = sign ? -1 : 1;
      slice = y;
    }
    if (lowbandOut) lowbandOut.data[lowbandOut.at] = x.data[x.at]!;
    return 1;
  }

  if (!stereo && level === 0) {
    if (tfChange > 0) recombine = tfChange;
    // Recombinar más veces que sub-bloques hay dejaría `blocks` en cero, y con
    // eso el cálculo de la rotación no termina NUNCA: un cuelgue en vez de un
    // error. No puede pasar con entradas reales —`TF_SELECT_TABLE` sólo da
    // valores positivos en tramas de bloques cortos— pero un bucle infinito es
    // el peor fallo posible, así que se corta aquí y se dice por qué.
    if (recombine > 0 && 1 << recombine > blocks) {
      throw new Error(
        `recombinar ${recombine} veces no cabe en ${blocks} sub-bloque(s): ` +
          'tfChange sólo puede ser positivo en tramas de bloques cortos',
      );
    }

    // Si hay que tocar el lowband, se trabaja sobre una copia: el original lo
    // comparten otras bandas.
    if (
      lowband &&
      (recombine || ((nB & 1) === 0 && tfChange < 0) || b0 > 1) &&
      params.lowbandScratch
    ) {
      for (let j = 0; j < n; j++) {
        params.lowbandScratch.data[params.lowbandScratch.at + j] = lowband.data[lowband.at + j]!;
      }
      lowband = params.lowbandScratch;
    }

    // Recombinar sub-bloques: más resolución en frecuencia.
    for (let k = 0; k < recombine; k++) {
      if (ctx.encode) haar1(x.data, x.at, n >> k, 1 << k);
      if (lowband) haar1(lowband.data, lowband.at, n >> k, 1 << k);
      fill = BIT_INTERLEAVE_TABLE[fill & 0xf]! | (BIT_INTERLEAVE_TABLE[fill >> 4]! << 2);
    }
    blocks >>= recombine;
    nB <<= recombine;

    // O al revés: más resolución en el tiempo, que es lo que pide un transitorio.
    while ((nB & 1) === 0 && tfChange < 0) {
      if (ctx.encode) haar1(x.data, x.at, nB, blocks);
      if (lowband) haar1(lowband.data, lowband.at, nB, blocks);
      fill |= fill << blocks;
      blocks <<= 1;
      nB >>= 1;
      timeDivide++;
      tfChange++;
    }
    b0 = blocks;
    nB0 = nB;

    // Reordenar las muestras por tiempo en vez de por frecuencia.
    if (b0 > 1) {
      if (ctx.encode) {
        deinterleaveHadamard(x.data, x.at, nB >> recombine, b0 << recombine, longBlocks);
      }
      if (lowband) {
        deinterleaveHadamard(
          lowband.data,
          lowband.at,
          nB >> recombine,
          b0 << recombine,
          longBlocks,
        );
      }
    }
  }

  // Si harían falta 1,5 bits más de los que puede dar el PVQ, se parte la banda.
  const cacheAt = ctx.cache.index[(lm + 1) * ctx.bands + band]!;
  const cacheMax = ctx.cache.bits[cacheAt + ctx.cache.bits[cacheAt]!]!;
  if (!stereo && lm !== -1 && b > cacheMax + 12 && n > 2) {
    n >>= 1;
    y = { data: x.data, at: x.at + n };
    split = true;
    lm -= 1;
    if (blocks === 1) fill = (fill & 1) | (fill << 1);
    blocks = (blocks + 1) >> 1;
  }

  if (split) {
    let itheta = 0;
    let mbits: number;
    let sbits: number;
    let delta: number;
    let imid = 0;
    let iside = 0;

    // Cuánta resolución se le da al ángulo.
    const pulseCap = ctx.logN[band]! + lm * (1 << BITRES);
    const offset =
      (pulseCap >> 1) - (stereo && n === 2 ? QTHETA_OFFSET_TWOPHASE : QTHETA_OFFSET);
    let qn = computeQn(n, b, offset, pulseCap, stereo);
    if (stereo && band >= ctx.intensity) qn = 1;

    if (ctx.encode) {
      itheta = stereoItheta(x.data, y!.data, x.at, y!.at, stereo, n);
    }
    const tell = tellFrac(ctx);

    if (qn !== 1) {
      if (ctx.encode) itheta = (itheta * qn + 8192) >> 14;

      // El ángulo se codifica con una distribución distinta según el caso:
      // uniforme para la partición temporal, un escalón para estéreo, y
      // triangular para el resto — que es la que refleja que las particiones
      // suelen quedar equilibradas.
      if (stereo && n > 2) {
        const p0 = 3;
        const x0 = qn >> 1;
        const ft = p0 * (x0 + 1) + x0;
        if (ctx.encode) {
          const v = itheta;
          ctx.enc!.encode(
            v <= x0 ? p0 * v : v - 1 - x0 + (x0 + 1) * p0,
            v <= x0 ? p0 * (v + 1) : v - x0 + (x0 + 1) * p0,
            ft,
          );
        } else {
          const fs = ctx.dec!.decode(ft);
          const v = fs < (x0 + 1) * p0 ? Math.trunc(fs / p0) : x0 + 1 + (fs - (x0 + 1) * p0);
          ctx.dec!.update(
            v <= x0 ? p0 * v : v - 1 - x0 + (x0 + 1) * p0,
            v <= x0 ? p0 * (v + 1) : v - x0 + (x0 + 1) * p0,
            ft,
          );
          itheta = v;
        }
      } else if (b0 > 1 || stereo) {
        if (ctx.encode) ctx.enc!.uint(itheta, qn + 1);
        else itheta = ctx.dec!.uint(qn + 1);
      } else {
        const ft = ((qn >> 1) + 1) * ((qn >> 1) + 1);
        if (ctx.encode) {
          const fs = itheta <= qn >> 1 ? itheta + 1 : qn + 1 - itheta;
          const fl =
            itheta <= qn >> 1
              ? (itheta * (itheta + 1)) >> 1
              : ft - (((qn + 1 - itheta) * (qn + 2 - itheta)) >> 1);
          ctx.enc!.encode(fl, fl + fs, ft);
        } else {
          const fm = ctx.dec!.decode(ft);
          let fs: number;
          let fl: number;
          if (fm < ((qn >> 1) * ((qn >> 1) + 1)) >> 1) {
            itheta = (isqrt32(8 * fm + 1) - 1) >> 1;
            fs = itheta + 1;
            fl = (itheta * (itheta + 1)) >> 1;
          } else {
            itheta = (2 * (qn + 1) - isqrt32(8 * (ft - fm - 1) + 1)) >> 1;
            fs = qn + 1 - itheta;
            fl = ft - (((qn + 1 - itheta) * (qn + 2 - itheta)) >> 1);
          }
          ctx.dec!.update(fl, fl + fs, ft);
        }
      }
      itheta = Math.trunc((itheta * 16384) / qn);

      if (ctx.encode && stereo) {
        if (itheta === 0) {
          intensityStereo(x.data, y!.data, x.at, y!.at, ctx.bandE, ctx.bands, band, n);
        } else {
          stereoSplit(x.data, y!.data, x.at, y!.at, n);
        }
      }
    } else if (stereo) {
      if (ctx.encode) {
        inv = itheta > 8192 ? 1 : 0;
        if (inv) for (let j = 0; j < n; j++) y!.data[y!.at + j] = -y!.data[y!.at + j]!;
        intensityStereo(x.data, y!.data, x.at, y!.at, ctx.bandE, ctx.bands, band, n);
      }
      if (b > 2 << BITRES && ctx.remainingBits > 2 << BITRES) {
        if (ctx.encode) ctx.enc!.bitLogp(inv, 2);
        else inv = ctx.dec!.bitLogp(2);
      } else {
        inv = 0;
      }
      itheta = 0;
    }

    const qalloc = tellFrac(ctx) - tell;
    b -= qalloc;
    const origFill = fill;

    if (itheta === 0) {
      imid = 32767;
      iside = 0;
      fill &= (1 << blocks) - 1;
      delta = -16384;
    } else if (itheta === 16384) {
      imid = 0;
      iside = 32767;
      fill &= ((1 << blocks) - 1) << blocks;
      delta = 16384;
    } else {
      imid = bitexactCos(itheta);
      iside = bitexactCos(16384 - itheta);
      // Éste es el reparto entre mid y side que minimiza el error cuadrático.
      delta = fracMul16((n - 1) << 7, bitexactLog2Tan(iside, imid));
    }
    mid = imid / 32768;
    side = iside / 32768;

    if (n === 2 && stereo) {
      // Caso especial: mid y side son ortogonales, así que el side cabe en un
      // solo bit de signo.
      mbits = b;
      sbits = itheta !== 0 && itheta !== 16384 ? 1 << BITRES : 0;
      mbits -= sbits;
      const swap = itheta > 8192;
      ctx.remainingBits -= qalloc + sbits;

      const x2 = swap ? y! : x;
      const y2 = swap ? x : y!;
      let sign = 0;
      if (sbits) {
        if (ctx.encode) {
          sign =
            x2.data[x2.at]! * y2.data[y2.at + 1]! - x2.data[x2.at + 1]! * y2.data[y2.at]! < 0
              ? 1
              : 0;
        }
        sign = rawBits(ctx, sign, 1);
      }
      const signValue = 1 - 2 * sign;
      // Se usa `origFill` porque el side sí se pliega, aunque con itheta=16384
      // se hayan limpiado los bits bajos de fill.
      cm = quantBand(ctx, {
        ...params,
        tfChange,
        x: x2,
        y: null,
        n,
        b: mbits,
        blocks,
        lowband,
        lm,
        lowbandOut,
        level,
        gain,
        fill: origFill,
      });
      y2.data[y2.at] = -signValue * x2.data[x2.at + 1]!;
      y2.data[y2.at + 1] = signValue * x2.data[x2.at]!;

      x.data[x.at] = mid * x.data[x.at]!;
      x.data[x.at + 1] = mid * x.data[x.at + 1]!;
      y!.data[y!.at] = side * y!.data[y!.at]!;
      y!.data[y!.at + 1] = side * y!.data[y!.at + 1]!;
      let tmp = x.data[x.at]!;
      x.data[x.at] = tmp - y!.data[y!.at]!;
      y!.data[y!.at] = tmp + y!.data[y!.at]!;
      tmp = x.data[x.at + 1]!;
      x.data[x.at + 1] = tmp - y!.data[y!.at + 1]!;
      y!.data[y!.at + 1] = tmp + y!.data[y!.at + 1]!;
    } else {
      // Partición normal.
      // A las MDCT de poca energía se les da más de lo que les tocaría, para
      // que un transitorio no deje un hueco audible.
      if (b0 > 1 && !stereo && (itheta & 0x3fff) !== 0) {
        if (itheta > 8192) delta -= delta >> (4 - lm);
        else delta = Math.min(0, delta + ((n << BITRES) >> (5 - lm)));
      }
      mbits = Math.max(0, Math.min(b, (b - delta) / 2 | 0));
      sbits = b - mbits;
      ctx.remainingBits -= qalloc;

      const nextLowband2: Slice | null =
        lowband && !stereo ? { data: lowband.data, at: lowband.at + n } : null;
      const nextLowbandOut1 = stereo ? lowbandOut : null;
      const nextLevel = stereo ? level : level + 1;

      let rebalance = ctx.remainingBits;
      if (mbits >= sbits) {
        cm = quantBand(ctx, {
          ...params,
          tfChange,
          x,
          y: null,
          n,
          b: mbits,
          blocks,
          lowband,
          lm,
          lowbandOut: nextLowbandOut1,
          level: nextLevel,
          gain: stereo ? 1 : gain * mid,
          fill,
        });
        rebalance = mbits - (rebalance - ctx.remainingBits);
        if (rebalance > 3 << BITRES && itheta !== 0) sbits += rebalance - (3 << BITRES);
        cm |=
          quantBand(ctx, {
            ...params,
            tfChange,
            x: y!,
            y: null,
            n,
            b: sbits,
            blocks,
            lowband: nextLowband2,
            lm,
            lowbandOut: null,
            level: nextLevel,
            gain: gain * side,
            lowbandScratch: null,
            fill: fill >> blocks,
          }) << (stereo ? b0 >> 1 : 0);
      } else {
        cm =
          quantBand(ctx, {
            ...params,
            tfChange,
            x: y!,
            y: null,
            n,
            b: sbits,
            blocks,
            lowband: nextLowband2,
            lm,
            lowbandOut: null,
            level: nextLevel,
            gain: gain * side,
            lowbandScratch: null,
            fill: fill >> blocks,
          }) << (stereo ? b0 >> 1 : 0);
        rebalance = sbits - (rebalance - ctx.remainingBits);
        if (rebalance > 3 << BITRES && itheta !== 16384) mbits += rebalance - (3 << BITRES);
        cm |= quantBand(ctx, {
          ...params,
          tfChange,
          x,
          y: null,
          n,
          b: mbits,
          blocks,
          lowband,
          lm,
          lowbandOut: nextLowbandOut1,
          level: nextLevel,
          gain: stereo ? 1 : gain * mid,
          fill,
        });
      }
    }
  } else {
    // Caso base: sin partir.
    let q = bitsToPulses(ctx.cache, band, lm, b);
    let currBits = pulsesToBits(ctx.cache, band, lm, q);
    ctx.remainingBits -= currBits;

    // Nunca pasarse del presupuesto: se bajan pulsos hasta que quepa.
    while (ctx.remainingBits < 0 && q > 0) {
      ctx.remainingBits += currBits;
      q--;
      currBits = pulsesToBits(ctx.cache, band, lm, q);
      ctx.remainingBits -= currBits;
    }

    if (q !== 0) {
      const k = getPulses(q);
      cm = ctx.encode
        ? algQuant(x.data, x.at, n, k, ctx.spread, blocks, ctx.enc!, gain)
        : algUnquant(x.data, x.at, n, k, ctx.spread, blocks, ctx.dec!, gain);
    } else {
      // Sin pulsos, la banda se rellena igualmente. Dejarla en silencio se oye.
      const cmMask = (1 << blocks) - 1;
      fill &= cmMask;
      if (!fill) {
        for (let j = 0; j < n; j++) x.data[x.at + j] = 0;
      } else {
        if (lowband === null) {
          // Ruido: no hay de dónde copiar.
          for (let j = 0; j < n; j++) {
            ctx.seed = celtLcgRand(ctx.seed);
            x.data[x.at + j] = (ctx.seed | 0) >> 20;
          }
          cm = cmMask;
        } else {
          // Espectro plegado: se copia de las bandas graves ya codificadas, con
          // un pelín de ruido para que no salga una copia literal.
          for (let j = 0; j < n; j++) {
            ctx.seed = celtLcgRand(ctx.seed);
            const tmp = ctx.seed & 0x8000 ? 1 / 256 : -1 / 256;
            x.data[x.at + j] = lowband.data[lowband.at + j]! + tmp;
          }
          cm = fill;
        }
        renormaliseVector(x.data, x.at, n, gain);
      }
    }
  }

  // Deshacer todo lo que se hizo al entrar.
  if (stereo) {
    if (n !== 2) stereoMerge(x.data, y!.data, x.at, y!.at, mid, n);
    if (inv) for (let j = 0; j < n; j++) y!.data[y!.at + j] = -y!.data[y!.at + j]!;
  } else if (level === 0) {
    if (b0 > 1) {
      interleaveHadamard(x.data, x.at, nB >> recombine, b0 << recombine, longBlocks);
    }
    nB = nB0;
    blocks = b0;
    for (let k = 0; k < timeDivide; k++) {
      blocks >>= 1;
      nB <<= 1;
      cm |= cm >> blocks;
      haar1(x.data, x.at, nB, blocks);
    }
    for (let k = 0; k < recombine; k++) {
      cm = BIT_DEINTERLEAVE_TABLE[cm]!;
      haar1(x.data, x.at, n0 >> k, 1 << k);
    }
    blocks <<= recombine;

    // Escalar la salida para el plegado de las bandas de arriba.
    if (lowbandOut) {
      const scale = Math.sqrt(n0);
      for (let j = 0; j < n0; j++) {
        lowbandOut.data[lowbandOut.at + j] = scale * x.data[x.at + j]!;
      }
    }
    cm &= (1 << blocks) - 1;
  }
  return cm;
}

export interface AllBandsInput {
  /** Bandas normalizadas del canal izquierdo (o mono). Se modifica in situ. */
  x: Float64Array;
  /** Canal derecho, o `null` en mono. */
  y: Float64Array | null;
  /** Salida: qué sub-bloques recibieron energía, por banda y canal. */
  collapseMasks: Uint8Array;
  bandE: Float64Array;
  pulses: Int32Array;
  shortBlocks: boolean;
  spread: number;
  dualStereo: number;
  intensity: number;
  tfRes: Int32Array;
  totalBits: number;
  balance: number;
  lm: number;
  codedBands: number;
  start: number;
  end: number;
  seed: number;
}

/**
 * Recorre las bandas y las cuantiza. Devuelve la semilla actualizada.
 *
 * El `balance` que se arrastra de banda a banda es lo que hace que los bits que
 * una banda no llegó a gastar acaben en la siguiente en vez de perderse.
 */
export function quantAllBands(
  ctx: Omit<QuantContext, 'remainingBits' | 'seed' | 'spread' | 'intensity' | 'bandE'>,
  input: AllBandsInput,
): number {
  const m = 1 << input.lm;
  const blocks = input.shortBlocks ? m : 1;
  const { ebands, bands } = ctx;
  const channels = input.y !== null ? 2 : 1;

  const normSize = m * ebands[bands]!;
  const norm = new Float64Array(channels * normSize);
  const scratch = new Float64Array(m * (ebands[bands]! - ebands[bands - 1]!));

  const full: QuantContext = {
    ...ctx,
    spread: input.spread,
    intensity: input.intensity,
    bandE: input.bandE,
    remainingBits: 0,
    seed: input.seed,
  };

  let balance = input.balance;
  let lowbandOffset = 0;
  let updateLowband = true;
  let dualStereo = input.dualStereo;

  for (let i = input.start; i < input.end; i++) {
    const atBand = m * ebands[i]!;
    const n = m * ebands[i + 1]! - atBand;
    const tell = tellFrac(full);

    if (i !== input.start) balance -= tell;
    full.remainingBits = input.totalBits - tell - 1;

    let b = 0;
    if (i <= input.codedBands - 1) {
      // `trunc` y NO `floor`: C trunca hacia cero al dividir enteros y
      // JavaScript redondea hacia menos infinito. Con `balance` negativo —que
      // pasa en cuanto una banda gasta de más— dan resultados distintos, y ahí
      // se va la sincronía con cualquier decodificador que no sea el nuestro.
      const currBalance = Math.trunc(balance / Math.min(3, input.codedBands - i));
      b = Math.max(0, Math.min(16383, Math.min(full.remainingBits + 1, input.pulses[i]! + currBalance)));
    }

    if (atBand - n >= m * ebands[input.start]! && (updateLowband || lowbandOffset === 0)) {
      lowbandOffset = i;
    }

    const tfChange = input.tfRes[i]!;
    let xSlice: Slice = { data: input.x, at: atBand };
    let ySlice: Slice | null = input.y ? { data: input.y, at: atBand } : null;

    // Estimación conservadora de las máscaras de las bandas de las que se va a
    // plegar: así nunca se repite contenido dentro de una misma banda.
    let xcm: number;
    let ycm: number;
    let effectiveLowband = -1;
    if (lowbandOffset !== 0 && (input.spread !== SPREAD_AGGRESSIVE || blocks > 1 || tfChange < 0)) {
      effectiveLowband = Math.max(m * ebands[input.start]!, m * ebands[lowbandOffset]! - n);
      let foldStart = lowbandOffset;
      while (m * ebands[--foldStart]! > effectiveLowband);
      let foldEnd = lowbandOffset - 1;
      while (m * ebands[++foldEnd]! < effectiveLowband + n);
      xcm = 0;
      ycm = 0;
      for (let f = foldStart; f < foldEnd; f++) {
        xcm |= input.collapseMasks[f * channels]!;
        ycm |= input.collapseMasks[f * channels + channels - 1]!;
      }
    } else {
      xcm = (1 << blocks) - 1;
      ycm = xcm;
    }

    if (dualStereo && i === input.intensity) {
      // Se apaga el estéreo dual para pasar a intensidad: a partir de aquí los
      // dos canales comparten forma.
      dualStereo = 0;
      for (let j = m * ebands[input.start]!; j < atBand; j++) {
        norm[j] = 0.5 * (norm[j]! + norm[normSize + j]!);
      }
    }

    const lowbandSlice = (channel: number): Slice | null =>
      effectiveLowband !== -1
        ? { data: norm, at: channel * normSize + effectiveLowband }
        : null;

    if (dualStereo) {
      xcm = quantBand(full, {
        band: i,
        x: xSlice,
        y: null,
        n,
        b: b >> 1,
        blocks,
        tfChange,
        lowband: lowbandSlice(0),
        lm: input.lm,
        lowbandOut: { data: norm, at: atBand },
        level: 0,
        gain: 1,
        lowbandScratch: { data: scratch, at: 0 },
        fill: xcm,
      });
      ycm = quantBand(full, {
        band: i,
        x: ySlice!,
        y: null,
        n,
        b: b >> 1,
        blocks,
        tfChange,
        lowband: lowbandSlice(1),
        lm: input.lm,
        lowbandOut: { data: norm, at: normSize + atBand },
        level: 0,
        gain: 1,
        lowbandScratch: { data: scratch, at: 0 },
        fill: ycm,
      });
    } else {
      xcm = quantBand(full, {
        band: i,
        x: xSlice,
        y: ySlice,
        n,
        b,
        blocks,
        tfChange,
        lowband: lowbandSlice(0),
        lm: input.lm,
        lowbandOut: { data: norm, at: atBand },
        level: 0,
        gain: 1,
        lowbandScratch: { data: scratch, at: 0 },
        fill: xcm | ycm,
      });
      ycm = xcm;
    }

    input.collapseMasks[i * channels] = xcm & 0xff;
    input.collapseMasks[i * channels + channels - 1] = ycm & 0xff;
    balance += input.pulses[i]! + tell;

    // La posición de plegado sólo avanza mientras haya al menos 1 bit por muestra.
    updateLowband = b > n << BITRES;
  }

  return full.seed;
}

export { MAX_PULSES };
