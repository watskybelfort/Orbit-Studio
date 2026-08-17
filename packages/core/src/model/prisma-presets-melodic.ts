/**
 * Presets melódicos de Orbit Prisma: teclas, bajos, leads, pads, plucks,
 * campanas, órganos, cuerdas, vientos y guitarras.
 *
 * Cómo se lee una ficha: las CAPAS dicen de qué está hecho el sonido y `base`
 * dice en qué punto quedan las perillas del canal al cargarlo — eso es lo que
 * ve y toca el usuario. Las macros mueven varias cosas a la vez con un nombre
 * que signifique algo ("Aire", "Mordida"), no el nombre técnico del parámetro.
 *
 * Parámetros propios de cada motor que entienden las capas (`params`):
 *   fm      → ratio (0.25..16), feedback (0..1)
 *   pluck   → damp (0..1)
 *   organ   → perc (0..1)
 *   bell    → partials (2..12), inharm (0..1)
 *   noise   → q (0.3..12)
 * El resto de motores se gobiernan solo con `wave`.
 */

import { chan, layer, macro, on, preset, type PrismaPreset } from './prisma';

export const PRISMA_MELODIC: PrismaPreset[] = [
  // ── Teclas ──────────────────────────────────────────────────────────────
  preset(
    'keys/rhodes-nocturno',
    'Rhodes Nocturno',
    'keys',
    ['rhodes', 'ep', 'boombap', 'lofi', 'noche', 'suave'],
    [
      layer('fm', { wave: 0.42, level: 0.9, params: { ratio: 2, feedback: 0.12 } }),
      layer('wt', { wave: 0.1, level: 0.3, pan: 0.18, cutoffOct: -0.5, decayMul: 1.4 }),
      layer('bell', { wave: 0.3, level: 0.14, semi: 12, decayMul: 0.35, velTrack: 1, params: { partials: 4, inharm: 0.3 } }),
    ],
    {
      cutoff: 3200, resonance: 0.08, filterEnv: 0.25,
      attack: 0.004, decay: 1.8, sustain: 0.22, release: 0.6,
      wave: 0.42, drive: 0.08, width: 1.1, velSens: 0.8, bass: 1,
    },
    [
      macro('Campana', 0.4, [on(0, 'wave', 0.05, 0.95), on(2, 'level', 0, 0.4)]),
      macro('Cuerpo', 0.5, [chan('cutoff', 900, 9000), on(1, 'level', 0.05, 0.6)]),
      macro('Cola', 0.5, [chan('decay', 0.5, 4.5), chan('release', 0.15, 2.2)]),
      macro('Aire', 0.3, [chan('treble', -6, 8)]),
    ],
  ),
  preset(
    'keys/piano-vidrio',
    'Piano de Vidrio',
    'keys',
    ['piano', 'cristal', 'cine', 'limpio'],
    [
      layer('wt', { wave: 0.28, level: 0.85, decayMul: 0.9 }),
      layer('bell', { wave: 0.55, level: 0.3, semi: 12, decayMul: 0.5, params: { partials: 6, inharm: 0.45 } }),
      layer('wt', { wave: 0.05, level: 0.25, semi: -12, cutoffOct: -1, pan: -0.15 }),
    ],
    {
      cutoff: 6500, resonance: 0.05, filterEnv: 0.35,
      attack: 0.002, decay: 2.4, sustain: 0.08, release: 0.9,
      wave: 0.28, width: 1.2, velSens: 0.9,
    },
    [
      macro('Cristal', 0.45, [on(1, 'level', 0, 0.7), chan('treble', -3, 9)]),
      macro('Peso', 0.4, [on(2, 'level', 0, 0.6), chan('bass', -2, 7)]),
      macro('Cola', 0.55, [chan('decay', 0.6, 6), chan('release', 0.2, 3)]),
    ],
  ),

  // ── Bajos ───────────────────────────────────────────────────────────────
  preset(
    'bass/sub-lienzo',
    'Sub Lienzo',
    'bass',
    ['808', 'sub', 'trap', 'glide', 'limpio'],
    [
      layer('sub', { wave: 0.35, level: 1 }),
      layer('wt', { wave: 0.6, level: 0.18, cutoffOct: -1.5, keyHi: 60, decayMul: 0.4 }),
    ],
    {
      voiceMode: 1, glide: 0.07,
      cutoff: 1200, resonance: 0.05, filterEnv: 0.3,
      attack: 0.002, decay: 2.6, sustain: 0.35, release: 0.5,
      wave: 0.35, drive: 0.28, bass: 3, velSens: 0.4, width: 0.4,
    },
    [
      macro('Distorsión', 0.3, [chan('drive', 0, 1), on(0, 'wave', 0.1, 0.9)]),
      macro('Cola', 0.6, [chan('decay', 0.4, 6), chan('release', 0.1, 2)]),
      macro('Click', 0.35, [on(1, 'level', 0, 0.5)]),
      macro('Glide', 0.3, [chan('glide', 0, 0.4)]),
    ],
  ),
  preset(
    'bass/reese-partido',
    'Reese Partido',
    'bass',
    ['reese', 'dnb', 'dubstep', 'ancho', 'movimiento'],
    [
      layer('wt', { wave: 0.62, level: 0.75, fine: -14, pan: -0.35, phase: -1 }),
      layer('wt', { wave: 0.62, level: 0.75, fine: 14, pan: 0.35, phase: -1 }),
      layer('sub', { wave: 0.2, level: 0.55, semi: -12 }),
    ],
    {
      unison: 3, uniDetune: 0.35, uniWidth: 0.8,
      cutoff: 900, resonance: 0.28, filterEnv: 0.2,
      attack: 0.006, decay: 1.2, sustain: 0.9, release: 0.25,
      lfoShape: 0, lfoRate: 0.6, lfoAmount: 0.18, lfoTarget: 1,
      wave: 0.62, drive: 0.35, width: 1.4, velSens: 0.3,
    },
    [
      macro('Movimiento', 0.4, [chan('lfoAmount', 0, 0.6), chan('lfoRate', 0.15, 3)]),
      macro('Filtro', 0.35, [chan('cutoff', 180, 6000)]),
      macro('Ancho', 0.55, [chan('uniDetune', 0, 0.8), chan('width', 0.4, 2)]),
      macro('Sub', 0.5, [on(2, 'level', 0, 1)]),
    ],
  ),

  // ── Leads ───────────────────────────────────────────────────────────────
  preset(
    'leads/lead-cristal',
    'Lead Cristal',
    'leads',
    ['lead', 'edm', 'brillante', 'ancho'],
    [
      layer('wt', { wave: 0.72, level: 0.9, phase: -1 }),
      layer('wt', { wave: 0.5, level: 0.35, semi: 12, pan: 0.25, cutoffOct: 0.5 }),
    ],
    {
      unison: 5, uniDetune: 0.3, uniWidth: 0.85,
      cutoff: 11000, resonance: 0.12, filterEnv: 0.3,
      attack: 0.008, decay: 1.4, sustain: 0.75, release: 0.35,
      wave: 0.72, drive: 0.15, width: 1.5, treble: 2,
    },
    [
      macro('Detune', 0.35, [chan('uniDetune', 0, 0.9)]),
      macro('Brillo', 0.6, [chan('cutoff', 1200, 20000), chan('treble', -4, 8)]),
      macro('Filo', 0.3, [chan('drive', 0, 0.9), on(0, 'wave', 0.35, 1)]),
    ],
  ),
  preset(
    'leads/flauta-humo',
    'Flauta de Humo',
    'leads',
    ['flauta', 'trap', 'melodia', 'aire'],
    [
      layer('wt', { wave: 0.06, level: 0.85, attackMul: 3 }),
      layer('noise', { wave: 0.72, level: 0.12, attackMul: 2, params: { q: 6 } }),
    ],
    {
      voiceMode: 2, glide: 0.05,
      cutoff: 5200, resonance: 0.1,
      attack: 0.05, decay: 1.2, sustain: 0.7, release: 0.3,
      lfoShape: 0, lfoRate: 5.2, lfoAmount: 0.06, lfoTarget: 0, lfoDelay: 0.35,
      wave: 0.06, width: 0.9, velSens: 0.7,
    },
    [
      macro('Aire', 0.35, [on(1, 'level', 0, 0.4)]),
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.2)]),
      macro('Ataque', 0.35, [chan('attack', 0.008, 0.35)]),
    ],
  ),

  // ── Pads ────────────────────────────────────────────────────────────────
  preset(
    'pads/pad-catedral',
    'Pad Catedral',
    'pads',
    ['pad', 'fondo', 'cine', 'amplio'],
    [
      layer('wt', { wave: 0.55, level: 0.7, phase: -1, attackMul: 1.2 }),
      layer('organ', { wave: 0.4, level: 0.35, semi: 12, pan: 0.3, params: { perc: 0 } }),
      layer('wt', { wave: 0.2, level: 0.4, semi: -12, pan: -0.3, cutoffOct: -0.7 }),
    ],
    {
      unison: 3, uniDetune: 0.22, uniWidth: 1,
      cutoff: 3400, resonance: 0.06, filterEnv: 0.4,
      attack: 0.9, decay: 3, sustain: 0.85, release: 2.4,
      lfoShape: 0, lfoRate: 0.25, lfoAmount: 0.1, lfoTarget: 1,
      wave: 0.55, width: 1.6,
    },
    [
      macro('Apertura', 0.45, [chan('cutoff', 400, 16000)]),
      macro('Respiración', 0.5, [chan('attack', 0.05, 3), chan('release', 0.4, 6)]),
      macro('Oleaje', 0.3, [chan('lfoAmount', 0, 0.4), chan('lfoRate', 0.05, 1.2)]),
      macro('Ancho', 0.6, [chan('width', 0.6, 2), chan('uniDetune', 0.05, 0.6)]),
    ],
  ),

  // ── Plucks ──────────────────────────────────────────────────────────────
  preset(
    'plucks/pluck-vidrio',
    'Pluck de Vidrio',
    'plucks',
    ['pluck', 'reggaeton', 'brillante', 'corto'],
    [
      layer('pluck', { wave: 0.6, level: 0.85, params: { damp: 0.35 } }),
      layer('bell', { wave: 0.5, level: 0.2, semi: 12, decayMul: 0.4, params: { partials: 5, inharm: 0.35 } }),
    ],
    {
      cutoff: 8000, resonance: 0.12, filterEnv: 0.5,
      attack: 0.001, decay: 0.45, sustain: 0, release: 0.28,
      wave: 0.6, width: 1.1, velSens: 0.85,
    },
    [
      macro('Brillo', 0.55, [chan('cutoff', 1200, 18000), on(0, 'wave', 0.15, 1)]),
      macro('Cola', 0.35, [chan('decay', 0.12, 1.8), chan('release', 0.05, 1.2)]),
      macro('Metal', 0.3, [on(1, 'level', 0, 0.5)]),
    ],
  ),

  // ── Campanas ────────────────────────────────────────────────────────────
  preset(
    'bells/campana-lejana',
    'Campana Lejana',
    'bells',
    ['campana', 'bell', 'trap', 'cine'],
    [
      layer('bell', { wave: 0.55, level: 0.9, params: { partials: 8, inharm: 0.55 } }),
      layer('fm', { wave: 0.5, level: 0.25, semi: 12, decayMul: 0.6, params: { ratio: 7, feedback: 0.05 } }),
    ],
    {
      cutoff: 9000, resonance: 0.05,
      attack: 0.001, decay: 3.2, sustain: 0, release: 1.6,
      wave: 0.55, width: 1.3, velSens: 0.9,
    },
    [
      macro('Metal', 0.5, [on(0, 'wave', 0.1, 1), on(1, 'level', 0, 0.6)]),
      macro('Cola', 0.55, [chan('decay', 0.6, 8), chan('release', 0.2, 5)]),
      macro('Lejanía', 0.3, [chan('cutoff', 1500, 18000), chan('treble', -8, 4)]),
    ],
  ),

  // ── Órganos ─────────────────────────────────────────────────────────────
  preset(
    'organs/organo-humo',
    'Órgano de Humo',
    'organs',
    ['organo', 'soul', 'reggaeton', 'dembow'],
    [
      layer('organ', { wave: 0.45, level: 0.9, params: { perc: 0.35 } }),
      layer('organ', { wave: 0.7, level: 0.3, semi: 12, pan: 0.22, params: { perc: 0.6 } }),
    ],
    {
      cutoff: 4200, resonance: 0.1, filterEnv: 0.1,
      attack: 0.006, decay: 0.5, sustain: 1, release: 0.18,
      lfoShape: 0, lfoRate: 6.4, lfoAmount: 0.05, lfoTarget: 4,
      wave: 0.45, drive: 0.2, width: 1.2,
    },
    [
      macro('Registros', 0.45, [on(0, 'wave', 0.05, 1), on(1, 'level', 0, 0.7)]),
      macro('Leslie', 0.3, [chan('lfoAmount', 0, 0.35), chan('lfoRate', 1, 9)]),
      macro('Suciedad', 0.25, [chan('drive', 0, 0.9)]),
    ],
  ),

  // ── Cuerdas ─────────────────────────────────────────────────────────────
  preset(
    'strings/cuerdas-cine',
    'Cuerdas de Cine',
    'strings',
    ['cuerdas', 'strings', 'cine', 'epico'],
    [
      layer('wt', { wave: 0.66, level: 0.75, phase: -1, attackMul: 1.5 }),
      layer('wt', { wave: 0.6, level: 0.45, semi: 12, pan: 0.3, phase: -1, attackMul: 1.8 }),
      layer('wt', { wave: 0.66, level: 0.4, semi: -12, pan: -0.3, phase: -1, cutoffOct: -0.5 }),
    ],
    {
      unison: 4, uniDetune: 0.28, uniWidth: 0.95,
      cutoff: 4800, resonance: 0.05, filterEnv: 0.25,
      attack: 0.35, decay: 2, sustain: 0.9, release: 1.2,
      lfoShape: 0, lfoRate: 4.6, lfoAmount: 0.05, lfoTarget: 0, lfoDelay: 0.6,
      wave: 0.66, width: 1.5,
    },
    [
      macro('Sección', 0.55, [chan('uniDetune', 0.05, 0.7), chan('width', 0.6, 2)]),
      macro('Arco', 0.4, [chan('attack', 0.05, 1.2)]),
      macro('Brillo', 0.45, [chan('cutoff', 800, 14000)]),
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.18)]),
    ],
  ),

  // ── Vientos ─────────────────────────────────────────────────────────────
  preset(
    'brass/metales-anchos',
    'Metales Anchos',
    'brass',
    ['brass', 'metales', 'epico', 'latin'],
    [
      layer('wt', { wave: 0.78, level: 0.85, attackMul: 1.4 }),
      layer('fm', { wave: 0.55, level: 0.3, params: { ratio: 1, feedback: 0.3 } }),
    ],
    {
      unison: 3, uniDetune: 0.18, uniWidth: 0.7,
      cutoff: 4200, resonance: 0.15, filterEnv: 0.55,
      attack: 0.06, decay: 1, sustain: 0.85, release: 0.3,
      wave: 0.78, drive: 0.3, width: 1.3, velSens: 0.9, treble: 2,
    },
    [
      macro('Empuje', 0.5, [chan('filterEnv', 0, 1), chan('drive', 0, 0.8)]),
      macro('Brillo', 0.5, [chan('cutoff', 900, 14000)]),
      macro('Sección', 0.45, [chan('uniDetune', 0.02, 0.5)]),
    ],
  ),

  // ── Guitarras ───────────────────────────────────────────────────────────
  preset(
    'guitars/nylon-cercano',
    'Nylon Cercano',
    'guitars',
    ['guitarra', 'nylon', 'latin', 'acustico'],
    [
      layer('pluck', { wave: 0.35, level: 0.95, params: { damp: 0.55 } }),
      layer('noise', { wave: 0.85, level: 0.06, decayMul: 0.08, params: { q: 8 } }),
    ],
    {
      cutoff: 6000, resonance: 0.08, filterEnv: 0.3,
      attack: 0.001, decay: 1.6, sustain: 0.1, release: 0.5,
      wave: 0.35, width: 0.9, velSens: 0.95,
    },
    [
      macro('Púa', 0.35, [on(1, 'level', 0, 0.2), on(0, 'wave', 0.1, 0.8)]),
      macro('Cuerpo', 0.5, [chan('bass', -4, 8), chan('cutoff', 1500, 12000)]),
      macro('Cola', 0.45, [chan('decay', 0.3, 4)]),
    ],
  ),
];
