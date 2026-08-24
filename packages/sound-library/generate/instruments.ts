/**
 * Instrumentos con altura para el pack de fábrica "Orbit Essentials".
 *
 * Módulo de síntesis PURA (sin fs, sin WAV): cada spec expone `render(sr)` y
 * el orquestador (generate.ts) lo integra — escribe el archivo, normaliza a
 * -1 dBFS y registra la entrada del manifest con id "instrumentos/<slug>".
 *
 * Cada instrumento se graba a VARIAS alturas —su registro natural y una octava
 * a cada lado— y el pack las reparte por el teclado con un keymap. Estirar una
 * sola muestra no transpone un instrumento: cambia la velocidad de lectura, y
 * con ella se mueven las formantes y el ataque. Un piano grabado en do suena a
 * ratón dos octavas arriba, y eso es lo que esto viene a quitar.
 *
 * La altura entra por `render(sr, rootHz)`. Sin ella sale la del registro
 * natural del instrumento, que es exactamente el sample de siempre.
 *
 * Determinista: cero Math.random — todos los ruidos/excitaciones salen de
 * mulberry32 sembrado con el hash FNV-1a del slug Y de la altura. Dos renders
 * del mismo spec a la misma altura son idénticos bit a bit; dos alturas del
 * mismo instrumento estrenan ruido, o sonarían enganchadas al tocar juntas.
 *
 * Calidad: fade-in de 3 ms y fade-out de 40 ms en todo (sin clicks), pico
 * interno ~0.9 (el orquestador renormaliza igualmente), estéreo por
 * desafinaciones suaves L/R o paneo de potencia constante (mono-compatible,
 * nada de trucos de fase) y bajos en mono (regla de low-end mono del repo).
 */

// ── Tipos públicos ───────────────────────────────────────────────────────────

/** Subcategorías del browser para instrumentos con altura. */
export type InstrumentSubcategory =
  | 'teclas'
  | 'cuerdas'
  | 'bajos'
  | 'leads'
  | 'pads'
  | 'campanas';

/** Par de canales renderizados (misma longitud, la sample rate la fija render). */
export interface StereoRender {
  left: Float32Array;
  right: Float32Array;
}

export interface InstrumentSpec {
  /** Id relativo, ej. "piano-suave" (el orquestador antepone "instrumentos/"). */
  slug: string;
  /** Nombre visible, ej. "Piano Suave". */
  name: string;
  /** Subcategoría del browser: "teclas" | "cuerdas" | "bajos" | "leads" | "pads" | "campanas". */
  subcategory: InstrumentSubcategory;
  tags: string[];
  /** Nota raíz del sample. */
  keyRoot: string;
  /** Frecuencia de la nota raíz en Hz. */
  rootHz: number;
  /** Ganancia sugerida al cargar (0.5..1). */
  gainSuggestion: number;
  /**
   * Sintetiza el sample: estéreo a la sample rate dada.
   *
   * `rootHz` es la altura a la que se graba esta toma. Sin él sale la del
   * registro natural del instrumento (`spec.rootHz`), que es exactamente el
   * sample de siempre — el pack multisample pide las otras alturas a mano.
   */
  render(sampleRate: number, rootHz?: number): StereoRender;
}

/**
 * Las alturas a las que se graba un instrumento: su registro natural y una
 * octava a cada lado.
 *
 * Tres y no una porque estirar una muestra no transpone un instrumento: cambia
 * la velocidad de lectura, y con ella se mueven las formantes y el ataque. Tres
 * y no diez porque cada zona cubre así media octava a cada lado de su raíz, que
 * es donde el estiramiento todavía no se oye — y porque cada altura más son
 * veinticuatro archivos más en el instalador.
 */
export function rootsFor(spec: InstrumentSpec): number[] {
  return [spec.rootHz / 2, spec.rootHz, spec.rootHz * 2];
}

