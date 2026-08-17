/**
 * Asistente de mezcla sobre análisis FABRICADOS a mano: aquí no se renderiza
 * nada, se comprueba que el consejo detecta los casos claros (exceso de
 * graves, master demasiado bajo, correlación negativa) y que la cadena que
 * propone es coherente con el diagnóstico.
 *
 * Los números de partida salen de medir el propio motor con señales de
 * referencia (ver la cabecera de src/mix-advisor.ts).
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@orbit/core';
import type { MixAnalysis } from '@orbit/engine';
import { ToolExecutor } from '../src/executor';
import {
  CEILING_DB,
  MONO_BELOW_HZ,
  STREAMING_LUFS,
  adviseMix,
  formatAdvice,
  guessGenre,
  type MixAdvice,
  type MixContext,
  type MixIssueId,
  type TrackSlots,
} from '../src/mix-advisor';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Mezcla de trap equilibrada y a -14 LUFS (medida con ruido rosa + 808). */
const SANA: MixAnalysis = {
  lufsIntegrated: -14,
  peakDb: -1.2,
  bands: { low: -1.1, lowMid: -10.2, highMid: -11.3, high: -13 },
  stereoCorrelation: 0.72,
};

function mix(patch: Partial<MixAnalysis>): MixAnalysis {
  return {
    ...SANA,
    ...patch,
    bands: { ...SANA.bands, ...(patch.bands ?? {}) },
  };
}

function track(index: number, name: string, slots: TrackSlots['slots'] = [null, null, null, null]): TrackSlots {
  return { index, name, slots };
}

function ctx(extra: Partial<MixContext> = {}): MixContext {
  return {
    genre: 'trap',
    targetLufs: STREAMING_LUFS,
    master: track(0, 'Master'),
    ...extra,
  };
}

