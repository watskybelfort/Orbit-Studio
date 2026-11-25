import { describe, expect, it } from 'vitest';
import { COMPOSER_ROLES, composeBeat, createProfile, type TrackFeatures } from '@orbit/sound-library';
import {
  MAX_TRAIN_FILES,
  bpmHint,
  defaultForm,
  isAudioFileName,
  parseForm,
  rollSeed,
  toComposeOptions,
} from '../src/composer/composer-form';
import { readSource } from './read-source';

function features(bpm: number): TrackFeatures {
  const lane = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 0.9 : 0));
  return {
    name: 'ref', durationSec: 60, bpm, bpmConfidence: 0.8, keyRoot: 9, keyMode: 'minor', keyConfidence: 0.6,
    swing: 0, lanes: { low: lane, mid: lane, high: lane }, density: { low: 4, mid: 4, high: 4 }, brightness: 0.5, grit: 0.5,
  };
}

describe('formulario del compositor', () => {
  it('«Auto» no se cuela como un valor: sin tonalidad, tempo ni escala fijados', () => {
    const opts = toComposeOptions(defaultForm(5), []);
    expect(opts).not.toHaveProperty('keyRoot');
    expect(opts).not.toHaveProperty('bpm');
    expect(opts).not.toHaveProperty('scale');
    expect(opts).not.toHaveProperty('profile');
    expect(opts.roles).toEqual([...COMPOSER_ROLES]);
    // Y compone de verdad con eso.
    expect(composeBeat(opts).parts.length).toBeGreaterThan(0);
  });

  it('lo fijado pasa tal cual; el bucle lleva sus compases', () => {
    const form = { ...defaultForm(9), genre: 'neoperreo' as const, bpm: 98, keyRoot: 6, scale: 'Frigio', shape: 'loop' as const, loopBars: 4 };
    const plan = composeBeat(toComposeOptions(form, []));
    expect(plan.bpm).toBe(98);
    expect(plan.keyRoot).toBe(6);
    expect(plan.scaleName).toBe('Frigio');
    expect(plan.totalBars).toBe(4);
  });

  it('el perfil elegido entra con su influencia y la referencia manda sobre él', () => {
    const mine = createProfile('mine', 'Mis beats', [features(95)]);
    const ref = createProfile('ref', 'Referencia', [features(100)]);
    const form = { ...defaultForm(1), genre: 'reggaeton' as const, profileId: 'mine', influence: 1 };
    expect(toComposeOptions(form, [mine]).profile?.id).toBe('mine');
    expect(toComposeOptions(form, [mine], ref).profile?.id).toBe('ref');
    expect(toComposeOptions({ ...form, profileId: 'borrado' }, [mine]).profile).toBeUndefined();
    expect(composeBeat(toComposeOptions(form, [mine], ref)).bpm).toBe(100);
  });

  it('lo guardado en settings se sanea campo a campo', () => {
    const form = parseForm({ genre: 'polka', bpm: 9000, keyRoot: 3.5, roles: ['kick', 'voz'], influence: 2, shape: 'loop', loopBars: 16 }, 7);
    expect(form.genre).toBe('trap');
    expect(form.bpm).toBeNull();
    expect(form.keyRoot).toBeNull();
    expect(form.roles).toEqual(['kick']);
    expect(form.influence).toBe(0.5);
    expect(form.shape).toBe('loop');
    expect(form.loopBars).toBe(16);
    expect(form.seed).toBe(7);
    expect(parseForm(null, 3)).toEqual(defaultForm(3));
  });

  it('una variante de otro género no sobrevive ni al guardado ni al componer', () => {
    // El ajuste persistido puede venir con la variante del género anterior
    // (lo que arregló el botón de la referencia). `parseForm` la tira y
    // `toComposeOptions` tampoco la deja llegar a `resolvePreset`, que lanza
    // con una variante que no existe para el género.
    expect(parseForm({ genre: 'reggaeton', variant: 'moderno' }, 1).variant).toBe('moderno');
    expect(parseForm({ genre: 'boombap', variant: 'moderno' }, 1).variant).toBeNull();
    expect(parseForm({ genre: 'trap', variant: 'inventada' }, 1).variant).toBeNull();

    const ajeno = { ...defaultForm(3), genre: 'boombap' as const, variant: 'moderno' };
    expect(toComposeOptions(ajeno, [])).not.toHaveProperty('variant');
    expect(toComposeOptions({ ...ajeno, genre: 'reggaeton' as const }, []).variant).toBe('moderno');
  });

  it('una escala que no existe no llega ni al ajuste guardado ni al compositor', () => {
    // `compose` LANZA con una escala desconocida («escala desconocida "…"»),
    // así que una guardada a mano o venida de un settings viejo dejaba el
    // panel sin poder componer. Se tira al leer Y al traducir.
    expect(parseForm({ scale: 'Frigio' }, 1).scale).toBe('Frigio');
    expect(parseForm({ scale: 'Inventada' }, 1).scale).toBeNull();
    expect(parseForm({ scale: 'toString' }, 1).scale).toBeNull();

    const form = { ...defaultForm(2), scale: 'Inventada' };
    expect(toComposeOptions(form, [])).not.toHaveProperty('scale');
    expect(composeBeat(toComposeOptions(form, [])).parts.length).toBeGreaterThan(0);
    expect(toComposeOptions({ ...form, scale: 'Frigio' }, []).scale).toBe('Frigio');
  });

  it('la pista del tempo sigue a la variante y vuelve al género si no existe', () => {
    expect(bpmHint('trap')).toBe('142 (130–160)');
    expect(bpmHint('trap', 'duro')).toBe('150 (140–162)');
    expect(bpmHint('trap', 'inventada')).toBe('142 (130–160)');
  });

  it('solo audios, y una semilla de 32 bits', () => {
    expect(isAudioFileName('Beat.WAV')).toBe(true);
    expect(isAudioFileName('beat.mp3')).toBe(true);
    expect(isAudioFileName('beat.flp')).toBe(false);
    expect(MAX_TRAIN_FILES).toBe(32);
    const s = rollSeed(() => 0.999999);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('panel y registro de la ventana (código fuente real)', () => {
  it('el drop lee los archivos ANTES de cualquier await', () => {
    const src = readSource('composer/ComposerPanel.tsx');
    const start = src.indexOf('const onDrop =');
    const body = src.slice(start, src.indexOf('const dragProps', start));
    const read = body.indexOf('Array.from(event.dataTransfer.files)');
    expect(read).toBeGreaterThan(0);
    expect(body.slice(0, read)).not.toMatch(/\bawait\b|\.then\(/);
  });

  it('cambiar de género limpia la variante del anterior', () => {
    // `resolvePreset` es estricto con la variante: si el formulario se queda
    // con la del género viejo, no hay ninguna chip marcada y el ajuste guardado
    // viaja inválido. Todo `updateForm` que toque `genre` limpia la variante.
    const src = readSource('composer/ComposerPanel.tsx');
    const calls = [...src.matchAll(/updateForm\(\{[^}]*genre:[^}]*\}\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).toMatch(/variant:\s*null/);
  });

  it('la ventana está en todos los sitios que la abren o la describen', () => {
    expect(readSource('state/ui.ts')).toMatch(/\| 'composer'/);
    expect(readSource('state/ui.ts')).toMatch(/composer: \{ open: false/);
    expect(readSource('shell/Workspace.tsx')).toMatch(/<InternalWindow id="composer"[\s\S]*?<ComposerPanel \/>/);
    expect(readSource('shell/MenuBar.tsx')).toMatch(/windowItem\('composer'/);
    expect(readSource('shell/MenuBar.tsx')).toMatch(/openWindow\('composer'\)/);
    expect(readSource('palette/default-commands.ts')).toMatch(/id: 'composer'/);
    expect(readSource('shell/StudioNavigation.tsx')).toMatch(/value="composer"/);
    expect(readSource('shell/editor-guides.ts')).toMatch(/composer: \{ purpose/);
  });

  it('el puente de Claude recibe el host del compositor', () => {
    const src = readSource('state/claude.ts');
    expect(src).toMatch(/import \{ composerHost \} from '\.\/composer'/);
    expect(src).toMatch(/composerHost\(\),\s*\);/);
  });

  it('el panel no pinta colores literales ni fuentes mono', () => {
    const css = readSource('composer/composer.css');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/monospace|Space Mono|font-family/i);
  });
});

describe('samples de fábrica en la app', () => {
  it('componer y recomponer suben al motor lo que registran, y el host del MCP también', () => {
    const src = readSource('state/composer.ts');
    expect(src).toMatch(/store\.dispatch\(\{ type: 'batch', label, commands \}, \{ label \}\);\s*void loadSamplesIntoEngine\(samples\);/);
    expect(src).toMatch(/void loadSamplesIntoEngine\(registeredIn\(commands\)\);/);
    expect(src).toMatch(/loadSamples: loadSamplesIntoEngine,/);
    expect(src).toMatch(/await engine\.loadSample\(ref\.id, bytes\)/);
  });
});