/** Nota MIDI de una frecuencia (la 440 = 69). */
export function midiDeHz(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

// ── Constantes de afinación ──────────────────────────────────────────────────

const TAU = Math.PI * 2;
const HZ_C2 = 65.41;
const HZ_C3 = 130.81;
const HZ_C4 = 261.63;
const HZ_C5 = 523.25;

/** Relación de frecuencias para un desvío en centésimas de semitono. */
function centavos(c: number): number {
  return Math.pow(2, c / 1200);
}

// ── PRNG determinista ────────────────────────────────────────────────────────

/** Hash FNV-1a de 32 bits: semilla estable a partir del slug. */
function hashSlug(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Semilla de UNA toma concreta: el instrumento y la altura a la que se graba.
 *
 * La altura entra en la semilla a propósito. Las tres tomas de un pad comparten
 * slug, y con la semilla vieja compartían también las desafinaciones, las fases
 * de arranque y las frecuencias de la deriva lenta: al sonar juntas en el
 * teclado no sonaban a sección, sonaban a una sola fuente doblada, porque su
 * "respiración" iba enganchada. Se redondea a centésimas de Hz para que la
 * semilla no dependa del ruido del punto flotante.
 */
function semillaDe(slug: string, f0: number): number {
  return hashSlug(`${slug}@${Math.round(f0 * 100)}`);
}

/** mulberry32: PRNG rápido y determinista; devuelve [0, 1). */
function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Osciladores de tabla (banda limitada, sin alias) ─────────────────────────

const TAM_TABLA = 4096;
const cacheTablas = new Map<string, Float32Array>();

/** Tabla aditiva de un ciclo, normalizada a pico 1 y cacheada por clave. */
function tablaAditiva(
  clave: string,
  parciales: number,
  amplitud: (n: number) => number,
): Float32Array {
  const guardada = cacheTablas.get(clave);
  if (guardada) return guardada;
  const t = new Float32Array(TAM_TABLA);
  for (let n = 1; n <= parciales; n++) {
    const a = amplitud(n);
    if (a === 0) continue;
    for (let i = 0; i < TAM_TABLA; i++) {
      t[i] = t[i]! + a * Math.sin((TAU * n * i) / TAM_TABLA);
    }
  }
  let pico = 0;
  for (let i = 0; i < TAM_TABLA; i++) {
    const v = Math.abs(t[i]!);
    if (v > pico) pico = v;
  }
  if (pico > 0) {
    for (let i = 0; i < TAM_TABLA; i++) t[i] = t[i]! / pico;
  }
  cacheTablas.set(clave, t);
  return t;
}

function tablaSierra(parciales: number): Float32Array {
  return tablaAditiva(`sierra-${parciales}`, parciales, (n) => 1 / n);
}

/**
 * Nº de parciales para una raíz: banda limitada y al Nyquist.
 *
 * El tope sube de 12 a 14 kHz con el pack multisample, y es la mejora que
 * viene gratis: el margen existía para que el sampler pudiera repitchear hacia
 * arriba sin alias grosero, y con una raíz por octava el estiramiento hacia
 * arriba es de media octava (×1,41) en vez de tres octavas. 14 kHz × 1,41 son
 * 19,8 kHz, todavía por debajo del Nyquist de 44,1. Y el tamaño del archivo no
 * cambia: en PCM depende de la duración, no del ancho de banda.
 */
function parcialesPara(f0: number, sr: number): number {
  const tope = Math.min(14000, sr * 0.42);
  return Math.max(8, Math.min(120, Math.floor(tope / f0)));
}

/** Lectura de tabla con interpolación lineal; `fase` en ciclos (0..1 se repite). */
function leerTabla(tabla: Float32Array, fase: number): number {
  const p = (fase - Math.floor(fase)) * TAM_TABLA;
  const i = p | 0;
  const f = p - i;
  const a = tabla[i]!;
  const b = tabla[(i + 1) & (TAM_TABLA - 1)]!;
  return a + (b - a) * f;
}

/** Pulso de ancho variable como resta de dos sierras (media cero, sin DC). */
function leerPulso(sierra: Float32Array, fase: number, ancho: number): number {
  return 0.5 * (leerTabla(sierra, fase) - leerTabla(sierra, fase + ancho));
}

// ── Filtros ──────────────────────────────────────────────────────────────────

/** Paso bajo de un polo (6 dB/oct): suavizados, excitaciones y cuerpos cálidos. */
class FiltroLP1 {
  private y = 0;
  constructor(private readonly sr: number) {}
  procesar(x: number, fcHz: number): number {
    const a = 1 - Math.exp((-TAU * fcHz) / this.sr);
    this.y += a * (x - this.y);
    return this.y;
  }
}

/**
 * Filtro de variable de estado TPT (Zavalishin): estable con el cutoff
 * modulado por muestra. Deja lp/bp/hp en campos (sin alocar por muestra).
 */
class FiltroSVF {
  private ic1 = 0;
  private ic2 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  constructor(private readonly sr: number) {}
  procesar(x: number, fcHz: number, q: number): void {
    const g = Math.tan((Math.PI * Math.min(fcHz, this.sr * 0.45)) / this.sr);
    const k = 1 / Math.max(0.4, q);
    const a1 = 1 / (1 + g * (g + k));
    const v1 = a1 * (this.ic1 + g * (x - this.ic2));
    const v2 = this.ic2 + g * v1;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
  }
}

// ── Envolventes y post-procesado ─────────────────────────────────────────────

/** Ataque smoothstep de `ataqueSec` (0 → 1 sin click ni codo duro). */
function envAtaque(t: number, ataqueSec: number): number {
  if (ataqueSec <= 0) return 1;
  const x = t / ataqueSec;
  if (x >= 1) return 1;
  if (x <= 0) return 0;
  return x * x * (3 - 2 * x);
}

/** Meseta hasta `inicioRel` y cola exponencial con constante `relSec`. */
function envSalida(t: number, inicioRel: number, relSec: number): number {
  return t <= inicioRel ? 1 : Math.exp(-(t - inicioRel) / relSec);
}

/** Rampa 0→1 entre `desde` y `desde + dur`: vibratos tardíos, etc. */
function rampa(t: number, desde: number, dur: number): number {
  if (t <= desde) return 0;
  const x = (t - desde) / dur;
  return x >= 1 ? 1 : x;
}

function crearCanales(sr: number, dur: number): { l: Float32Array; r: Float32Array; n: number } {
  const n = Math.max(1, Math.round(dur * sr));
  return { l: new Float32Array(n), r: new Float32Array(n), n };
}

/** Fade-in lineal de 3 ms y fade-out de 40 ms (anti-click en ambos bordes). */
function aplicarFades(l: Float32Array, r: Float32Array, sr: number): void {
  const nIn = Math.min(l.length, Math.max(1, Math.round(0.003 * sr)));
  for (let i = 0; i < nIn; i++) {
    const g = i / nIn; // la primera muestra queda exactamente en 0
    l[i] = l[i]! * g;
    r[i] = r[i]! * g;
  }
  const nOut = Math.min(l.length, Math.max(1, Math.round(0.04 * sr)));
  const desde = l.length - nOut;
  for (let i = 0; i < nOut; i++) {
    const g = 1 - (i + 1) / nOut; // la última muestra queda exactamente en 0
    l[desde + i] = l[desde + i]! * g;
    r[desde + i] = r[desde + i]! * g;
  }
}

/** Normaliza in-place al pico objetivo (~0.9 lineal). */
function normalizarPico(slug: string, l: Float32Array, r: Float32Array, objetivo: number): void {
  let p = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]!);
    const b = Math.abs(r[i]!);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  if (p <= 1e-9) throw new Error(`"${slug}": render en silencio, revisa la síntesis`);
  const g = objetivo / p;
  for (let i = 0; i < l.length; i++) {
    l[i] = l[i]! * g;
    r[i] = r[i]! * g;
  }
}

/** Post común: fades anti-click + pico interno a 0.9. */
function terminar(slug: string, l: Float32Array, r: Float32Array, sr: number): StereoRender {
  aplicarFades(l, r, sr);
  normalizarPico(slug, l, r, 0.9);
  return { left: l, right: r };
}

// ── Familias de síntesis ─────────────────────────────────────────────────────

type Render = (sampleRate: number) => StereoRender;
/**
 * Una fábrica de instrumento: recibe el slug (semilla del PRNG) y la ALTURA
 * a la que hay que grabar esta toma, en Hz.
 *
 * La altura es un parámetro y no una constante desde que el pack es
 * multisample. Antes `rootHz` era solo metadato del manifest y la altura de
 * verdad vivía dentro de cada síntesis: los dos podían dejar de coincidir sin
 * que nada lo notara.
 */
type PorRaiz = (slug: string, f0: number) => Render;

