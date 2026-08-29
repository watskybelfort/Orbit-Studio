/** Filtros: SVF TPT (Zavalishin) para sintes y biquads RBJ para EQ. */

// Tiempo de suavizado de coeficientes al automatizar (curva de corte, LFO
// sobre un EQ, la perilla girando). Sin esto cada `set()`/recálculo aplica el
// coeficiente nuevo de golpe, y como el kernel llama a `setParams` una vez por
// bloque (hasta 128 samples, ver MAX_BLOCK en kernel-core.ts), ese salto es
// una discontinuidad real en la respuesta del filtro: zipper noise. 5 ms es
// bastante rápido para seguir un barrido de mano y sobra para tapar el
// escalón de un bloque (~2.9 ms a 44.1 kHz); es el mismo orden que ya usan
// AutofilterUnit/GateUnit para su ataque (timeCoef(0.005, sr) en effects.ts).
export const COEF_SMOOTH_SECONDS = 0.005;

/**
 * De dónde viene el valor nuevo de un coeficiente. Son DOS clases de llamante
 * con necesidades OPUESTAS, y por eso hay que declararlo al construir el
 * filtro en vez de decidirlo llamada a llamada:
 *
 * - `'per-block'` (por defecto) — el kernel empuja `setParams()` UNA vez por
 *   bloque (MAX_BLOCK = 128 muestras): automatización, LFO sobre un EQ, la
 *   perilla girando. Lo que llega es una escalera, y el suavizado de arriba es
 *   el que rellena los escalones. Sin él: zipper noise. Aquí el suavizado NO
 *   se toca.
 * - `'per-sample'` — el llamante ya calcula el valor muestra a muestra desde
 *   algo continuo (el ADSR de filtro de SynthVoice/PrismaVoice, el LFO + el
 *   seguidor de envolvente de AutofilterUnit). No hay escalón que rellenar: lo
 *   único que aporta el one-pole de 5 ms es RETRASO, apilado encima de una
 *   envolvente cuyo ataque por defecto también son 5 ms. Es lo que le comía el
 *   punch al pluck del Orbit Synth: medido a 44,1 kHz, el corte llegaba al
 *   90 % del brillo en 6,37 ms en vez de los 3,42 ms de la referencia sin
 *   suavizar, y en el render del fixture `inst-synth-sweep` en 8,03 ms en vez
 *   de 5,42 (ver `test/dsp-per-sample-smoothing.test.ts`, que lo mide con
 *   estas mismas clases).
 *
 * Ojo, y es la parte que se pierde si no queda escrita: un filtro
 * `'per-sample'` deja de amortiguar a SU llamante, así que el llamante se hace
 * cargo de suavizar los parámetros que SÍ le llegan por bloque. SynthVoice y
 * PrismaVoice no tienen ninguno (su cutoff/resonancia se fijan al nacer la voz
 * y no se vuelven a tocar: `pushInstrumentParams` de kernel-core.ts solo
 * alcanza a PluginVoice), pero AutofilterUnit sí —su `cutoff`/`resonance`
 * salen de `setParams()`— y por eso desliza esos dos él mismo antes de
 * multiplicarlos por su modulación. Ver `AutofilterUnit.process` en effects.ts.
 *
 * Lo que NO es esto: la guarda de umbral del 0,2 % que rodea a esas llamadas.
 * Esa ahorra CPU cuando el corte está quieto y está bien puesta, pero está
 * medido que durante un ataque de 5 ms el corte se mueve más del 0,2 % en
 * casi todas las muestras, así que no quitaba ni un microsegundo de retraso.
 * Son cosas distintas y las dos siguen ahí.
 *
 * El mecanismo, a propósito, es que `smoothCoef` se quede en 0: la línea de
 * `tick()` que desliza (`v = target + coef * (v - target)`) pasa a ser la
 * identidad `v = target`, sin ramas nuevas en el bucle de audio ni una
 * segunda copia de las fórmulas de coeficientes que mantener en sincronía.
 *
 * Quién lo pide hoy: los tres SVF de SynthVoice, PrismaVoice y AutofilterUnit.
 * `Biquad` acepta el modo por simetría y porque el próximo llamante por
 * muestra no tiene por qué redescubrir esto, pero HOY no lo usa nadie, y no es
 * un descuido: los dos biquads que parecen candidatos no lo son. Los del
 * `FormantOsc` de prisma-voice.ts reciben la vocal cuantizada a 1/64 —una
 * escalera, justo lo que el suavizado rellena— y los `Allpass1` del phaser los
 * mueve un LFO de ~1 s, donde 5 ms de retraso sobre la muesca no se oyen
 * mientras que `depth`/`stages` sí llegan por bloque.
 */
