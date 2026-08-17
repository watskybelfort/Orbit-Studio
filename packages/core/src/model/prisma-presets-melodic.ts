/**
 * Presets melódicos de Orbit Prisma: teclas, bajos, leads, pads, plucks,
 * campanas, órganos, cuerdas, vientos y guitarras.
 *
 * Cómo se lee una ficha: las CAPAS dicen de qué está hecho el sonido y `base`
 * dice en qué punto quedan las perillas del canal al cargarlo — eso es lo que
 * ve y toca el usuario. Las macros mueven varias cosas a la vez con un nombre
 * que signifique algo ("Aire", "Mordida"), no el nombre técnico del parámetro.
 *
 * Dos reglas que se siguen en TODO el archivo, porque si no el preset miente:
 *
 * 1. `base.wave` se deja en su neutro (0.5, o sea: no se escribe). El carácter
 *    de cada motor va en el `wave` de SU capa; la perilla Wave del canal es un
 *    desplazamiento global sobre todas ellas. Si el preset carga la perilla en
 *    0.42 y la capa ya dice 0.42, el motor suma las dos y suena otra cosa.
 * 2. Una macro que apunta a un parámetro ESCRIBE ese parámetro al disparar la
 *    nota, así que su valor por defecto tiene que reproducir lo que dice
 *    `base` (o el campo de la capa). Por eso los rangos son "raros": están
 *    elegidos para que la posición de fábrica caiga justo encima del valor
 *    declarado. Al mover el preset, mover las dos cosas.
 *
 * Parámetros propios de cada motor que entienden las capas (`params`):
 *   fm      → ratio (0.25..16), feedback (0..1)
 *   pluck   → damp (0..1)
 *   organ   → perc (0..1)
 *   bell    → partials (2..8), inharm (0..1)
 *   noise   → q (0.5..12)
 * El resto de motores se gobiernan solo con `wave`.
 *
 * Del motor (`engine/dsp/prisma-voice.ts`) conviene recordar tres techos:
 * doce osciladores por voz repartidos entre las capas (unísono grande = una o
 * dos capas), cuarenta y ocho líneas de cuerda pulsada en total (nada de
 * 'pluck' con unísono) y las campanas se apagan solas por parcial, así que un
 * 'bell' nunca sostiene.
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
      layer('fm', { wave: 0.41, level: 0.9, params: { ratio: 2, feedback: 0.12 } }),
      layer('wt', { wave: 0.1, level: 0.3, pan: 0.18, cutoffOct: -0.5, decayMul: 1.4 }),
      layer('bell', { wave: 0.3, level: 0.16, semi: 12, decayMul: 0.35, params: { partials: 4, inharm: 0.3 } }),
    ],
    {
      cutoff: 3200, resonance: 0.08, filterEnv: 0.25,
      attack: 0.004, decay: 1.8, sustain: 0.22, release: 0.6,
      drive: 0.08, width: 1.1, velSens: 0.8, bass: 1, treble: 2,
    },
    [
      macro('Campana', 0.4, [on(0, 'wave', 0.05, 0.95), on(2, 'level', 0, 0.4)]),
      macro('Cuerpo', 0.5, [chan('cutoff', 900, 5500), on(1, 'level', 0.05, 0.55)]),
      macro('Cola', 0.5, [chan('decay', 0.5, 3.1), chan('release', 0.15, 1.05)]),
      macro('Aire', 0.5, [chan('treble', -6, 10)]),
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
      width: 1.2, velSens: 0.9, bass: 1,
    },
    [
      macro('Cristal', 0.4, [on(1, 'level', 0, 0.75), chan('treble', -6, 9)]),
      macro('Peso', 0.4, [on(2, 'level', 0, 0.625), chan('bass', -3, 7)]),
      macro('Cola', 0.5, [chan('decay', 0.6, 4.2), chan('release', 0.2, 1.6)]),
    ],
  ),
  preset(
    'keys/piano-cinta',
    'Piano de Cinta',
    'keys',
    ['piano', 'lofi', 'boombap', 'cinta', 'vintage', 'oscuro'],
    [
      layer('wt', { wave: 0.34, level: 0.8 }),
      layer('fm', { wave: 0.18, level: 0.22, decayMul: 0.35, params: { ratio: 3.5, feedback: 0.05 } }),
      layer('wt', { wave: 0.08, level: 0.25, semi: -12, pan: -0.12, cutoffOct: -1 }),
    ],
    {
      cutoff: 2400, resonance: 0.07, filterEnv: 0.2, keytrack: 0.3,
      attack: 0.004, decay: 2.2, sustain: 0.12, release: 0.5,
      lfoShape: 0, lfoRate: 0.35, lfoAmount: 0.015, lfoTarget: 0,
      drive: 0.1, bass: 3, treble: -4.5, width: 0.85, velSens: 0.85,
    },
    [
      macro('Cinta', 0.3, [chan('lfoAmount', 0, 0.05), chan('treble', -9, 6)]),
      macro('Cuerpo', 0.5, [chan('cutoff', 300, 4500), chan('bass', -4, 10)]),
      macro('Martillo', 0.44, [on(1, 'level', 0, 0.5)]),
      macro('Cola', 0.5, [chan('decay', 0.6, 3.8), chan('release', 0.15, 0.85)]),
    ],
  ),
  preset(
    'keys/ep-cremoso',
    'EP Cremoso',
    'keys',
    ['wurlitzer', 'ep', 'soul', 'afrobeat', 'tremolo', 'calido'],
    [
      layer('fm', { wave: 0.3, level: 0.9, params: { ratio: 1, feedback: 0.28 } }),
      layer('wt', { wave: 0.12, level: 0.28, pan: 0.15, cutoffOct: -0.5 }),
    ],
    {
      cutoff: 3000, resonance: 0.06, filterEnv: 0.2,
      attack: 0.005, decay: 1.6, sustain: 0.3, release: 0.5,
      lfoShape: 0, lfoRate: 5.3, lfoAmount: 0.12, lfoTarget: 2,
      drive: 0.12, bass: 2, width: 1, velSens: 0.9,
    },
    [
      macro('Trémolo', 0.3, [chan('lfoAmount', 0, 0.4), chan('lfoRate', 2, 13)]),
      macro('Ladrido', 0.4, [on(0, 'wave', 0.06, 0.66)]),
      macro('Cuerpo', 0.5, [chan('cutoff', 800, 5200), chan('bass', -3, 7)]),
      macro('Cola', 0.5, [chan('decay', 0.4, 2.8), chan('release', 0.15, 0.85)]),
    ],
  ),
  preset(
    'keys/clave-funk',
    'Clave Funk',
    'keys',
    ['clavinet', 'funk', 'latin', 'corto', 'wah'],
    [
      layer('pulse', { wave: 0.22, level: 0.85 }),
      layer('pulse', { wave: 0.7, level: 0.25, semi: 12, pan: 0.2 }),
      layer('noise', { wave: 0.8, level: 0.05, decayMul: 0.05, params: { q: 7 } }),
    ],
    {
      cutoff: 3200, resonance: 0.42, filterEnv: 0.55, keytrack: 0.5,
      attack: 0.002, decay: 0.3, sustain: 0.06, release: 0.14, modDecay: 0.18,
      drive: 0.2, treble: 2, width: 0.8, velSens: 0.9,
    },
    [
      macro('Wah', 0.3, [chan('cutoff', 800, 8800)]),
      macro('Mordida', 0.45, [chan('resonance', 0.05, 0.87)]),
      macro('Uña', 0.33, [on(2, 'level', 0, 0.15)]),
      macro('Corte', 0.3, [chan('decay', 0.08, 0.82), chan('release', 0.05, 0.35)]),
    ],
  ),
  preset(
    'keys/piano-drill',
    'Piano de Drill',
    'keys',
    ['piano', 'drill', 'oscuro', 'desafinado', 'uk'],
    [
      layer('wt', { wave: 0.4, level: 0.75, fine: -6, phase: -1 }),
      layer('wt', { wave: 0.4, level: 0.5, fine: 7, pan: 0.2, phase: -1 }),
      layer('fm', { wave: 0.15, level: 0.2, decayMul: 0.3, params: { ratio: 2, feedback: 0.1 } }),
    ],
    {
      cutoff: 1900, resonance: 0.1, filterEnv: 0.25,
      attack: 0.003, decay: 2.6, sustain: 0.1, release: 0.9,
      drive: 0.08, bass: 4, treble: -3, width: 1.15, velSens: 0.8,
    },
    [
      macro('Oscuridad', 0.35, [chan('cutoff', 500, 4500), chan('treble', -9, 8)]),
      macro('Desafine', 0.2, [on(0, 'fine', -1, -26), on(1, 'fine', 1, 31)]),
      macro('Cola', 0.4, [chan('decay', 0.6, 5.6), chan('release', 0.2, 1.95)]),
      macro('Martillo', 0.44, [on(2, 'level', 0, 0.45)]),
    ],
  ),
  preset(
    'keys/clave-barroca',
    'Clave Barroca',
    'keys',
    ['clavecin', 'clavicembalo', 'barroco', 'cuerda', 'acustico'],
    [
      layer('pluck', { wave: 0.75, level: 0.85, params: { damp: 0.35 } }),
      layer('pulse', { wave: 0.3, level: 0.22, semi: 12, pan: 0.15, decayMul: 0.5 }),
    ],
    {
      cutoff: 7000, resonance: 0.1, filterEnv: 0.25, keytrack: 0.4,
      attack: 0.001, decay: 1.4, sustain: 0.05, release: 0.3,
      treble: 3, width: 1, velSens: 0.35,
    },
    [
      macro('Púa', 0.75, [on(0, 'wave', 0.15, 0.95)]),
      macro('Registro', 0.44, [on(1, 'level', 0, 0.5)]),
      macro('Cola', 0.35, [chan('decay', 0.25, 3.5), chan('release', 0.08, 0.71)]),
      macro('Brillo', 0.35, [chan('cutoff', 1500, 17200)]),
    ],
  ),
  preset(
    'keys/juguete-metalico',
    'Juguete Metálico',
    'keys',
    ['celesta', 'juguete', 'trap', 'metal', 'agudo'],
    [
      layer('bell', { wave: 0.45, level: 0.7, params: { partials: 5, inharm: 0.35 } }),
      layer('fm', { wave: 0.35, level: 0.3, decayMul: 0.4, params: { ratio: 5.5, feedback: 0.05 } }),
      layer('wt', { wave: 0.05, level: 0.2, semi: -12, cutoffOct: -1.5 }),
    ],
    {
      cutoff: 9000, resonance: 0.05,
      attack: 0.001, decay: 1.3, sustain: 0, release: 0.5,
      bass: 3, treble: 3, width: 1.2, velSens: 0.9,
    },
    [
      macro('Metal', 0.44, [on(0, 'wave', 0.1, 0.9), on(1, 'level', 0, 0.68)]),
      macro('Cola', 0.3, [chan('decay', 0.3, 3.63), chan('release', 0.1, 1.43)]),
      macro('Madera', 0.5, [on(2, 'level', 0, 0.4), chan('bass', -2, 8)]),
    ],
  ),
  preset(
    'keys/mellotron-polvo',
    'Mellotron de Polvo',
    'keys',
    ['mellotron', 'cinta', 'cine', 'lofi', 'flauta', 'vintage'],
    [
      layer('wt', { wave: 0.12, level: 0.7, attackMul: 2.5, phase: -1 }),
      layer('wt', { wave: 0.2, level: 0.35, semi: 12, pan: 0.25, attackMul: 3, cutoffOct: -0.3, phase: -1 }),
      layer('noise', { wave: 0.6, level: 0.07, attackMul: 4, params: { q: 4 } }),
    ],
    {
      unison: 2, uniDetune: 0.18, uniWidth: 0.7,
      cutoff: 2600, resonance: 0.05,
      attack: 0.12, decay: 2, sustain: 0.75, release: 0.7,
      lfoShape: 0, lfoRate: 0.55, lfoAmount: 0.02, lfoTarget: 0,
      bass: 2, treble: -3.1, width: 1.2, velSens: 0.4,
    },
    [
      macro('Cinta', 0.33, [chan('lfoAmount', 0, 0.06), chan('lfoRate', 0.2, 1.25)]),
      macro('Aire', 0.35, [on(2, 'level', 0, 0.2), chan('treble', -8, 6)]),
      macro('Cuerpo', 0.25, [chan('cutoff', 700, 8300)]),
      macro('Fuelle', 0.2, [chan('attack', 0.02, 0.52), chan('release', 0.2, 2.7)]),
    ],
  ),

  // ── Bajos ───────────────────────────────────────────────────────────────
  preset(
    'bass/sub-lienzo',
    'Sub Lienzo',
    'bass',
    ['808', 'sub', 'trap', 'glide', 'limpio'],
    [
      layer('sub', { wave: 0.34, level: 1 }),
      layer('wt', { wave: 0.6, level: 0.18, cutoffOct: -1.5, keyHi: 60, decayMul: 0.4 }),
    ],
    {
      voiceMode: 1, glide: 0.07,
      cutoff: 1200, resonance: 0.05, filterEnv: 0.3,
      attack: 0.002, decay: 2.6, sustain: 0.35, release: 0.5,
      drive: 0.3, bass: 3, velSens: 0.4, width: 0.4,
    },
    [
      macro('Distorsión', 0.3, [chan('drive', 0, 1), on(0, 'wave', 0.1, 0.9)]),
      macro('Cola', 0.6, [chan('decay', 0.5, 4), chan('release', 0.05, 0.8)]),
      macro('Click', 0.36, [on(1, 'level', 0, 0.5)]),
      macro('Glide', 0.2, [chan('glide', 0, 0.35)]),
    ],
  ),
  preset(
    'bass/reese-partido',
    'Reese Partido',
    'bass',
    ['reese', 'dnb', 'dubstep', 'ancho', 'movimiento'],
    [
      layer('wt', { wave: 0.62, level: 0.6, fine: -14, pan: -0.35, phase: -1 }),
      layer('wt', { wave: 0.62, level: 0.6, fine: 14, pan: 0.35, phase: -1 }),
      layer('sub', { wave: 0.2, level: 0.45, semi: -12 }),
    ],
    {
      unison: 3, uniDetune: 0.35, uniWidth: 0.8,
      cutoff: 900, resonance: 0.28, filterEnv: 0.2,
      attack: 0.006, decay: 1.2, sustain: 0.9, release: 0.25,
      lfoShape: 0, lfoRate: 0.6, lfoAmount: 0.18, lfoTarget: 1,
      drive: 0.35, width: 1.4, velSens: 0.3,
    },
    [
      macro('Movimiento', 0.4, [chan('lfoAmount', 0, 0.45), chan('lfoRate', 0.15, 1.3)]),
      macro('Filtro', 0.15, [chan('cutoff', 180, 5000)]),
      macro('Ancho', 0.5, [chan('uniDetune', 0, 0.7), chan('width', 0.8, 2)]),
      macro('Sub', 0.5, [on(2, 'level', 0, 0.9)]),
    ],
  ),
  preset(
    'bass/808-carbon',
    '808 de Carbón',
    'bass',
    ['808', 'trap', 'drill', 'distorsion', 'sucio'],
    [
      layer('sub', { wave: 0.71, level: 1 }),
      layer('noise', { wave: 0.8, level: 0.06, decayMul: 0.02, params: { q: 2 } }),
    ],
    {
      voiceMode: 1, glide: 0.04, level: 0.68,
      cutoff: 2200, resonance: 0.05, filterEnv: 0.2,
      attack: 0.001, decay: 1.6, sustain: 0.15, release: 0.35,
      drive: 0.6, bass: 4, treble: -2, width: 0.25, velSens: 0.35,
    },
    [
      macro('Distorsión', 0.55, [chan('drive', 0.1, 1), chan('level', 0.9, 0.5), on(0, 'wave', 0.35, 1)]),
      macro('Cola', 0.4, [chan('decay', 0.3, 3.55), chan('release', 0.08, 0.76)]),
      macro('Click', 0.4, [on(1, 'level', 0, 0.15)]),
      macro('Glide', 0.2, [chan('glide', 0, 0.2)]),
    ],
  ),
  preset(
    'bass/dembow-goma',
    'Bajo de Goma',
    'bass',
    ['reggaeton', 'dembow', 'latin', 'redondo', 'corto'],
    [
      layer('sub', { wave: 0.12, level: 0.9 }),
      layer('wt', { wave: 0.5, level: 0.28, cutoffOct: -0.8, decayMul: 0.35, velTrack: 0.6 }),
    ],
    {
      voiceMode: 1, glide: 0.02,
      cutoff: 900, resonance: 0.12, filterEnv: 0.35, modDecay: 0.12,
      attack: 0.002, decay: 0.55, sustain: 0, release: 0.18,
      drive: 0.22, bass: 3, width: 0.3, velSens: 0.5,
    },
    [
      macro('Cuerpo', 0.3, [chan('decay', 0.15, 1.48)]),
      macro('Punta', 0.4, [on(1, 'level', 0, 0.7), chan('cutoff', 300, 1800)]),
      macro('Goma', 0.4, [chan('drive', 0, 0.55)]),
      macro('Glide', 0.2, [chan('glide', 0, 0.1)]),
    ],
  ),
  preset(
    'bass/house-redondo',
    'Bajo Redondo',
    'bass',
    ['house', 'deep', 'techno', 'filtro', 'calido'],
    [
      layer('wt', { wave: 0.5, level: 0.8 }),
      layer('wt', { wave: 0.02, level: 0.35, semi: -12, cutoffOct: -1 }),
    ],
    {
      cutoff: 700, resonance: 0.18, filterEnv: 0.3, modDecay: 0.22, keytrack: 0.25,
      attack: 0.004, decay: 0.6, sustain: 0.48, release: 0.16,
      drive: 0.15, bass: 2, width: 0.35, velSens: 0.5,
    },
    [
      macro('Filtro', 0.25, [chan('cutoff', 200, 2200)]),
      macro('Empuje', 0.3, [chan('filterEnv', 0, 1), chan('resonance', 0.05, 0.48)]),
      macro('Sub', 0.5, [on(1, 'level', 0, 0.7)]),
      macro('Largo', 0.3, [chan('decay', 0.15, 1.65), chan('sustain', 0.25, 1)]),
    ],
  ),
  preset(
    'bass/acido-303',
    'Ácido 303',
    'bass',
    ['acid', '303', 'techno', 'house', 'resonante', 'mono'],
    [layer('wt', { wave: 0.5, level: 1 })],
    {
      voiceMode: 1, glide: 0.06, level: 0.8,
      cutoff: 480, resonance: 0.72, filterEnv: 0.55, keytrack: 0.35,
      modAttack: 0.002, modDecay: 0.35, modSustain: 0,
      attack: 0.002, decay: 0.9, sustain: 0.35, release: 0.12,
      drive: 0.42, width: 0.3, velSens: 0.7,
    },
    [
      macro('Corte', 0.1, [chan('cutoff', 120, 3720)]),
      macro('Resonancia', 0.7, [chan('resonance', 0.1, 0.98)]),
      macro('Envolvente', 0.5, [chan('filterEnv', 0.2, 0.9), chan('modDecay', 0.06, 0.64)]),
      macro('Acidez', 0.5, [chan('drive', 0, 0.84)]),
      macro('Glide', 0.2, [chan('glide', 0, 0.3)]),
    ],
  ),
  preset(
    'bass/fm-hueso',
    'Bajo de Hueso',
    'bass',
    ['fm', 'metal', 'techno', 'drill', 'seco'],
    [
      layer('fm', { wave: 0.42, level: 0.85, params: { ratio: 2.5, feedback: 0.25 } }),
      layer('sub', { wave: 0.25, level: 0.45 }),
    ],
    {
      voiceMode: 1, glide: 0.02,
      cutoff: 2400, resonance: 0.15, filterEnv: 0.3, modDecay: 0.25,
      attack: 0.001, decay: 0.7, sustain: 0.36, release: 0.15,
      drive: 0.3, bass: 2, width: 0.35, velSens: 0.6,
    },
    [
      macro('Metal', 0.4, [on(0, 'wave', 0.05, 0.98)]),
      macro('Aspereza', 0.3, [on(0, 'feedback', 0.02, 0.79)]),
      macro('Sub', 0.5, [on(1, 'level', 0, 0.9)]),
      macro('Cola', 0.25, [chan('decay', 0.15, 2.35), chan('sustain', 0.15, 1)]),
    ],
  ),
  preset(
    'bass/hardtek-motor',
    'Motor Hardtek',
    'bass',
    ['hardtek', 'tribe', 'hardcore', 'distorsion', 'mono'],
    [
      layer('pulse', { wave: 0.35, level: 0.7, phase: -1 }),
      layer('wt', { wave: 0.62, level: 0.4, fine: 9, phase: -1 }),
      layer('sub', { wave: 0.5, level: 0.5, semi: -12 }),
    ],
    {
      voiceMode: 1, glide: 0.01, level: 0.56,
      unison: 2, uniDetune: 0.2, uniWidth: 0.5,
      cutoff: 1400, resonance: 0.3, filterEnv: 0.35, modDecay: 0.3,
      attack: 0.001, decay: 0.5, sustain: 0.6, release: 0.1,
      drive: 0.72, bass: 3, treble: 2, width: 0.7, velSens: 0.4,
    },
    [
      macro('Motor', 0.65, [chan('drive', 0.2, 1), chan('level', 0.75, 0.45)]),
      macro('Corte', 0.2, [chan('cutoff', 300, 5800)]),
      macro('Rugido', 0.4, [chan('resonance', 0.05, 0.68), on(0, 'wave', 0.15, 0.65)]),
      macro('Sub', 0.63, [on(2, 'level', 0, 0.8)]),
    ],
  ),
  preset(
    'bass/slap-dedo',
    'Bajo de Dedo',
    'bass',
    ['bajo electrico', 'funk', 'afrobeat', 'latin', 'cuerda'],
    [
      layer('pluck', { wave: 0.55, level: 0.9, params: { damp: 0.38 } }),
      layer('wt', { wave: 0.05, level: 0.3, cutoffOct: -1.2 }),
      layer('noise', { wave: 0.9, level: 0.05, decayMul: 0.02, params: { q: 8 } }),
    ],
    {
      cutoff: 3200, resonance: 0.12, filterEnv: 0.35, modDecay: 0.2, keytrack: 0.3,
      attack: 0.001, decay: 1.4, sustain: 0.25, release: 0.25,
      drive: 0.15, bass: 3, treble: 0.9, width: 0.5, velSens: 0.9,
    },
    [
      macro('Dedo', 0.5, [on(2, 'level', 0, 0.1), on(0, 'wave', 0.2, 0.9)]),
      macro('Cuerpo', 0.4, [chan('bass', -2, 10.5), chan('cutoff', 700, 6950)]),
      macro('Cola', 0.4, [chan('decay', 0.3, 3.05), on(0, 'damp', 0.6, 0.05)]),
      macro('Mordida', 0.3, [chan('drive', 0, 0.5), chan('treble', -3, 10)]),
    ],
  ),
  preset(
    'bass/upright-humo',
    'Contrabajo de Humo',
    'bass',
    ['contrabajo', 'jazz', 'boombap', 'acustico', 'oscuro'],
    [
      layer('pluck', { wave: 0.28, level: 0.9, params: { damp: 0.55 } }),
      layer('sub', { wave: 0.05, level: 0.35 }),
    ],
    {
      cutoff: 1200, resonance: 0.06, filterEnv: 0.25, modDecay: 0.25,
      attack: 0.002, decay: 1.8, sustain: 0.12, release: 0.4,
      drive: 0.06, bass: 4, treble: -6, width: 0.4, velSens: 0.9,
    },
    [
      macro('Cuerda', 0.35, [on(0, 'wave', 0.05, 0.71)]),
      macro('Madera', 0.5, [chan('bass', -4, 12), chan('cutoff', 400, 2000)]),
      macro('Cola', 0.4, [chan('decay', 0.4, 3.9), on(0, 'damp', 0.85, 0.1)]),
      macro('Aire', 0.5, [chan('treble', -12, 0)]),
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
      drive: 0.15, width: 1.5, treble: 2,
    },
    [
      macro('Detune', 0.35, [chan('uniDetune', 0, 0.86)]),
      macro('Brillo', 0.6, [chan('cutoff', 1200, 17500), chan('treble', -4, 6)]),
      macro('Filo', 0.3, [chan('drive', 0, 0.5), on(0, 'wave', 0.6, 1)]),
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
      width: 0.9, velSens: 0.7,
    },
    [
      macro('Aire', 0.35, [on(1, 'level', 0, 0.34)]),
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.2)]),
      macro('Ataque', 0.35, [chan('attack', 0.01, 0.125)]),
    ],
  ),
  preset(
    'leads/sierra-hardtek',
    'Sierra Hardtek',
    'leads',
    ['hardtek', 'hardcore', 'techno', 'sierra', 'duro'],
    [
      layer('wt', { wave: 0.55, level: 0.8, phase: -1 }),
      layer('pulse', { wave: 0.28, level: 0.35, semi: 12, pan: 0.2, phase: -1 }),
    ],
    {
      voiceMode: 1, glide: 0.015, level: 0.65,
      unison: 4, uniDetune: 0.28, uniWidth: 0.7,
      cutoff: 5200, resonance: 0.25, filterEnv: 0.3, modDecay: 0.4,
      attack: 0.004, decay: 0.8, sustain: 0.8, release: 0.12,
      drive: 0.58, treble: 3, width: 1.2, velSens: 0.4,
    },
    [
      macro('Distorsión', 0.5, [chan('drive', 0.15, 1), chan('level', 0.8, 0.5)]),
      macro('Corte', 0.3, [chan('cutoff', 700, 15700)]),
      macro('Detune', 0.35, [chan('uniDetune', 0.05, 0.7)]),
      macro('Chillido', 0.25, [chan('resonance', 0.05, 0.85)]),
    ],
  ),
  preset(
    'leads/melodica-caribe',
    'Melódica Caribe',
    'leads',
    ['melodica', 'caña', 'latin', 'dembow', 'reggae'],
    [
      layer('organ', { wave: 0.28, level: 0.7, params: { perc: 0.1 } }),
      layer('pulse', { wave: 0.42, level: 0.3, fine: 6 }),
      layer('noise', { wave: 0.7, level: 0.07, attackMul: 2.5, params: { q: 5 } }),
    ],
    {
      voiceMode: 2, glide: 0.03,
      cutoff: 3800, resonance: 0.12, filterEnv: 0.15,
      attack: 0.02, decay: 0.8, sustain: 0.75, release: 0.2,
      lfoShape: 0, lfoRate: 5.8, lfoAmount: 0.024, lfoTarget: 0, lfoDelay: 0.25,
      drive: 0.18, width: 0.9, velSens: 0.75,
    },
    [
      macro('Aliento', 0.35, [on(2, 'level', 0, 0.2)]),
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.08)]),
      macro('Caña', 0.3, [chan('drive', 0, 0.6), on(1, 'level', 0, 1)]),
      macro('Brillo', 0.25, [chan('cutoff', 900, 12500)]),
    ],
  ),
  preset(
    'leads/sync-neon',
    'Sync Neón',
    'leads',
    ['pwm', 'edm', 'techno', 'agresivo', 'barrido'],
    [
      layer('pulse', { wave: 0.5, level: 0.85, phase: -1 }),
      layer('wt', { wave: 0.75, level: 0.3, semi: -12, cutoffOct: -0.5 }),
    ],
    {
      voiceMode: 1, glide: 0.02,
      unison: 3, uniDetune: 0.22, uniWidth: 0.8,
      cutoff: 6000, resonance: 0.3, filterEnv: 0.4,
      modAttack: 0.002, modDecay: 0.5, modSustain: 0.2,
      attack: 0.005, decay: 0.7, sustain: 0.7, release: 0.2,
      lfoShape: 1, lfoRate: 3.2, lfoAmount: 0.18, lfoTarget: 3,
      drive: 0.35, treble: 2, width: 1.3, velSens: 0.5,
    },
    [
      macro('PWM', 0.4, [chan('lfoAmount', 0, 0.45), chan('lfoRate', 0.4, 7.4)]),
      macro('Barrido', 0.4, [chan('filterEnv', 0, 1), chan('cutoff', 800, 13800)]),
      macro('Filo', 0.35, [chan('drive', 0, 1), chan('resonance', 0.05, 0.76)]),
      macro('Grave', 0.5, [on(1, 'level', 0, 0.6)]),
    ],
  ),
  preset(
    'leads/sierra-drill',
    'Sierra de Drill',
    'leads',
    ['drill', 'oscuro', 'desafinado', 'melodia', 'uk'],
    [
      layer('wt', { wave: 0.48, level: 0.8, fine: -8, phase: -1 }),
      layer('wt', { wave: 0.48, level: 0.5, fine: 9, pan: 0.25, phase: -1 }),
    ],
    {
      voiceMode: 2, glide: 0.05,
      cutoff: 2200, resonance: 0.18, filterEnv: 0.25,
      attack: 0.01, decay: 1, sustain: 0.65, release: 0.3,
      drive: 0.2, bass: 3, treble: -3, width: 1.25, velSens: 0.6,
    },
    [
      macro('Oscuridad', 0.3, [chan('cutoff', 400, 6400), chan('treble', -9, 11)]),
      macro('Desafine', 0.25, [on(0, 'fine', -2, -26), on(1, 'fine', 2, 30)]),
      macro('Deslizamiento', 0.2, [chan('glide', 0, 0.25)]),
      macro('Presión', 0.25, [chan('drive', 0, 0.8)]),
    ],
  ),
  preset(
    'leads/talkbox-latino',
    'Talkbox Latino',
    'leads',
    ['formante', 'talkbox', 'latin', 'reggaeton', 'vocal'],
    [
      layer('formant', { wave: 0.35, level: 0.75 }),
      layer('wt', { wave: 0.55, level: 0.3, cutoffOct: -0.5 }),
    ],
    {
      voiceMode: 2, glide: 0.05,
      cutoff: 4200, resonance: 0.1,
      attack: 0.02, decay: 0.9, sustain: 0.8, release: 0.25,
      lfoShape: 0, lfoRate: 4.8, lfoAmount: 0.03, lfoTarget: 0, lfoDelay: 0.3,
      drive: 0.25, width: 1, velSens: 0.6,
    },
    [
      macro('Vocal', 0.35, [on(0, 'wave', 0, 1)]),
      macro('Mezcla', 0.5, [on(0, 'level', 0.5, 1), on(1, 'level', 0.6, 0)]),
      macro('Vibrato', 0.375, [chan('lfoAmount', 0, 0.08)]),
      macro('Brillo', 0.3, [chan('cutoff', 900, 11900), chan('treble', -3, 7)]),
    ],
  ),
  preset(
    'leads/chicle-neon',
    'Chicle Neón',
    'leads',
    ['hyperpop', 'reggaeton', 'pulso', 'glide', 'dulce'],
    [
      layer('pulse', { wave: 0.3, level: 0.85 }),
      layer('wt', { wave: 0, level: 0.3, semi: 12, pan: 0.2 }),
    ],
    {
      voiceMode: 1, glide: 0.09,
      cutoff: 7000, resonance: 0.15, filterEnv: 0.3, modDecay: 0.25,
      attack: 0.003, decay: 0.6, sustain: 0.6, release: 0.25,
      drive: 0.12, treble: 4, width: 1.1, velSens: 0.6,
    },
    [
      macro('Deslizamiento', 0.3, [chan('glide', 0, 0.3)]),
      macro('Nasal', 0.25, [on(0, 'wave', 0.12, 0.84)]),
      macro('Brillo', 0.35, [chan('cutoff', 1500, 17200)]),
      macro('Octava', 0.5, [on(1, 'level', 0, 0.6)]),
    ],
  ),
  preset(
    'leads/chip-arcade',
    'Chip Arcade',
    'leads',
    ['chiptune', '8bit', 'arcade', 'pulso', 'seco'],
    [
      layer('pulse', { wave: 0.25, level: 0.9 }),
      layer('pulse', { wave: 0.5, level: 0.25, semi: 12, pan: -0.2 }),
    ],
    {
      voiceMode: 1, glide: 0.005,
      cutoff: 20000, resonance: 0,
      attack: 0.001, decay: 0.4, sustain: 0.85, release: 0.05,
      lfoShape: 1, lfoRate: 6.6, lfoAmount: 0.03, lfoTarget: 0, lfoDelay: 0.12,
      treble: 2, width: 0.9, velSens: 0.3,
    },
    [
      macro('Duty', 0.35, [on(0, 'wave', 0.08, 0.56)]),
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.1), chan('lfoRate', 3, 15)]),
      macro('Octava', 0.5, [on(1, 'level', 0, 0.5)]),
      macro('Corte', 1, [chan('cutoff', 1000, 20000)]),
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
      attack: 0.9, decay: 3, sustain: 0.85, release: 2.38,
      lfoShape: 0, lfoRate: 0.25, lfoAmount: 0.1, lfoTarget: 1,
      width: 1.6,
    },
    [
      macro('Apertura', 0.3, [chan('cutoff', 400, 10400)]),
      macro('Respiración', 0.3, [chan('attack', 0.05, 2.9), chan('release', 0.4, 7)]),
      macro('Oleaje', 0.3, [chan('lfoAmount', 0, 0.33), chan('lfoRate', 0.05, 0.72)]),
      macro('Ancho', 0.6, [chan('width', 1, 2), chan('uniDetune', 0.05, 0.33)]),
    ],
  ),
  preset(
    'pads/pad-vapor',
    'Pad de Vapor',
    'pads',
    ['vaporwave', 'lofi', 'cinta', 'quinta', 'nostalgico'],
    [
      layer('wt', { wave: 0.45, level: 0.65, phase: -1, attackMul: 1.3 }),
      layer('wt', { wave: 0.2, level: 0.35, semi: 7, pan: 0.3, cutoffOct: -0.4, phase: -1 }),
      layer('wt', { wave: 0.05, level: 0.3, semi: -12, pan: -0.25, cutoffOct: -0.8 }),
    ],
    {
      unison: 3, uniDetune: 0.3, uniWidth: 0.9,
      cutoff: 1800, resonance: 0.08, filterEnv: 0.3,
      modAttack: 1.2, modDecay: 3, modSustain: 0.6,
      attack: 0.7, decay: 3, sustain: 0.8, release: 2.2,
      lfoShape: 0, lfoRate: 0.28, lfoAmount: 0.02, lfoTarget: 0,
      bass: 3, treble: -6, width: 1.5, velSens: 0.3,
    },
    [
      macro('Cinta', 0.33, [chan('lfoAmount', 0, 0.06), chan('lfoRate', 0.08, 0.68)]),
      macro('Bruma', 0.25, [chan('cutoff', 400, 6000), chan('treble', -10, 6)]),
      macro('Respiración', 0.25, [chan('attack', 0.1, 2.5), chan('release', 0.4, 7.6)]),
      macro('Quinta', 0.5, [on(1, 'level', 0, 0.7)]),
    ],
  ),
  preset(
    'pads/pad-analogico',
    'Pad Analógico',
    'pads',
    ['analogico', 'pwm', 'calido', 'poly', 'clasico'],
    [
      layer('pulse', { wave: 0.5, level: 0.7, phase: -1 }),
      layer('wt', { wave: 0.5, level: 0.45, fine: 7, pan: 0.3, phase: -1 }),
    ],
    {
      unison: 4, uniDetune: 0.25, uniWidth: 0.9,
      cutoff: 2600, resonance: 0.12, filterEnv: 0.35,
      modAttack: 0.8, modDecay: 2.5, modSustain: 0.5,
      attack: 0.5, decay: 2.5, sustain: 0.85, release: 1.8,
      lfoShape: 0, lfoRate: 0.4, lfoAmount: 0.12, lfoTarget: 3,
      bass: 2, width: 1.4, velSens: 0.4,
    },
    [
      macro('Vaivén', 0.3, [chan('lfoAmount', 0, 0.4), chan('lfoRate', 0.08, 1.15)]),
      macro('Apertura', 0.2, [chan('cutoff', 300, 11800)]),
      macro('Respiración', 0.2, [chan('attack', 0.05, 2.3), chan('release', 0.3, 7.8)]),
      macro('Coro', 0.6, [chan('uniDetune', 0.1, 0.35), chan('width', 0.5, 2)]),
    ],
  ),
  preset(
    'pads/pad-cine-oscuro',
    'Pad Cine Oscuro',
    'pads',
    ['cine', 'oscuro', 'tension', 'viento', 'grave'],
    [
      layer('wt', { wave: 0.6, level: 0.6, semi: -12, attackMul: 1.4, phase: -1 }),
      layer('wt', { wave: 0.3, level: 0.4, cutoffOct: -0.3, phase: -1 }),
      layer('noise', { wave: 0.45, level: 0.1, attackMul: 2, params: { q: 1.2 } }),
    ],
    {
      unison: 3, uniDetune: 0.2, uniWidth: 1,
      cutoff: 900, resonance: 0.1, filterEnv: 0.45,
      modAttack: 2.2, modDecay: 4, modSustain: 0.7,
      attack: 1.6, decay: 3.8, sustain: 0.9, release: 3.5,
      lfoShape: 0, lfoRate: 0.12, lfoAmount: 0.12, lfoTarget: 1,
      bass: 5, treble: -6, width: 1.7, velSens: 0.3,
    },
    [
      macro('Marea', 0.3, [chan('lfoAmount', 0, 0.4), chan('lfoRate', 0.05, 0.28)]),
      macro('Apertura', 0.1, [chan('cutoff', 200, 7200)]),
      macro('Viento', 0.33, [on(2, 'level', 0, 0.3)]),
      macro('Cola', 0.4, [chan('decay', 1, 8), chan('release', 1, 7.25)]),
    ],
  ),
  preset(
    'pads/pad-neon-house',
    'Pad Neón',
    'pads',
    ['house', 'edm', 'supersaw', 'brillante', 'ancho'],
    [
      layer('wt', { wave: 0.52, level: 0.75, phase: -1 }),
      layer('wt', { wave: 0.52, level: 0.45, semi: 12, pan: 0.3, cutoffOct: 0.3, phase: -1 }),
    ],
    {
      unison: 6, uniDetune: 0.35, uniWidth: 1,
      cutoff: 6500, resonance: 0.08, filterEnv: 0.3,
      modAttack: 0.4, modDecay: 2, modSustain: 0.6,
      attack: 0.25, decay: 2, sustain: 0.85, release: 1.2,
      drive: 0.12, treble: 3, width: 1.7, velSens: 0.4,
    },
    [
      macro('Coro', 0.5, [chan('uniDetune', 0.1, 0.6)]),
      macro('Brillo', 0.5, [chan('cutoff', 900, 12100), chan('treble', -4, 10)]),
      macro('Ataque', 0.1, [chan('attack', 0.02, 2.32)]),
      macro('Octava', 0.6, [on(1, 'level', 0, 0.75)]),
    ],
  ),
  preset(
    'pads/pad-cristal-aire',
    'Cristal de Aire',
    'pads',
    ['shimmer', 'cristal', 'cine', 'agudo', 'ambiente'],
    [
      layer('wt', { wave: 0.15, level: 0.6, attackMul: 1.5, phase: -1 }),
      layer('bell', { wave: 0.5, level: 0.22, semi: 12, attackMul: 0.5, decayMul: 2, params: { partials: 5, inharm: 0.3 } }),
      layer('wt', { wave: 0.05, level: 0.3, semi: 19, pan: 0.35, cutoffOct: 0.5, attackMul: 2.5 }),
    ],
    {
      unison: 2, uniDetune: 0.18, uniWidth: 0.9,
      cutoff: 7000, resonance: 0.05, filterEnv: 0.25,
      modAttack: 1.5, modDecay: 3, modSustain: 0.6,
      attack: 0.8, decay: 3.5, sustain: 0.7, release: 3,
      lfoShape: 0, lfoRate: 0.35, lfoAmount: 0.1, lfoTarget: 1,
      treble: 4, width: 1.8, velSens: 0.35,
    },
    [
      macro('Escarcha', 0.5, [on(1, 'level', 0, 0.44), on(2, 'level', 0, 0.6)]),
      macro('Aire', 0.5, [chan('treble', -1, 9), chan('cutoff', 1200, 12800)]),
      macro('Respiración', 0.35, [chan('attack', 0.1, 2.1), chan('release', 0.5, 7.6)]),
      macro('Brisa', 0.33, [chan('lfoAmount', 0, 0.3), chan('lfoRate', 0.08, 0.9)]),
    ],
  ),
  preset(
    'pads/pad-aliento',
    'Pad de Aliento',
    'pads',
    ['formante', 'voz', 'coro', 'cine', 'suave'],
    [
      layer('formant', { wave: 0.62, level: 0.6, attackMul: 1.4, phase: -1 }),
      layer('wt', { wave: 0.25, level: 0.35, cutoffOct: -0.5, phase: -1 }),
      layer('noise', { wave: 0.55, level: 0.06, attackMul: 2.5, params: { q: 3 } }),
    ],
    {
      unison: 3, uniDetune: 0.22, uniWidth: 0.95,
      cutoff: 3200, resonance: 0.06, filterEnv: 0.2,
      modAttack: 1.5, modDecay: 3, modSustain: 0.6,
      attack: 0.8, decay: 3, sustain: 0.85, release: 2.45,
      lfoShape: 0, lfoRate: 4.2, lfoAmount: 0.02, lfoTarget: 0, lfoDelay: 0.8,
      bass: 1, width: 1.6, velSens: 0.35,
    },
    [
      macro('Vocal', 0.62, [on(0, 'wave', 0, 1)]),
      macro('Aire', 0.4, [on(2, 'level', 0, 0.15), chan('treble', -4, 6)]),
      macro('Respiración', 0.25, [chan('attack', 0.1, 2.9), chan('release', 0.6, 8)]),
      macro('Coro', 0.5, [chan('uniDetune', 0.04, 0.4), chan('width', 1.2, 2)]),
    ],
  ),
  preset(
    'pads/pad-fm-vidrio',
    'Vidrio FM',
    'pads',
    ['fm', 'evolutivo', 'cristal', 'cine', 'frio'],
    [
      layer('fm', { wave: 0.3, level: 0.75, phase: -1, params: { ratio: 3.5, feedback: 0.08 } }),
      layer('fm', { wave: 0.2, level: 0.25, semi: 12, pan: 0.3, params: { ratio: 7, feedback: 0 } }),
    ],
    {
      unison: 2, uniDetune: 0.15, uniWidth: 0.8,
      cutoff: 5200, resonance: 0.06,
      attack: 0.9, decay: 3, sustain: 0.8, release: 2.6,
      modAttack: 2.5, modDecay: 4, modSustain: 0.5, modAmount: 0.22, modTarget: 3,
      treble: 2, width: 1.5, velSens: 0.4,
    },
    [
      macro('Evolución', 0.65, [chan('modAmount', -0.3, 0.5), chan('modAttack', 0.3, 3.7)]),
      macro('Campana', 0.4, [on(0, 'wave', 0.06, 0.66)]),
      macro('Brillo', 0.25, [chan('cutoff', 800, 18400)]),
      macro('Respiración', 0.3, [chan('attack', 0.15, 2.65), chan('release', 0.5, 7.5)]),
    ],
  ),

  // ── Plucks ──────────────────────────────────────────────────────────────
  preset(
    'plucks/pluck-vidrio',
    'Pluck de Vidrio',
    'plucks',
    ['pluck', 'reggaeton', 'brillante', 'corto'],
    [
      layer('pluck', { wave: 0.52, level: 0.85, params: { damp: 0.35 } }),
      layer('bell', { wave: 0.5, level: 0.2, semi: 12, decayMul: 0.4, params: { partials: 5, inharm: 0.35 } }),
    ],
    {
      cutoff: 8000, resonance: 0.12, filterEnv: 0.5,
      attack: 0.001, decay: 0.45, sustain: 0, release: 0.28,
      width: 1.1, velSens: 0.85,
    },
    [
      macro('Brillo', 0.4, [chan('cutoff', 1200, 18200), on(0, 'wave', 0.2, 1)]),
      macro('Cola', 0.35, [chan('decay', 0.12, 1.06), chan('release', 0.05, 0.71)]),
      macro('Metal', 0.35, [on(1, 'level', 0, 0.57)]),
    ],
  ),
  preset(
    'plucks/pluck-dembow',
    'Pluck Dembow',
    'plucks',
    ['reggaeton', 'dembow', 'latin', 'resonante', 'corto'],
    [
      layer('wt', { wave: 0.5, level: 0.8 }),
      layer('wt', { wave: 0.25, level: 0.3, semi: 12, pan: 0.25, decayMul: 0.7 }),
    ],
    {
      cutoff: 2600, resonance: 0.28, filterEnv: 0.5, modDecay: 0.14, keytrack: 0.35,
      attack: 0.002, decay: 0.35, sustain: 0, release: 0.2,
      drive: 0.2, treble: 2, width: 1, velSens: 0.85,
    },
    [
      macro('Filtro', 0.25, [chan('cutoff', 600, 8600)]),
      macro('Mordida', 0.5, [chan('resonance', 0.05, 0.51), chan('filterEnv', 0.05, 0.95)]),
      macro('Cola', 0.25, [chan('decay', 0.1, 1.1), chan('release', 0.05, 0.65)]),
      macro('Octava', 0.5, [on(1, 'level', 0, 0.6)]),
    ],
  ),
  preset(
    'plucks/pluck-house',
    'Pluck House',
    'plucks',
    ['house', 'edm', 'coro', 'brillante', 'baile'],
    [
      layer('wt', { wave: 0.55, level: 0.75, phase: -1 }),
      layer('wt', { wave: 0.55, level: 0.35, semi: 12, fine: 8, pan: 0.3, phase: -1 }),
    ],
    {
      unison: 3, uniDetune: 0.25, uniWidth: 0.9,
      cutoff: 4200, resonance: 0.15, filterEnv: 0.45, modDecay: 0.2,
      attack: 0.002, decay: 0.5, sustain: 0.05, release: 0.3,
      drive: 0.15, treble: 3, width: 1.3, velSens: 0.7,
    },
    [
      macro('Brillo', 0.2, [chan('cutoff', 900, 17400)]),
      macro('Cola', 0.25, [chan('decay', 0.12, 1.64), chan('release', 0.06, 1.02)]),
      macro('Coro', 0.5, [chan('uniDetune', 0.05, 0.45), chan('width', 0.6, 2)]),
      macro('Ataque', 0.45, [chan('filterEnv', 0, 1)]),
    ],
  ),
  preset(
    'plucks/pluck-fm-campana',
    'Pluck de Campana',
    'plucks',
    ['fm', 'trap', 'afrobeat', 'campana', 'melodia'],
    [
      layer('fm', { wave: 0.4, level: 0.85, params: { ratio: 3.5, feedback: 0.05 } }),
      layer('bell', { wave: 0.35, level: 0.2, semi: 12, decayMul: 0.5, params: { partials: 4, inharm: 0.3 } }),
    ],
    {
      cutoff: 9000, resonance: 0.05, keytrack: 0.3,
      attack: 0.001, decay: 0.9, sustain: 0, release: 0.5,
      treble: 2, width: 1.2, velSens: 0.9,
    },
    [
      macro('Metal', 0.4, [on(0, 'wave', 0.08, 0.88)]),
      macro('Cola', 0.25, [chan('decay', 0.2, 3), chan('release', 0.1, 1.7)]),
      macro('Aire', 0.5, [chan('treble', -4, 8), chan('cutoff', 2000, 16000)]),
      macro('Campana', 0.5, [on(1, 'level', 0, 0.4)]),
    ],
  ),
  preset(
    'plucks/pizzicato-cuerdas',
    'Pizzicato',
    'plucks',
    ['pizzicato', 'cuerdas', 'cine', 'latin', 'acustico'],
    [
      layer('pluck', { wave: 0.4, level: 0.85, params: { damp: 0.75 } }),
      layer('wt', { wave: 0.3, level: 0.25, decayMul: 0.25, cutoffOct: -0.5 }),
      layer('noise', { wave: 0.85, level: 0.05, decayMul: 0.015, params: { q: 6 } }),
    ],
    {
      cutoff: 4200, resonance: 0.1, filterEnv: 0.3, modDecay: 0.1, keytrack: 0.3,
      attack: 0.001, decay: 0.4, sustain: 0, release: 0.25,
      bass: 2, width: 1.1, velSens: 0.95,
    },
    [
      macro('Uña', 0.5, [on(2, 'level', 0, 0.1), on(0, 'wave', 0.1, 0.7)]),
      macro('Cuerpo', 0.4, [chan('bass', -2, 8), chan('cutoff', 800, 9300)]),
      macro('Cola', 0.3, [chan('decay', 0.12, 1.05), on(0, 'damp', 0.96, 0.26)]),
      macro('Sección', 0.5, [chan('width', 0.4, 1.8)]),
    ],
  ),
  preset(
    'plucks/pluck-metal-drill',
    'Pluck Metálico',
    'plucks',
    ['drill', 'fm', 'metal', 'oscuro', 'corto'],
    [
      layer('fm', { wave: 0.6, level: 0.8, params: { ratio: 5, feedback: 0.3 } }),
      layer('wt', { wave: 0.35, level: 0.25, semi: -12, cutoffOct: -1 }),
    ],
    {
      cutoff: 5000, resonance: 0.2, filterEnv: 0.5, modDecay: 0.12,
      attack: 0.001, decay: 0.5, sustain: 0, release: 0.25,
      drive: 0.25, treble: 2, width: 1.1, velSens: 0.9,
    },
    [
      macro('Metal', 0.6, [on(0, 'wave', 0.12, 0.92)]),
      macro('Aspereza', 0.3, [on(0, 'feedback', 0.03, 0.93), chan('drive', 0, 0.83)]),
      macro('Cola', 0.2, [chan('decay', 0.1, 2.1), chan('release', 0.05, 1.05)]),
      macro('Grave', 0.5, [on(1, 'level', 0, 0.5)]),
    ],
  ),
  preset(
    'plucks/pluck-gota',
    'Gota',
    'plucks',
    ['afrobeat', 'amapiano', 'agua', 'seno', 'limpio'],
    [
      layer('wt', { wave: 0.05, level: 0.85 }),
      layer('wt', { wave: 0, level: 0.25, semi: 12, pan: 0.2, decayMul: 0.6 }),
    ],
    {
      cutoff: 6000, resonance: 0.12,
      attack: 0.001, decay: 0.45, sustain: 0, release: 0.35,
      modAttack: 0.001, modDecay: 0.09, modSustain: 0, modAmount: 0.28, modTarget: 0,
      treble: 3, width: 1.1, velSens: 0.8,
    },
    [
      macro('Salto', 0.4, [chan('modAmount', 0, 0.7), chan('modDecay', 0.02, 0.195)]),
      macro('Cola', 0.25, [chan('decay', 0.15, 1.35), chan('release', 0.08, 1.16)]),
      macro('Brillo', 0.34, [chan('cutoff', 900, 15900)]),
      macro('Octava', 0.5, [on(1, 'level', 0, 0.5)]),
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
      cutoff: 8000, resonance: 0.05,
      attack: 0.001, decay: 3.2, sustain: 0, release: 1.6,
      width: 1.3, velSens: 0.9,
    },
    [
      macro('Metal', 0.5, [on(0, 'wave', 0.1, 1), on(1, 'level', 0, 0.5)]),
      macro('Cola', 0.35, [chan('decay', 0.6, 8), chan('release', 0.2, 4.2)]),
      macro('Lejanía', 0.4, [chan('cutoff', 1200, 18200), chan('treble', -8, 12)]),
    ],
  ),
  preset(
    'bells/caja-musica',
    'Caja de Música',
    'bells',
    ['caja de musica', 'juguete', 'lofi', 'cine', 'tierno'],
    [
      layer('bell', { wave: 0.4, level: 0.85, semi: 12, params: { partials: 5, inharm: 0.22 } }),
      layer('wt', { wave: 0.02, level: 0.2, semi: 12, decayMul: 0.5, cutoffOct: -0.5 }),
    ],
    {
      cutoff: 11000, resonance: 0.04,
      attack: 0.001, decay: 1.1, sustain: 0, release: 0.7,
      lfoShape: 0, lfoRate: 0.45, lfoAmount: 0.015, lfoTarget: 0,
      bass: -3, treble: 3, width: 1.2, velSens: 0.9,
    },
    [
      macro('Metal', 0.4, [on(0, 'wave', 0.08, 0.88)]),
      macro('Cola', 0.3, [chan('decay', 0.25, 3.08), chan('release', 0.1, 2.1)]),
      macro('Cuerda', 0.3, [chan('lfoAmount', 0, 0.05)]),
      macro('Aire', 0.5, [chan('treble', -4, 10)]),
    ],
  ),
  preset(
    'bells/glockenspiel-frio',
    'Glockenspiel Frío',
    'bells',
    ['glockenspiel', 'metalofono', 'frio', 'agudo', 'cine'],
    [
      layer('bell', { wave: 0.3, level: 0.85, semi: 12, params: { partials: 3, inharm: 0.1 } }),
      layer('fm', { wave: 0.3, level: 0.18, semi: 12, decayMul: 0.25, params: { ratio: 9, feedback: 0 } }),
    ],
    {
      cutoff: 14000, resonance: 0.03,
      attack: 0.001, decay: 1.6, sustain: 0, release: 0.9,
      bass: -4, treble: 4, width: 1.3, velSens: 0.95,
    },
    [
      macro('Golpe', 0.5, [on(1, 'level', 0, 0.36)]),
      macro('Cola', 0.35, [chan('decay', 0.3, 4), chan('release', 0.15, 2.3)]),
      macro('Metal', 0.35, [on(0, 'wave', 0.05, 0.76), on(0, 'inharm', 0.02, 0.25)]),
      macro('Aire', 0.5, [chan('treble', -1, 9)]),
    ],
  ),
  preset(
    'bells/campana-iglesia',
    'Campana de Iglesia',
    'bells',
    ['campana', 'bronce', 'iglesia', 'grave', 'cine'],
    [
      layer('bell', { wave: 0.75, level: 0.9, semi: -12, params: { partials: 8, inharm: 0.75 } }),
      layer('wt', { wave: 0.02, level: 0.22, semi: -12, decayMul: 3 }),
    ],
    {
      cutoff: 4500, resonance: 0.05,
      attack: 0.002, decay: 5.9, sustain: 0, release: 5.75,
      bass: 4, treble: -3, width: 1.5, velSens: 0.8,
    },
    [
      macro('Bronce', 0.7, [on(0, 'inharm', 0.2, 0.99), on(0, 'wave', 0.3, 0.94)]),
      macro('Cola', 0.7, [chan('decay', 1, 8), chan('release', 0.5, 8)]),
      macro('Lejanía', 0.25, [chan('cutoff', 800, 15600), chan('treble', -8, 12)]),
      macro('Cuerpo', 0.5, [on(1, 'level', 0, 0.44), chan('bass', -4, 12)]),
    ],
  ),
  preset(
    'bells/tubular-cine',
    'Tubulares',
    'bells',
    ['tubular', 'orquesta', 'cine', 'epico', 'mazo'],
    [
      layer('bell', { wave: 0.55, level: 0.8, params: { partials: 6, inharm: 0.45 } }),
      layer('fm', { wave: 0.5, level: 0.22, decayMul: 0.3, params: { ratio: 4.2, feedback: 0.15 } }),
      layer('noise', { wave: 0.8, level: 0.05, decayMul: 0.01, params: { q: 5 } }),
    ],
    {
      cutoff: 8000, resonance: 0.05,
      attack: 0.001, decay: 3.5, sustain: 0, release: 2.5,
      treble: 2, width: 1.4, velSens: 0.9,
    },
    [
      macro('Mazo', 0.5, [on(2, 'level', 0, 0.1), on(1, 'level', 0, 0.44)]),
      macro('Metal', 0.5, [on(0, 'wave', 0.15, 0.95)]),
      macro('Cola', 0.4, [chan('decay', 0.6, 7.85), chan('release', 0.3, 5.8)]),
      macro('Distancia', 0.4, [chan('cutoff', 1200, 18200)]),
    ],
  ),
  preset(
    'bells/celesta-cofre',
    'Celesta del Cofre',
    'bells',
    ['celesta', 'dulce', 'cine', 'lofi', 'suave'],
    [
      layer('fm', { wave: 0.28, level: 0.8, semi: 12, params: { ratio: 3, feedback: 0.02 } }),
      layer('bell', { wave: 0.3, level: 0.25, semi: 12, decayMul: 0.7, params: { partials: 4, inharm: 0.25 } }),
    ],
    {
      cutoff: 9000, resonance: 0.04,
      attack: 0.001, decay: 1.4, sustain: 0, release: 0.8,
      bass: -1, treble: 2, width: 1.15, velSens: 0.85,
    },
    [
      macro('Campana', 0.5, [on(1, 'level', 0, 0.5)]),
      macro('Dulzura', 0.4, [on(0, 'wave', 0.06, 0.61)]),
      macro('Cola', 0.3, [chan('decay', 0.3, 4), chan('release', 0.15, 2.3)]),
      macro('Aire', 0.5, [chan('treble', -8, 12), chan('cutoff', 2000, 16000)]),
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
      drive: 0.2, width: 1.2,
    },
    [
      macro('Registros', 0.45, [on(0, 'wave', 0.05, 0.94), on(1, 'level', 0, 0.67)]),
      macro('Leslie', 0.3, [chan('lfoAmount', 0, 0.17), chan('lfoRate', 1, 19)]),
      macro('Suciedad', 0.25, [chan('drive', 0, 0.8)]),
    ],
  ),
  preset(
    'organs/hammond-rueda',
    'Hammond de Rueda',
    'organs',
    ['hammond', 'leslie', 'soul', 'funk', 'gospel'],
    [
      layer('organ', { wave: 0.55, level: 0.85, params: { perc: 0.55 } }),
      layer('organ', { wave: 0.85, level: 0.25, semi: 12, pan: 0.25, params: { perc: 0.2 } }),
    ],
    {
      level: 0.85,
      cutoff: 6000, resonance: 0.08,
      attack: 0.004, decay: 0.4, sustain: 1, release: 0.12,
      lfoShape: 0, lfoRate: 6.56, lfoAmount: 0.09, lfoTarget: 4,
      drive: 0.35, treble: 2, width: 1.3, velSens: 0.35,
    },
    [
      macro('Registros', 0.5, [on(0, 'wave', 0.1, 1)]),
      macro('Leslie', 0.3, [chan('lfoRate', 0.8, 20), chan('lfoAmount', 0, 0.3)]),
      macro('Percusión', 0.55, [on(0, 'perc', 0, 1)]),
      macro('Overdrive', 0.4, [chan('drive', 0, 0.875), chan('level', 0.95, 0.7)]),
    ],
  ),
  preset(
    'organs/organo-iglesia',
    'Órgano de Iglesia',
    'organs',
    ['organo', 'tubos', 'iglesia', 'cine', 'solemne'],
    [
      layer('organ', { wave: 0.9, level: 0.7, attackMul: 2, params: { perc: 0 } }),
      layer('organ', { wave: 0.5, level: 0.3, semi: 12, pan: 0.3, attackMul: 2.5, params: { perc: 0 } }),
      layer('organ', { wave: 0.35, level: 0.3, semi: -12, pan: -0.3, attackMul: 1.6, params: { perc: 0 } }),
    ],
    {
      cutoff: 6700, resonance: 0.05,
      attack: 0.09, decay: 0.5, sustain: 1, release: 0.55,
      bass: 3, treble: 1, width: 1.6, velSens: 0.15,
    },
    [
      macro('Registros', 0.85, [on(0, 'wave', 0.3, 1), on(1, 'level', 0, 0.35)]),
      macro('Pedal', 0.5, [on(2, 'level', 0, 0.6), chan('bass', -2, 8)]),
      macro('Nave', 0.15, [chan('release', 0.1, 3.1)]),
      macro('Brillo', 0.3, [chan('cutoff', 1000, 20000)]),
    ],
  ),
  preset(
    'organs/organo-reggae',
    'Órgano Burbuja',
    'organs',
    ['reggae', 'skank', 'dembow', 'percusivo', 'corto'],
    [layer('organ', { wave: 0.4, level: 0.9, params: { perc: 0.75 } })],
    {
      cutoff: 3800, resonance: 0.18, filterEnv: 0.25, modDecay: 0.12,
      attack: 0.003, decay: 0.22, sustain: 0.25, release: 0.1,
      drive: 0.28, treble: 2, width: 0.9, velSens: 0.7,
    },
    [
      macro('Burbuja', 0.75, [on(0, 'perc', 0, 1)]),
      macro('Registros', 0.375, [on(0, 'wave', 0.1, 0.9)]),
      macro('Corte', 0.4, [chan('cutoff', 600, 8600), chan('resonance', 0.05, 0.38)]),
      macro('Suciedad', 0.35, [chan('drive', 0, 0.8)]),
    ],
  ),
  preset(
    'organs/acordeon-barrio',
    'Acordeón de Barrio',
    'organs',
    ['acordeon', 'musette', 'latin', 'cumbia', 'fuelle'],
    [
      layer('organ', { wave: 0.45, level: 0.55, fine: -12, params: { perc: 0.05 } }),
      layer('organ', { wave: 0.45, level: 0.55, fine: 13, pan: 0.25, params: { perc: 0.05 } }),
      layer('noise', { wave: 0.5, level: 0.05, attackMul: 3, params: { q: 3 } }),
    ],
    {
      cutoff: 4200, resonance: 0.1,
      attack: 0.03, decay: 0.6, sustain: 1, release: 0.2,
      lfoShape: 0, lfoRate: 4.5, lfoAmount: 0.02, lfoTarget: 0, lfoDelay: 0.4,
      drive: 0.15, bass: 2, width: 1.2, velSens: 0.5,
    },
    [
      macro('Musette', 0.4, [on(0, 'fine', -2, -27), on(1, 'fine', 2, 29.5)]),
      macro('Fuelle', 0.2, [on(2, 'level', 0, 0.25), chan('attack', 0.005, 0.13)]),
      macro('Vibrato', 0.33, [chan('lfoAmount', 0, 0.06)]),
      macro('Brillo', 0.3, [chan('cutoff', 900, 11900)]),
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
      layer('wt', { wave: 0.6, level: 0.4, semi: 12, pan: 0.3, phase: -1, attackMul: 1.8 }),
      layer('wt', { wave: 0.66, level: 0.35, semi: -12, pan: -0.3, phase: -1, cutoffOct: -0.5 }),
    ],
    {
      unison: 4, uniDetune: 0.28, uniWidth: 0.95,
      cutoff: 4800, resonance: 0.05, filterEnv: 0.25,
      attack: 0.35, decay: 2, sustain: 0.9, release: 1.2,
      lfoShape: 0, lfoRate: 4.6, lfoAmount: 0.05, lfoTarget: 0, lfoDelay: 0.6,
      width: 1.5,
    },
    [
      macro('Sección', 0.5, [chan('uniDetune', 0.06, 0.5), chan('width', 1, 2)]),
      macro('Arco', 0.4, [chan('attack', 0.05, 0.8)]),
      macro('Brillo', 0.3, [chan('cutoff', 900, 13900)]),
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.17)]),
    ],
  ),
  preset(
    'strings/violin-solo',
    'Violín Solo',
    'strings',
    ['violin', 'solo', 'cine', 'latin', 'vibrato'],
    [
      layer('wt', { wave: 0.62, level: 0.85, attackMul: 1.4, phase: -1 }),
      layer('noise', { wave: 0.75, level: 0.06, attackMul: 2, params: { q: 5 } }),
    ],
    {
      voiceMode: 2, glide: 0.03,
      unison: 2, uniDetune: 0.08, uniWidth: 0.4,
      cutoff: 3600, resonance: 0.12, filterEnv: 0.3,
      modAttack: 0.15, modDecay: 1.5, modSustain: 0.5,
      attack: 0.09, decay: 1.4, sustain: 0.85, release: 0.4,
      lfoShape: 0, lfoRate: 5.4, lfoAmount: 0.03, lfoTarget: 0, lfoDelay: 0.35,
      bass: 1, width: 0.8, velSens: 0.8,
    },
    [
      macro('Vibrato', 0.33, [chan('lfoAmount', 0, 0.09), chan('lfoRate', 3.5, 9.2)]),
      macro('Arco', 0.3, [chan('attack', 0.02, 0.25), on(1, 'level', 0, 0.2)]),
      macro('Brillo', 0.25, [chan('cutoff', 800, 12000), chan('treble', -4, 12)]),
      macro('Cuerpo', 0.4, [chan('bass', -3, 7)]),
    ],
  ),
  preset(
    'strings/cuerdas-staccato',
    'Cuerdas Staccato',
    'strings',
    ['staccato', 'spiccato', 'cine', 'latin', 'trap'],
    [
      layer('wt', { wave: 0.65, level: 0.8, phase: -1 }),
      layer('wt', { wave: 0.6, level: 0.4, semi: 12, pan: 0.3, decayMul: 0.8, phase: -1 }),
      layer('noise', { wave: 0.7, level: 0.06, decayMul: 0.05, params: { q: 4 } }),
    ],
    {
      unison: 4, uniDetune: 0.25, uniWidth: 0.9,
      cutoff: 4000, resonance: 0.1, filterEnv: 0.35, modDecay: 0.12,
      attack: 0.012, decay: 0.3, sustain: 0, release: 0.22,
      bass: 2, treble: 1, width: 1.5, velSens: 0.9,
    },
    [
      macro('Sección', 0.5, [chan('uniDetune', 0.05, 0.45), chan('width', 1, 2)]),
      macro('Arco', 0.2, [chan('attack', 0.004, 0.044), on(2, 'level', 0, 0.3)]),
      macro('Largo', 0.2, [chan('decay', 0.1, 1.1), chan('release', 0.06, 0.86)]),
      macro('Brillo', 0.25, [chan('cutoff', 800, 13600)]),
    ],
  ),
  preset(
    'strings/cuerdas-cinta',
    'Cuerdas de Cinta',
    'strings',
    ['lofi', 'boombap', 'cinta', 'oscuro', 'vintage'],
    [
      layer('wt', { wave: 0.6, level: 0.7, attackMul: 1.6, phase: -1 }),
      layer('wt', { wave: 0.45, level: 0.35, semi: -12, pan: -0.25, cutoffOct: -0.6, phase: -1 }),
    ],
    {
      unison: 3, uniDetune: 0.22, uniWidth: 0.8,
      cutoff: 1800, resonance: 0.06, filterEnv: 0.2,
      modAttack: 0.5, modDecay: 2, modSustain: 0.5,
      attack: 0.25, decay: 2, sustain: 0.85, release: 1,
      lfoShape: 0, lfoRate: 0.32, lfoAmount: 0.02, lfoTarget: 0,
      drive: 0.1, bass: 4, treble: -7, width: 1.1, velSens: 0.4,
    },
    [
      macro('Cinta', 0.2, [chan('lfoAmount', 0, 0.1), chan('lfoRate', 0.12, 1.12)]),
      macro('Polvo', 0.25, [chan('cutoff', 500, 5700), chan('treble', -12, 8)]),
      macro('Sección', 0.4, [chan('uniDetune', 0.05, 0.475), chan('width', 0.5, 2)]),
      macro('Arco', 0.2, [chan('attack', 0.03, 1.13), chan('release', 0.2, 4.2)]),
    ],
  ),
  preset(
    'strings/cello-hondo',
    'Chelo Hondo',
    'strings',
    ['chelo', 'cello', 'grave', 'cine', 'solo'],
    [
      layer('wt', { wave: 0.58, level: 0.8, semi: -12, attackMul: 1.5, phase: -1 }),
      layer('wt', { wave: 0.3, level: 0.28, semi: -12, pan: -0.2, cutoffOct: -0.5, phase: -1 }),
      layer('noise', { wave: 0.6, level: 0.05, attackMul: 2.5, params: { q: 5 } }),
    ],
    {
      voiceMode: 2, glide: 0.04,
      unison: 2, uniDetune: 0.1, uniWidth: 0.5,
      cutoff: 2200, resonance: 0.1, filterEnv: 0.3,
      modAttack: 0.2, modDecay: 1.8, modSustain: 0.5,
      attack: 0.13, decay: 1.8, sustain: 0.85, release: 0.7,
      lfoShape: 0, lfoRate: 4.8, lfoAmount: 0.024, lfoTarget: 0, lfoDelay: 0.5,
      bass: 5, treble: -2, width: 0.9, velSens: 0.8,
    },
    [
      macro('Vibrato', 0.3, [chan('lfoAmount', 0, 0.08)]),
      macro('Arco', 0.2, [chan('attack', 0.02, 0.57), on(2, 'level', 0, 0.25)]),
      macro('Madera', 0.5, [chan('bass', -2, 12), chan('cutoff', 400, 4000)]),
      macro('Cola', 0.2, [chan('release', 0.15, 2.9)]),
    ],
  ),
  preset(
    'strings/tremolo-tension',
    'Trémolo de Tensión',
    'strings',
    ['tremolo', 'tension', 'cine', 'suspenso', 'seccion'],
    [
      layer('wt', { wave: 0.66, level: 0.7, attackMul: 1.2, phase: -1 }),
      layer('wt', { wave: 0.66, level: 0.4, semi: 12, pan: 0.35, phase: -1 }),
    ],
    {
      unison: 3, uniDetune: 0.3, uniWidth: 1,
      cutoff: 3200, resonance: 0.1, filterEnv: 0.28,
      modAttack: 1.5, modDecay: 3, modSustain: 0.6,
      attack: 0.5, decay: 2.5, sustain: 0.9, release: 1.4,
      lfoShape: 1, lfoRate: 9, lfoAmount: 0.35, lfoTarget: 2,
      treble: 1, width: 1.6, velSens: 0.5,
    },
    [
      macro('Trémolo', 0.4, [chan('lfoRate', 3, 18), chan('lfoAmount', 0.05, 0.8)]),
      macro('Tensión', 0.2, [chan('cutoff', 500, 14000), chan('filterEnv', 0.1, 1)]),
      macro('Sección', 0.5, [chan('uniDetune', 0.1, 0.5), chan('width', 1.2, 2)]),
      macro('Crecida', 0.15, [chan('attack', 0.05, 3.05), chan('release', 0.3, 7.6)]),
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
      drive: 0.3, width: 1.3, velSens: 0.9, treble: 2,
    },
    [
      macro('Empuje', 0.5, [chan('filterEnv', 0.1, 1), chan('drive', 0, 0.6)]),
      macro('Brillo', 0.5, [chan('cutoff', 900, 7500)]),
      macro('Sección', 0.45, [chan('uniDetune', 0.02, 0.38)]),
    ],
  ),
  preset(
    'brass/trompeta-mariachi',
    'Trompeta Mariachi',
    'brass',
    ['trompeta', 'mariachi', 'latin', 'solo', 'brillante'],
    [
      layer('wt', { wave: 0.72, level: 0.85, attackMul: 1.2 }),
      layer('fm', { wave: 0.35, level: 0.25, params: { ratio: 1, feedback: 0.35 } }),
    ],
    {
      voiceMode: 2, glide: 0.03,
      unison: 2, uniDetune: 0.1, uniWidth: 0.4,
      cutoff: 3600, resonance: 0.18, filterEnv: 0.5,
      modAttack: 0.03, modDecay: 0.5, modSustain: 0.55,
      attack: 0.035, decay: 0.8, sustain: 0.85, release: 0.22,
      lfoShape: 0, lfoRate: 5.6, lfoAmount: 0.03, lfoTarget: 0, lfoDelay: 0.3,
      drive: 0.35, treble: 3, width: 0.85, velSens: 0.9,
    },
    [
      macro('Empuje', 0.5, [chan('filterEnv', 0.1, 0.9), chan('drive', 0, 0.7)]),
      macro('Vibrato', 0.375, [chan('lfoAmount', 0, 0.08)]),
      macro('Brillo', 0.5, [chan('cutoff', 600, 6600), chan('treble', -6, 12)]),
      macro('Ataque', 0.15, [chan('attack', 0.005, 0.205)]),
    ],
  ),
  preset(
    'brass/trombon-humo',
    'Trombón de Humo',
    'brass',
    ['trombon', 'grave', 'jazz', 'latin', 'oscuro'],
    [
      layer('wt', { wave: 0.6, level: 0.85, semi: -12, attackMul: 1.6 }),
      layer('fm', { wave: 0.28, level: 0.25, semi: -12, params: { ratio: 1, feedback: 0.25 } }),
    ],
    {
      voiceMode: 2, glide: 0.06,
      cutoff: 1800, resonance: 0.15, filterEnv: 0.45,
      modAttack: 0.06, modDecay: 0.7, modSustain: 0.5,
      attack: 0.07, decay: 1, sustain: 0.85, release: 0.3,
      lfoShape: 0, lfoRate: 4.6, lfoAmount: 0.02, lfoTarget: 0, lfoDelay: 0.5,
      drive: 0.25, bass: 5, treble: -2, width: 0.8, velSens: 0.85,
    },
    [
      macro('Empuje', 0.5, [chan('filterEnv', 0.05, 0.85), chan('drive', 0, 0.5)]),
      macro('Vara', 0.15, [chan('glide', 0, 0.4)]),
      macro('Cuerpo', 0.5, [chan('bass', -2, 12), chan('cutoff', 400, 3200)]),
      macro('Vibrato', 0.25, [chan('lfoAmount', 0, 0.08)]),
    ],
  ),
  preset(
    'brass/seccion-funk',
    'Sección Funk',
    'brass',
    ['funk', 'afrobeat', 'stab', 'seccion', 'corto'],
    [
      layer('wt', { wave: 0.75, level: 0.7, phase: -1 }),
      layer('wt', { wave: 0.68, level: 0.35, semi: 12, pan: 0.3, phase: -1 }),
      layer('fm', { wave: 0.42, level: 0.22, params: { ratio: 1, feedback: 0.3 } }),
    ],
    {
      level: 0.85,
      unison: 3, uniDetune: 0.14, uniWidth: 0.7,
      cutoff: 3400, resonance: 0.2, filterEnv: 0.6,
      modAttack: 0.008, modDecay: 0.28, modSustain: 0.25,
      attack: 0.012, decay: 0.5, sustain: 0.35, release: 0.18,
      drive: 0.4, treble: 4, width: 1.1, velSens: 0.95,
    },
    [
      macro('Golpe', 0.5, [chan('filterEnv', 0.2, 1), chan('modDecay', 0.06, 0.5)]),
      macro('Sección', 0.4, [chan('uniDetune', 0.02, 0.32), chan('width', 0.5, 2)]),
      macro('Brillo', 0.25, [chan('cutoff', 900, 10900)]),
      macro('Suciedad', 0.5, [chan('drive', 0, 0.8), chan('level', 0.95, 0.75)]),
    ],
  ),
  preset(
    'brass/corno-cine',
    'Corno de Cine',
    'brass',
    ['corno', 'trompa', 'cine', 'epico', 'noble'],
    [
      layer('wt', { wave: 0.52, level: 0.8, attackMul: 2, phase: -1 }),
      layer('wt', { wave: 0.3, level: 0.35, semi: -12, pan: -0.2, cutoffOct: -0.4, attackMul: 2.4, phase: -1 }),
    ],
    {
      unison: 3, uniDetune: 0.16, uniWidth: 0.8,
      cutoff: 2400, resonance: 0.1, filterEnv: 0.36,
      modAttack: 0.25, modDecay: 1.2, modSustain: 0.5,
      attack: 0.18, decay: 1.4, sustain: 0.9, release: 0.6,
      lfoShape: 0, lfoRate: 4.2, lfoAmount: 0.015, lfoTarget: 0, lfoDelay: 0.7,
      drive: 0.15, bass: 4, treble: -2, width: 1.4, velSens: 0.7,
    },
    [
      macro('Crecida', 0.15, [chan('attack', 0.03, 1.03), chan('filterEnv', 0.25, 1)]),
      macro('Sección', 0.4, [chan('uniDetune', 0.04, 0.34), chan('width', 1, 2)]),
      macro('Cuerpo', 0.5, [chan('bass', -4, 12), chan('cutoff', 400, 4400)]),
      macro('Cola', 0.15, [chan('release', 0.15, 3.15)]),
    ],
  ),
  preset(
    'brass/saxo-noche',
    'Saxo de Noche',
    'brass',
    ['saxo', 'caña', 'jazz', 'noche', 'formante'],
    [
      layer('formant', { wave: 0.28, level: 0.5 }),
      layer('wt', { wave: 0.68, level: 0.55, cutoffOct: -0.3 }),
      layer('noise', { wave: 0.72, level: 0.06, attackMul: 2, params: { q: 5 } }),
    ],
    {
      voiceMode: 2, glide: 0.04,
      cutoff: 2840, resonance: 0.22, filterEnv: 0.4,
      modAttack: 0.04, modDecay: 0.6, modSustain: 0.5,
      attack: 0.045, decay: 1, sustain: 0.85, release: 0.28,
      lfoShape: 0, lfoRate: 5.2, lfoAmount: 0.035, lfoTarget: 0, lfoDelay: 0.35,
      drive: 0.3, bass: 2, treble: 0.95, width: 0.85, velSens: 0.9,
    },
    [
      macro('Caña', 0.5, [on(0, 'level', 0.2, 0.8), chan('drive', 0, 0.6)]),
      macro('Aliento', 0.4, [on(2, 'level', 0, 0.15)]),
      macro('Vibrato', 0.35, [chan('lfoAmount', 0, 0.1)]),
      macro('Brillo', 0.35, [chan('cutoff', 600, 7000), chan('treble', -5, 12)]),
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
      bass: 2, width: 0.9, velSens: 0.95,
    },
    [
      macro('Púa', 0.35, [on(1, 'level', 0, 0.17), on(0, 'wave', 0.1, 0.8)]),
      macro('Cuerpo', 0.5, [chan('bass', -4, 8), chan('cutoff', 1500, 10500)]),
      macro('Cola', 0.45, [chan('decay', 0.3, 3.2)]),
    ],
  ),
  preset(
    'guitars/acustica-acero',
    'Acústica de Acero',
    'guitars',
    ['guitarra', 'acustica', 'folk', 'afrobeat', 'brillante'],
    [
      layer('pluck', { wave: 0.62, level: 0.9, params: { damp: 0.28 } }),
      layer('wt', { wave: 0.1, level: 0.18, cutoffOct: -1, decayMul: 1.5 }),
      layer('noise', { wave: 0.9, level: 0.06, decayMul: 0.012, params: { q: 7 } }),
    ],
    {
      cutoff: 7000, resonance: 0.08, filterEnv: 0.3, modDecay: 0.12, keytrack: 0.3,
      attack: 0.001, decay: 2, sustain: 0.1, release: 0.5,
      bass: 2, treble: 3, width: 1, velSens: 0.95,
    },
    [
      macro('Púa', 0.5, [on(2, 'level', 0, 0.12), on(0, 'wave', 0.24, 1)]),
      macro('Cuerpo', 0.4, [chan('bass', -3, 9.5), on(1, 'level', 0, 0.45)]),
      macro('Cola', 0.7, [chan('decay', 0.4, 2.7), on(0, 'damp', 0.75, 0.08)]),
      macro('Brillo', 0.5, [chan('cutoff', 1200, 12800), chan('treble', -6, 12)]),
    ],
  ),
  preset(
    'guitars/electrica-limpia',
    'Eléctrica Limpia',
    'guitars',
    ['guitarra', 'electrica', 'limpia', 'chorus', 'lofi'],
    [
      layer('pluck', { wave: 0.45, level: 0.9, params: { damp: 0.18 } }),
      layer('wt', { wave: 0.2, level: 0.22, fine: 7, pan: 0.25, cutoffOct: -0.3 }),
    ],
    {
      cutoff: 4200, resonance: 0.12, filterEnv: 0.25, modDecay: 0.2, keytrack: 0.3,
      attack: 0.002, decay: 2.6, sustain: 0.18, release: 0.6,
      lfoShape: 0, lfoRate: 3.6, lfoAmount: 0.05, lfoTarget: 4,
      drive: 0.12, bass: 2, treble: 2, width: 1.2, velSens: 0.9,
    },
    [
      macro('Chorus', 0.2, [chan('lfoAmount', 0, 0.25), chan('lfoRate', 0.4, 16.4)]),
      macro('Cuerpo', 0.4, [chan('bass', -3, 9.5), chan('cutoff', 800, 9300)]),
      macro('Cola', 0.5, [chan('decay', 0.6, 4.6), on(0, 'damp', 0.34, 0.02)]),
      macro('Cristal', 0.5, [on(1, 'level', 0, 0.44), chan('treble', -8, 12)]),
    ],
  ),
  preset(
    'guitars/electrica-sucia',
    'Eléctrica Sucia',
    'guitars',
    ['guitarra', 'distorsion', 'rock', 'hardtek', 'potencia'],
    [
      layer('wt', { wave: 0.45, level: 0.7, phase: -1 }),
      layer('wt', { wave: 0.45, level: 0.35, fine: 10, pan: 0.3, phase: -1 }),
      layer('pluck', { wave: 0.5, level: 0.3, decayMul: 0.6, params: { damp: 0.25 } }),
    ],
    {
      level: 0.54,
      cutoff: 2600, resonance: 0.2, filterEnv: 0.3, modDecay: 0.4,
      attack: 0.003, decay: 1.6, sustain: 0.45, release: 0.3,
      drive: 0.76, bass: 3, treble: 2, width: 1.15, velSens: 0.5,
    },
    [
      macro('Ganancia', 0.7, [chan('drive', 0.2, 1), chan('level', 0.75, 0.45)]),
      macro('Cuerpo', 0.4, [chan('cutoff', 600, 5600), chan('bass', -3, 12)]),
      macro('Cuerda', 0.5, [on(2, 'level', 0, 0.6)]),
      macro('Cola', 0.35, [chan('decay', 0.3, 4), chan('release', 0.1, 0.67)]),
    ],
  ),
  preset(
    'guitars/requinto-latino',
    'Requinto Latino',
    'guitars',
    ['requinto', 'nylon', 'latin', 'bolero', 'melodia'],
    [
      layer('pluck', { wave: 0.5, level: 0.9, params: { damp: 0.42 } }),
      layer('noise', { wave: 0.88, level: 0.05, decayMul: 0.012, params: { q: 8 } }),
    ],
    {
      voiceMode: 2, glide: 0.02,
      cutoff: 5500, resonance: 0.1, filterEnv: 0.3, modDecay: 0.15, keytrack: 0.35,
      attack: 0.001, decay: 1.3, sustain: 0.08, release: 0.35,
      bass: 1, treble: 3, width: 0.85, velSens: 0.95,
    },
    [
      macro('Uña', 0.5, [on(1, 'level', 0, 0.1), on(0, 'wave', 0.15, 0.85)]),
      macro('Cuerpo', 0.5, [chan('bass', -4, 6), chan('cutoff', 1000, 10000)]),
      macro('Cola', 0.5, [chan('decay', 0.25, 2.35), on(0, 'damp', 0.66, 0.18)]),
      macro('Ligado', 0.2, [chan('glide', 0, 0.1)]),
    ],
  ),
  preset(
    'guitars/palm-muteada',
    'Palm Muteada',
    'guitars',
    ['guitarra', 'palm mute', 'drill', 'rock', 'seco'],
    [
      layer('pluck', { wave: 0.35, level: 0.85, semi: -12, params: { damp: 0.9 } }),
      layer('wt', { wave: 0.5, level: 0.3, semi: -12, cutoffOct: -0.6, decayMul: 0.5 }),
    ],
    {
      level: 0.8,
      cutoff: 2200, resonance: 0.15, filterEnv: 0.35, modDecay: 0.08,
      attack: 0.001, decay: 0.28, sustain: 0, release: 0.14,
      drive: 0.5, bass: 4, treble: 1, width: 0.7, velSens: 0.9,
    },
    [
      macro('Chug', 0.5, [chan('drive', 0.15, 0.85), chan('level', 0.9, 0.7)]),
      macro('Apagado', 0.5, [on(0, 'damp', 0.8, 1), chan('decay', 0.4, 0.16)]),
      macro('Cuerpo', 0.5, [chan('bass', -1, 9), chan('cutoff', 500, 3900)]),
      macro('Cuerda', 0.6, [on(1, 'level', 0, 0.5)]),
    ],
  ),
];