/**
 * Cuánto hay que mover los cortes de filtro de un instrumento SINTÉTICO al
 * grabarlo en otra altura.
 *
 * La regla que separa los dos casos, y que es justo lo que hace que el
 * multisample valga la pena:
 *
 * - En un instrumento SINTÉTICO (pads, leads, órgano, bajos) el filtro es
 *   parte de la voz: sigue a la nota. Dejarlo fijo haría que el pad grave
 *   sonara brillante y el agudo apagado, y el salto se oiría justo al cruzar
 *   el borde entre dos zonas del teclado — el defecto que el multisample viene
 *   a quitar, no a traer.
 * - En un instrumento ACÚSTICO el golpe del martillo, el soplo de la flauta o
 *   el cuerpo de la guitarra son FORMANTES: no se mueven con la nota, y por
 *   eso una muestra estirada suena a ratón. Esos se quedan donde están, que es
 *   la razón de grabar varias alturas en vez de estirar una.
 */
function escalaDe(f0: number, base: number): number {
  return f0 / base;
}

/**
 * Índice de FM que cabe por debajo del Nyquist.
 *
 * La FM reparte energía hasta `f0·ratio·(I+1)` más o menos, y con un modulador
 * 14:1 —el tine clásico de un piano eléctrico— eso se sale del muestreo en
 * cuanto subes de registro: lo que vuelve no suena más agudo, vuelve doblado,
 * como una campanilla metálica que no estaba en el sonido. Se acota el índice
 * a lo que cabe, que es además lo que hace un FM de verdad al subir de octava:
 * las notas altas salen menos brillantes que las bajas.
 */
function indiceQueCabe(indice: number, f0: number, ratio: number, sr: number): number {
  const cabe = (sr * 0.45) / (f0 * ratio) - 1;
  return Math.min(indice, Math.max(0.4, cabe));
}

// — Piano acústico (aditivo con inarmonicidad de cuerda) —

interface OpcionesPiano {
  dur: number;
  parciales: number;
  /** Exponente de caída espectral: menor = más brillante. */
  brillo: number;
  /** Coeficiente B de inarmonicidad (fk = f0·k·√(1 + B·k²)). */
  inarmonicidad: number;
  ataqueSec: number;
  /** Tasa de decaimiento del fundamental (1/s); los agudos caen más rápido. */
  caida: number;
  /** Nivel del golpe de martillo (ruido corto paso-bajo). */
  martillo: number;
}

function piano(o: OpcionesPiano): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, o.dur);
    interface Parcial {
      ampl: number;
      tasa: number;
      wL: number;
      wR: number;
      fase: number;
    }
    const parciales: Parcial[] = [];
    for (let k = 1; k <= o.parciales; k++) {
      const fk = f0 * k * Math.sqrt(1 + o.inarmonicidad * k * k);
      if (fk > sr * 0.45) break;
      // ±0.6 cent opuesto por canal: batido de cuerdas y ancho suave mono-compatible.
      const des = (rng() - 0.5) * 1.2;
      parciales.push({
        ampl: 1 / Math.pow(k, o.brillo),
        tasa: o.caida * (1 + 0.16 * (k - 1)),
        wL: (TAU * fk * centavos(des)) / sr,
        wR: (TAU * fk * centavos(-des)) / sr,
        fase: rng() * TAU,
      });
    }
    const lpMartillo = new FiltroLP1(sr);
    const nMartillo = Math.round(0.01 * sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let xl = 0;
      let xr = 0;
      for (const p of parciales) {
        const e = p.ampl * Math.exp(-p.tasa * t);
        xl += e * Math.sin(p.fase + p.wL * i);
        xr += e * Math.sin(p.fase + p.wR * i);
      }
      if (i < nMartillo) {
        const golpe =
          lpMartillo.procesar(rng() * 2 - 1, 3200) * o.martillo * Math.exp(-t / 0.004) * 4;
        xl += golpe;
        xr += golpe;
      }
      const env = envAtaque(t, o.ataqueSec) * envSalida(t, o.dur - 0.35, 0.12);
      l[i] = xl * env;
      r[i] = xr * env;
    }
    return terminar(slug, l, r, sr);
  };
}

// — Piano eléctrico (FM 2-op: tine 14:1 + cuerpo 1:1) —

interface OpcionesEP {
  dur: number;
  /** Ratio del modulador del "tine" (clásico 14:1). */
  ratio: number;
  /** Índice FM inicial del tine (el brillo del golpe). */
  indice: number;
  /** Constante de caída del índice (s): qué tan rápido se apaga el brillo. */
  caidaIndice: number;
  nivelTine: number;
  nivelCuerpo: number;
  /** Índice FM 1:1 del cuerpo (calidez). */
  indiceCuerpo: number;
  /** Trémolo de paneo (Hz): potencia constante, mono-compatible. */
  tremoloHz: number;
  tremoloProf: number;
  /** Drive tanh para el EP sucio. */
  saturacion?: number;
}

function pianoElectrico(o: OpcionesEP): PorRaiz {
  return (slug, f0) => (sr) => {
    const { l, r, n } = crearCanales(sr, o.dur);
    const indiceTine = indiceQueCabe(o.indice, f0, o.ratio, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const fase = TAU * f0 * t;
      const iTine = indiceTine * Math.exp(-t / o.caidaIndice);
      const tine = Math.sin(fase + iTine * Math.sin(o.ratio * fase)) * Math.exp(-1.5 * t);
      const iCuerpo = o.indiceCuerpo * Math.exp(-0.9 * t);
      const cuerpo = Math.sin(fase + iCuerpo * Math.sin(fase)) * Math.exp(-0.75 * t);
      let x = o.nivelTine * tine + o.nivelCuerpo * cuerpo;
      x *= envAtaque(t, 0.003) * envSalida(t, o.dur - 0.35, 0.12);
      if (o.saturacion !== undefined) x = Math.tanh(x * o.saturacion) / Math.tanh(o.saturacion);
      const lfo = o.tremoloProf * Math.sin(TAU * o.tremoloHz * t);
      l[i] = x * Math.SQRT1_2 * (1 + lfo);
      r[i] = x * Math.SQRT1_2 * (1 - lfo);
    }
    return terminar(slug, l, r, sr);
  };
}

// — Guitarra (Karplus-Strong con filtro de pérdida en el lazo) —

interface VozCuerda {
  /** Desvío del largo del buffer en muestras (0, +1... = desafinación de coro). */
  offsetMuestras: number;
  /** Paneo -1..1 (equal power). */
  pan: number;
  nivel: number;
}

interface OpcionesCuerda {
  dur: number;
  /** Ganancia del lazo por vuelta: controla el sustain (0.94 corto..0.99 largo). */
  perdida: number;
  /** 0..1: peso del promedio de dos muestras — más = agudos que mueren antes. */
  amortiguacion: number;
  /** Cutoff (Hz) del paso-bajo que conforma la excitación de ruido. */
  brilloExcHz: number;
  voces: VozCuerda[];
  /** Transitorio de púa: ruido de 2 ms. */
  click?: number;
  /** Paso-bajo de salida para cuerpo cálido (Hz). */
  lpSalidaHz?: number;
}

