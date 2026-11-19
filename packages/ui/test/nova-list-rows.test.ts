/**
 * Las tarjetas del catálogo de Nova se aplastaban a ~27 px.
 *
 * `.nova-list` es un grid con `align-content: start`, pero sin
 * `grid-auto-rows` el navegador reparte la altura disponible entre las filas
 * implícitas como si fueran `1fr`: cada tarjeta se quedaba con 26,95 px y sus
 * dos líneas de texto (nombre 16,8 px de interlineado + tags) se comprimían a
 * tiras de 3-4 px. Se veía en los DOS acabados, porque el bug estaba en la
 * hoja base, no en la capa `soft`.
 *
 * La altura de fila la tiene que mandar el contenido (`max-content`) y lo que
 * sobre, scroll. Este test lee el CSS porque el fallo no está en la lógica de
 * React sino en una decisión de layout; montar el panel entero para medir
 * alturas pediría jsdom, que este repo no usa.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const nova = readSource('editors/nova/nova.css');
const native = readSource('theme/native.css');

describe('Nova: las filas del catálogo las mide el contenido', () => {
  it('.nova-list declara grid-auto-rows: max-content', () => {
    expect(nova).toMatch(/\.nova-list \{[^}]*grid-auto-rows:\s*max-content/);
  });

  it('la capa soft no vuelve a fijar una altura de fila que aplaste las tarjetas', () => {
    // La capa soft puede cambiar gap/padding/columnas (lo hace), pero no
    // altura de fila: si algún día lo necesita, que sea explícito y revisado.
    expect(native).not.toMatch(/\.nova-list \{[^}]*grid-auto-rows/);
  });
});
