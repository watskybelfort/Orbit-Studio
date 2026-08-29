/**
 * Las dos decisiones de estéreo del reparto: intensidad y estéreo dual.
 *
 * Ninguna de las dos inventa sonido. Las dos deciden **cuánto de los bits se va
 * en describir la diferencia entre los dos canales**, que es la parte del gasto
 * que menos se oye y la que más cuesta.
 *
 * ## Intensidad
 *
 * En una banda codificada por intensidad viaja **una sola forma** y el
 * decodificador la reparte entre los dos canales con el panorama que ya sabe —
 * las energías de banda, que van aparte y en logaritmo. O sea: se transmite
 * *dónde* suena, no *en qué se diferencian*. Arriba de cierta frecuencia el
 * oído no localiza por diferencia de forma sino por diferencia de nivel, así
 * que la información que se tira no se estaba oyendo, y los bits que libera van
 * a las bandas graves, que sí.
 *
 * El parámetro que viaja es **la banda a partir de la cual empieza** eso. Hasta
 * ahora este encoder mandaba siempre `NB_BANDS` —o sea, nunca— y por eso en
 * estéreo pagaba dos canales completos hasta los 20 kHz.
 *
 * Dónde poner el corte lo deciden dos cosas. La primera es el bitrate —cuanto
 * más apretado va el paquete, más abajo hay que empezar a ahorrar—, y ahí los
 * escalones son los de la referencia, en kb/s efectivos. La segunda es la
 * SEÑAL, y esa parte no está en la referencia: mide cuánto se tira de verdad al
 * juntar los dos canales en cada banda candidata, y sube el corte hasta donde
 * eso deja de oírse. Sin ella, los escalones solos cuestan −0,67 dB de patrón
 * en el banco; ver `intensityBandForFrame`.
 *
 * ## Estéreo dual
 *
 * La otra cara. En mid/side —lo normal en CELT— los dos canales se giran a
 * suma y diferencia; eso gana cuando los canales se parecen, porque la
 * diferencia sale casi vacía y cuesta poco. Pero cuando NO se parecen, el giro
 * es contraproducente: suma y diferencia salen las dos llenas y hay que pagar
 * dos bandas gordas en vez de dos normales. El estéreo dual apaga el giro y
 * codifica cada canal por su cuenta.
 *
 * La medida es exactamente esa comparación, con la norma L1 como modelo del
 * coste de entropía: se suma |L|+|R| y |L+R|+|L−R| sobre las 13 bandas graves
 * —las que se llevan los bits— y gana la representación más barata. El factor
 * `0,707` es la normalización del giro; el `+thetas` es lo que cuesta mandar
 * los ángulos del mid/side, que en dual no se mandan.
 *
 * ## Y por qué esto NO es de las decisiones que descolocan el paquete
 *
 * Las dos viajan como VALOR, no como una rama del formato: el símbolo de
 * intensidad y el bit de dual se escriben siempre que quepan (dentro de
 * `interpBitsToPulses`, en su `if`), y lo que decida aquí el codificador sale
 * escrito ahí. Quien reparte después —el propio asignador y `quantAllBands`—
 * usa el valor DEVUELTO por el asignador, que es el que se transmitió y puede
 * venir recortado a `codedBands`. Esa es toda la sincronía, y está probada
 * releyendo el paquete en `opus-stereo.test.ts`.
 *
 * ---
 * Port de la decisión de `intensity` de `celt_encode_with_ec` y de
 * `stereo_analysis` de `celt/celt_encoder.c` de la implementación de referencia
 * de la RFC 6716. Copyright 1994-2011 IETF Trust, Xiph.Org, Skype Limited,
 * Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell,
 * Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

/**
 * Qué hace el codificador con el estéreo.
 *
 * `'off'` es lo que hacía antes de esta pieza: ni intensidad ni dual, los dos
 * canales completos en todas las bandas. `'intensity'` y `'dual'` encienden una
 * sola de las dos. Los cuatro modos existen para poder medirlos uno contra
 * otro, que es la única forma de decidir esto: ver `opus-stereo-ab.ts`.
 */
export type StereoMode = 'adaptive' | 'off' | 'intensity' | 'dual';

/** Bandas graves que mira `stereoAnalysis`: hasta la 13, que es donde van los bits. */
const BANDAS_ANALISIS = 13;

/**
 * Bitrate efectivo de la trama, en kb/s.
 *
 * El `− 80` descuenta lo que se lleva la energía gruesa, que no depende del
 * bitrate; el `>> lm` lo pasa a bits por sub-trama de 2,5 ms y el `·2/5` de ahí
 * a kb/s. Sale, redondeando, el bitrate de verdad: 160 bytes por trama de 20 ms
 * dan 60 y no 64 porque los 80 bits ya están descontados.
 */
export function bitrateEfectivo(bytes: number, lm: number): number {
  return Math.trunc((2 * ((8 * bytes - 80) >> lm)) / 5);
}

/**
 * A partir de qué banda se codifica por intensidad.
 *
 * Devolver `end` es apagarla: no queda ninguna banda por encima.
 */