/** Una cuerda KS: buffer de retardo + pérdida + promedio (paso-bajo del lazo). */
function vozKS(
  sr: number,
  nMuestras: number,
  f0: number,
  perdida: number,
  amortiguacion: number,
  brilloExcHz: number,
  offsetMuestras: number,
  rng: () => number,
): Float32Array {
  // Periodo EXACTO, con parte fraccionaria. Con el retardo redondeado a
  // muestras enteras la cuerda sale desafinada, y lo grave del asunto es que
  // sale desafinada de FORMA DISTINTA en cada altura: media muestra son 0,7
  // cents en C2 y 2,6 en C4, así que un instrumento hecho de tres tomas
  // quedaba desafinado consigo mismo y el salto se oía al cruzar de zona.
  // Se descuenta además el retardo del filtro de pérdida (media muestra por
  // cada unidad de amortiguación), que es lo que dejaba la cuerda plana.
  const periodo = Math.max(3, sr / f0 - amortiguacion * 0.5 + offsetMuestras);
  const N = Math.ceil(periodo) + 1;
  const buf = new Float32Array(N);
  // Excitación: ruido blanco conformado por un paso-bajo, sin componente DC.
  const lpExc = new FiltroLP1(sr);
  let media = 0;
  for (let i = 0; i < N; i++) {
    const v = lpExc.procesar(rng() * 2 - 1, brilloExcHz);
    buf[i] = v;
    media += v;
  }
  media /= N;
  for (let i = 0; i < N; i++) buf[i] = buf[i]! - media;

  const entero = Math.floor(periodo);
  const frac = periodo - entero;
  const out = new Float32Array(nMuestras);
  let previo = 0;
  let escribe = 0;
  for (let i = 0; i < nMuestras; i++) {
    // Retardo fraccionario por interpolación lineal entre las dos muestras que
    // rodean el periodo exacto. La interpolación es en sí un paso-bajo suave,
    // que en una cuerda pulsada es exactamente lo que ya hace el lazo.
    const a = escribe - entero >= 0 ? escribe - entero : escribe - entero + N;
    const b = a - 1 >= 0 ? a - 1 : a - 1 + N;
    const y = buf[a]! * (1 - frac) + buf[b]! * frac;
    out[i] = y;
    // Filtro de pérdida: mezcla entre la muestra cruda (brillante) y el
    // promedio de dos (oscuro), todo escalado por la pérdida del lazo.
    buf[escribe] = perdida * ((1 - amortiguacion) * y + amortiguacion * 0.5 * (y + previo));
    previo = y;
    escribe = escribe + 1 === N ? 0 : escribe + 1;
  }
  return out;
}

function guitarra(o: OpcionesCuerda): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, o.dur);
    for (const voz of o.voces) {
      const cuerda = vozKS(
        sr, n, f0, o.perdida, o.amortiguacion, o.brilloExcHz, voz.offsetMuestras, rng,
      );
      const ang = ((voz.pan + 1) * Math.PI) / 4;
      const gl = Math.cos(ang) * voz.nivel;
      const gr = Math.sin(ang) * voz.nivel;
      for (let i = 0; i < n; i++) {
        l[i] = l[i]! + cuerda[i]! * gl;
        r[i] = r[i]! + cuerda[i]! * gr;
      }
    }
    if (o.click !== undefined) {
      const nClick = Math.min(n, Math.round(0.002 * sr));
      for (let i = 0; i < nClick; i++) {
        const c = (rng() * 2 - 1) * o.click * (1 - i / nClick);
        l[i] = l[i]! + c;
        r[i] = r[i]! + c;
      }
    }
    // Cierre de la cola + cuerpo cálido opcional.
    const fcSalida = o.lpSalidaHz;
    const lpL = new FiltroLP1(sr);
    const lpR = new FiltroLP1(sr);
    for (let i = 0; i < n; i++) {
      const cierre = envSalida(i / sr, o.dur - 0.3, 0.1);
      let xl = l[i]! * cierre;
      let xr = r[i]! * cierre;
      if (fcSalida !== undefined) {
        xl = lpL.procesar(xl, fcSalida);
        xr = lpR.procesar(xr, fcSalida);
      }
      l[i] = xl;
      r[i] = xr;
    }
    return terminar(slug, l, r, sr);
  };
}

// — Bajos (mono deliberado: low-end mono, regla del repo) —

interface OpcionesBajoSub {
  dur: number;
  /** Envolvente del filtro: cutoff inicial → final (Hz) con constante tEnv (s). */
  fcIni: number;
  fcFin: number;
  tEnv: number;
  q: number;
  /** Meseta de la amplitud (s) antes de la cola. */
  sostenido: number;
  rel: number;
  ataqueSec: number;
  /** Transitorio de púa (ruido corto). */
  click?: number;
}

function bajoSustractivo(o: OpcionesBajoSub): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const escala = escalaDe(f0, HZ_C2);
    const { l, r, n } = crearCanales(sr, o.dur);
    const sierra = tablaSierra(parcialesPara(f0, sr));
    const svf = new FiltroSVF(sr);
    const lpClick = new FiltroLP1(sr);
    const nClick = o.click !== undefined ? Math.min(n, Math.round(0.004 * sr)) : 0;
    let fase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let x = leerTabla(sierra, fase);
      fase += f0 / sr;
      if (i < nClick && o.click !== undefined) {
        x += lpClick.procesar(rng() * 2 - 1, 5000) * o.click * (1 - i / nClick) * 3;
      }
      // La envolvente de filtro es la articulación de la nota, no el cuerpo
      // del bajo: sigue a la altura. Fija, un bajo grabado en C3 acababa con
      // el corte por debajo de su propio fundamental y salía tapado.
      const fc = (o.fcFin + (o.fcIni - o.fcFin) * Math.exp(-t / o.tEnv)) * escala;
      svf.procesar(x, fc, o.q);
      const y = svf.lp * envAtaque(t, o.ataqueSec) * envSalida(t, o.sostenido, o.rel);
      l[i] = y;
      r[i] = y;
    }
    return terminar(slug, l, r, sr);
  };
}

