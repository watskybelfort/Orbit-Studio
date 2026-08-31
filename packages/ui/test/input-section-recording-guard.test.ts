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
 * La decisión (documentada en `input-monitor.ts`) es BLOQUEAR los dos
 * controles que de verdad cierran el stream —el toggle de Micro y el select
 * de Dispositivo— mientras hay una toma en curso, con un aviso VISIBLE (no un
 * bloqueo silencioso) explicando por qué.
 *
 * **Remate de la v3.7**: la guarda de verdad vive ahora en las funciones
 * (`toggleInputListening`/`setInputDevice`, ver
 * `input-monitor-recording-guard.test.ts`), no en este componente — eso ya lo
 * cubre otro archivo. Lo que este test comprueba es la otra mitad de la regla
 * "no dos copias de una invariante": `InputSection.tsx` no debe volver a
 * traerse su propia condición `phase !== 'idle'` ni su propio texto, sino
 * LEER `useInputGuardReason()` (que exporta `input-monitor.ts`) y pintar lo
 * que devuelve.
 *
 * Por qué este test lee el CÓDIGO FUENTE en vez de montar el componente: es
 * la convención del repo para lógica que vive en el JSX de un `.tsx` sin
 * traer jsdom/@testing-library (ver `drop-handlers-sync.test.ts` y
 * CLAUDE.md). Montar `InputSection` de verdad exigiría un DOM, un
 * `AudioContext` y un `store` de proyecto completos solo para leer un
 * atributo `disabled` — el texto fuente ya es la fuente de verdad de esa
 * propiedad, y una regresión (alguien borra el `disabled={recording}`, o
 * vuelve a escribir `phase !== 'idle'` a mano) rompe este test igual.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const file = readSource('settings/InputSection.tsx');

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
  it('lee la regla de input-monitor.ts (useInputGuardReason), no se trae su propia condición', () => {
    expect(file).toContain(
      "  useInputGuardReason,\n  useInputMonitorStore,\n} from '../state/input-monitor';",
    );
    expect(file).toMatch(/const guardReason = useInputGuardReason\(\);/);
    expect(file).toMatch(/const recording = guardReason !== null;/);
    // Que no vuelva a importar `useRecorderStore` ni a leer su fase a mano:
    // eso es justo la duplicación que causó el bug (el throttle del aviso de
    // versión, citado en la tarjeta de esta tarea) — dos copias de la misma
    // condición que se desincronizan sin que ningún test lo note.
    expect(file).not.toContain("from '../state/recorder'");
    expect(file).not.toMatch(/const recPhase = useRecorderStore/);
    expect(file).not.toMatch(/const recording = recPhase/);
  });

  it('el toggle de "Micro" (cierra el stream) se deshabilita en pleno REC', () => {
    const row = rowContaining('<span className="set-label">Micro</span>');
    expect(row).toContain('disabled={recording}');
    // Y el motivo se ve, no solo se bloquea a ciegas — leído de guardReason,
    // no un texto propio.
    expect(row).toContain('guardReason');
  });

  it('el select de "Dispositivo" (reabre el stream con otro aparato) se deshabilita en pleno REC', () => {
    const row = rowContaining('<span className="set-label">Dispositivo</span>');
    expect(row).toContain('disabled={recording}');
    expect(row).toContain('guardReason');
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

  it('hay un aviso visible de por qué (no es un bloqueo mudo), con el mismo texto que la regla', () => {
    expect(file).toMatch(/\{recording && <p className="set-error">\{guardReason\}<\/p>\}/);
  });

  it('el error de input-monitor.ts (hot-unplug / cambio de dispositivo del sistema) también se pinta', () => {
    // Ese aviso no se puede bloquear —el cable ya se fue—, así que llega por
    // `useInputMonitorStore().error`, no por la guarda de arriba.
    expect(file).toMatch(/const error = useInputMonitorStore\(\(s\) => s\.error\);/);
    expect(file).toMatch(/\{error && <p className="set-error">\{error\}<\/p>\}/);
  });

  it('la propia comprobación de fila sabe fallar si el marcador no existe', () => {
    expect(() => rowContaining('<span className="set-label">Esto no existe</span>')).toThrow(
      /no se encontró/,
    );
  });
});