export function intensityBand(bytes: number, lm: number, start: number, end: number): number {
  const kbps = bitrateEfectivo(bytes, lm);
  let intensity: number;
  if (kbps < 35) intensity = 8;
  else if (kbps < 50) intensity = 12;
  else if (kbps < 68) intensity = 16;
  else if (kbps < 84) intensity = 18;
  else if (kbps < 102) intensity = 19;
  else if (kbps < 130) intensity = 20;
  else intensity = 21;
  return Math.min(end, Math.max(start, intensity));
}

/**
 * Fracción de la energía de la trama que se puede tirar al codificar por
 * intensidad antes de que se note: 0,2 %, o sea 27 dB por debajo de la trama.
 *
 * No es un número afinado a ojo ni ajustado al banco. Se barrió de 0,0002 a 0,3
 * y el resultado es **idéntico entre 0,0002 y 0,02** —dos órdenes de magnitud de
 * meseta— porque en la práctica la decisión es binaria: o la banda no lleva
 * diferencia entre canales y sale gratis, o lleva mucha y no sale a cuenta ni de
 * lejos. A partir de 0,1 empieza a colarse lo segundo (−0,24 dB en la percusión)
 * y a 0,3 ya cuesta −0,32 dB de media. El valor está en el centro de la meseta.
 */
export const UMBRAL_DIFERENCIA = 0.002;

/**
 * El corte de intensidad de ESTA trama: el de bitrate, subido hasta donde la
 * diferencia entre canales deje de oírse.
 *
 * El escalón por bitrate de la referencia dice cuánto hay que ahorrar, pero no
 * mira la señal, y eso se paga: medido sobre el banco, aplicarlo tal cual cuesta
 * −0,67 dB de patrón de media y hasta −2,69 dB en la percusión estéreo, porque
 * mete por intensidad bandas agudas donde los dos canales NO llevan lo mismo —
 * y ahí la diferencia sí se oye, es justo el aire de los platos.
 *
 * Lo que falta es la otra mitad de la frase: «una banda con su panorama **donde
 * la diferencia entre canales no se oye**». Eso se puede medir, y es lo que hace
 * esta función: por cada banda candidata, la energía del SIDE —lo que la
 * intensidad tira— comparada con la energía de la trama entera. Se sube el corte
 * desde arriba mientras lo acumulado siga por debajo del umbral, y se para en
 * cuanto una banda pide más.
 *
 * Con esto la intensidad entra donde de verdad es gratis —bandas agudas vacías o
 * con los dos canales pegados, que es lo normal en una mezcla— y se queda fuera
 * donde costaría.
 */
export function intensityBandForFrame(
  shape: Float64Array,
  bandE: Float64Array,
  ebands: readonly number[],
  bands: number,
  end: number,
  lm: number,
  frameSize: number,
  desde: number,
  umbral: number = UMBRAL_DIFERENCIA,
): number {
  if (desde >= end) return end;
  const m = 1 << lm;
  let total = 0;
  for (let j = 0; j < end; j++) {
    const el = bandE[j]!;
    const er = bandE[j + bands]!;
    total += el * el + er * er;
  }
  if (!(total > 0)) return end;

  let acumulado = 0;
  let corte = end;
  for (let j = end - 1; j >= desde; j--) {
    // Las formas ya vienen normalizadas a norma 1, así que su producto escalar
    // ES la correlación entre canales dentro de la banda.
    let rho = 0;
    for (let k = m * ebands[j]!; k < m * ebands[j + 1]!; k++) {
      rho += shape[k]! * shape[frameSize + k]!;
    }
    if (rho > 1) rho = 1;
    else if (rho < -1) rho = -1;
    const el = bandE[j]!;
    const er = bandE[j + bands]!;
    // Energía del side de la banda: `(1 − ρ)/2` de la energía total de los dos
    // canales. Con los canales pegados sale cero; con ellos en contrafase, todo.
    acumulado += (el * el + er * er) * 0.5 * (1 - rho);
    if (acumulado > umbral * total) break;
    corte = j;
  }
  return corte;
}

/**
 * ¿Sale más barato cada canal por su cuenta que suma y diferencia?
 *
 * `x` son las bandas ya normalizadas, con el canal derecho a `frameSize` de
 * distancia. `ebands` va en unidades de 2,5 ms, por eso el `<< lm`.
 */
export function stereoAnalysis(
  x: Float64Array,
  ebands: readonly number[],
  lm: number,
  frameSize: number,
): boolean {
  const m = 1 << lm;
  // El epsilon evita el 0/0 de una trama muda; es el `EPSILON` de la referencia.
  let sumaLR = 1e-15;
  let sumaMS = 1e-15;
  for (let i = 0; i < BANDAS_ANALISIS; i++) {
    for (let j = m * ebands[i]!; j < m * ebands[i + 1]!; j++) {
      const l = x[j]!;
      const r = x[frameSize + j]!;
      sumaLR += Math.abs(l) + Math.abs(r);
      sumaMS += Math.abs(l + r) + Math.abs(l - r);
    }
  }
  sumaMS *= 0.707107;
  // Los ángulos del mid/side: uno por banda, y en tramas cortas sólo cuentan
  // las cinco de arriba porque las graves no se parten.
  const thetas = lm <= 1 ? BANDAS_ANALISIS - 8 : BANDAS_ANALISIS;
  const coeficientes = ebands[BANDAS_ANALISIS]! << (lm + 1);
  return (coeficientes + thetas) * sumaMS > coeficientes * sumaLR;
}