/** Seno + octava con drive suave: sub redondo que se sienta sin ocupar medios. */
function bajoRedondo(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const { l, r, n } = crearCanales(sr, dur);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const w = TAU * f0 * t;
      let x = Math.sin(w) + 0.35 * Math.sin(2 * w + 0.4);
      x = Math.tanh(x * 1.7) / Math.tanh(1.7);
      const env = envAtaque(t, 0.008) * envSalida(t, dur - 0.9, 0.3);
      l[i] = x * env;
      r[i] = x * env;
    }
    return terminar(slug, l, r, sr);
  };
}

/** FM 2:1 con feedback leve en el modulador y el índice "respirando" a 4.3 Hz. */
function bajoGrowl(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const escala = escalaDe(f0, HZ_C2);
    const { l, r, n } = crearCanales(sr, dur);
    const lp = new FiltroLP1(sr);
    let mPrevio = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const w = TAU * f0 * t;
      const m = Math.sin(2 * w + 0.35 * mPrevio);
      mPrevio = m;
      const indice = (1.8 + 1.7 * Math.exp(-t / 0.5)) * (1 + 0.18 * Math.sin(TAU * 4.3 * t));
      let x = 0.8 * Math.sin(w + indice * m) + 0.35 * Math.sin(w);
      x = lp.procesar(x, 2800 * escala);
      const env = envAtaque(t, 0.006) * envSalida(t, dur - 0.9, 0.32);
      l[i] = x * env;
      r[i] = x * env;
    }
    return terminar(slug, l, r, sr);
  };
}

// — Órgano (aditivo por drawbars) —

interface OpcionesOrgano {
  dur: number;
  /** Barras [ratio, nivel]: 0.5 = 16', 1 = 8', 2 = 4', 3 = 2⅔', 4 = 2'. */
  barras: Array<[number, number]>;
  vibrato?: { hz: number; cents: number };
  /** Percusión Hammond: armónico extra con caída rápida. */
  percusion?: { ratio: number; nivel: number; caida: number };
  /** Click de tecla (ruido de 4 ms). */
  click?: number;
  /** Desvío L/R en cents (coro suave del scanner); 0 = mono. */
  coroCents: number;
}

function organo(o: OpcionesOrgano): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, o.dur);
    const fasesL = new Float64Array(o.barras.length);
    const fasesR = new Float64Array(o.barras.length);
    const desL = centavos(o.coroCents);
    const desR = centavos(-o.coroCents);
    const lpClick = new FiltroLP1(sr);
    const nClick = Math.min(n, Math.round(0.004 * sr));
    let fasePerc = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vib =
        o.vibrato !== undefined
          ? centavos(o.vibrato.cents * Math.sin(TAU * o.vibrato.hz * t))
          : 1;
      let xl = 0;
      let xr = 0;
      for (let b = 0; b < o.barras.length; b++) {
        const [ratio, nivel] = o.barras[b]!;
        const f = f0 * ratio * vib;
        fasesL[b] = fasesL[b]! + (TAU * f * desL) / sr;
        fasesR[b] = fasesR[b]! + (TAU * f * desR) / sr;
        xl += nivel * Math.sin(fasesL[b]!);
        xr += nivel * Math.sin(fasesR[b]!);
      }
      if (o.percusion !== undefined) {
        fasePerc += (TAU * f0 * o.percusion.ratio) / sr;
        const p = o.percusion.nivel * Math.exp(-t / o.percusion.caida) * Math.sin(fasePerc);
        xl += p;
        xr += p;
      }
      if (o.click !== undefined && i < nClick) {
        const c = lpClick.procesar(rng() * 2 - 1, 4000) * o.click * (1 - i / nClick) * 4;
        xl += c;
        xr += c;
      }
      const env = envAtaque(t, 0.012) * envSalida(t, o.dur - 0.35, 0.09);
      l[i] = xl * env;
      r[i] = xr * env;
    }
    return terminar(slug, l, r, sr);
  };
}

// — Pads (ataque ≤ 60 ms: en Orbit los pads lentos suenan tarde) —

/** Ensemble de 6 sierras desafinadas con deriva lenta propia + LPF por canal. */
function ensembleCuerdas(o: { dur: number; fcHz: number; ataqueSec: number }): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const escala = escalaDe(f0, HZ_C4);
    const { l, r, n } = crearCanales(sr, o.dur);
    const sierra = tablaSierra(parcialesPara(f0, sr));
    const DETUNES = [-12, -7, -2, 3, 8, 13];
    const PANS = [-0.8, 0.5, -0.25, 0.25, -0.5, 0.8];
    interface Voz {
      fase: number;
      detune: number;
      driftHz: number;
      faseLfo: number;
      gl: number;
      gr: number;
    }
    const voces: Voz[] = DETUNES.map((detune, idx) => {
      const ang = ((PANS[idx]! + 1) * Math.PI) / 4;
      return {
        fase: rng(),
        detune,
        driftHz: 0.11 + rng() * 0.25,
        faseLfo: rng() * TAU,
        gl: Math.cos(ang) / Math.sqrt(DETUNES.length),
        gr: Math.sin(ang) / Math.sqrt(DETUNES.length),
      };
    });
    const svfL = new FiltroSVF(sr);
    const svfR = new FiltroSVF(sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let xl = 0;
      let xr = 0;
      for (const v of voces) {
        const f = f0 * centavos(v.detune + 2.5 * Math.sin(TAU * v.driftHz * t + v.faseLfo));
        v.fase += f / sr;
        const s = leerTabla(sierra, v.fase);
        xl += s * v.gl;
        xr += s * v.gr;
      }
      svfL.procesar(xl, o.fcHz * escala, 0.7);
      svfR.procesar(xr, o.fcHz * escala, 0.7);
      const env = envAtaque(t, o.ataqueSec) * envSalida(t, o.dur - 0.8, 0.45);
      l[i] = svfL.lp * env;
      r[i] = svfR.lp * env;
    }
    return terminar(slug, l, r, sr);
  };
}

/** Sierra ±5 cents (una por canal) + pulso 30% al centro, todo bajo LPF cálido. */
function padCalido(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const escala = escalaDe(f0, HZ_C4);
    const { l, r, n } = crearCanales(sr, dur);
    const sierra = tablaSierra(parcialesPara(f0, sr));
    const incL = (f0 * centavos(-5)) / sr;
    const incR = (f0 * centavos(5)) / sr;
    const incC = f0 / sr;
    let fL = rng();
    let fR = rng();
    let fC = rng();
    const svfL = new FiltroSVF(sr);
    const svfR = new FiltroSVF(sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      fL += incL;
      fR += incR;
      fC += incC;
      const pulso = leerPulso(sierra, fC, 0.3) * 0.55;
      svfL.procesar(leerTabla(sierra, fL) + pulso, 1600 * escala, 0.6);
      svfR.procesar(leerTabla(sierra, fR) + pulso, 1600 * escala, 0.6);
      const env = envAtaque(t, 0.045) * envSalida(t, dur - 0.8, 0.5);
      l[i] = svfL.lp * env;
      r[i] = svfR.lp * env;
    }
    return terminar(slug, l, r, sr);
  };
}

