/**
 * El transitorio: detectar el golpe y decidir cuánta resolución temporal darle.
 *
 * Una trama de 20 ms es UNA MDCT de 960 puntos. El error de cuantización que
 * sale de ella se reparte por las 960 muestras, así que si dentro hay un ataque
 * —un bombo, un clap, un hat— el ruido del golpe aparece también ANTES del
 * golpe, en un tramo que era silencio. Eso es el pre-eco, y el oído lo nota
 * muchísimo: hacia atrás no hay enmascaramiento que valga (el enmascaramiento
 * previo dura ~2 ms; el posterior, ~100 ms).
 *
 * La respuesta del formato son dos decisiones distintas, y hacen falta LAS DOS:
 *
 * 1. **`isTransient`** — un bit por trama que dice «esta trama va en `M`
 *    MDCT cortas de 2,5 ms en vez de una larga». Lo decide `transientAnalysis`.
 * 2. **`tf_res`** — un bit por banda que dice cuánta de esa resolución temporal
 *    se queda. Lo decide `tfAnalysis`.
 *
 * Y el segundo no es opcional: con `isTransient=1` y `tf_res` todo a cero, la
 * tabla `TF_SELECT_TABLE` manda **recombinar** los `M` sub-bloques hasta volver
 * a resolución de frecuencia (para LM=3 el valor es 3, o sea tres pasadas de
 * Haar), y la trama acaba sonando como si fuera larga. Poner el bit y no poner
 * el otro es pagar el bit y no cobrar nada.
 *
 * ## Cómo se detecta el golpe
 *
 * No por «la energía sube mucho»: eso confunde una nota que entra con un
 * transitorio, y encima depende del volumen. Lo que se mide es la **relación
 * entre la energía de la trama y el umbral de enmascaramiento temporal**, que
 * es exactamente lo que decide si el pre-eco se va a oír o no:
 *
 * - se filtra paso alto (el pre-eco molesta arriba; abajo la MDCT larga es la
 *   que conviene);
 * - se calcula la energía en grupos de dos muestras;
 * - se pasa un envolvente hacia delante con caída de 6,7 dB/ms (enmascaramiento
 *   posterior) y otro hacia atrás con 13,9 dB/ms (enmascaramiento previo, que
 *   es mucho más corto: por eso cae más rápido);
 * - y se compara la energía de la trama contra la MEDIA ARMÓNICA de ese
 *   envolvente. La media armónica la dominan los valores pequeños — o sea, los
 *   tramos que el golpe NO tapa. Si hay muchos, hay sitio donde el pre-eco se
 *   va a oír.
 *
 * La medida es invariante a la escala (numerador y denominador crecen igual con
 * el volumen), así que el umbral es un número absoluto y no hay que calibrarlo
 * por señal.
 *
 * ## Una diferencia declarada con la referencia
 *
 * La implementación de referencia hace el último paso con una tabla de 128
 * inversos (`inv_table`) porque está pensada para coma fija. Aquí se usa su
 * forma cerrada, `384/(id + ½)` acotada a 255, que es de donde sale la tabla
 * (entrada a entrada: `inv_table[5]=70` y `384/5,5=69,8`; `inv_table[24]=16` y
 * `384/24,5=15,7`). Se dice porque **este detector no necesita ser idéntico al
 * de libopus**: lo que decide viaja en el bitstream como un bit explícito, así
 * que el decodificador hace lo que se le diga. Lo que sí tiene que ser idéntico
 * es lo que se DEDUCE del bit, y eso está en las tablas del formato.
 *
 * ---
 * Port de `transient_analysis` y `tf_analysis` de `celt/celt_encoder.c` de la
 * implementación de referencia de la RFC 6716. Copyright 1994-2011 IETF Trust,
 * Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry,
 * CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { haar1 } from './band-ops';
import { TF_SELECT_TABLE } from './tables';

/**
 * Qué hace el codificador con los transitorios.
 *
 * - `'adaptive'`: se detecta el golpe por trama y, si lo hay, la trama va en
 *   sub-tramas cortas; la resolución tiempo/frecuencia se decide por banda.
 * - `'tf'`: **sólo** la decisión por banda, sin sub-tramas cortas. Sirve para
 *   separar en el banco cuánto aporta cada mitad del mecanismo.
 * - `'off'`: bloques largos siempre y resolución sin cambios, que es lo que
 *   hacía este encoder antes de que esto existiera. Es la referencia del A/B.
 * - `'force'`: sub-tramas cortas SIEMPRE. No es una opción sensata para
 *   exportar —en material estacionario cuesta calidad—, pero es la única forma
 *   de poner a prueba el camino de bloque corto contra ffmpeg sin depender de
 *   que el detector se dispare: si la ganancia y la correlación salen bien con
 *   TODAS las tramas cortas, el intercalado y el reparto de bits son correctos.
 */