export type CoefSource = 'per-block' | 'per-sample';

// Flush de denormales (mismo mecanismo que reverb.ts, y por la misma razón:
// el estado recursivo de estos tres filtros decae hacia cero sin llegar
// nunca cuando la nota suelta o el efecto se queda en silencio). Biquad es
// StripEq (kernel-core.ts:2469-2499) y corre en CADA canal del mixer todo el
// tiempo — el peor caso aquí no es un efecto ocasional, es el EQ por
// defecto de cada pista. Medido (ver packages/engine/test/dsp-denormal.test.ts
// y el benchmark aparte): un Biquad resonante (Q=8) sin flush, tras soltar la
// señal, no solo pasa por denormal — con dos polos complejos el estado
// entra en un CICLO LÍMITE dentro del rango subnormal de float64 y se queda
// ahí para siempre (jamás llega a 0 exacto), costando ~5-9x el ns/muestra
// base de forma indefinida. Con esta DC el punto fijo al que converge —
// eps/(1+a1+a2) en Biquad, eps/(2g) en SVF, eps/(1+a) en Allpass1— se midió
// numéricamente contra el rango real de frecuencia/Q del motor: el peor caso
// encontrado (highShelf a 1 Hz con -18 dB, muy por fuera de lo que expone la
// UI) da ~1.6e-12, 27 000 veces por debajo del piso de 24 bits (~6e-8).
const ANTI_DENORMAL = 1e-20;

export class SVF {
  private ic1eq = 0;
  private ic2eq = 0;
  // g y k son los parámetros TPT (frecuencia prewarpeada y 1/Q), no
  // coeficientes crudos de un biquad de forma directa: la estructura TPT de
  // Zavalishin es incondicionalmente estable para cualquier g,k > 0 (viene de
  // integrar un prototipo analógico pasivo por trapecio), así que deslizar g
  // y k linealmente jamás cruza un estado inestable — no hay "hueco" que
  // evitar, a diferencia de un biquad de forma directa.
  private g = 0;
  private k = 1;
  private gTarget = 0;
  private kTarget = 1;
  private smoothCoef = 0;
  private primed = false;
  /** Ver `CoefSource`: false = el llamante ya modula por muestra, no suavizar. */
  private readonly smooths: boolean;

  constructor(source: CoefSource = 'per-block') {
    this.smooths = source !== 'per-sample';
  }

  /** res 0..1 → Q 0.5..10. */
  set(cutoff: number, res: number, sr: number): void {
    const fc = Math.min(cutoff, sr * 0.49);
    this.gTarget = Math.tan(Math.PI * (fc / sr));
    const q = 0.5 + res * 9.5;
    this.kTarget = 1 / q;
    // Con un llamante por muestra `smoothCoef` se queda en 0 y `tick()` copia
    // el objetivo tal cual; de paso se ahorra este `Math.exp` por MUESTRA, que
    // es justo el que la guarda del 0,2 % venía esquivando a duras penas.
    if (!this.smooths) return;
    this.smoothCoef = timeCoef(COEF_SMOOTH_SECONDS, sr);
    // La primera vez que se configura, aplica de una: no hay "antes" del que
    // deslizar, y así un filtro recién creado responde desde la muestra 0
    // (nada de fundido de entrada en cada nota o en un one-shot de medición).
    if (!this.primed) {
      this.g = this.gTarget;
      this.k = this.kTarget;
      this.primed = true;
    }
  }

  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
  }

  /** type: 0 LP, 1 HP, 2 BP, 3 notch. */
  tick(x: number, type: number): number {
    // `smoothCoef` = 0 (llamante por muestra) deja estas dos líneas en la
    // identidad: g = gTarget, k = kTarget, sin rama que predecir.
    this.g = this.gTarget + this.smoothCoef * (this.g - this.gTarget);
    this.k = this.kTarget + this.smoothCoef * (this.k - this.kTarget);
    const { g, k } = this;
    const v1 = (this.ic1eq + g * (x - this.ic2eq)) / (1 + g * (g + k));
    const v2 = this.ic2eq + g * v1;
    this.ic1eq = 2 * v1 - this.ic1eq + ANTI_DENORMAL;
    this.ic2eq = 2 * v2 - this.ic2eq;
    switch (type | 0) {
      case 1: return x - k * v1 - v2;
      case 2: return v1;
      // Notch = LP + HP = x - k·v1. El BP (v1) tiene ganancia Q en resonancia,
      // así que restar v1 CRUDO amplificaba la banda en vez de vaciarla (a res
      // alta salía un pico de +19 dB donde debía haber una muesca).
      case 3: return x - k * v1;
      default: return v2;
    }
  }
}

