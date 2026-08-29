/**
 * VBR por trama: mover el presupuesto de bits de donde sobra a donde falta.
 *
 * Hasta aquí el reparto era plano —cada trama recibía los mismos bytes— y eso es
 * una decisión, no una neutralidad: quiere decir que la cola de una caja y el
 * golpe siguiente valen lo mismo, y no valen lo mismo. La cola llega tapada por
 * lo que acaba de sonar; el golpe llega descubierto.
 *
 * ## Esto NO toca el formato
 *
 * Conviene decirlo primero, porque es lo que lo hace seguro. Un paquete de Opus
 * no lleva su longitud dentro: la lleva el contenedor, y en Ogg cada paquete
 * mide lo que mide. El decodificador saca `totalBits` de la longitud del paquete
 * que le llega, así que las condiciones de «esto cabe / esto no cabe» que
 * deciden qué símbolos se transmiten —el postfiltro, el transitorio, la
 * dispersión, la inclinación— las calculan los dos lados sobre el MISMO número.
 * Cambiar los bytes de una trama no descoloca nada: cambia el presupuesto de las
 * dos partes a la vez.
 *
 * ## Mover, no gastar menos
 *
 * Ésa es la diferencia entre esto y bajar el bitrate. **El plan se normaliza: la
 * suma de los bytes de todas las tramas es la que habría dado el reparto
 * plano**, byte arriba byte abajo por el redondeo. No es una precaución de
 * estilo — el banco compara contra libopus «al mismo bitrate», y un VBR que
 * gastara de menos ganaría espacio a costa de calidad sin que se viera.
 *
 * (Y se midió lo otro: dejando que ahorre sin devolver nada, la percusión sale
 * un **27 % más pequeña con la misma nota**. Es un resultado bueno y es OTRA
 * cosa —un modo de tamaño objetivo, no un reparto—, así que se anota y no entra
 * aquí.)
 *
 * ## Lo que decide cuánto pide cada trama
 *
 * **La sombra**, y sólo la sombra: cuánto por debajo está la trama del nivel de
 * lo que acaba de sonar, que es lo que la tapa. El enmascarador sube de golpe y
 * baja despacio, a una constante fija en dB por segundo; así una trama fuerte
 * pone el listón y las que vienen detrás se miden contra él. La cola de un 808,
 * el final de una reverb o el hueco entre dos frases caen en sombra, y ahí el
 * ruido de cuantización está tapado por lo de antes.
 *
 * Más el caso extremo: **una trama de silencio digital se lleva el mínimo del
 * formato**. El codificador sólo va a escribir la bandera de silencio y ahí se
 * acaba —lo de detrás no lo lee nadie—, así que darle el reparto entero es tirar
 * un paquete completo por trama, y en una exportación de un DAW eso son los
 * compases vacíos.
 *
 * ## Y lo que se midió y no entró
 *
 * **El refuerzo por transitorio.** Es lo que hace la referencia
 * (`target += 2·(tf_estimate − 0,044)·target`) y parecía lo primero que había que
 * poner. Medido sobre el banco con el mismo `transientAnalysis` que ya decide el
 * bloque corto: solo da +0,19 dB de patrón; sumado a la sombra, **la baja** de
 * +0,52 a +0,22. Tiene sentido a posteriori: la trama del golpe es la más fuerte
 * de su entorno, así que la sombra ya le está dejando todo el presupuesto por no
 * quitárselo; reforzarla otra vez sale del sostenido, que es lo que se oye el
 * resto del tiempo.
 *
 * Antes de eso hubo una versión que medía el ataque a mano, como salto de
 * energía entre sub-bloques de 2,5 ms. En un acorde SOSTENIDO leía entre 2 y
 * 11 dB —los cinco parciales baten entre sí y la energía de 2,5 ms fluctúa de
 * verdad— y repartía el presupuesto al azar sobre una señal estacionaria.
 *
 * **Un suelo global del enmascarador** (que ninguna trama a más de 30 dB del
 * pico del archivo cuente como descubierta). Sale exactamente el mismo número
 * con y sin él, y con 20 dB también: en el banco no hay ninguna entrada lenta
 * que lo active. Un parámetro que no cambia nada no se queda.
 */