export type TransientMode = 'adaptive' | 'tf' | 'off' | 'force';

/** Caída del enmascaramiento posterior por grupo de 2 muestras: 6,7 dB/ms. */
const FORWARD_DECAY = 0.0625;
/** Caída del enmascaramiento previo por grupo de 2 muestras: 13,9 dB/ms. */
const BACKWARD_DECAY = 0.125;
/**
 * Por encima de esto la trama va en sub-tramas cortas.
 *
 * Es el mismo 200 de la referencia, y se puede leer: la métrica sale de
 * `10,67 · media(384/(id+½))` con `id = 64·umbral/energía`, así que 200 pide
 * que de media el umbral de enmascaramiento esté unas 3,5 veces por debajo de
 * la energía de la trama. Una señal estacionaria da unos 45; un click en
 * silencio se va por encima de 2.000.
 */
const UMBRAL_TRANSITORIO = 200;

export interface TransientResult {
  /** Si la trama lleva un ataque que pide sub-tramas cortas. */
  isTransient: boolean;
  /** Cuánto de transitoria es, de 0 a ~1. Sesga la decisión por banda. */
  tfEstimate: number;
  /** Qué canal manda: el de la métrica más alta. */
  tfChan: number;
  /** La métrica cruda, para poder mirarla desde el banco. */
  metric: number;
}

/**
 * ¿Lleva esta trama un ataque?
 *
 * `input` son las muestras YA con pre-énfasis, con los canales concatenados: el
 * canal `c` empieza en `c * len`, y dentro van primero las `OVERLAP` muestras
 * de la trama anterior y luego las de ésta. Ese solape no es opcional: un golpe
 * que cae en las primeras muestras de la trama sólo se ve como salto si se
 * tiene lo de antes con qué compararlo.
 */
export function transientAnalysis(
  input: Float64Array,
  len: number,
  channels: number,
): TransientResult {
  const len2 = len >> 1;
  // Con menos de 18 grupos el bucle de la media armónica se queda sin muestras
  // fiables (se descartan 12 por delante y 5 por detrás). No pasa con los
  // tamaños de trama de Opus donde el transitorio existe (LM>0 ⇒ len ≥ 360).
  if (len2 < 24) return { isTransient: false, tfEstimate: 0, tfChan: 0, metric: 0 };

  const tmp = new Float64Array(len2);
  const bruto = new Float64Array(len);
  let metric = 0;
  let tfChan = 0;

  for (let c = 0; c < channels; c++) {
    // Paso alto (1 − 2z⁻¹ + z⁻²)/(1 − z⁻¹ + ½z⁻²). Quita el grave, que es donde
    // la MDCT larga acierta y donde un bombo tiene casi toda su energía sin ser
    // por eso un problema de pre-eco.
    let mem0 = 0;
    let mem1 = 0;
    for (let i = 0; i < len; i++) {
      const x = input[c * len + i]!;
      const y = mem0 + x;
      mem0 = mem1 + y - 2 * x;
      mem1 = x - 0.5 * y;
      bruto[i] = y;
    }
    // Las primeras muestras no valen: el filtro arranca sin memoria y lo que
    // sale de ahí es su propio transitorio, no el de la señal.
    for (let i = 0; i < 12; i++) bruto[i] = 0;

    // Ida: el umbral de enmascaramiento POSTERIOR, que es el que tapa la cola
    // del golpe. Y de paso la energía total de la trama.
    let energia = 0;
    mem0 = 0;
    for (let i = 0; i < len2; i++) {
      const a = bruto[2 * i]!;
      const b = bruto[2 * i + 1]!;
      const x2 = a * a + b * b;
      energia += x2;
      mem0 += FORWARD_DECAY * (x2 - mem0);
      tmp[i] = mem0;
    }

    // Vuelta: el enmascaramiento PREVIO, que es el corto. Lo que quede por
    // debajo de esta curva antes del golpe es pre-eco audible.
    mem0 = 0;
    let maxE = 0;
    for (let i = len2 - 1; i >= 0; i--) {
      mem0 += BACKWARD_DECAY * (tmp[i]! - mem0);
      tmp[i] = mem0;
      if (mem0 > maxE) maxE = mem0;
    }
    if (!(maxE > 0) || !(energia > 0)) continue;

    // La energía de referencia de la trama: media geométrica entre la energía
    // media y la mitad del pico. Con la media sola, un golpe corto en una trama
    // larga apenas movería el número; con el pico solo, cualquier ruido lo
    // dispararía.
    const media = energia / len2;
    const referencia = Math.sqrt(media * maxE * 0.5);

    // Media armónica del umbral, en unidades de esa referencia. Se toma una de
    // cada cuatro muestras (la curva es suave, no hace falta más) y se dejan
    // fuera los bordes, que arrastran el arranque de los filtros.
    let suma = 0;
    let cuenta = 0;
    for (let i = 12; i < len2 - 5; i += 4) {
      const id = Math.min(127, Math.max(0, Math.floor((64 * tmp[i]!) / referencia)));
      suma += Math.min(255, 384 / (id + 0.5));
      cuenta++;
    }
    if (cuenta === 0) continue;
    // El 64/6 sale de la referencia: normaliza la escala de la tabla de
    // inversos, que va en sextos. (El ×4 de «una de cada cuatro muestras» ya
    // está aquí dentro de la media, y contarlo dos veces multiplicaría la
    // métrica por cuatro: el detector dispararía en todas las tramas, incluidas
    // las de un acorde sostenido.)
    const unmask = (64 / 6) * (suma / cuenta);
    if (unmask > metric) {
      metric = unmask;
      tfChan = c;
    }
  }

  // Métrica arbitraria de la referencia, acotada a [0,1) y usada sólo para
  // sesgar la decisión por banda: cuanto más transitoria es la trama, menos se
  // penaliza gastar resolución temporal.
  const tfMax = Math.max(0, Math.sqrt(27 * metric) - 42);
  const tfEstimate = Math.sqrt(Math.max(0, 0.0069 * Math.min(163, tfMax) - 0.139));

  return { isTransient: metric > UMBRAL_TRANSITORIO, tfEstimate, tfChan, metric };
}