/** Parciales pares con "respiración" lenta e independiente: vidrio/aire. */
function padVidrio(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, dur);
    const RATIOS = [1, 2, 4, 6, 8];
    const NIVELES = [0.55, 1, 0.55, 0.4, 0.28];
    interface Parcial {
      wL: number;
      wR: number;
      nivel: number;
      lfoHz: number;
      faseLfo: number;
      fase: number;
    }
    const partes: Parcial[] = [];
    RATIOS.forEach((ratio, idx) => {
      // Un parcial por encima del Nyquist no suena más agudo: vuelve doblado,
      // como una nota que no está en el acorde.
      if (f0 * ratio >= sr * 0.45) return;
      const des = (rng() - 0.5) * 3; // ±1.5 cents entre canales
      partes.push({
        wL: (TAU * f0 * ratio * centavos(des)) / sr,
        wR: (TAU * f0 * ratio * centavos(-des)) / sr,
        nivel: NIVELES[idx]!,
        lfoHz: 0.15 + rng() * 0.35,
        faseLfo: rng() * TAU,
        fase: rng() * TAU,
      });
    });
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let xl = 0;
      let xr = 0;
      for (const p of partes) {
        const brillo = p.nivel * (1 - 0.15 * (1 - Math.cos(TAU * p.lfoHz * t + p.faseLfo)));
        xl += brillo * Math.sin(p.fase + p.wL * i);
        xr += brillo * Math.sin(p.fase + p.wR * i);
      }
      const env = envAtaque(t, 0.05) * envSalida(t, dur - 0.8, 0.5);
      l[i] = xl * env;
      r[i] = xr * env;
    }
    return terminar(slug, l, r, sr);
  };
}

// — Campanas (FM inarmónica en C5) —

interface OpcionesCampana {
  dur: number;
  /** Ratio inarmónico del modulador (3.53 campana, 3.01 caja de música). */
  ratio: number;
  indice: number;
  caidaIndice: number;
  /** Tasa de decaimiento de la amplitud (1/s). */
  caidaAmp: number;
  /** Parcial "hum" una octava abajo. */
  hum?: number;
  /** Octava superior con caída rápida (brillo de caja de música). */
  octavaArriba?: number;
  /** Tick de mecanismo (ruido de 2 ms). */
  tick?: number;
}

function campanaFM(o: OpcionesCampana): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, o.dur);
    const wL = (TAU * f0 * centavos(1.2)) / sr;
    const wR = (TAU * f0 * centavos(-1.2)) / sr;
    const wHum = (TAU * f0 * 0.5) / sr;
    const nTick = o.tick !== undefined ? Math.min(n, Math.round(0.002 * sr)) : 0;
    const indice = indiceQueCabe(o.indice, f0, o.ratio, sr);
    // La octava de brillo se calla si no cabe, en vez de doblarse hacia abajo.
    const conOctava = o.octavaArriba !== undefined && f0 * 2 < sr * 0.45;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const ind = indice * Math.exp(-t / o.caidaIndice);
      const amp = Math.exp(-o.caidaAmp * t);
      let xl = Math.sin(wL * i + ind * Math.sin(o.ratio * wL * i)) * amp;
      let xr = Math.sin(wR * i + ind * Math.sin(o.ratio * wR * i)) * amp;
      if (o.hum !== undefined) {
        const h = o.hum * Math.sin(wHum * i) * Math.exp(-o.caidaAmp * 0.6 * t);
        xl += h;
        xr += h;
      }
      if (conOctava && o.octavaArriba !== undefined) {
        const oct = o.octavaArriba * Math.exp(-o.caidaAmp * 2.2 * t);
        xl += oct * Math.sin(2 * wL * i);
        xr += oct * Math.sin(2 * wR * i);
      }
      if (i < nTick && o.tick !== undefined) {
        const c = (rng() * 2 - 1) * o.tick * (1 - i / nTick);
        xl += c;
        xr += c;
      }
      const env = envAtaque(t, 0.002) * envSalida(t, o.dur - 0.4, 0.14);
      l[i] = xl * env;
      r[i] = xr * env;
    }
    return terminar(slug, l, r, sr);
  };
}

/** Aditivo 1:4:10 (afinación de barras de vibráfono) + trémolo de motor. */
function vibrafono(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, dur);
    const RATIOS = [1, 4, 10];
    const NIVELES = [1, 0.32, 0.1];
    const CAIDAS = [0.85, 1.9, 3.6];
    interface Barra {
      wL: number;
      wR: number;
      nivel: number;
      caida: number;
    }
    const barras: Barra[] = [];
    RATIOS.forEach((ratio, idx) => {
      // El parcial 10 de un vibráfono está a 5 kHz en C5; una octava más
      // arriba se sale del muestreo y volvería doblado.
      if (f0 * ratio >= sr * 0.45) return;
      const des = (rng() - 0.5) * 2; // ±1 cent entre canales
      barras.push({
        wL: (TAU * f0 * ratio * centavos(des)) / sr,
        wR: (TAU * f0 * ratio * centavos(-des)) / sr,
        nivel: NIVELES[idx]!,
        caida: CAIDAS[idx]!,
      });
    });
    const lpGolpe = new FiltroLP1(sr);
    const nGolpe = Math.min(n, Math.round(0.006 * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // Trémolo del motor (mismo en L y R: mono-compatible).
      const trem = 1 - 0.21 * (1 - Math.cos(TAU * 5.2 * t));
      let xl = 0;
      let xr = 0;
      for (const b of barras) {
        const e = b.nivel * Math.exp(-b.caida * t);
        xl += e * Math.sin(b.wL * i);
        xr += e * Math.sin(b.wR * i);
      }
      if (i < nGolpe) {
        const g = lpGolpe.procesar(rng() * 2 - 1, 2500) * 0.4 * (1 - i / nGolpe);
        xl += g;
        xr += g;
      }
      const env = trem * envAtaque(t, 0.002) * envSalida(t, dur - 0.4, 0.14);
      l[i] = xl * env;
      r[i] = xr * env;
    }
    return terminar(slug, l, r, sr);
  };
}

