/**
 * Asistente de mezcla: convierte el análisis del motor (`analyzeMix` de
 * @orbit/engine — LUFS, pico, bandas y correlación estéreo) en un diagnóstico
 * ACCIONABLE y en una cadena concreta de efectos con valores reales.
 *
 * Es una función PURA: análisis + contexto → consejo. No toca el proyecto (de
 * eso se encarga el executor, que la aplica por el bus de comandos como
 * cualquier otra tool). Así se puede probar con análisis fabricados a mano.
 *
 * Cómo se leen las bandas: `analyzeMix` devuelve cada banda en dB RELATIVOS al
 * total, así que su valor absoluto sube y baja con el balance general. Lo que
 * de verdad describe el sonido son las DIFERENCIAS entre bandas ("tilts"), que
 * no dependen de la normalización. Referencias medidas con el propio motor:
 *
 *   ruido rosa (neutro)   low −3.9  lowMid −6.3  highMid −6.6  high −8.4
 *   trap equilibrado      low −1.1  lowMid −10.2 highMid −11.3 high −13.0
 *   graves de más (808)   low −0.2  lowMid −15.0 highMid −21.6 high −23.3
 *   ruido blanco (brillo) low −22.2 lowMid −14.1 highMid −6.2  high −1.5
 *
 * De ahí salen los rangos sanos por género de `GENRE_PROFILES`: el usuario
 * produce trap / boom bap / reggaetón, mezcla voz sobre beat con la voz por
 * delante, y masteriza a -14 LUFS para streaming.
 */

import type { EffectKind } from '@orbit/core';
import { gainToTarget, type MixAnalysis } from '@orbit/engine';

/** Objetivo de loudness de las plataformas de streaming. */
export const STREAMING_LUFS = -14;

/** Techo de salida recomendado (margen para el true peak del codec). */
export const CEILING_DB = -0.3;

/** Frecuencia por debajo de la cual el grave va mono (regla del repo). */
export const MONO_BELOW_HZ = 110;

export type MixGenre = 'trap' | 'boombap' | 'reggaeton' | 'generico';

export const GENRE_LABELS: Record<MixGenre, string> = {
  trap: 'trap',
  boombap: 'boom bap',
  reggaeton: 'reggaetón',
  generico: 'genérico',
};

interface Range {
  min: number;
  max: number;
}

interface GenreProfile {
  /** low − highMid: cuánto pesa el grave frente a la presencia. */
  tiltLow: Range;
  /** lowMid − highMid: cuerpo. Muy alto = barro; muy bajo = hueco. */
  tiltBody: Range;
  /** high − highMid: brillo/aire. */
  tiltHigh: Range;
}

/**
 * Rangos sanos por género (en dB). El trap y el reggaetón viven con el grave
 * muy por delante; el boom bap pesa más en el cuerpo y brilla menos.
 */
export const GENRE_PROFILES: Record<MixGenre, GenreProfile> = {
  trap: { tiltLow: { min: 6, max: 16 }, tiltBody: { min: -2, max: 6 }, tiltHigh: { min: -6, max: 2 } },
  reggaeton: { tiltLow: { min: 5, max: 15 }, tiltBody: { min: -2, max: 6 }, tiltHigh: { min: -5, max: 3 } },
  boombap: { tiltLow: { min: 2, max: 12 }, tiltBody: { min: 0, max: 8 }, tiltHigh: { min: -7, max: 1 } },
  generico: { tiltLow: { min: 0, max: 14 }, tiltBody: { min: -3, max: 7 }, tiltHigh: { min: -7, max: 3 } },
};

export type MixIssueId =
  | 'graves-de-mas'
  | 'graves-de-menos'
  | 'medios-turbios'
  | 'medios-vacios'
  | 'agudos-de-mas'
  | 'agudos-de-menos'
  | 'fase'
  | 'estereo-extremo'
  | 'demasiado-mono'
  | 'loudness-bajo'
  | 'loudness-alto'
  | 'peak-alto'
  | 'headroom-de-sobra';