/**
 * L1 de una banda, con un sesgo a favor de la resolución de frecuencia.
 *
 * La norma L1 de un vector de energía fija es MÍNIMA cuando la energía está
 * concentrada en pocos coeficientes — que es justo lo que el PVQ codifica
 * barato. Así que «qué transformada deja la L1 más baja» es literalmente «qué
 * transformada cuesta menos bits», sin tener que codificar nada para saberlo.
 */
function l1Metric(x: Float64Array, n: number, lm: number, bias: number): number {
  let l1 = 0;
  for (let i = 0; i < n; i++) l1 += Math.abs(x[i]!);
  return l1 + lm * bias * l1;
}

export interface TfResult {
  /** Cuál de las dos filas de `TF_SELECT_TABLE` se usa. */
  tfSelect: number;
  /** Un 0 o un 1 por banda, ANTES de pasar por la tabla. */
  tfRes: Int32Array;
}

/**
 * Cuánta resolución temporal se queda cada banda.
 *
 * Un golpe no es igual de brusco en todas partes: el sub del bombo es casi un
 * seno y se describe mejor con resolución de frecuencia, mientras que el click
 * de arriba pide resolución de tiempo. Por eso la decisión es POR BANDA y no
 * por trama.
 *
 * El criterio es la L1: se prueban todas las reagrupaciones posibles con la
 * transformada de Haar (que es ortogonal, así que no cambia la energía, sólo
 * cómo se reparte) y gana la que deja la banda más concentrada.
 *
 * Y encima hay un Viterbi: el resultado de cada banda no se decide sola, porque
 * cada cambio respecto a la banda anterior cuesta un bit. `lambda` es ese
 * precio, y lo que hace es que una banda no se salga del grupo por un margen
 * mínimo.
 */
