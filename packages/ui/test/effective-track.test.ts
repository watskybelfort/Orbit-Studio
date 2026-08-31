/**
 * El scope del plugin de INSTRUMENTO en el Channel Rack tiene que medir el
 * canal, no el máster.
 *
 * Bug real (auditoría v3.7, mismo patrón que `mixtab-effective-track.test.ts`
 * para la v3.5): `ChannelRack.tsx` pasaba `trackIndex={channel.mixerTrack}` a
 * `InstrumentPluginView`. `channel.mixerTrack` es el campo CRUDO — un canal
 * sin pista propia (`mixerTrack === 0`, "Master", su valor de fábrica) dentro
 * de una carpeta CON bus en realidad compila en el bus del grupo
 * (`trackOfChannel`, `@orbit/core` — el mismo criterio que ya usan
 * `MixTab.tsx`, `run-export.ts` y `executor.ts`). Una vista de plugin que pida
 * `needs.level` o `needs.spectrum` con la pista cruda mide el MÁSTER en vez de
 * lo que suena en ese canal.
 *
 * La fila del rack YA sabía resolver esto para su propia chapa visual
 * (`const viaBus = busTrack !== null && channel.mixerTrack === 0;`, unas 300
 * líneas antes del `<InstrumentPluginView>`). El arreglo reusa esa regla vía
 * `trackOfChannel` — la implementación única y ya probada en
 * `core/test/routing.test.ts` y `core/test/group-bus.test.ts` — en vez de
 * reinventarla como una segunda copia local: dos copias de esta regla ya se
 * desincronizaron una vez en este repo.
 *
 * Por qué este test lee el CÓDIGO FUENTE en vez de montar el componente: ver
 * `mixtab-effective-track.test.ts` (mismo motivo exacto, mismo componente
 * conectado a `useProject()`/store real) y `read-source.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const rack = readSource('editors/rack/ChannelRack.tsx');
const pluginView = readSource('plugins/PluginView.tsx');

describe('ChannelRack: el scope del instrumento mide la pista EFECTIVA (trackOfChannel), no channel.mixerTrack crudo', () => {
  it('importa trackOfChannel de @orbit/core', () => {
    expect(rack).toMatch(/import \{[^}]*trackOfChannel[^}]*\}\s*from\s*'@orbit\/core'/s);
  });

  it('resuelve effectiveTrack con trackOfChannel(project, id) donde ya resuelve busTrack', () => {
    // Mismo sitio donde ya se calculaba `busTrack={busOfChannel(project, id)}`
    // para la chapa: la pista efectiva se resuelve ahí, una sola vez por fila,
    // no dentro de ChannelRow por cada uso.
    expect(rack).toMatch(/busTrack=\{busOfChannel\(project,\s*id\)\}[\s\S]{0,500}effectiveTrack=\{trackOfChannel\(project,\s*id\)\}/);
  });

  it('InstrumentPluginView recibe trackIndex={effectiveTrack}, no channel.mixerTrack crudo', () => {
    expect(rack).toMatch(/<InstrumentPluginView[\s\S]{0,400}trackIndex=\{effectiveTrack\}/);
    expect(rack).not.toMatch(/<InstrumentPluginView[\s\S]{0,400}trackIndex=\{channel\.mixerTrack\}/);
  });

  it('la regla de "via bus" de la chapa (:1393) sigue existiendo tal cual — no se duplicó, se reusó por otro camino', () => {
    // El arreglo no reescribe `viaBus`: reusa `trackOfChannel` (la MISMA
    // función que ya prueban `core/test/routing.test.ts` y
    // `core/test/group-bus.test.ts`) para el número que necesita la vista del
    // plugin, en vez de sumar una tercera copia de "mixerTrack === 0 &&
    // busTrack !== null" en algún sitio nuevo.
    expect(rack).toMatch(/const viaBus = busTrack !== null && channel\.mixerTrack === 0;/);
    expect(rack.match(/mixerTrack === 0 && busTrack/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('el JSDoc de InstrumentPluginView (PluginView.tsx) ya no afirma que el tap va siempre por la pista de mixer del canal', () => {
    const at = pluginView.indexOf('export function InstrumentPluginView');
    expect(at).toBeGreaterThan(0);
    const jsdocStart = pluginView.lastIndexOf('/**', at);
    const jsdoc = pluginView.slice(jsdocStart, at);
    // La afirmación vieja y falsa, sin matices sobre el bus.
    expect(jsdoc).not.toMatch(/el tap del scope va por la pista de mixer del canal,\s*\n?\s*\* que es donde se oye lo que suena/);
    // La regla de verdad, con el caso del bus explícito.
    expect(jsdoc).toMatch(/trackOfChannel/);
    expect(jsdoc).toMatch(/bus/);
  });
});