export interface MixIssue {
  id: MixIssueId;
  /** 'grave' = hay que arreglarlo; 'aviso' = mirarlo. */
  severity: 'grave' | 'aviso';
  /** Frase accionable en español. */
  text: string;
  /** Desvío medido en dB (lo que sobra o falta), si aplica. */
  deltaDb?: number;
}

/** Una pista del mixer tal y como la ve el asistente. */
export interface TrackSlots {
  index: number;
  name: string;
  /** Efecto de cada slot (null = libre). Longitud = nº de slots del mixer. */
  slots: (EffectKind | null)[];
}

export interface MixContext {
  genre: MixGenre;
  /** LUFS objetivo (por defecto -14, streaming). */
  targetLufs: number;
  /** Pista master (índice 0). */
  master: TrackSlots;
  /** Pista de la voz, si se ha detectado. */
  voice?: TrackSlots;
  /** Pista del beat/instrumental (para que la voz mande por encima). */
  beat?: TrackSlots;
  /** Pista del 808/sub, si se ha detectado. */
  low?: TrackSlots;
}

/** Un efecto de la cadena propuesta, con sus valores reales. */
export interface ChainStep {
  trackIndex: number;
  trackName: string;
  slotIndex: number;
  kind: EffectKind;
  /** Parámetros a fijar (los que no salgan aquí se quedan por defecto). */
  params: Record<string, number>;
  /** Dry/wet del slot, si el consejo lo mueve. */
  mix?: number;
  /** Pista que alimenta el detector (compresor sidechain). */
  sidechainSource?: number;
  /** true = el slot ya tenía ese efecto y solo se reajusta. */
  existing: boolean;
  why: string;
}

/** Movimiento de fader propuesto. */
export interface GainStep {
  trackIndex: number;
  trackName: string;
  volumeDb: number;
  why: string;
}

