/**
 * Detección y corrección de tono de una toma (el "autotune" de Orbit).
 *
 * Trabaja OFFLINE sobre el sample completo, no en el kernel: corregir bien
 * exige mirar hacia delante y hacia atrás, y una toma de voz se procesa una
 * vez, no cada bloque de audio.
 *
 * Dos piezas:
 * - `detectPitchTrack`: f0 por ventana con autocorrelación normalizada (a lo
 *   YIN simplificado) más interpolación parabólica, con un filtro de mediana
 *   que se come los saltos de octava sueltos que ensucian la curva.
 * - `correctPitch`: PSOLA — corta el audio en granos de dos periodos con
 *   ventana de Hann centrados en marcas de pitch y los vuelve a pegar con el
 *   espaciado del tono destino. Cambia la altura SIN cambiar la duración ni
 *   la formante de forma agresiva, que es lo que hace que una voz corregida
 *   siga sonando a esa voz.
 *
 * Todo determinista: misma entrada, misma salida.
 */

export interface PitchTrackOptions {
  /** Rango de búsqueda en Hz (voz humana por defecto). */
  minHz?: number;
  maxHz?: number;
  /** Salto entre ventanas en samples. */
  hop?: number;
}

export interface PitchTrack {
  /** f0 por ventana en Hz; 0 = sin tono claro (silencio o consonante). */
  f0: Float32Array;
  /** Confianza 0..1 por ventana. */
  confidence: Float32Array;
  hop: number;
  sampleRate: number;
}

const DEFAULT_HOP = 256;

/** Curva de tono de una señal mono. */
export function detectPitchTrack(
  mono: Float32Array,
  sampleRate: number,
  opts: PitchTrackOptions = {},
): PitchTrack {
  const minHz = opts.minHz ?? 70;
  const maxHz = opts.maxHz ?? 1000;
  const hop = opts.hop ?? DEFAULT_HOP;
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.floor(sampleRate / minHz), 2048);
  const win = maxLag * 2;
  const frames = Math.max(0, Math.floor((mono.length - win) / hop) + 1);
  const f0 = new Float32Array(frames);
  const confidence = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const from = f * hop;
    // Energía: por debajo de un umbral no hay tono que buscar.
    let energy = 0;
    for (let i = from; i < from + win; i++) energy += mono[i]! * mono[i]!;
    energy = Math.sqrt(energy / win);
    if (energy < 1e-4) continue;

    // Puntuación de cada desfase; luego se elige con guarda de octava.
    const scores = new Float32Array(maxLag - minLag + 1);
    let bestLag = 0;
    let bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      let normA = 0;
      let normB = 0;
      // Muestreo de a 2 dentro de la ventana: la mitad de cuentas y la
      // diferencia en la estimación es despreciable a estas longitudes.
      for (let i = from; i < from + win - lag; i += 2) {
        const a = mono[i]!;
        const b = mono[i + lag]!;
        corr += a * b;
        normA += a * a;
        normB += b * b;
      }
      const denom = Math.sqrt(normA * normB) + 1e-9;
      const score = corr / denom;
      scores[lag - minLag] = score;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    // Guarda de octava: la autocorrelación puntúa igual de bien el doble del
    // periodo, así que un La de 220 Hz se leería como 110. Nos quedamos con el
    // desfase MÁS CORTO que casi empate con el mejor — que es el periodo real.
    if (bestLag > 0) {
      const floorScore = bestScore * 0.9;
      for (let lag = minLag; lag < bestLag; lag++) {
        const score = scores[lag - minLag]!;
        if (score < floorScore) continue;
        // Solo si es un pico local (si no, es la ladera del bueno).
        const prev = lag > minLag ? scores[lag - minLag - 1]! : -1;
        const next = lag < maxLag ? scores[lag - minLag + 1]! : -1;
        if (score >= prev && score >= next) {
          bestLag = lag;
          bestScore = score;
          break;
        }
      }
    }

    if (bestLag === 0 || bestScore < 0.35) continue;

    // Interpolación parabólica sobre el pico de correlación.
    const y0 = lagScore(mono, from, win, bestLag - 1);
    const y1 = bestScore;
    const y2 = lagScore(mono, from, win, bestLag + 1);
    const denom = y0 - 2 * y1 + y2;
    const shift = Math.abs(denom) > 1e-9 ? (0.5 * (y0 - y2)) / denom : 0;
    const lag = bestLag + Math.max(-1, Math.min(1, shift));
    f0[f] = sampleRate / lag;
    confidence[f] = bestScore;
  }

  medianSmooth(f0, 5);
  return { f0, confidence, hop, sampleRate };
}