function ids(advice: MixAdvice): MixIssueId[] {
  return advice.issues.map((i) => i.id);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('adviseMix: casos claros', () => {
  it('una mezcla sana no inventa problemas', () => {
    const advice = adviseMix(SANA, ctx());
    expect(advice.issues).toHaveLength(0);
    expect(advice.headline).toMatch(/en su sitio/i);
    // Aun así deja la cadena mínima de master: EQ de limpieza + limitador.
    expect(advice.chain.map((s) => s.kind)).toEqual(['eq', 'limiter']);
    expect(advice.chain.every((s) => s.trackIndex === 0)).toBe(true);
  });

  it('detecta exceso de graves y lo corrige con shelf negativo', () => {
    // low muy por encima del resto (medido con pink + 808 a saco).
    const analysis = mix({ bands: { low: -0.2, lowMid: -15, highMid: -21.6, high: -23.3 } });
    const advice = adviseMix(analysis, ctx());

    expect(ids(advice)).toContain('graves-de-mas');
    const issue = advice.issues.find((i) => i.id === 'graves-de-mas')!;
    expect(issue.severity).toBe('grave');
    expect(issue.deltaDb).toBeGreaterThan(0);
    expect(advice.tilts.low).toBeCloseTo(21.4, 1);

    const eq = advice.chain.find((s) => s.trackIndex === 0 && s.kind === 'eq')!;
    expect(eq.params['lowGain']).toBeLessThan(0);
    expect(eq.params['lowGain']).toBeGreaterThanOrEqual(-6);
    expect(eq.params['hpFreq']).toBe(28);
  });

  it('detecta falta de graves y sube el shelf', () => {
    // Ruido blanco: casi todo por arriba.
    const analysis = mix({ bands: { low: -22.2, lowMid: -14.1, highMid: -6.2, high: -1.5 } });
    const advice = adviseMix(analysis, ctx());

    expect(ids(advice)).toContain('graves-de-menos');
    expect(ids(advice)).toContain('agudos-de-mas');
    const eq = advice.chain.find((s) => s.kind === 'eq')!;
    expect(eq.params['lowGain']).toBeGreaterThan(0);
    expect(eq.params['highGain']).toBeLessThan(0);
  });

  it('detecta el master demasiado bajo y pide ganancia al limitador', () => {
    const analysis = mix({ lufsIntegrated: -22, peakDb: -8 });
    const advice = adviseMix(analysis, ctx());

    expect(ids(advice)).toContain('loudness-bajo');
    const issue = advice.issues.find((i) => i.id === 'loudness-bajo')!;
    expect(issue.severity).toBe('grave');
    expect(advice.gainToTargetDb).toBeCloseTo(8, 1);
    expect(issue.text).toContain('-14');

    const limiter = advice.chain.find((s) => s.kind === 'limiter')!;
    expect(limiter.params['gain']).toBeCloseTo(8, 1);
    expect(limiter.params['ceiling']).toBe(CEILING_DB);
    // Con tanto aire por arriba, avisa de que no hace falta comprimir más.
    expect(ids(advice)).toContain('headroom-de-sobra');
  });

  it('detecta el master pasado de vueltas y propone bajar en vez de ganar', () => {
    const analysis = mix({ lufsIntegrated: -7, peakDb: -0.05 });
    const advice = adviseMix(analysis, ctx());

    expect(ids(advice)).toContain('loudness-alto');
    expect(ids(advice)).toContain('peak-alto');
    const limiter = advice.chain.find((s) => s.kind === 'limiter')!;
    expect(limiter.params['gain']).toBe(0);
    expect(advice.gains).toHaveLength(1);
    expect(advice.gains[0]!.volumeDb).toBeLessThan(0);
    expect(advice.gains[0]!.trackIndex).toBe(0);
  });

  it('detecta correlación negativa como problema de fase y no fía las bandas', () => {
    // Con la fase invertida L+R se cancela y todas las bandas leen 0.
    const analysis = mix({
      stereoCorrelation: -1,
      bands: { low: 0, lowMid: 0, highMid: 0, high: 0 },
    });
    const advice = adviseMix(analysis, ctx());

    const fase = advice.issues.find((i) => i.id === 'fase')!;
    expect(fase).toBeDefined();
    expect(fase.severity).toBe('grave');
    // Nada de diagnóstico espectral a ciegas.
    expect(ids(advice)).not.toContain('graves-de-mas');
    expect(ids(advice)).not.toContain('graves-de-menos');
    expect(advice.warnings.join(' ')).toMatch(/no es fiable/i);

    const stereo = advice.chain.find((s) => s.kind === 'stereo')!;
    expect(stereo.params['width']).toBeLessThan(1);
    expect(stereo.params['monoBelow']).toBe(MONO_BELOW_HZ);
  });

  it('avisa de mezcla casi mono y propone abrirla dejando el grave centrado', () => {
    const advice = adviseMix(mix({ stereoCorrelation: 0.999 }), ctx());
    expect(ids(advice)).toContain('demasiado-mono');
    const stereo = advice.chain.find((s) => s.kind === 'stereo')!;
    expect(stereo.params['width']).toBeGreaterThan(1);
    expect(stereo.params['monoBelow']).toBe(MONO_BELOW_HZ);
  });

  it('el criterio de género cambia el veredicto sobre el mismo grave', () => {
    // tilt de grave = 13 dB: normal en trap, de más para boom bap.
    const analysis = mix({ bands: { low: -1, lowMid: -10, highMid: -14, high: -16 } });
    expect(ids(adviseMix(analysis, ctx({ genre: 'trap' })))).not.toContain('graves-de-mas');
    expect(ids(adviseMix(analysis, ctx({ genre: 'boombap' })))).toContain('graves-de-mas');
  });
});

describe('adviseMix: cadena propuesta', () => {
  it('trata la voz para que mande sobre el beat, con sidechain en el beat', () => {
    const advice = adviseMix(
      SANA,
      ctx({ voice: track(3, 'Voz'), beat: track(4, 'Beat') }),
    );

    const voiceEq = advice.chain.find((s) => s.trackIndex === 3 && s.kind === 'eq')!;
    expect(voiceEq.params['hpFreq']).toBe(100);
    expect(voiceEq.params['midGain']).toBeGreaterThan(0); // presencia
    expect(voiceEq.params['highGain']).toBeGreaterThan(0); // aire

    const voiceComp = advice.chain.find((s) => s.trackIndex === 3 && s.kind === 'compressor')!;
    expect(voiceComp.params['ratio']).toBeGreaterThan(1);

    const beatComp = advice.chain.find((s) => s.trackIndex === 4 && s.kind === 'compressor')!;
    expect(beatComp.sidechainSource).toBe(3);
  });

  it('reajusta el efecto que ya existe en vez de duplicarlo', () => {
    const advice = adviseMix(
      mix({ lufsIntegrated: -20 }),
      ctx({ master: track(0, 'Master', ['limiter', null, null, null]) }),
    );
    const limiter = advice.chain.find((s) => s.kind === 'limiter')!;
    expect(limiter.existing).toBe(true);
    expect(limiter.slotIndex).toBe(0);
    // Y avisa de que así el limitador queda antes que el EQ nuevo.
    expect(advice.warnings.join(' ')).toMatch(/limitador/i);
  });

  it('avisa cuando no quedan slots libres en vez de proponer imposibles', () => {
    const full: TrackSlots['slots'] = ['reverb', 'delay', 'chorus', 'phaser'];
    const advice = adviseMix(SANA, ctx({ master: track(0, 'Master', full) }));
    expect(advice.chain).toHaveLength(0);
    expect(advice.warnings.join(' ')).toMatch(/slots libres/i);
  });

  it('corrige el grave también en la pista del 808 cuando sobra', () => {
    const analysis = mix({ bands: { low: -0.2, lowMid: -15, highMid: -21.6, high: -23.3 } });
    const advice = adviseMix(analysis, ctx({ low: track(2, '808') }));
    const subEq = advice.chain.find((s) => s.trackIndex === 2 && s.kind === 'eq')!;
    expect(subEq.params['hpFreq']).toBe(30);
    expect(subEq.params['lowGain']).toBeLessThan(0);
  });

  it('el texto sale en el formato de las demás tools (accionable y compacto)', () => {
    const analysis = mix({ lufsIntegrated: -21, bands: { low: -0.2, lowMid: -15, highMid: -21.6, high: -23.3 } });
    const text = formatAdvice(adviseMix(analysis, ctx()), analysis, 'canción');
    expect(text).toContain('Diagnóstico:');
    expect(text).toContain('Cadena propuesta:');
    expect(text).toMatch(/Mixer 0 "Master" slot \d+: insertar (eq|limiter)/);
    expect(text).toContain('-14 LUFS');
  });
});

describe('tool advise_mix (executor)', () => {
  /** Proyecto mínimo con 808 y voz en pistas de mixer distintas. */
  async function project() {
    const store = new ProjectStore();
    const executor = new ToolExecutor(store);
    const patternId = store.project.patternOrder[0]!;

    await executor.execute('add_channel', { kind: 'drums', name: 'Kit', mixerTrack: 1 });
    await executor.execute('set_steps', { patternId, channelId: 'Kit', steps: 'x---x---x---x---' });
    await executor.execute('add_channel', { kind: 'sub808', name: '808', mixerTrack: 2 });
    await executor.execute('set_notes', {
      patternId,
      channelId: '808',
      notes: [{ start: 0, duration: 2, note: 'F1' }],
    });
    await executor.execute('add_channel', { kind: 'vox', name: 'Voz', mixerTrack: 3 });
    await executor.execute('set_notes', {
      patternId,
      channelId: 'Voz',
      notes: [{ start: 0, duration: 1, note: 'C4' }],
    });
    return { store, executor };
  }

  it('aconseja sin tocar nada y detecta voz y 808 por su nombre', async () => {
    const { store, executor } = await project();
    const before = store.version;
    const { text } = await executor.execute('advise_mix', {});

    expect(text).toContain('Consejo de mezcla');
    expect(text).toContain('Diagnóstico:');
    expect(text).toMatch(/voz = mixer 3/);
    expect(text).toMatch(/808\/sub = mixer 2/);
    expect(text).toContain('apply=true');
    expect(store.version).toBe(before); // sin apply no muta nada
  });

  it('con apply=true deja la cadena puesta en UN solo paso de undo', async () => {
    const { store, executor } = await project();
    const historyBefore = store.history.length;

    const { text } = await executor.execute('advise_mix', { apply: true, genre: 'trap' });
    expect(text).toContain('Aplicado en un solo paso de undo');

    expect(store.history.length).toBe(historyBefore + 1);
    const entry = store.history[store.history.length - 1]!;
    expect(entry.origin).toBe('claude');

    // El master acaba con EQ y limitador; la voz, con su EQ y su compresor.
    const master = store.project.mixer[0]!.slots.filter((s) => s !== null).map((s) => s!.kind);
    expect(master).toContain('eq');
    expect(master).toContain('limiter');
    const voz = store.project.mixer[3]!.slots.filter((s) => s !== null).map((s) => s!.kind);
    expect(voz).toEqual(['eq', 'compressor']);

    // Y se deshace entero de una (undo por origen, el de Claude).
    expect(store.undo('claude')).toBe(true);
    expect(store.project.mixer[0]!.slots.every((s) => s === null)).toBe(true);
    expect(store.project.mixer[3]!.slots.every((s) => s === null)).toBe(true);
  });
});

describe('guessGenre', () => {
  it('deduce el género por el tempo del proyecto', () => {
    expect(guessGenre(76)).toBe('trap'); // boom bap oscuro a mitad de tiempo / trap
    expect(guessGenre(64)).toBe('boombap');
    expect(guessGenre(95)).toBe('reggaeton');
    expect(guessGenre(140)).toBe('trap');
    expect(guessGenre(174)).toBe('generico');
  });
});