/**
 * Qué hace el codificador con el presupuesto de cada trama.
 *
 * `'off'` reparte plano, que es lo que hacía antes; existe para que el banco
 * pueda medir una contra otra.
 */
export type VbrMode = 'adaptive' | 'off';

/**
 * Cuánto baja el enmascarador por segundo, en dB.
 *
 * 120 dB/s son 2,4 dB por trama de 20 ms. El número no es crítico: entre 60 y
 * 240 el resultado del banco se mueve seis centésimas de dB.
 */
export const CAIDA_DB_S = 120;
/** Sombra a partir de la cual ya no se descuenta más, en dB. */
export const SOMBRA_MAX = 24;
/**
 * Cuánto se descuenta como mucho por estar en sombra, en fracción del reparto.
 *
 * Barrido sobre el banco: 0,4 da +0,41 dB de patrón, 0,5 da +0,50, 0,6 da +0,52
 * y 0,7 da +0,49. La curva es plana por arriba.
 *
 * Y el peor caso —el acorde en estéreo, que es lo único que pierde— tampoco pide
 * bajarlo: a 128k sale −0,11 dB con 0,6, −0,15 con 0,45 y −0,17 con 0,3. Recortar
 * el reparto no le devuelve nada y le quita 2,4 dB a la percusión, así que no hay
 * compromiso que buscar.
 */
export const PESO_SOMBRA = 0.6;
/** Suelo y techo del reparto por trama, en fracción del plano. */
export const SUELO = 0.5;
export const TECHO = 1.6;
/** Energía por debajo de la cual el logaritmo ya no dice nada. */
const EPSILON_ENERGIA = 1e-30;
/** Rondas del reparto: cada una fija las tramas que se salieron de los topes. */
const RONDAS = 8;

/** Lo que pide una trama, antes de normalizar. */
export interface DemandaTrama {
  /** Peso relativo: 1 es el reparto plano. */
  peso: number;
  /** Silencio digital: se lleva el mínimo y sale del reparto. */
  muda: boolean;
  /** Cuánto por debajo del enmascarador va la trama, en dB. */
  sombra: number;
  /** Nivel de la trama, en dB. Sólo para poder mirarlo desde el banco. */
  nivel: number;
}

/**
 * Lo que pide cada trama de `pcm`, en orden.
 *
 * Una pasada de análisis sobre el PCM crudo: energía por trama y nada más. Ni
 * MDCT, ni filtros, ni FFT — cuesta una suma de cuadrados por muestra, que al
 * lado de codificar la trama no se nota.
 *
 * La última trama se completa con ceros igual que en el codificador, para que
 * las dos vean lo mismo.
 */
export function vbrDemandas(
  pcm: Float64Array | Float32Array,
  frameSize: number,
  channels: number,
): DemandaTrama[] {
  const total = Math.floor(pcm.length / channels);
  const salida: DemandaTrama[] = [];
  const caida = (CAIDA_DB_S * frameSize) / 48000;

  let enmascarador = -Infinity;
  let primera = true;

  for (let start = 0; start < total; start += frameSize) {
    let energia = 0;
    let muda = true;
    const hasta = Math.min(start + frameSize, total);
    for (let at = start; at < hasta; at++) {
      for (let c = 0; c < channels; c++) {
        const v = pcm[at * channels + c]!;
        if (v !== 0) muda = false;
        energia += v * v;
      }
    }
    // El divisor es `frameSize` y no lo que había de verdad: la última trama se
    // rellena con ceros en el codificador, y aquí tiene que pesar igual.
    const nivel = 10 * Math.log10(energia / (frameSize * channels) + EPSILON_ENERGIA);

    if (muda) {
      // El enmascarador sigue cayendo: un silencio no baja el listón a cero de
      // golpe, sigue tapado un rato por lo que sonaba antes.
      enmascarador -= caida;
      salida.push({ peso: 0, muda: true, sombra: 0, nivel });
      continue;
    }

    if (primera) enmascarador = nivel;
    const sombra = Math.max(0, Math.min(SOMBRA_MAX, enmascarador - nivel));
    enmascarador = Math.max(nivel, enmascarador - caida);
    primera = false;

    const peso = 1 - (PESO_SOMBRA * sombra) / SOMBRA_MAX;
    salida.push({
      peso: Math.max(SUELO, Math.min(TECHO, peso)),
      muda: false,
      sombra,
      nivel,
    });
  }
  return salida;
}

