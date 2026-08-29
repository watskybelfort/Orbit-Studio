/**
 * MixTab.tsx tiene que decir la verdad sobre por dónde sale un canal.
 *
 * Bug real (auditoría v3.5): la pestaña leía `channel.mixerTrack` crudo. Un
 * canal SIN pista propia (mixerTrack 0, "Master", su valor de fábrica) dentro
 * de una carpeta CON bus en realidad compila en el bus del grupo
 * (`trackOfChannel`, `@orbit/core` — mismo criterio que ya usan
 * `run-export.ts` y `executor.ts`, ver `packages/claude-bridge/test/executor.test.ts`).
 * La pestaña decía "Sale por Master" cuando de verdad sonaba por el bus: no
 * rompe el audio, pero confunde al mezclar.
 *
 * Por qué este test lee el CÓDIGO FUENTE en vez de montar el componente:
 * `MixTab` ahora depende de `useProject()` (`useSyncExternalStore` sobre el
 * store real), así que montarlo de verdad para comprobar un `<p>` exigiría
 * jsdom + un ProjectStore + un AudioEngine completos — justo lo que CLAUDE.md
 * pide evitar para este repo. La propiedad que importa («¿la pestaña usa el
 * track EFECTIVO o el campo crudo para decidir qué mostrar?») vive entera en
 * el texto fuente, así que se comprueba ahí, con la misma técnica que
 * `drop-handlers-sync.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const file = readFileSync(resolve(here, '../src/editors/channel/MixTab.tsx'), 'utf8');

describe('MixTab: "Sale por…" usa la pista EFECTIVA (trackOfChannel), no channel.mixerTrack crudo', () => {
  it('importa trackOfChannel de @orbit/core y useProject para resolverlo', () => {
    expect(file).toMatch(/import \{[^}]*trackOfChannel[^}]*\}\s*from\s*'@orbit\/core'/s);
    expect(file).toContain("import { useProject } from '../../state/useProject';");
  });

  it('calcula la pista efectiva con trackOfChannel(project, channel.id)', () => {
    expect(file).toMatch(/trackOfChannel\(project,\s*channel\.id\)/);
  });

  it('la nota "Sale por…" y el lookup de la pista NO vuelven a leer channel.mixerTrack crudo', () => {
    // Estas dos formas exactas son el bug: si alguien las reintroduce, la
    // pestaña vuelve a mentir con un canal de grupo. No basta con que
    // `trackOfChannel` aparezca en el archivo — tiene que ser lo que
    // realmente alimenta el lookup y la etiqueta.
    expect(file).not.toMatch(/mixer\[channel\.mixerTrack\]/);
    expect(file).not.toMatch(/mixerTrackLabel\(channel\.mixerTrack/);
  });

  it('el lookup de la pista (para "N efecto(s) en esa pista") usa la variable resuelta', () => {
    expect(file).toMatch(/const track = mixer\[effectiveTrack\];/);
  });

  it('la etiqueta "Sale por…" usa la variable resuelta', () => {
    expect(file).toMatch(/Sale por[\s\S]{0,40}mixerTrackLabel\(effectiveTrack, names\)/);
  });

  it('el <select> de "Pista de mixer" sigue editando el campo CRUDO del canal (es la asignación explícita, no un status)', () => {
    // Distinto problema, a propósito NO tocado por este fix: el desplegable
    // es el control con el que el usuario declara `channel.mixerTrack`, así
    // que su `value` sigue siendo el campo crudo — mostrar ahí el resuelto
    // confundiría "lo que puse" con "por dónde sale de rebote".
    expect(file).toMatch(/<select[\s\S]{0,80}value=\{channel\.mixerTrack\}/);
  });
});