export interface MixAdvice {
  genre: MixGenre;
  targetLufs: number;
  /** dB que faltan (+) o sobran (−) para el objetivo. */
  gainToTargetDb: number;
  /** Diferencias entre bandas que sostienen el diagnóstico. */
  tilts: { low: number; body: number; high: number };
  issues: MixIssue[];
  chain: ChainStep[];
  gains: GainStep[];
  /** Pegas del plan que conviene leer (orden de slots, slots llenos…). */
  warnings: string[];
  /** Resumen de una línea. */
  headline: string;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function round(x: number, decimals = 1): number {
  const p = Math.pow(10, decimals);
  return Math.round(x * p) / p;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function dbText(x: number): string {
  return `${x >= 0 ? '+' : ''}${round(x)} dB`;
}

/**
 * Reserva de slots: busca uno que ya tenga ese efecto (para reajustarlo) o el
 * primero libre. Lleva su propia copia para que dos pasos no pidan el mismo.
 */
class SlotPlanner {
  private readonly taken = new Map<number, (EffectKind | null)[]>();

  private lanes(track: TrackSlots): (EffectKind | null)[] {
    let lanes = this.taken.get(track.index);
    if (!lanes) {
      lanes = [...track.slots];
      this.taken.set(track.index, lanes);
    }
    return lanes;
  }

  /** Devuelve {slotIndex, existing} o null si no queda hueco. */
  take(track: TrackSlots, kind: EffectKind): { slotIndex: number; existing: boolean } | null {
    const lanes = this.lanes(track);
    const existing = lanes.indexOf(kind);
    if (existing >= 0) {
      lanes[existing] = kind;
      return { slotIndex: existing, existing: true };
    }
    const free = lanes.indexOf(null);
    if (free < 0) return null;
    lanes[free] = kind;
    return { slotIndex: free, existing: false };
  }
}

// ── Diagnóstico ──────────────────────────────────────────────────────────────

/** Bandas y fase → lista de problemas con su desvío en dB. */
function diagnoseSpectrum(analysis: MixAnalysis, profile: GenreProfile): MixIssue[] {
  const issues: MixIssue[] = [];
  const { low, lowMid, highMid, high } = analysis.bands;
  const tiltLow = low - highMid;
  const tiltBody = lowMid - highMid;
  const tiltHigh = high - highMid;

  if (tiltLow > profile.tiltLow.max) {
    const delta = tiltLow - profile.tiltLow.max;
    issues.push({
      id: 'graves-de-mas',
      severity: delta > 4 ? 'grave' : 'aviso',
      deltaDb: round(delta),
      text:
        `Sobran graves: el low (<120 Hz) va ${round(tiltLow)} dB por encima de los medios altos, ` +
        `${round(delta)} dB más de lo sano para el género. Baja el sub/808 o mete un shelf negativo bajo 120 Hz.`,
    });
  } else if (tiltLow < profile.tiltLow.min) {
    const delta = profile.tiltLow.min - tiltLow;
    issues.push({
      id: 'graves-de-menos',
      severity: delta > 5 ? 'grave' : 'aviso',
      deltaDb: round(delta),
      text:
        `Faltan graves: el low está solo ${round(tiltLow)} dB sobre los medios altos (${round(delta)} dB corto). ` +
        'Sube el 808/sub o levanta un shelf a 60–90 Hz.',
    });
  }

  if (tiltBody > profile.tiltBody.max) {
    const delta = tiltBody - profile.tiltBody.max;
    issues.push({
      id: 'medios-turbios',
      severity: delta > 4 ? 'grave' : 'aviso',
      deltaDb: round(delta),
      text:
        `Barro en los medios bajos (120–900 Hz): ${round(delta)} dB de más. ` +
        'Campana estrecha de −2/−3 dB entre 250 y 400 Hz y respira.',
    });
  } else if (tiltBody < profile.tiltBody.min) {
    const delta = profile.tiltBody.min - tiltBody;
    issues.push({
      id: 'medios-vacios',
      severity: delta > 5 ? 'grave' : 'aviso',
      deltaDb: round(delta),
      text:
        `Mezcla hueca: faltan ${round(delta)} dB de cuerpo en 120–900 Hz. ` +
        'Sube el cuerpo de caja/voz o una campana de +2 dB a 300 Hz.',
    });
  }

  if (tiltHigh > profile.tiltHigh.max) {
    const delta = tiltHigh - profile.tiltHigh.max;
    issues.push({
      id: 'agudos-de-mas',
      severity: delta > 4 ? 'grave' : 'aviso',
      deltaDb: round(delta),
      text:
        `Agudos pasados de vueltas: ${round(delta)} dB de más por encima de 6 kHz. ` +
        'Hats y aire de la voz cansan; shelf de −2 dB a 8 kHz.',
    });
  } else if (tiltHigh < profile.tiltHigh.min) {
    const delta = profile.tiltHigh.min - tiltHigh;
    issues.push({
      id: 'agudos-de-menos',
      severity: delta > 5 ? 'grave' : 'aviso',
      deltaDb: round(delta),
      text:
        `Suena apagado: faltan ${round(delta)} dB por encima de 6 kHz. ` +
        'Shelf de +2 dB a 8–10 kHz (aire de la voz y hats).',
    });
  }

  return issues;
}

/** Correlación estéreo → fase / anchura. */
function diagnoseStereo(analysis: MixAnalysis): MixIssue[] {
  const corr = analysis.stereoCorrelation;
  if (!Number.isFinite(corr)) return [];
  if (corr < 0) {
    return [
      {
        id: 'fase',
        severity: 'grave',
        text:
          `Problema de fase: correlación ${round(corr, 2)} (negativa). En mono se cancela media mezcla. ` +
          'Revisa duplicados de la voz y el ancho del sub; deja el grave mono por debajo de 110 Hz.',
      },
    ];
  }
  if (corr < 0.2) {
    return [
      {
        id: 'estereo-extremo',
        severity: 'aviso',
        text:
          `Estéreo extremo: correlación ${round(corr, 2)}. Comprueba en mono antes de dar por buena la mezcla ` +
          'y mantén el grave centrado.',
      },
    ];
  }
  if (corr > 0.985) {
    return [
      {
        id: 'demasiado-mono',
        severity: 'aviso',
        text:
          `Casi mono (correlación ${round(corr, 2)}): la mezcla no respira a los lados. ` +
          'Ensancha hats, pads y dobles de voz — el sub se queda en el centro.',
      },
    ];
  }
  return [];
}

/** LUFS y pico frente al objetivo de streaming. */
function diagnoseLoudness(analysis: MixAnalysis, target: number): MixIssue[] {
  const issues: MixIssue[] = [];
  const need = gainToTarget(analysis, target);

  if (need > 1) {
    issues.push({
      id: 'loudness-bajo',
      severity: need > 4 ? 'grave' : 'aviso',
      deltaDb: round(need),
      text:
        `El master se queda corto: ${round(analysis.lufsIntegrated)} LUFS, ${dbText(need)} por debajo de ` +
        `${target} LUFS de streaming. Al lado de otros temas va a sonar flojo.`,
    });
  } else if (need < -1) {
    issues.push({
      id: 'loudness-alto',
      severity: need < -3 ? 'grave' : 'aviso',
      deltaDb: round(need),
      text:
        `El master pega de más: ${round(analysis.lufsIntegrated)} LUFS (${dbText(-need)} sobre ${target}). ` +
        'Spotify/YouTube lo bajarán igual, así que solo pierdes pegada y dinámica.',
    });
  }

  if (analysis.peakDb > -0.1) {
    issues.push({
      id: 'peak-alto',
      severity: 'grave',
      deltaDb: round(analysis.peakDb),
      text:
        `Pico a ${round(analysis.peakDb)} dBFS: sin margen, el codec va a clipear. ` +
        `Limitador con techo ${CEILING_DB} dB.`,
    });
  } else if (analysis.peakDb < -6 && need > 3) {
    issues.push({
      id: 'headroom-de-sobra',
      severity: 'aviso',
      deltaDb: round(analysis.peakDb),
      text:
        `Pico a ${round(analysis.peakDb)} dBFS: tienes ${round(-analysis.peakDb)} dB de aire sin usar. ` +
        'Aquí no hace falta comprimir más, solo ganancia y limitador.',
    });
  }

  return issues;
}

// ── Cadena propuesta ─────────────────────────────────────────────────────────

function has(issues: MixIssue[], id: MixIssueId): MixIssue | undefined {
  return issues.find((i) => i.id === id);
}

/**
 * De los problemas a una cadena concreta. Orden en el master: EQ correctivo →
 * ancho/mono del grave → limitador al final. La voz, si se detecta, se trata
 * aparte para que mande por encima del beat.
 */
function buildChain(
  issues: MixIssue[],
  analysis: MixAnalysis,
  ctx: MixContext,
  warnings: string[],
): { chain: ChainStep[]; gains: GainStep[] } {
  const chain: ChainStep[] = [];
  const gains: GainStep[] = [];
  const planner = new SlotPlanner();

  const push = (
    track: TrackSlots,
    kind: EffectKind,
    params: Record<string, number>,
    why: string,
    extra: { mix?: number; sidechainSource?: number } = {},
  ): void => {
    const slot = planner.take(track, kind);
    if (!slot) {
      warnings.push(
        `La pista ${track.index} "${track.name}" no tiene slots libres para el ${kind}: libera uno antes.`,
      );
      return;
    }
    chain.push({
      trackIndex: track.index,
      trackName: track.name,
      slotIndex: slot.slotIndex,
      kind,
      params,
      existing: slot.existing,
      why,
      ...(extra.mix !== undefined ? { mix: extra.mix } : null),
      ...(extra.sidechainSource !== undefined ? { sidechainSource: extra.sidechainSource } : null),
    });
  };

  // ── Voz por delante del beat ───────────────────────────────────────────────
  if (ctx.voice) {
    const airBoost = has(issues, 'agudos-de-menos') ? 3 : 2;
    push(
      ctx.voice,
      'eq',
      {
        hpFreq: 100,
        midGain: 3,
        midFreq: 3000,
        midQ: 1.2,
        highGain: airBoost,
        highFreq: 9000,
      },
      'La voz manda: HP a 100 Hz para quitarle sitio al 808, presencia a 3 kHz y aire a 9 kHz.',
    );
    push(
      ctx.voice,
      'compressor',
      { threshold: -18, ratio: 3.5, attack: 0.008, release: 0.12, knee: 6, makeup: 3 },
      'Compresión media para que ninguna frase se caiga por debajo del beat.',
    );
    if (ctx.beat) {
      push(
        ctx.beat,
        'compressor',
        { threshold: -22, ratio: 2.5, attack: 0.005, release: 0.15, knee: 6, makeup: 0 },
        `Sidechain desde la voz (pista ${ctx.voice.index}): el beat se aparta ~2 dB cuando ella canta.`,
        { sidechainSource: ctx.voice.index },
      );
    }
  }

  // ── EQ correctivo del master ───────────────────────────────────────────────
  const eqParams: Record<string, number> = { hpFreq: 28 };
  const eqWhy: string[] = ['limpieza por debajo de 28 Hz (regala headroom)'];

  const bassUp = has(issues, 'graves-de-mas');
  const bassDown = has(issues, 'graves-de-menos');
  if (bassUp) {
    eqParams['lowGain'] = -clamp((bassUp.deltaDb ?? 2) / 2, 1, 6);
    eqParams['lowFreq'] = 100;
    eqWhy.push(`shelf de ${dbText(eqParams['lowGain']!)} a 100 Hz (sobran graves)`);
  } else if (bassDown) {
    eqParams['lowGain'] = clamp((bassDown.deltaDb ?? 2) / 2, 1, 5);
    eqParams['lowFreq'] = 80;
    eqWhy.push(`shelf de ${dbText(eqParams['lowGain']!)} a 80 Hz (faltan graves)`);
  }

  const mud = has(issues, 'medios-turbios');
  const hollow = has(issues, 'medios-vacios');
  if (mud) {
    eqParams['midGain'] = -clamp((mud.deltaDb ?? 2) / 2, 1, 5);
    eqParams['midFreq'] = 320;
    eqParams['midQ'] = 1.4;
    eqWhy.push(`campana de ${dbText(eqParams['midGain']!)} a 320 Hz (barro)`);
  } else if (hollow) {
    eqParams['midGain'] = clamp((hollow.deltaDb ?? 2) / 2, 1, 4);
    eqParams['midFreq'] = 300;
    eqParams['midQ'] = 0.9;
    eqWhy.push(`campana de ${dbText(eqParams['midGain']!)} a 300 Hz (falta cuerpo)`);
  }

  const bright = has(issues, 'agudos-de-mas');
  const dull = has(issues, 'agudos-de-menos');
  if (bright) {
    eqParams['highGain'] = -clamp((bright.deltaDb ?? 2) / 2, 1, 5);
    eqParams['highFreq'] = 8000;
    eqWhy.push(`shelf de ${dbText(eqParams['highGain']!)} a 8 kHz (agudos de más)`);
  } else if (dull) {
    eqParams['highGain'] = clamp((dull.deltaDb ?? 2) / 2, 1, 4);
    eqParams['highFreq'] = 9000;
    eqWhy.push(`shelf de ${dbText(eqParams['highGain']!)} a 9 kHz (falta aire)`);
  }
  push(ctx.master, 'eq', eqParams, `EQ correctivo del master: ${eqWhy.join(', ')}.`);

  // El 808 se corrige también en origen cuando el grave se desmanda.
  if (bassUp && ctx.low) {
    push(
      ctx.low,
      'eq',
      { hpFreq: 30, lowGain: -clamp((bassUp.deltaDb ?? 2) / 3, 1, 4), lowFreq: 90 },
      'El grave se arregla mejor en el 808 que en el master: HP a 30 Hz y shelf negativo a 90 Hz.',
    );
  }

  // ── Ancho / mono del grave ─────────────────────────────────────────────────
  const phase = has(issues, 'fase');
  const wide = has(issues, 'estereo-extremo');
  const mono = has(issues, 'demasiado-mono');
  if (phase || wide || mono) {
    const width = phase ? 0.7 : wide ? 0.85 : 1.25;
    push(
      ctx.master,
      'stereo',
      { width, gain: 1, monoBelow: MONO_BELOW_HZ },
      phase
        ? `Recoge la imagen (width ${width}) y fuerza mono por debajo de ${MONO_BELOW_HZ} Hz: primero se arregla la fase.`
        : mono
          ? `Abre un poco la imagen (width ${width}) manteniendo el grave mono bajo ${MONO_BELOW_HZ} Hz.`
          : `Cierra la imagen a ${width} y grave mono bajo ${MONO_BELOW_HZ} Hz para que aguante en mono.`,
    );
  }

  // ── Loudness: limitador al final ───────────────────────────────────────────
  const need = gainToTarget(analysis, ctx.targetLufs);
  const loud = has(issues, 'loudness-alto');
  const limiterGain = loud ? 0 : clamp(need, 0, 12);
  push(
    ctx.master,
    'limiter',
    { gain: round(limiterGain), ceiling: CEILING_DB, release: 0.06 },
    loud
      ? `Techo a ${CEILING_DB} dB sin ganancia extra: el master ya pega de sobra.`
      : `${dbText(limiterGain)} de ganancia y techo ${CEILING_DB} dB para clavar ${ctx.targetLufs} LUFS.`,
  );

  if (loud) {
    gains.push({
      trackIndex: ctx.master.index,
      trackName: ctx.master.name,
      volumeDb: round(clamp(need, -6, 0)),
      why: `Baja el master ${dbText(clamp(need, -6, 0))} para aterrizar en ${ctx.targetLufs} LUFS sin machacar.`,
    });
  }

  // El limitador tiene que ir el ÚLTIMO de la cadena del master.
  const masterSteps = chain.filter((s) => s.trackIndex === ctx.master.index);
  const limiter = masterSteps.find((s) => s.kind === 'limiter');
  if (limiter && masterSteps.some((s) => s.slotIndex > limiter.slotIndex)) {
    warnings.push(
      `El limitador del master queda en el slot ${limiter.slotIndex}, antes que otro efecto propuesto: ` +
        'muévelo al último slot ocupado o la ganancia se aplicará fuera de sitio.',
    );
  }

  return { chain, gains };
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Diagnóstico + cadena propuesta a partir del análisis del motor.
 * Pura: mismo análisis y mismo contexto → mismo consejo.
 */
export function adviseMix(analysis: MixAnalysis, ctx: MixContext): MixAdvice {
  const profile = GENRE_PROFILES[ctx.genre];
  const warnings: string[] = [];

  const stereoIssues = diagnoseStereo(analysis);
  const phaseBroken = stereoIssues.some((i) => i.id === 'fase');
  if (phaseBroken) {
    // Con la fase invertida, L+R se cancela y el reparto por bandas deja de
    // significar nada: se avisa y no se diagnostica espectro a ciegas.
    warnings.push(
      'Con la correlación en negativo el balance por bandas no es fiable (L+R se cancela): ' +
        'arregla la fase y vuelve a analizar.',
    );
  }
  const spectrumIssues = phaseBroken ? [] : diagnoseSpectrum(analysis, profile);
  const loudnessIssues = diagnoseLoudness(analysis, ctx.targetLufs);

  const issues = [...stereoIssues, ...spectrumIssues, ...loudnessIssues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'grave' ? -1 : 1,
  );

  const { chain, gains } = buildChain(issues, analysis, ctx, warnings);

  const graves = issues.filter((i) => i.severity === 'grave').length;
  const headline =
    issues.length === 0
      ? `La mezcla está en su sitio para ${GENRE_LABELS[ctx.genre]} a ${ctx.targetLufs} LUFS.`
      : graves > 0
        ? `${graves} cosa(s) que arreglar antes de dar el master por bueno.`
        : `Nada grave: ${issues.length} ajuste(s) finos.`;

  return {
    genre: ctx.genre,
    targetLufs: ctx.targetLufs,
    gainToTargetDb: round(gainToTarget(analysis, ctx.targetLufs)),
    tilts: {
      low: round(analysis.bands.low - analysis.bands.highMid),
      body: round(analysis.bands.lowMid - analysis.bands.highMid),
      high: round(analysis.bands.high - analysis.bands.highMid),
    },
    issues,
    chain,
    gains,
    warnings,
    headline,
  };
}

/** Adivina el género por el tempo cuando el usuario no lo dice. */
export function guessGenre(bpm: number): MixGenre {
  if (bpm >= 84 && bpm <= 100) return 'reggaeton'; // dembow moderno
  if (bpm >= 70 && bpm < 84) return 'trap'; // trap en mitad de tiempo
  if (bpm >= 60 && bpm < 70) return 'boombap';
  if (bpm >= 130 && bpm <= 160) return 'trap'; // el mismo trap contado a doble
  return 'generico';
}

/** Texto del consejo en el formato compacto que usan las demás tools. */
export function formatAdvice(advice: MixAdvice, analysis: MixAnalysis, what: string): string {
  const lines: string[] = [];
  lines.push(
    `Consejo de mezcla (${what}, criterio ${GENRE_LABELS[advice.genre]}, objetivo ${advice.targetLufs} LUFS): ${advice.headline}`,
  );
  lines.push(
    `Medidas: LUFS ${round(analysis.lufsIntegrated)} (${dbText(advice.gainToTargetDb)} al objetivo) · ` +
      `peak ${round(analysis.peakDb)} dBFS · correlación ${round(analysis.stereoCorrelation, 2)}`,
  );
  lines.push(
    `Bandas rel.: low ${round(analysis.bands.low)} · low-mid ${round(analysis.bands.lowMid)} · ` +
      `high-mid ${round(analysis.bands.highMid)} · high ${round(analysis.bands.high)} ` +
      `(tilts: grave ${dbText(advice.tilts.low)}, cuerpo ${dbText(advice.tilts.body)}, brillo ${dbText(advice.tilts.high)})`,
  );

  lines.push('');
  lines.push('Diagnóstico:');
  if (advice.issues.length === 0) lines.push('  - Nada que corregir: el balance y el loudness cuadran.');
  for (const issue of advice.issues) {
    lines.push(`  - [${issue.severity}] ${issue.text}`);
  }

  lines.push('');
  lines.push('Cadena propuesta:');
  for (const step of advice.chain) {
    const params = Object.entries(step.params)
      .map(([k, v]) => `${k}=${round(v, 3)}`)
      .join(' ');
    const sc = step.sidechainSource !== undefined ? ` sidechain=${step.sidechainSource}` : '';
    lines.push(
      `  - Mixer ${step.trackIndex} "${step.trackName}" slot ${step.slotIndex}: ` +
        `${step.existing ? 'ajustar' : 'insertar'} ${step.kind} · ${params}${sc}`,
    );
    lines.push(`      ${step.why}`);
  }
  for (const gain of advice.gains) {
    lines.push(`  - Mixer ${gain.trackIndex} "${gain.trackName}": fader a ${dbText(gain.volumeDb)}`);
    lines.push(`      ${gain.why}`);
  }

  if (advice.warnings.length > 0) {
    lines.push('');
    lines.push('Ojo:');
    for (const w of advice.warnings) lines.push(`  - ${w}`);
  }

  return lines.join('\n');
}