/**
 * Bytes de la trama CELT de cada trama, ya normalizados.
 *
 * `base` son los bytes del reparto plano y `minimo` el suelo del formato. La
 * suma de la salida es `base · tramas` — y cuando no lo es, es porque los topes
 * no dejan, no porque se haya escapado.
 *
 * El reparto va en rondas: se escala por peso, se fijan las tramas que se
 * salieron del suelo o del techo, y se vuelve a repartir lo que queda entre las
 * demás. Es un llenado por niveles y converge en dos o tres pasadas.
 */
export function vbrPlan(
  pcm: Float64Array | Float32Array,
  frameSize: number,
  channels: number,
  base: number,
  minimo: number,
): Int32Array {
  const demandas = vbrDemandas(pcm, frameSize, channels);
  const n = demandas.length;
  const bytes = new Int32Array(n);
  if (n === 0) return bytes;

  const suelo = Math.max(minimo, Math.floor(SUELO * base));
  const techo = Math.min(1275, Math.ceil(TECHO * base));

  let restante = base * n;
  let libres: number[] = [];
  for (let i = 0; i < n; i++) {
    if (demandas[i]!.muda) {
      bytes[i] = minimo;
      restante -= minimo;
    } else {
      libres.push(i);
    }
  }

  for (let ronda = 0; ronda < RONDAS && libres.length > 0; ronda++) {
    let sumaPesos = 0;
    for (const i of libres) sumaPesos += demandas[i]!.peso;
    if (sumaPesos <= 0) break;
    const escala = restante / sumaPesos;
    const siguen: number[] = [];
    let fijado = 0;
    for (const i of libres) {
      const v = Math.round(demandas[i]!.peso * escala);
      if (v < suelo) {
        bytes[i] = suelo;
        fijado += suelo;
      } else if (v > techo) {
        bytes[i] = techo;
        fijado += techo;
      } else {
        bytes[i] = v;
        siguen.push(i);
      }
    }
    if (siguen.length === libres.length) {
      libres = siguen;
      break;
    }
    restante -= fijado;
    libres = siguen;
  }

  // El resto del redondeo, byte a byte, empezando por quien más pidió —o por
  // quien menos, si hay que quitar—. Sin esto el archivo se iría unas decenas de
  // bytes: no se oyen, pero sí se ven al comparar tamaños, y entonces la
  // comparación con libopus deja de ser al mismo bitrate.
  let resto = base * n;
  for (let i = 0; i < n; i++) resto -= bytes[i]!;
  if (resto !== 0) {
    const orden = libres
      .slice()
      .sort((a, b) =>
        resto > 0 ? demandas[b]!.peso - demandas[a]!.peso : demandas[a]!.peso - demandas[b]!.peso,
      );
    for (let paso = 0; paso < 4 && resto !== 0; paso++) {
      for (const i of orden) {
        if (resto === 0) break;
        if (resto > 0 && bytes[i]! < techo) {
          bytes[i] = bytes[i]! + 1;
          resto--;
        } else if (resto < 0 && bytes[i]! > suelo) {
          bytes[i] = bytes[i]! - 1;
          resto++;
        }
      }
    }
  }
  return bytes;
}
