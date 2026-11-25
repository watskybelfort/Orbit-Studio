/**
 * Los tres avisos del botón «cortar por golpes» (pestaña Sonido del canal).
 *
 * Antes, cualquier fallo de esa ruta decía lo justo para no ayudar: «no se pudo
 * leer el archivo», «no se encontró ningún golpe claro», o —peor— el
 * `DOMException` en inglés que lanza `decodeAudioData`. El usuario no sabía si
 * el sample se había movido, si el archivo estaba a medias, o si el detector
 * simplemente no veía golpes con ese ajuste.
 *
 * La regla vive entera dentro del manejador de un `.tsx`, así que se prueba
 * sobre su código fuente (misma vía que `drop-handlers-sync.test.ts`, y por
 * `readSource` para no depender del final de línea del checkout): lo que se
 * afirma no es la redacción exacta, sino que el error del navegador queda
 * envuelto y que cada aviso dice qué pasó y qué probar.
 */

import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const source = readSource('editors/channel/SoundTab.tsx');

/** Cuerpo del manejador de detección, aislado del resto del componente. */
const body = source.slice(
  source.indexOf('const cutByTransients'),
  source.indexOf('const trim ='),
);

describe('cortar por golpes: los avisos explican el motivo', () => {
  it('el error de decodificación del navegador no llega al usuario', () => {
    // `decodeAudioData` rechaza con un DOMException en inglés y sin acción
    // posible; si se quita el try/catch, ese texto vuelve a la pantalla.
    expect(body).toMatch(/try\s*\{\s*decoded = await ctx\.decodeAudioData\(bytes\);\s*\}\s*catch/);
    const guarded = body.slice(body.indexOf('decodeAudioData'));
    expect(guarded).toContain('decodificar');
    expect(guarded).toContain('dañado');
  });

  it('sin golpes, el aviso nombra el ajuste usado y sugiere la alternativa', () => {
    const noHits = body.slice(body.indexOf('ningún golpe claro'), body.indexOf('setSlicePoints(clean'));
    // El ajuste con el que se intentó, no un «no hay golpes» a secas.
    expect(noHits).toMatch(/preset\.label/);
    expect(noHits).toContain('a mano');
  });

  it('si el archivo no se puede leer, dice qué revisar', () => {
    const unreadable = body.slice(body.indexOf('if (!bytes)'), body.indexOf('const ctx'));
    expect(unreadable).toContain('revisa');
  });
});