// — Leads y viento (C4) —

/** Pulso 42% con vibrato tardío (entra a los 0.55 s): lead clásico de synth. */
function leadCuadrada(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const escala = escalaDe(f0, HZ_C4);
    const { l, r, n } = crearCanales(sr, dur);
    const sierra = tablaSierra(parcialesPara(f0, sr));
    const lp = new FiltroLP1(sr);
    let fase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const prof = 12 * rampa(t, 0.55, 0.5);
      const f = f0 * centavos(prof * Math.sin(TAU * 5.6 * t));
      fase += f / sr;
      const x = lp.procesar(leerPulso(sierra, fase, 0.42), 7000 * escala);
      const env = envAtaque(t, 0.01) * envSalida(t, dur - 0.55, 0.22);
      l[i] = x * env;
      r[i] = x * env;
    }
    return terminar(slug, l, r, sr);
  };
}

/** Seno + armónicos suaves + soplo band-pass (chiff al ataque) + vibrato tardío. */
function flauta(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const { l, r, n } = crearCanales(sr, dur);
    const bpL = new FiltroSVF(sr);
    const bpR = new FiltroSVF(sr);
    let fase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vib = Math.sin(TAU * 5.1 * t) * rampa(t, 0.45, 0.5);
      const f = f0 * centavos(9 * vib);
      fase += (TAU * f) / sr;
      const tono =
        (Math.sin(fase) + 0.18 * Math.sin(2 * fase) + 0.06 * Math.sin(3 * fase)) *
        (1 + 0.035 * vib);
      // Soplo: ruido distinto por canal (aire real), band-pass alrededor de 2.1 kHz.
      const chiff = 1 + 2.2 * Math.exp(-t / 0.06);
      bpL.procesar(rng() * 2 - 1, 2100, 2.5);
      bpR.procesar(rng() * 2 - 1, 2100, 2.5);
      const env = envAtaque(t, 0.045) * envSalida(t, dur - 0.6, 0.28);
      l[i] = (tono + bpL.bp * 0.16 * chiff) * env;
      r[i] = (tono + bpR.bp * 0.16 * chiff) * env;
    }
    return terminar(slug, l, r, sr);
  };
}

/** Sierra con unison de 3 voces (±7 cents a los lados) y vibrato sutil tardío. */
function leadSierra(dur: number): PorRaiz {
  return (slug, f0) => (sr) => {
    const rng = mulberry32(semillaDe(slug, f0));
    const escala = escalaDe(f0, HZ_C4);
    const { l, r, n } = crearCanales(sr, dur);
    const sierra = tablaSierra(parcialesPara(f0, sr));
    const desL = centavos(-7);
    const desR = centavos(7);
    let fC = rng();
    let fL = rng();
    let fR = rng();
    const lpL = new FiltroLP1(sr);
    const lpR = new FiltroLP1(sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const prof = 6 * rampa(t, 0.7, 0.5);
      const vib = centavos(prof * Math.sin(TAU * 5.4 * t));
      fC += (f0 * vib) / sr;
      fL += (f0 * vib * desL) / sr;
      fR += (f0 * vib * desR) / sr;
      const centro = leerTabla(sierra, fC) * 0.6;
      const xl = lpL.procesar(centro + leerTabla(sierra, fL) * 0.55, 6500 * escala);
      const xr = lpR.procesar(centro + leerTabla(sierra, fR) * 0.55, 6500 * escala);
      const env = envAtaque(t, 0.006) * envSalida(t, dur - 0.5, 0.24);
      l[i] = xl * env;
      r[i] = xr * env;
    }
    return terminar(slug, l, r, sr);
  };
}

// ── Catálogo ─────────────────────────────────────────────────────────────────

function spec(
  slug: string,
  name: string,
  subcategory: InstrumentSubcategory,
  tags: string[],
  rootHz: number,
  gainSuggestion: number,
  crear: PorRaiz,
): InstrumentSpec {
  return {
    slug,
    name,
    subcategory,
    tags,
    keyRoot: 'C',
    rootHz,
    gainSuggestion,
    // Sin altura, la suya: `render(sr)` sigue dando exactamente el sample de
    // siempre y quien no sepa de multisample no se entera de nada.
    render: (sr, hz = rootHz) => crear(slug, hz)(sr),
  };
}

