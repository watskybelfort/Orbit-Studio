/**
 * Presets rítmicos y de textura de Orbit Prisma: voces, arpegios, atmósferas,
 * efectos, percusión y sonidos del mundo.
 *
 * Mismas reglas de autoría que el archivo melódico: las capas dicen de qué
 * está hecho, `base` deja las perillas donde el sonido ya funciona, y las
 * macros llevan nombre de lo que hacen al oído.
 */

import { chan, layer, macro, on, preset, type PrismaPreset } from './prisma';

export const PRISMA_RHYTHM: PrismaPreset[] = [
  // ── Voces ───────────────────────────────────────────────────────────────
  preset(
    'vocals/coro-fantasma',
    'Coro Fantasma',
    'vocals',
    ['coro', 'voces', 'fantasma', 'cine', 'ambiente'],
    [
      layer('formant', { wave: 0.15, level: 0.8, phase: -1, attackMul: 2 }),
      layer('formant', { wave: 0.55, level: 0.45, semi: 12, pan: 0.3, phase: -1, attackMul: 2.4 }),
      layer('noise', { wave: 0.8, level: 0.05, attackMul: 3, params: { q: 3 } }),
    ],
    {
      unison: 3, uniDetune: 0.3, uniWidth: 1,
      cutoff: 4000, resonance: 0.1,
      attack: 0.7, decay: 2.5, sustain: 0.8, release: 2,
      lfoShape: 0, lfoRate: 4.8, lfoAmount: 0.05, lfoTarget: 0, lfoDelay: 0.5,
      wave: 0.15, width: 1.7,
    },
    [
      macro('Vocal', 0.2, [on(0, 'wave', 0, 1), on(1, 'wave', 0.2, 1)]),
      macro('Aire', 0.35, [on(2, 'level', 0, 0.2), chan('treble', -4, 8)]),
      macro('Coro', 0.5, [chan('uniDetune', 0.05, 0.7), chan('width', 0.6, 2)]),
      macro('Respiración', 0.5, [chan('attack', 0.1, 2.5), chan('release', 0.5, 6)]),
    ],
  ),

  // ── Arpegios ────────────────────────────────────────────────────────────
  preset(
    'arps/arp-neon',
    'Arp Neón',
    'arps',
    ['arp', 'synthwave', 'retro', 'corto'],
    [
      layer('pulse', { wave: 0.28, level: 0.85 }),
      layer('wt', { wave: 0.75, level: 0.3, semi: 12, pan: 0.2 }),
    ],
    {
      cutoff: 3600, resonance: 0.35, filterEnv: 0.7,
      attack: 0.001, decay: 0.28, sustain: 0.15, release: 0.18,
      modAttack: 0.001, modDecay: 0.22, modSustain: 0, modAmount: 0.4, modTarget: 1,
      lfoShape: 0, lfoRate: 0.4, lfoAmount: 0.12, lfoTarget: 3,
      wave: 0.28, drive: 0.2, width: 1.2, velSens: 0.8,
    },
    [
      macro('Filtro', 0.4, [chan('cutoff', 400, 14000)]),
      macro('Mordida', 0.4, [chan('resonance', 0.05, 0.85), chan('filterEnv', 0, 1)]),
      macro('PWM', 0.4, [chan('lfoAmount', 0, 0.4), on(0, 'wave', 0.08, 0.5)]),
    ],
  ),

  // ── Atmósferas ──────────────────────────────────────────────────────────
  preset(
    'atmos/drone-abismo',
    'Drone del Abismo',
    'atmos',
    ['drone', 'tension', 'terror', 'cine', 'grave'],
    [
      layer('wt', { wave: 0.58, level: 0.7, semi: -12, phase: -1, attackMul: 3 }),
      layer('fm', { wave: 0.65, level: 0.3, semi: -24, attackMul: 4, params: { ratio: 0.5, feedback: 0.45 } }),
      layer('noise', { wave: 0.25, level: 0.08, attackMul: 5, params: { q: 1.5 } }),
    ],
    {
      unison: 4, uniDetune: 0.5, uniWidth: 1,
      cutoff: 800, resonance: 0.2, filterEnv: 0.2,
      attack: 2.2, decay: 4, sustain: 0.9, release: 3.5,
      lfoShape: 4, lfoRate: 0.18, lfoAmount: 0.2, lfoTarget: 1,
      wave: 0.58, drive: 0.25, width: 1.8, velSens: 0.2,
    },
    [
      macro('Inquietud', 0.4, [on(1, 'level', 0, 0.7), chan('lfoAmount', 0, 0.5)]),
      macro('Apertura', 0.25, [chan('cutoff', 120, 7000)]),
      macro('Peso', 0.5, [chan('bass', -3, 10)]),
    ],
  ),

  // ── Efectos ─────────────────────────────────────────────────────────────
  preset(
    'fx/riser-cinta',
    'Riser de Cinta',
    'fx',
    ['riser', 'transicion', 'edm', 'subida'],
    [
      layer('noise', { wave: 0.5, level: 0.6, attackMul: 4, params: { q: 5 } }),
      layer('wt', { wave: 0.7, level: 0.45, phase: -1, attackMul: 4 }),
    ],
    {
      unison: 3, uniDetune: 0.4, uniWidth: 1,
      cutoff: 2000, resonance: 0.45,
      attack: 1.8, decay: 2, sustain: 0.95, release: 0.25,
      modAttack: 2, modDecay: 0.5, modSustain: 1, modAmount: 0.9, modTarget: 1,
      lfoShape: 2, lfoRate: 3, lfoAmount: 0.1, lfoTarget: 0,
      wave: 0.7, width: 1.6, velSens: 0.3,
    },
    [
      macro('Subida', 0.6, [chan('attack', 0.3, 4), chan('modAttack', 0.3, 4)]),
      macro('Barrido', 0.6, [chan('modAmount', 0, 1), chan('resonance', 0.1, 0.85)]),
      macro('Ruido', 0.5, [on(0, 'level', 0, 1)]),
    ],
  ),
  preset(
    'fx/impacto-sub',
    'Impacto Sub',
    'fx',
    ['impacto', 'drop', 'sub', 'cine'],
    [
      layer('sub', { wave: 0.5, level: 1 }),
      layer('noise', { wave: 0.3, level: 0.25, decayMul: 0.15, params: { q: 1 } }),
    ],
    {
      glide: 0.45, voiceMode: 1,
      cutoff: 700, resonance: 0.1,
      attack: 0.001, decay: 3.5, sustain: 0.2, release: 1.5,
      wave: 0.5, drive: 0.35, bass: 6, width: 0.6, velSens: 0.5,
    },
    [
      macro('Caída', 0.6, [chan('glide', 0.05, 1)]),
      macro('Cola', 0.7, [chan('decay', 0.6, 8)]),
      macro('Golpe', 0.35, [on(1, 'level', 0, 0.7)]),
    ],
  ),

  // ── Percusión ───────────────────────────────────────────────────────────
  preset(
    'drums/kit-sintetico',
    'Kit Sintético',
    'drums',
    ['kit', 'percusion', 'trap', 'techno'],
    [
      // Grave: bombo/tom, solo en la parte baja del teclado.
      layer('sub', { wave: 0.6, level: 1, keyHi: 47, decayMul: 0.12, releaseMul: 0.2 }),
      // Medio: caja/clap.
      layer('noise', { wave: 0.45, level: 0.8, keyLo: 48, keyHi: 59, decayMul: 0.1, params: { q: 2.5 } }),
      // Agudo: hats y metales.
      layer('noise', { wave: 0.92, level: 0.55, keyLo: 60, decayMul: 0.05, params: { q: 6 } }),
    ],
    {
      keytrack: 0,
      cutoff: 12000, resonance: 0.1, filterEnv: 0.3,
      attack: 0.0005, decay: 0.6, sustain: 0, release: 0.08,
      wave: 0.5, drive: 0.3, velSens: 1, width: 1,
    },
    [
      macro('Cuerpo', 0.4, [on(0, 'decayMul', 0.04, 0.4)]),
      macro('Chasquido', 0.5, [on(1, 'wave', 0.1, 0.9), on(2, 'level', 0.1, 1)]),
      macro('Cola', 0.35, [chan('decay', 0.1, 2.5)]),
      macro('Suciedad', 0.35, [chan('drive', 0, 1)]),
    ],
  ),

  // ── Del mundo ───────────────────────────────────────────────────────────
  preset(
    'world/marimba-selva',
    'Marimba de Selva',
    'world',
    ['marimba', 'madera', 'latin', 'afrobeat'],
    [
      layer('bell', { wave: 0.28, level: 0.9, params: { partials: 4, inharm: 0.15 } }),
      layer('wt', { wave: 0.12, level: 0.2, semi: 12, decayMul: 0.35 }),
    ],
    {
      cutoff: 5200, resonance: 0.06, filterEnv: 0.35,
      attack: 0.001, decay: 0.9, sustain: 0, release: 0.4,
      wave: 0.28, width: 1, velSens: 0.9,
    },
    [
      macro('Madera', 0.35, [on(0, 'wave', 0.05, 0.7)]),
      macro('Cola', 0.4, [chan('decay', 0.25, 2.5)]),
      macro('Brillo', 0.5, [chan('cutoff', 1200, 12000)]),
    ],
  ),
  preset(
    'world/kalimba-lluvia',
    'Kalimba de Lluvia',
    'world',
    ['kalimba', 'afrobeat', 'suave', 'metal'],
    [
      layer('pluck', { wave: 0.7, level: 0.85, params: { damp: 0.2 } }),
      layer('bell', { wave: 0.4, level: 0.22, semi: 12, decayMul: 0.5, params: { partials: 3, inharm: 0.4 } }),
    ],
    {
      cutoff: 7000, resonance: 0.1, filterEnv: 0.4,
      attack: 0.001, decay: 1.1, sustain: 0, release: 0.55,
      wave: 0.7, width: 1.2, velSens: 0.85,
    },
    [
      macro('Metal', 0.4, [on(1, 'level', 0, 0.5), on(0, 'wave', 0.2, 1)]),
      macro('Cola', 0.45, [chan('decay', 0.3, 3)]),
      macro('Brillo', 0.5, [chan('cutoff', 1500, 16000)]),
    ],
  ),
];