export function tfAnalysis(
  x: Float64Array,
  ebands: readonly number[],
  end: number,
  isTransient: number,
  lm: number,
  n0: number,
  tfChan: number,
  tfEstimate: number,
): TfResult {
  const tfRes = new Int32Array(end);
  const row = TF_SELECT_TABLE[lm]!;
  if (lm === 0) return { tfSelect: 0, tfRes };

  const bias = 0.04 * Math.max(-0.25, 0.5 - tfEstimate);
  const lambda = lm;
  const ancho = ebands[end]! - ebands[end - 1]!;
  const tmp = new Float64Array(ancho << lm);
  const tmp1 = new Float64Array(ancho << lm);
  const metric = new Int32Array(end);

  for (let i = 0; i < end; i++) {
    const width = ebands[i + 1]! - ebands[i]!;
    const n = width << lm;
    // Una banda de un solo bin no se puede partir hasta el final; se le da el
    // punto medio para que no sesgue el Viterbi hacia ningún lado.
    const narrow = width === 1;
    const at = tfChan * n0 + (ebands[i]! << lm);
    for (let j = 0; j < n; j++) tmp[j] = x[at + j]!;

    let bestL1 = l1Metric(tmp, n, isTransient ? lm : 0, bias);
    let bestLevel = 0;

    // El caso «una división MÁS de las que trae la trama»: sólo tiene sentido
    // si ya venimos de sub-tramas cortas.
    if (isTransient && !narrow) {
      for (let j = 0; j < n; j++) tmp1[j] = tmp[j]!;
      haar1(tmp1, 0, n >> lm, 1 << lm);
      const l1 = l1Metric(tmp1, n, lm + 1, bias);
      if (l1 < bestL1) {
        bestL1 = l1;
        bestLevel = -1;
      }
    }

    // Y las reagrupaciones hacia frecuencia, una a una. `tmp` se va
    // transformando en sitio: cada vuelta parte de la anterior, que es
    // justamente la cascada de Haar.
    const niveles = lm + (isTransient || narrow ? 0 : 1);
    for (let k = 0; k < niveles; k++) {
      const b = isTransient ? lm - k - 1 : k + 1;
      haar1(tmp, 0, n >> k, 1 << k);
      const l1 = l1Metric(tmp, n, b, bias);
      if (l1 < bestL1) {
        bestL1 = l1;
        bestLevel = k + 1;
      }
    }

    // En Q1 (por dos) para que el punto medio de una banda estrecha sea entero.
    metric[i] = isTransient ? 2 * bestLevel : -2 * bestLevel;
    if (narrow && (metric[i] === 0 || metric[i] === -2 * lm)) metric[i] = metric[i]! - 1;
  }

  // ── Qué fila de la tabla sale más barata ──────────────────────────────────
  let tfSelect = 0;
  const selCoste = [0, 0];
  for (let sel = 0; sel < 2; sel++) {
    let coste0 = Math.abs(metric[0]! - 2 * row[4 * isTransient + 2 * sel + 0]!);
    let coste1 =
      Math.abs(metric[0]! - 2 * row[4 * isTransient + 2 * sel + 1]!) + (isTransient ? 0 : lambda);
    for (let i = 1; i < end; i++) {
      const curr0 = Math.min(coste0, coste1 + lambda);
      const curr1 = Math.min(coste0 + lambda, coste1);
      coste0 = curr0 + Math.abs(metric[i]! - 2 * row[4 * isTransient + 2 * sel + 0]!);
      coste1 = curr1 + Math.abs(metric[i]! - 2 * row[4 * isTransient + 2 * sel + 1]!);
    }
    selCoste[sel] = Math.min(coste0, coste1);
  }
  // Sólo se deja cambiar de fila en tramas transitorias: en las demás el ahorro
  // no compensa el riesgo de que la resolución baile de trama en trama.
  if (selCoste[1]! < selCoste[0]! && isTransient) tfSelect = 1;

  // ── Viterbi de verdad, ahora con la fila elegida ──────────────────────────
  const path0 = new Int32Array(end);
  const path1 = new Int32Array(end);
  let coste0 = Math.abs(metric[0]! - 2 * row[4 * isTransient + 2 * tfSelect + 0]!);
  let coste1 =
    Math.abs(metric[0]! - 2 * row[4 * isTransient + 2 * tfSelect + 1]!) +
    (isTransient ? 0 : lambda);
  for (let i = 1; i < end; i++) {
    const de0a0 = coste0;
    const de1a0 = coste1 + lambda;
    let curr0: number;
    if (de0a0 < de1a0) {
      curr0 = de0a0;
      path0[i] = 0;
    } else {
      curr0 = de1a0;
      path0[i] = 1;
    }
    const de0a1 = coste0 + lambda;
    const de1a1 = coste1;
    let curr1: number;
    if (de0a1 < de1a1) {
      curr1 = de0a1;
      path1[i] = 0;
    } else {
      curr1 = de1a1;
      path1[i] = 1;
    }
    coste0 = curr0 + Math.abs(metric[i]! - 2 * row[4 * isTransient + 2 * tfSelect + 0]!);
    coste1 = curr1 + Math.abs(metric[i]! - 2 * row[4 * isTransient + 2 * tfSelect + 1]!);
  }
  tfRes[end - 1] = coste0 < coste1 ? 0 : 1;
  for (let i = end - 2; i >= 0; i--) {
    tfRes[i] = tfRes[i + 1] === 1 ? path1[i + 1]! : path0[i + 1]!;
  }

  return { tfSelect, tfRes };
}
