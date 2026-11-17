/**
 * El panel de Claude se oculta con un botón a la vista, no solo desde el menú
 * Ver o la paleta: uno en la barra de navegación (junto a «Sonidos», que hace
 * lo mismo con la biblioteca) y una × en la cabecera del propio panel.
 *
 * La regla vive en el JSX, así que se lee la fuente (convención del repo: sin
 * jsdom). Lo que se fija es lo que una regresión rompería en silencio: que el
 * botón de la barra conmute el MISMO flag que pinta el panel, que salga del
 * modo compacto (si no, pulsarlo con el compacto activo no mostraría nada) y
 * que la × solo cierre.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

describe('botones para ocultar el panel de Claude', () => {
  it('la barra de navegación tiene un botón Claude que conmuta claudePanelOpen y sale del compacto', () => {
    const src = readSource('shell/StudioNavigation.tsx');
    expect(src).toContain('<IconClaude size={15} /><span>Claude</span>');
    expect(src).toContain('aria-pressed={claudePanelOpen && !compact}');
    expect(src).toContain('useUiStore.setState({ claudePanelOpen: !claudePanelOpen || compact, compact: false })');
  });

  it('la cabecera del panel lleva una × que solo lo cierra', () => {
    const src = readSource('App.tsx');
    expect(src).toContain('aria-label="Ocultar el panel de Claude"');
    expect(src).toContain('onClick={() => useUiStore.setState({ claudePanelOpen: false })}');
    // El panel se pinta con ese mismo flag: si se renombrara, la × apagaría otro.
    expect(src).toContain('{claudePanelOpen && !compact && (');
  });
});