function lagScore(mono: Float32Array, from: number, win: number, lag: number): number {
  if (lag < 1) return 0;
  let corr = 0;
  let normA = 0;
  let normB = 0;
  for (let i = from; i < from + win - lag; i += 2) {
    const a = mono[i]!;
    const b = mono[i + lag]!;
    corr += a * b;
    normA += a * a;
    normB += b * b;
  }
  return corr / (Math.sqrt(normA * normB) + 1e-9);
}

/** Mediana móvil: quita saltos de octava sueltos sin suavizar el vibrato. */
function medianSmooth(xs: Float32Array, size: number): void {
  const half = size >> 1;
  const copy = xs.slice();
  const buf = new Float32Array(size);
  for (let i = 0; i < xs.length; i++) {
    let n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= copy.length) continue;
      if (copy[j]! <= 0) continue;
      buf[n++] = copy[j]!;
    }
    if (n === 0) continue;
    const slice = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
    xs[i] = slice[n >> 1]!;
  }
}

export interface CorrectPitchOptions {
  /** Cuánto se lleva la nota al destino: 0 = nada, 1 = clavada (hard tune). */
  strength?: number;
  /**
   * Notas permitidas como clases de altura 0..11 (0 = Do). Vacío o ausente =
   * cromático (la nota más cercana, sin escala).
   */
  scale?: number[];
  /** Semitonos de transposición añadidos después de corregir. */
  transpose?: number;
  /** Ventana de corrección: cuánto tarda en llegar a la nota, en segundos. */
  glideSec?: number;
}

/**
 * Corrige el tono de una toma. Devuelve buffers nuevos del mismo largo.
 * `left`/`right` pueden ser el mismo array (mono).
 */
export function correctPitch(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts: CorrectPitchOptions = {},
): { left: Float32Array; right: Float32Array; track: PitchTrack } {
  const strength = clamp01(opts.strength ?? 1);
  const transpose = opts.transpose ?? 0;
  const glide = Math.max(0, opts.glideSec ?? 0.02);
  const scale = opts.scale && opts.scale.length > 0 ? opts.scale : null;

  const n = Math.min(left.length, right.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i]! + right[i]!) * 0.5;
  const track = detectPitchTrack(mono, sampleRate);

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const hop = track.hop;

  // Estado del "glide": la relación de corrección se acerca al objetivo con
  // una constante de tiempo, para que no salte de golpe entre ventanas.
  const alpha = glide > 0 ? 1 - Math.exp(-hop / (glide * sampleRate)) : 1;
  let ratio = 1;
  let readPos = 0;
  let writePos = 0;

  while (writePos < n) {
    const frame = Math.min(track.f0.length - 1, Math.floor(writePos / hop));
    const f0 = frame >= 0 ? track.f0[frame]! : 0;
    let target = 1;
    if (f0 > 0) {
      const midi = 69 + 12 * Math.log2(f0 / 440);
      const snapped = snapToScale(midi, scale) + transpose;
      const corrected = midi + (snapped - midi) * strength;
      target = Math.pow(2, (corrected - midi) / 12);
    }
    ratio += (target - ratio) * alpha;

    // Grano de dos periodos (o de la ventana por defecto si no hay tono).
    const period = f0 > 0 ? sampleRate / f0 : hop * 2;
    const grain = Math.max(64, Math.min(4096, Math.round(period * 2)));
    const step = Math.max(16, Math.round(period));

    // PSOLA: leer un grano y pegarlo con el espaciado del tono destino.
    const start = Math.round(readPos);
    for (let i = 0; i < grain; i++) {
      const src = start + i;
      const dst = writePos + i;
      if (dst >= n) break;
      if (src < 0 || src >= n) continue;
      // Hann: los granos solapados suman plano.
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
      outL[dst]! += left[src]! * w;
      outR[dst]! += right[src]! * w;
    }
    // Avanzar: en destino un periodo del tono corregido, en origen el del
    // original (así cambia la altura y NO la duración).
    writePos += Math.max(16, Math.round(step / ratio));
    readPos += step;
    if (readPos >= n) break;
  }

  return { left: outL, right: outR, track };
}

/** Nota MIDI más cercana dentro de la escala (o cromática si no hay escala). */
function snapToScale(midi: number, scale: number[] | null): number {
  const nearest = Math.round(midi);
  if (!scale) return nearest;
  const octave = Math.floor(nearest / 12);
  let best = nearest;
  let bestDist = Infinity;
  // Mira la octava de abajo, la propia y la de arriba: en los bordes la nota
  // buena puede estar cruzando el Do.
  for (let o = octave - 1; o <= octave + 1; o++) {
    for (const pc of scale) {
      const candidate = o * 12 + pc;
      const dist = Math.abs(candidate - midi);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
  }
  return best;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Escala mayor/menor como clases de altura, para la UI. */
export function scalePitchClasses(rootPc: number, mode: 'major' | 'minor'): number[] {
  const steps = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return steps.map((s) => (rootPc + s) % 12);
}
