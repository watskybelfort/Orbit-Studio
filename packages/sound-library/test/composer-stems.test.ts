import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@orbit/core';
import { compileProject, renderStems, type CompiledProject } from '@orbit/engine';
import { composeBeat, planToCommands } from '../src';

/**
 * El stem del bajo tiene que sonar como el bajo de la mezcla: agachándose con
 * el bombo. Antes el export muteaba la pista del bombo ENTERA, el detector del
 * compresor sidechain se quedaba sin señal y el bajo salía sin ducking.
 *
 * Batería sintética (no hacen falta samples): se reemplaza el bombo sampleado
 * por el kit de Orbit para que el test no dependa de leer WAV del pack.
 */
function trapProject(): { compiled: CompiledProject; kickTrack: number; bassTrack: number } {
  const store = new ProjectStore();
  const { commands, applied } = planToCommands(store.project, composeBeat({ genre: 'trap', seed: 1, shape: 'loop', loopBars: 2 }));
  store.dispatch({ type: 'batch', commands });
  const p = structuredClone(store.project);
  const kick = applied.parts.find((a) => a.role === 'kick')!;
  const bass = applied.parts.find((a) => a.role === 'bass')!;
  const ch = p.channels[kick.channelId]!;
  ch.kind = 'drums';
  delete ch.keymap;
  delete ch.sampleId;
  return { compiled: compileProject(p, { mode: 'song' }), kickTrack: kick.mixerTrack, bassTrack: bass.mixerTrack };
}

const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);

describe('stems con sidechain', () => {
  it('el stem del bajo lleva el ducking del bombo, sin que el bombo suene en él', () => {
    const { compiled, kickTrack, bassTrack } = trapProject();
    const opts = { sampleRate: 22050, tailSeconds: 0 };
    const withKey = renderStems(compiled, [bassTrack], opts).results.get(bassTrack)!;
    // El mismo stem sin el compresor: así sonaba el bajo exportado antes.
    const noComp: CompiledProject = {
      ...compiled,
      channels: compiled.channels.map((c) => (c.mixerTrack === bassTrack ? { ...c, fx: c.fx?.map((s) => (s && s.kind === 'compressor' ? { ...s, enabled: false } : s)) } : c)),
    };
    const dry = renderStems(noComp, [bassTrack], opts).results.get(bassTrack)!;
    const ducked = energy(withKey.left);
    const plain = energy(dry.left);
    // Se agacha de verdad (menos energía con el detector escuchando al bombo)...
    expect(10 * Math.log10(ducked / plain)).toBeLessThan(-0.5);
    // ...y el bombo no se cuela. El 808 casi no tiene agudos y el bombo sí (su
    // ataque): la energía de la segunda diferencia —un paso alto fuerte— del
    // stem con ducking no puede pasar de la del bajo seco. (Muestra a muestra no
    // se puede comparar: el stem pasa también por el limitador del master.)
    const highs = (x: Float32Array) => {
      let e = 0;
      for (let i = 2; i < x.length; i++) e += (x[i]! - 2 * x[i - 1]! + x[i - 2]!) ** 2;
      return e;
    };
    expect(highs(withKey.left)).toBeLessThanOrEqual(highs(dry.left) * 1.05);
    // Control: el bombo SÍ tiene agudos de sobra, así que si se colara se vería.
    // El stem del bombo sigue teniendo su bombo.
    const kickStem = renderStems(compiled, [kickTrack], opts).results.get(kickTrack)!;
    expect(highs(kickStem.left)).toBeGreaterThan(highs(dry.left) * 0.2);
  });
});
