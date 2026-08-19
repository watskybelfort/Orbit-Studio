/**
 * Un beat con estructura no es un loop largo.
 *
 * Lo que hay que probar no es que dure más, sino que cada compás suene según
 * DÓNDE está: la intro sin bombo, el drop con todo, la vuelta sin 808 para que
 * el drop siguiente vuelva a pegar, y el redoble anunciando lo que viene. Si
 * eso no se cumple, lo que sale es un loop de dos minutos.
 */

import { describe, expect, it } from 'vitest';
import { renderProject } from '../../engine/src/render/offline';
import { MAX_STRUCTURED_BEATS, PACK_STYLES, planPack } from '../src/pack-recipes';
import { planSections, sectionAt, totalBars } from '../src/pack-structure';

const DRUM_CHANNEL = 0;
const BASS_CHANNEL = 1;
const KICK = 36;

/** Compases (0-based) que ocupa cada sección del beat número `index`. */
function barsOf(index: number, kind: string): number[] {
  const sections = planSections(index);
  const out: number[] = [];
  for (let bar = 0; bar < totalBars(sections); bar++) {
    if (sectionAt(sections, bar)?.kind === kind) out.push(bar);
  }
  return out;
}

/** Notas de un canal dentro de un compás. */
function notesIn(
  events: { start: number; channelIndex: number; key: number }[],
  channelIndex: number,
  bar: number,
) {
  return events.filter(
    (e) => e.channelIndex === channelIndex && e.start >= bar * 4 && e.start < (bar + 1) * 4,
  );
}

const beat = planPack({ family: 'beats', count: 1 }).sounds[0]!;
const events = beat.project.events;

describe('beats con estructura', () => {
  it('sale un tema entero, no cuatro compases', () => {
    expect(beat.project.lengthBeats).toBeGreaterThanOrEqual(64);
    expect(beat.exactBeats).toBe(beat.project.lengthBeats);
    expect(beat.bpm).toBeGreaterThan(0);
  });

  it('trae las tres pistas sonando a la vez', () => {
    expect(beat.project.channels).toHaveLength(3);
    const usados = new Set(events.map((e) => e.channelIndex));
    expect(usados).toEqual(new Set([0, 1, 2]));
  });

  it('la intro no lleva bombo y el drop sí', () => {
    for (const bar of barsOf(0, 'intro')) {
      expect(notesIn(events, DRUM_CHANNEL, bar).filter((n) => n.key === KICK)).toHaveLength(0);
    }
    for (const bar of barsOf(0, 'drop')) {
      expect(
        notesIn(events, DRUM_CHANNEL, bar).filter((n) => n.key === KICK).length,
      ).toBeGreaterThan(0);
    }
  });

  it('la vuelta se queda sin 808 (es lo que deja sitio para volver a subir)', () => {
    for (const bar of barsOf(0, 'break')) {
      expect(notesIn(events, BASS_CHANNEL, bar)).toHaveLength(0);
    }
    for (const bar of barsOf(0, 'drop')) {
      expect(notesIn(events, BASS_CHANNEL, bar).length).toBeGreaterThan(0);
    }
  });

  it('la subida cierra con redoble y sin bombo: el drop entra por el silencio', () => {
    const sections = planSections(0);
    const build = sections.find((s) => s.kind === 'build')!;
    const ultimo = build.startBar + build.bars - 1;
    const enElUltimo = notesIn(events, DRUM_CHANNEL, ultimo);
    expect(enElUltimo.filter((n) => n.key === KICK)).toHaveLength(0);
    // El redoble son dieciséis golpes de caja en la segunda mitad del compás.
    const caja = enElUltimo.filter((n) => n.key === 38 || n.key === 39);
    expect(caja.length).toBeGreaterThanOrEqual(16);
  });

  it('el drop entra con plato', () => {
    const sections = planSections(0);
    const drop = sections.find((s) => s.kind === 'drop')!;
    const enElPrimero = notesIn(events, DRUM_CHANNEL, drop.startBar);
    expect(enElPrimero.some((n) => n.key === 46)).toBe(true);
  });

  it('todos los estilos dan un beat que suena', () => {
    for (const style of PACK_STYLES) {
      const plan = planPack({ family: 'beats', style, count: 1 });
      const sound = plan.sounds[0]!;
      expect(sound.project.events.length).toBeGreaterThan(50);
      expect(sound.project.channels).toHaveLength(3);
      expect(sound.maxSec).toBeGreaterThan(20);
    }
  });

  it('dos beats del mismo pack no son el mismo tema', () => {
    const plan = planPack({ family: 'beats', count: 2 });
    const a = JSON.stringify(plan.sounds[0]!.project.events);
    const b = JSON.stringify(plan.sounds[1]!.project.events);
    expect(a).not.toBe(b);
  });

  it('la familia tiene su propio tope: un beat pesa como veinte hats', () => {
    const plan = planPack({ family: 'beats', count: 32 });
    expect(plan.sounds).toHaveLength(MAX_STRUCTURED_BEATS);
    // Y por defecto no se piden ocho como en el resto de familias.
    expect(planPack({ family: 'beats' }).sounds.length).toBeLessThanOrEqual(MAX_STRUCTURED_BEATS);
  });

  it('suena de verdad: la intro entra floja y el drop pega más', () => {
    const sections = planSections(0);
    const drop = sections.find((s) => s.kind === 'drop')!;
    // Solo dos tramos cortos: renderizar el tema entero en un test es un minuto
    // y medio de audio por gusto.
    const intro = renderProject(beat.project, { endBeat: 8, tailSeconds: 0 });
    const golpe = renderProject(beat.project, {
      startBeat: drop.startBar * 4,
      endBeat: drop.startBar * 4 + 8,
      tailSeconds: 0,
    });

    const rms = (xs: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < xs.length; i++) s += xs[i]! * xs[i]!;
      return Math.sqrt(s / Math.max(1, xs.length));
    };
    /**
     * Energía por debajo de ~150 Hz (un polo, suficiente para esto). El RMS a
     * secas NO sirve para medir un drop: un pad sostenido como el de la intro
     * llena más el medidor que una batería a golpes. Lo que separa un drop de
     * una intro es el GRAVE — el bombo y el 808 —, y eso sí se mide.
     */
    const bajos = (xs: Float32Array, sr = 44100): number => {
      const a = Math.exp((-2 * Math.PI * 150) / sr);
      let y = 0;
      let s = 0;
      for (let i = 0; i < xs.length; i++) {
        y = (1 - a) * xs[i]! + a * y;
        s += y * y;
      }
      return Math.sqrt(s / Math.max(1, xs.length));
    };
    const finito = (xs: Float32Array): boolean => xs.every((v) => Number.isFinite(v));

    expect(finito(intro.left)).toBe(true);
    expect(finito(golpe.left)).toBe(true);
    expect(rms(intro.left)).toBeGreaterThan(0.001);
    expect(rms(golpe.left)).toBeGreaterThan(0.001);
    // El drop tiene que traer el grave que la intro no tiene: si no, la
    // estructura es un adorno del plan que no llega al audio.
    expect(bajos(golpe.left)).toBeGreaterThan(bajos(intro.left) * 3);
  });

  it('el mismo encargo da exactamente el mismo tema', () => {
    const a = planPack({ family: 'beats', style: 'drill', count: 2, seed: 7 });
    const b = planPack({ family: 'beats', style: 'drill', count: 2, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