/**
 * Biquad transposed direct form II.
 *
 * Los coeficientes vivos (b0..a2, públicos) se deslizan hacia el objetivo
 * calculado por cada diseño (lowpass/highpass/peaking/…) en vez de aplicarse
 * de golpe. Es seguro interpolarlos EN CRUDO —sin pasar por frecuencia/Q—
 * porque la región de estabilidad de un biquad normalizado (a0=1) es el
 * triángulo clásico |a2|<1, |a1|<1+a2, y un triángulo es convexo: cualquier
 * combinación lineal entre dos coeficientes estables cae dentro del mismo
 * triángulo, nunca fuera. Como las fórmulas RBJ (Q>0) siempre producen un
 * punto estable, deslizar linealmente entre dos diseños válidos no puede
 * pasar por un estado inestable en ningún punto del camino.
 */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private b0T = 1; private b1T = 0; private b2T = 0; private a1T = 0; private a2T = 0;
  private z1 = 0;
  private z2 = 0;
  private smoothCoef = 0;
  private primed = false;
  /** Ver `CoefSource`: false = el llamante ya modula por muestra, no suavizar. */
  private readonly smooths: boolean;

  constructor(source: CoefSource = 'per-block') {
    this.smooths = source !== 'per-sample';
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  tick(x: number): number {
    // c = 0 (llamante por muestra) deja las cinco líneas de abajo en la
    // identidad: el coeficiente vivo ES el objetivo.
    const c = this.smoothCoef;
    this.b0 = this.b0T + c * (this.b0 - this.b0T);
    this.b1 = this.b1T + c * (this.b1 - this.b1T);
    this.b2 = this.b2T + c * (this.b2 - this.b2T);
    this.a1 = this.a1T + c * (this.a1 - this.a1T);
    this.a2 = this.a2T + c * (this.a2 - this.a2T);
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2 + ANTI_DENORMAL;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** Fija el objetivo (y, la primera vez, el valor vivo) y arma el deslizamiento. */
  private commit(sr: number): this {
    if (!this.smooths) return this;
    this.smoothCoef = timeCoef(COEF_SMOOTH_SECONDS, sr);
    if (!this.primed) {
      this.b0 = this.b0T; this.b1 = this.b1T; this.b2 = this.b2T;
      this.a1 = this.a1T; this.a2 = this.a2T;
      this.primed = true;
    }
    return this;
  }

  /** Copia el objetivo (y el vivo, y el ritmo de deslizamiento) de `o`, para
   * mantener un par L/R en el mismo punto exacto de la rampa. */
  copyFrom(o: Biquad): void {
    this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2;
    this.a1 = o.a1; this.a2 = o.a2;
    this.b0T = o.b0T; this.b1T = o.b1T; this.b2T = o.b2T;
    this.a1T = o.a1T; this.a2T = o.a2T;
    // El ritmo de deslizamiento SÍ se copia, pero no el permiso: si este
    // biquad se declaró `'per-sample'`, copiar el `smoothCoef` de un hermano
    // por bloque le devolvería el suavizado por la puerta de atrás.
    this.smoothCoef = this.smooths ? o.smoothCoef : 0;
    this.primed = o.primed;
  }

  // ── Coeficientes RBJ (Audio EQ Cookbook) ──────────────────────────────────

  lowpass(f: number, q: number, sr: number): this {
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0T = ((1 - cw) / 2) / a0;
    this.b1T = (1 - cw) / a0;
    this.b2T = this.b0T;
    this.a1T = (-2 * cw) / a0;
    this.a2T = (1 - alpha) / a0;
    return this.commit(sr);
  }

  highpass(f: number, q: number, sr: number): this {
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0T = ((1 + cw) / 2) / a0;
    this.b1T = (-(1 + cw)) / a0;
    this.b2T = this.b0T;
    this.a1T = (-2 * cw) / a0;
    this.a2T = (1 - alpha) / a0;
    return this.commit(sr);
  }

  peaking(f: number, db: number, q: number, sr: number): this {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / A;
    this.b0T = (1 + alpha * A) / a0;
    this.b1T = (-2 * cw) / a0;
    this.b2T = (1 - alpha * A) / a0;
    this.a1T = (-2 * cw) / a0;
    this.a2T = (1 - alpha / A) / a0;
    return this.commit(sr);
  }

  lowShelf(f: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const S = 1;
    const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 + (A - 1) * cw + twoSqrtAAlpha;
    this.b0T = (A * (A + 1 - (A - 1) * cw + twoSqrtAAlpha)) / a0;
    this.b1T = (2 * A * (A - 1 - (A + 1) * cw)) / a0;
    this.b2T = (A * (A + 1 - (A - 1) * cw - twoSqrtAAlpha)) / a0;
    this.a1T = (-2 * (A - 1 + (A + 1) * cw)) / a0;
    this.a2T = (A + 1 + (A - 1) * cw - twoSqrtAAlpha) / a0;
    return this.commit(sr);
  }

  highShelf(f: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const S = 1;
    const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 - (A - 1) * cw + twoSqrtAAlpha;
    this.b0T = (A * (A + 1 + (A - 1) * cw + twoSqrtAAlpha)) / a0;
    this.b1T = (-2 * A * (A - 1 + (A + 1) * cw)) / a0;
    this.b2T = (A * (A + 1 + (A - 1) * cw - twoSqrtAAlpha)) / a0;
    this.a1T = (2 * (A - 1 - (A + 1) * cw)) / a0;
    this.a2T = (A + 1 - (A - 1) * cw - twoSqrtAAlpha) / a0;
    return this.commit(sr);
  }
}

/**
 * Allpass de primer orden (phaser). El coeficiente `a` vive siempre en
 * (-1, 1) —es tan((0,π/2)) mapeado por (t-1)/(t+1)—, un intervalo convexo, así
 * que deslizarlo en crudo tampoco puede pasar por un valor inestable.
 */
export class Allpass1 {
  private z = 0;
  a = 0;
  private aTarget = 0;
  private smoothCoef = 0;
  private primed = false;

  set(f: number, sr: number): void {
    const t = Math.tan((Math.PI * Math.min(f, sr * 0.49)) / sr);
    this.aTarget = (t - 1) / (t + 1);
    this.smoothCoef = timeCoef(COEF_SMOOTH_SECONDS, sr);
    if (!this.primed) {
      this.a = this.aTarget;
      this.primed = true;
    }
  }

  tick(x: number): number {
    this.a = this.aTarget + this.smoothCoef * (this.a - this.aTarget);
    const y = this.a * x + this.z;
    this.z = x - this.a * y + ANTI_DENORMAL;
    return y;
  }
}

/** Seguidor de envolvente (detector peak con attack/release). */
export class EnvFollower {
  value = 0;

  tick(x: number, attackCoef: number, releaseCoef: number): number {
    const a = Math.abs(x);
    const coef = a > this.value ? attackCoef : releaseCoef;
    this.value = a + coef * (this.value - a);
    return this.value;
  }
}

/** Coeficiente de suavizado one-pole a partir de un tiempo en segundos. */
export function timeCoef(seconds: number, sr: number): number {
  return Math.exp(-1 / (Math.max(0.0001, seconds) * sr));
}
