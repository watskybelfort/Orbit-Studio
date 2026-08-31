/**
 * El scope de un insert PROPIO del canal (pestaña "Efectos" del Channel Rack)
 * tiene que medir el canal, no el máster.
 *
 * Bug real (auditoría v3.9, mismo patrón que `mixtab-effective-track.test.ts`
 * para la v3.5 y `effective-track.test.ts` para la v3.7): `FxTab.tsx` pasaba
 * `trackIndex={channel.mixerTrack}` a `ChannelPluginView` (vía
 * `ChannelEffectEditor`). `channel.mixerTrack` es el campo CRUDO — un canal
 * sin pista propia (`mixerTrack === 0`, "Master", su valor de fábrica) dentro
 * de una carpeta CON bus en realidad compila en el bus del grupo
 * (`trackOfChannel`, `@orbit/core` — el mismo criterio que ya usan
 * `MixTab.tsx`, `ChannelRack.tsx`, `run-export.ts` y `executor.ts`). Una vista
 * de plugin de un insert que pida `needs.level` o `needs.spectrum` con la
 * pista cruda mide el MÁSTER en vez de lo que sale de la cadena del canal.
 *
 * Esta es la CUARTA vez que aparece el mismo bug con la misma corrección: no
 * se reinventa la regla, se reusa `trackOfChannel` — la implementación única
 * y ya probada en `core/test/routing.test.ts` y `core/test/group-bus.test.ts`.
 *
 * Por qué este test lee el CÓDIGO FUENTE en vez de montar el componente: ver
 * `mixtab-effective-track.test.ts` y `effective-track.test.ts` (mismo motivo
 * exacto — el componente cuelga de `useProject()`/store real, y montarlo con
 * jsdom para comprobar una prop es justo lo que CLAUDE.md pide evitar) y
 * `read-source.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const fxTab = readSource('editors/channel/FxTab.tsx');
const pluginView = readSource('plugins/PluginView.tsx');

describe('FxTab: el scope de un insert propio mide la pista EFECTIVA (trackOfChannel), no channel.mixerTrack crudo', () => {
  it('importa trackOfChannel de @orbit/core y useProject para resolverlo', () => {
    expect(fxTab).toMatch(/import \{[^}]*trackOfChannel[^}]*\}\s*from\s*'@orbit\/core'/s);
    expect(fxTab).toContain("import { useProject } from '../../state/useProject';");
  });

  it('calcula la pista efectiva con trackOfChannel(project, channel.id)', () => {
    expect(fxTab).toMatch(/trackOfChannel\(project,\s*channel\.id\)/);
  });

  it('ChannelEffectEditor recibe trackIndex={effectiveTrack}, no channel.mixerTrack crudo', () => {
    expect(fxTab).toMatch(/<ChannelEffectEditor[\s\S]{0,400}trackIndex=\{effectiveTrack\}/);
    expect(fxTab).not.toMatch(/trackIndex=\{channel\.mixerTrack\}/);
  });

  it('el JSDoc de ChannelPluginView (PluginView.tsx) ya no afirma que el tap va siempre por la pista de mixer del canal', () => {
    const at = pluginView.indexOf('export function ChannelPluginView');
    expect(at).toBeGreaterThan(0);
    const jsdocStart = pluginView.lastIndexOf('/**', at);
    const jsdoc = pluginView.slice(jsdocStart, at);
    // La afirmación vieja y falsa, sin matices sobre el bus.
    expect(jsdoc).not.toMatch(/el tap del scope va por\s*\n?\s*\* la pista de mixer del canal, que es donde se oye lo que sale de la cadena/);
    // La regla de verdad, con el caso del bus explícito.
    expect(jsdoc).toMatch(/trackOfChannel/);
    expect(jsdoc).toMatch(/bus/);
  });
});
