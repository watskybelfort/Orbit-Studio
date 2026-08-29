/**
 * Cambiar de dispositivo o cerrar el micro EN PLENO REC cierra el stream
 * (`stopInputMonitor`, en `state/input-monitor.ts`) y la captura del
 * grabador —anidada dentro de `if (inputListening…)` en el kernel— deja de
 * acumular muestras SIN excepción ni aviso: la toma sale corta y
 * desincronizada, y nadie se entera hasta escucharla. Bug real (auditoría
 * v3.5): `InputSection.tsx` no consultaba `useRecorderStore`, a diferencia de
 * `MidiSection.tsx`, que sí lo hace para deshabilitar el botón de calibrar
 * latencia mientras se graba.
 *
 * La decisión (documentada en el propio `InputSection.tsx`) es BLOQUEAR los
 * dos controles que de verdad cierran el stream —el toggle de Micro y el
 * select de Dispositivo— mientras `useRecorderStore().phase !== 'idle'`, con
 * un aviso VISIBLE (no un bloqueo silencioso) explicando por qué.
 *
 * Por qué este test lee el CÓDIGO FUENTE en vez de montar el componente: es
 * la convención del repo para lógica que vive en el JSX de un `.tsx` sin
 * traer jsdom/@testing-library (ver `drop-handlers-sync.test.ts` y
 * CLAUDE.md). Montar `InputSection` de verdad exigiría un DOM, un
 * `AudioContext` y un `store` de proyecto completos solo para leer un
 * atributo `disabled` — el texto fuente ya es la fuente de verdad de esa
 * propiedad, y una regresión (alguien borra el `disabled={recording}`, o dos
 * clics permiten truncar la toma) rompe este test igual.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const file = readFileSync(resolve(here, '../src/settings/InputSection.tsx'), 'utf8');

/**
 * El fragmento del JSX que empieza en `marker` y se cierra en el primer
 * `</div>` de después: cada control de este archivo vive en su propio
 * `<div className="set-row">…</div>`, así que esto aísla el bloque de un
 * control concreto (el de "Micro", el de "Dispositivo"...) del resto del
 * archivo.
 */
function rowContaining(marker: string): string {
  const at = file.indexOf(marker);
  expect(at, `no se encontró "${marker}" en InputSection.tsx`).toBeGreaterThanOrEqual(0);
  const end = file.indexOf('</div>', at);
  expect(end, `no se encontró el "</div>" que cierra el bloque de "${marker}"`).toBeGreaterThan(at);
  return file.slice(at, end);
}

describe('InputSection: no truncar una toma en curso al cambiar de dispositivo o cerrar el micro', () => {
  it('lee useRecorderStore, igual que MidiSection.tsx para el botón de calibrar', () => {
    expect(file).toContain("import { useRecorderStore } from '../state/recorder';");
    expect(file).toMatch(/const recPhase = useRecorderStore\(\(s\) => s\.phase\);/);
    expect(file).toMatch(/const recording = recPhase !== 'idle';/);
  });

  it('el toggle de "Micro" (cierra el stream) se deshabilita en pleno REC', () => {
    const row = rowContaining('<span className="set-label">Micro</span>');
    expect(row).toContain('disabled={recording}');
    // Y el motivo se ve, no solo se bloquea a ciegas.
    expect(row).toMatch(/toma en curso/i);
  });

  it('el select de "Dispositivo" (reabre el stream con otro aparato) se deshabilita en pleno REC', () => {
    const row = rowContaining('<span className="set-label">Dispositivo</span>');
    expect(row).toContain('disabled={recording}');
    expect(row).toMatch(/toma en curso/i);
  });

  it('controles que NO cierran el stream (Pista, Ganancia, Monitor) siguen libres durante la toma', () => {
    // `setInputTrack`/`setInputGain`/`toggleInputMonitor` nunca llaman a
    // `stopInputMonitor` (ver `input-monitor.ts`): bloquearlos también sería
    // una sobre-corrección sin motivo real. Si alguna vez ganan un
    // `disabled={recording}` habrá que revisar por qué, no basta con que
    // este test lo permita en silencio.
    const pista = rowContaining('<span className="set-label">Pista</span>');
    const ganancia = rowContaining('<span className="set-label">Ganancia</span>');
    const monitor = rowContaining('<span className="set-label">Monitor</span>');
    expect(pista).not.toContain('disabled={recording}');
    expect(ganancia).not.toContain('disabled={recording}');
    expect(monitor).not.toContain('disabled={recording}');
  });

  it('hay un aviso visible de por qué (no es un bloqueo mudo)', () => {
    expect(file).toMatch(/\{recording && \(/);
    expect(file).toMatch(/cortaría en silencio/i);
  });

  it('la propia comprobación de fila sabe fallar si el marcador no existe', () => {
    expect(() => rowContaining('<span className="set-label">Esto no existe</span>')).toThrow(
      /no se encontró/,
    );
  });
});