export const INSTRUMENTS: InstrumentSpec[] = [
  // ── Teclas: pianos acústicos (aditivo inarmónico, C4) ──────────────────────
  spec('piano-suave', 'Piano Suave', 'teclas', ['piano', 'keys', 'suave', 'natural'], HZ_C4, 0.85,
    piano({ dur: 3.2, parciales: 10, brillo: 1.9, inarmonicidad: 0.0003, ataqueSec: 0.012, caida: 1.0, martillo: 0.05 })),
  spec('piano-brillante', 'Piano Brillante', 'teclas', ['piano', 'keys', 'brillante', 'pop'], HZ_C4, 0.85,
    piano({ dur: 3.0, parciales: 16, brillo: 1.15, inarmonicidad: 0.0005, ataqueSec: 0.004, caida: 1.15, martillo: 0.12 })),

  // ── Teclas: pianos eléctricos (FM 2-op, C4) ────────────────────────────────
  spec('ep-rhodes', 'EP Rhodes', 'teclas', ['ep', 'rhodes', 'keys', 'soul', 'fm'], HZ_C4, 0.8,
    pianoElectrico({ dur: 3.0, ratio: 14, indice: 5, caidaIndice: 0.07, nivelTine: 0.5, nivelCuerpo: 0.85, indiceCuerpo: 0.5, tremoloHz: 4.5, tremoloProf: 0.2 })),
  spec('ep-sucio', 'EP Sucio', 'teclas', ['ep', 'keys', 'sucio', 'lofi', 'saturado'], HZ_C4, 0.8,
    pianoElectrico({ dur: 2.8, ratio: 14, indice: 7, caidaIndice: 0.09, nivelTine: 0.6, nivelCuerpo: 0.85, indiceCuerpo: 0.7, tremoloHz: 5.5, tremoloProf: 0.28, saturacion: 2.6 })),

  // ── Cuerdas: guitarras Karplus-Strong (C3) ─────────────────────────────────
  spec('guitarra-nylon', 'Guitarra Nylon', 'cuerdas', ['guitarra', 'nylon', 'acustica', 'calida'], HZ_C3, 0.85,
    guitarra({
      dur: 3.0, perdida: 0.985, amortiguacion: 0.7, brilloExcHz: 2600,
      voces: [
        { offsetMuestras: 0, pan: -0.25, nivel: 0.8 },
        { offsetMuestras: 1, pan: 0.25, nivel: 0.7 },
      ],
      lpSalidaHz: 3200,
    })),
  spec('guitarra-electrica-limpia', 'Guitarra Eléctrica Limpia', 'cuerdas', ['guitarra', 'electrica', 'limpia', 'chorus'], HZ_C3, 0.8,
    guitarra({
      dur: 3.4, perdida: 0.99, amortiguacion: 0.5, brilloExcHz: 4500,
      voces: [
        { offsetMuestras: 0, pan: -0.55, nivel: 0.75 },
        { offsetMuestras: 1, pan: 0.55, nivel: 0.75 },
      ],
    })),
  spec('guitarra-muted', 'Guitarra Muted', 'cuerdas', ['guitarra', 'muted', 'palm', 'corta'], HZ_C3, 0.85,
    guitarra({
      dur: 1.6, perdida: 0.94, amortiguacion: 0.85, brilloExcHz: 900,
      voces: [{ offsetMuestras: 0, pan: 0, nivel: 1 }],
      click: 0.08,
    })),
  spec('guitarra-acustica-brillante', 'Guitarra Acústica Brillante', 'cuerdas', ['guitarra', 'acustica', 'brillante', 'folk'], HZ_C3, 0.8,
    guitarra({
      dur: 3.5, perdida: 0.988, amortiguacion: 0.35, brilloExcHz: 6000,
      voces: [
        { offsetMuestras: 0, pan: -0.3, nivel: 0.8 },
        { offsetMuestras: 1, pan: 0.3, nivel: 0.7 },
      ],
      click: 0.16,
    })),

  // ── Bajos (C2, mono deliberado) ────────────────────────────────────────────
  spec('bajo-fingered', 'Bajo Fingered', 'bajos', ['bajo', 'fingered', 'sustractivo', 'redondo'], HZ_C2, 0.9,
    bajoSustractivo({ dur: 2.4, fcIni: 1300, fcFin: 200, tEnv: 0.22, q: 1.3, sostenido: 1.5, rel: 0.28, ataqueSec: 0.006 })),
  spec('bajo-pick', 'Bajo Pick', 'bajos', ['bajo', 'pick', 'ataque', 'brillante'], HZ_C2, 0.9,
    bajoSustractivo({ dur: 2.2, fcIni: 3400, fcFin: 320, tEnv: 0.1, q: 1.1, sostenido: 1.3, rel: 0.24, ataqueSec: 0.003, click: 0.25 })),
  spec('bajo-redondo', 'Bajo Redondo', 'bajos', ['bajo', 'sub', 'redondo', 'suave'], HZ_C2, 0.9,
    bajoRedondo(2.4)),
  spec('bajo-growl', 'Bajo Growl', 'bajos', ['bajo', 'growl', 'fm', 'agresivo'], HZ_C2, 0.85,
    bajoGrowl(2.6)),

  // ── Teclas: órganos (aditivo por drawbars, C4) ─────────────────────────────
  spec('organo-suave', 'Órgano Suave', 'teclas', ['organo', 'keys', 'suave', 'gospel'], HZ_C4, 0.75,
    organo({ dur: 2.4, barras: [[0.5, 0.7], [1, 1], [2, 0.35]], coroCents: 0 })),
  spec('organo-full', 'Órgano Full', 'teclas', ['organo', 'keys', 'full', 'vibrato'], HZ_C4, 0.7,
    organo({
      dur: 2.6,
      barras: [[0.5, 0.8], [1, 1], [2, 0.7], [3, 0.5], [4, 0.45]],
      vibrato: { hz: 6.4, cents: 5 },
      coroCents: 3,
    })),
  spec('organo-percusivo', 'Órgano Percusivo', 'teclas', ['organo', 'keys', 'percusivo', 'funk'], HZ_C4, 0.75,
    organo({
      dur: 2.2,
      barras: [[1, 1], [2, 0.5]],
      percusion: { ratio: 3, nivel: 0.6, caida: 0.18 },
      click: 0.1,
      coroCents: 2,
    })),

  // ── Pads (C4, ataque ≤ 60 ms) ──────────────────────────────────────────────
  spec('strings-ensemble', 'Strings Ensemble', 'pads', ['strings', 'pad', 'ensemble', 'cinematica'], HZ_C4, 0.65,
    ensembleCuerdas({ dur: 3.6, fcHz: 3200, ataqueSec: 0.055 })),
  spec('pad-calido', 'Pad Cálido', 'pads', ['pad', 'calido', 'analogico', 'suave'], HZ_C4, 0.65,
    padCalido(3.4)),
  spec('pad-vidrio', 'Pad Vidrio', 'pads', ['pad', 'vidrio', 'aire', 'brillante'], HZ_C4, 0.65,
    padVidrio(3.4)),

  // ── Campanas (C5) ──────────────────────────────────────────────────────────
  spec('campana-pura', 'Campana Pura', 'campanas', ['campana', 'bell', 'fm', 'larga'], HZ_C5, 0.7,
    campanaFM({ dur: 3.6, ratio: 3.5307, indice: 2.6, caidaIndice: 1.2, caidaAmp: 1.05, hum: 0.25 })),
  spec('campanita-musica', 'Campanita Música', 'campanas', ['campana', 'musicbox', 'dulce', 'corta'], HZ_C5, 0.7,
    campanaFM({ dur: 2.2, ratio: 3.01, indice: 1.4, caidaIndice: 0.12, caidaAmp: 2.1, octavaArriba: 0.3, tick: 0.06 })),
  spec('vibrafono', 'Vibráfono', 'campanas', ['vibrafono', 'mallet', 'jazz', 'tremolo'], HZ_C5, 0.75,
    vibrafono(3.6)),

  // ── Leads y viento (C4) ────────────────────────────────────────────────────
  spec('lead-cuadrada', 'Lead Cuadrada', 'leads', ['lead', 'pulso', 'chip', 'vibrato'], HZ_C4, 0.7,
    leadCuadrada(2.4)),
  spec('flauta', 'Flauta', 'leads', ['flauta', 'viento', 'aire', 'organica'], HZ_C4, 0.75,
    flauta(2.7)),
  spec('lead-saw', 'Lead Saw', 'leads', ['lead', 'saw', 'unison', 'synth'], HZ_C4, 0.7,
    leadSierra(2.4)),
];
