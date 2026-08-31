/**
 * El menú de un send (`Mixer.tsx` → `SendMenu`) despachaba `patchSend` con
 * `label` pero SIN `mergeKey` — el mismo hueco que costó 80 undos en el
 * deslizador de ganancia de entrada (`input-route-merge.test.ts`), esta vez
 * en el Pan de un send: `<input type="range" min={-1} max={1} step={0.05}>`
 * son 40 pasos por un arrastre de punta a punta, así que un solo gesto dejaba
 * hasta 40 filas «Send: pan» en el historial y pedía 40 Ctrl+Z para deshacerse.
 *
 * La `mergeKey` se arregló EN EL ENVOLTORIO (la función `patch` local de
 * `SendMenu`), no en el deslizador — igual que hizo `patchInputRoute` con el
 * suyo — para que el próximo campo del send no reabra el mismo bug. La clave
 * lleva la pista de origen, la pista destino Y el campo tocado
 * (`send:${trackIndex}:${target}:${campo}`): el target solo no identifica un
 * send porque una misma pista puede tener varios, y el campo hace falta para
 * que el pan y la polaridad de un mismo send no se fundan entre sí.
 *
 * Esa lógica vive dentro de un `.tsx` (la función `patch` de `SendMenu`), así
 * que por la convención del repo (CLAUDE.md, `read-source.ts`) no se monta el
 * componente con jsdom: se lee su código fuente de verdad para fijar la forma
 * exacta de la clave, y por separado se ejercita el `ProjectStore` REAL
 * despachando `patchSend` con esa misma forma — que es lo que un vistazo al
 * panel de Historial no prueba con la misma fuerza (ver docblock de
 * `input-route-merge.test.ts`).
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSource, readText } from './read-source';

async function rig() {
  vi.resetModules();

  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  const app = await import('../src/state/app');

  return { core, app };
}

type SendPatch = Partial<Omit<import('@orbit/core').Send, 'target'>>;

/** El mismo criterio de fusión que `SendMenu.patch` en Mixer.tsx: id + campo. */
function sendMergeKey(trackIndex: number, target: number, patch: SendPatch): string {
  const fields = Object.keys(patch).sort().join('+') || 'patch';
  return `send:${trackIndex}:${target}:${fields}`;
}

/** El mismo despacho que hace `SendMenu.patch`, para probarlo contra el store real. */
function dispatchSendPatch(
  app: Awaited<ReturnType<typeof rig>>['app'],
  trackIndex: number,
  target: number,
  patch: SendPatch,
  what: string,
): void {
  app.store.dispatch(
    { type: 'patchSend', trackIndex, target, patch },
    { label: `Send: ${what}`, mergeKey: sendMergeKey(trackIndex, target, patch) },
  );
}

/** Crea un send trackIndex→target con nivel 1, por el bus de comandos. */
function createSend(app: Awaited<ReturnType<typeof rig>>['app'], trackIndex: number, target: number): void {
  app.store.dispatch({ type: 'setSend', trackIndex, target, level: 1 });
}

function sendOf(app: Awaited<ReturnType<typeof rig>>['app'], trackIndex: number, target: number) {
  const send = app.store.project.mixer[trackIndex]?.sends.find((s) => s.target === target);
  if (!send) throw new Error(`no hay send ${trackIndex}->${target}`);
  return send;
}

describe('el código fuente de SendMenu.patch (Mixer.tsx) deriva mergeKey del patch', () => {
  it('despacha patchSend con mergeKey, no solo con label', () => {
    const file = readSource('editors/mixer/Mixer.tsx');
    const at = file.indexOf(
      "const patch = (p: Partial<Omit<Send, 'target'>>, what: string): void => {",
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const closeAt = file.indexOf('\n  };', at);
    expect(closeAt).toBeGreaterThan(at);
    const body = file.slice(at, closeAt);

    expect(body).toContain("type: 'patchSend'");
    expect(body).toContain('mergeKey:');
    // La clave se afirma por trozos unidos con un "$": escribirla entera dentro
    // de comillas simples dispara `no-template-curly-in-string`, una regla que existe
    // para cazar una plantilla mal escrita — y aqui el ${...} es el TEXTO que se
    // busca en el fuente, no una interpolacion olvidada.
    const CLAVE_ESPERADA = [
      '`send:',
      '{trackIndex}:',
      '{send.target}:',
      '{fields}`',
    ].join('$');
    expect(body).toContain(CLAVE_ESPERADA);
  });

  it('el Pan del send es un <input type="range"> que llama a ese patch', () => {
    const file = readSource('editors/mixer/Mixer.tsx');
    const panAt = file.indexOf('Pan\n        <input');
    expect(panAt).toBeGreaterThanOrEqual(0);
    const tagEnd = file.indexOf('/>', panAt);
    const tag = file.slice(panAt, tagEnd);
    expect(tag).toContain('type="range"');
    expect(tag).toContain("patch({ pan: Number(e.target.value) }, 'pan')");
  });
});

describe('patchSend con mergeKey funde el arrastre del pan (ProjectStore real)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('un arrastre completo de 40 pasos deja UNA entrada, y un undo vuelve al pan de antes del gesto', async () => {
    const { app } = await rig();
    createSend(app, 1, 2);
    const panBefore = sendOf(app, 1, 2).pan ?? 0;
    expect(panBefore).toBe(0);

    const historyBefore = app.store.history.length;

    // El deslizador real: min=-1 max=1 step=0.05 -> 40 pasos por un arrastre
    // de punta a punta.
    for (let i = 1; i <= 40; i++) {
      const value = Math.round((-1 + i * 0.05) * 100) / 100;
      dispatchSendPatch(app, 1, 2, { pan: value }, 'pan');
    }

    expect(sendOf(app, 1, 2).pan).toBe(1);
    // Una sola entrada nueva, no 40.
    expect(app.store.history.length).toBe(historyBefore + 1);

    const entry = app.store.history[app.store.history.length - 1]!;
    expect(entry.label).toBe('Send: pan');
    expect(entry.mergeKey).toBe('send:1:2:pan');

    app.store.undo();
    // Al valor de ANTES del gesto — no al penúltimo paso (0.95), que es el
    // bug que deja una mergeKey sin el campo (o sin nada).
    expect(sendOf(app, 1, 2).pan ?? 0).toBe(panBefore);
  });

  it('dos sends distintos de la MISMA pista no se funden entre sí', async () => {
    const { app } = await rig();
    createSend(app, 1, 2);
    createSend(app, 1, 3);
    const historyBefore = app.store.history.length;

    for (let i = 1; i <= 5; i++) dispatchSendPatch(app, 1, 2, { pan: i * 0.1 }, 'pan');
    for (let i = 1; i <= 5; i++) dispatchSendPatch(app, 1, 3, { pan: i * 0.1 }, 'pan');

    // Dos entradas: una por send, no una sola fundiendo las dos.
    expect(app.store.history.length).toBe(historyBefore + 2);
    const tail = app.store.history.slice(-2);
    expect(tail.map((e) => e.mergeKey)).toEqual(['send:1:2:pan', 'send:1:3:pan']);

    // Deshacer una vez solo toca el send hacia el target 3 (la última ráfaga).
    app.store.undo();
    expect(sendOf(app, 1, 3).pan ?? 0).toBe(0);
    expect(sendOf(app, 1, 2).pan).toBeCloseTo(0.5, 5);

    app.store.undo();
    expect(sendOf(app, 1, 2).pan ?? 0).toBe(0);
  });

  it('el pan no se funde con la polaridad del mismo send', async () => {
    const { app } = await rig();
    createSend(app, 1, 2);
    const historyBefore = app.store.history.length;

    for (let i = 1; i <= 3; i++) dispatchSendPatch(app, 1, 2, { pan: i * 0.1 }, 'pan');
    dispatchSendPatch(app, 1, 2, { invert: true }, 'polaridad');
    for (let i = 1; i <= 3; i++) dispatchSendPatch(app, 1, 2, { pan: 0.3 + i * 0.1 }, 'pan');

    // Tres entradas: la ráfaga de pan, el cambio de polaridad (en medio, sin
    // fundirse con ninguna), y la SEGUNDA ráfaga de pan.
    expect(app.store.history.length).toBe(historyBefore + 3);
    const labels = app.store.history.slice(-3).map((e) => e.label);
    expect(labels).toEqual(['Send: pan', 'Send: polaridad', 'Send: pan']);

    expect(sendOf(app, 1, 2).invert).toBe(true);
    expect(sendOf(app, 1, 2).pan).toBeCloseTo(0.6, 5);
  });
});

// ── La pregunta de fondo: ¿puede un <input type="range"> que despacha ──────
// olvidarse la mergeKey?
//
// Van tres sitios con este mismo bug en tres rondas (ganancia de entrada,
// canales de entrada, y ahora el pan de un send) más dos latentes. Rastrear
// EN GENERAL "toda ráfaga que termina en un store.dispatch" no es un problema
// textual: un slider puede delegar en un widget reusable (Knob, Fader) cuyo
// dispatch real vive en el CALLSITE que le pasa el onChange, no en el widget
// — seguir esa cadena de props sin ejecutar el componente pide, en el fondo,
// un analizador de flujo de datos entre archivos, y ese es exactamente el
// tipo de herramienta que este repo no tiene a propósito (CLAUDE.md: los
// .tsx se prueban por texto o por estado, nunca montando con jsdom). Un
// helper compartido tampoco cierra el hueco por sí solo: `patchInputRoute` YA
// es ese helper para las rutas de entrada, y aun así el pan de un send lo
// reinventó mal al lado, en otro archivo, porque nada obliga a un wrapper
// nuevo a pasar por uno existente ni a acordarse de la mergeKey.
//
// Lo que SÍ es textual, barato, y no se puede esquivar sin que algo se rompa:
// hoy hay exactamente OCHO `<input type="range">` en todo `packages/ui/src`.
// Un inventario cerrado los nombra a los ocho con su veredicto — toca el
// ProjectStore o no, y si lo toca, por qué su mergeKey está garantizada — y
// si aparece un noveno, este test se rompe por la CUENTA antes de que nadie
// tenga que acordarse de mirar. No adivina si el próximo slider está bien:
// obliga a que alguien lo decida AQUÍ, a mano, la primera vez que aparece —
// que es más barato y más de fiar que un analizador que un día deja de
// seguir un patrón nuevo y falla en silencio.
describe('inventario cerrado de <input type="range"> en packages/ui/src', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const UI_SRC = resolve(HERE, '../src');

  /** Todos los .tsx bajo packages/ui/src, recorrido recursivo. */
  function walkTsx(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkTsx(full, out);
      else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  /**
   * `file:line` de cada `type="range"` REAL — una línea que es exactamente
   * ese atributo JSX, como los escribe este repo (uno por línea). Filtra a
   * propósito un comentario que solo MENCIONE `type="range"` (como el
   * docblock de `patch` en Mixer.tsx, unas líneas arriba en este mismo
   * archivo): esa línea no abre con el atributo pelado, así que no cuenta.
   */
  function findRangeInputs(): string[] {
    const sites: string[] = [];
    for (const file of walkTsx(UI_SRC)) {
      const rel = file.slice(UI_SRC.length + 1).replace(/\\/g, '/');
      readText(file)
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*type="range"\s*$/.test(line)) sites.push(`${rel}:${i + 1}`);
        });
    }
    return sites.sort();
  }

  /** Cuerpo entre llaves de la función que arranca en `startMarker`. */
  function functionBodyAfter(source: string, startMarker: string): string {
    const at = source.indexOf(startMarker);
    if (at < 0) throw new Error(`no se encontró "${startMarker}"`);
    const braceStart = source.indexOf('{', at);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(braceStart, i + 1);
      }
    }
    throw new Error(`"${startMarker}" nunca cierra`);
  }

  it('son exactamente estos ocho, ni uno más ni uno menos — uno nuevo rompe este test', () => {
    expect(findRangeInputs()).toEqual([
      'collab/CollabPanel.tsx:451',
      'editors/mixer/Mixer.tsx:1543',
      'settings/InputSection.tsx:139',
      'settings/MidiSection.tsx:186',
      'settings/MidiSection.tsx:375',
      'settings/SettingsPanel.tsx:236',
      'settings/SettingsPanel.tsx:304',
      'settings/SettingsPanel.tsx:348',
    ]);
  });

  it('CollabPanel:451 (volumen de escucha) no toca el ProjectStore: setStreamVolume es de la sesión, no del proyecto', () => {
    expect(readSource('collab/CollabPanel.tsx')).toContain(
      'onChange={(e) => setStreamVolume(Number(e.target.value))}',
    );
    const masterStream = readSource('collab/master-stream.ts');
    const body = functionBodyAfter(masterStream, 'export function setStreamVolume(volume: number): void {');
    expect(body).not.toContain('store.dispatch');
  });

  it('SettingsPanel:236/304/348 (acrílico, escala, radio) no tocan el ProjectStore: son ajustes de la app', () => {
    const panel = readSource('settings/SettingsPanel.tsx');
    expect(panel).toContain(
      'onChange={(e) => commit(theme, { ...overrides, glassAlpha: Number(e.target.value) })}',
    );
    expect(panel).toContain(
      'onChange={(e) => commitLook({ ...appearance, scale: Number(e.target.value) })}',
    );
    expect(panel).toContain(
      'onChange={(e) => commitLook({ ...appearance, radius: Number(e.target.value) })}',
    );
    // Ningún control de este panel dispara nada del bus de comandos: el
    // archivo entero, no solo estos tres, se queda sin `store.dispatch`.
    expect(panel).not.toContain('store.dispatch');
  });

  it('MidiSection:186 (octava) no toca el ProjectStore: setMidiOctave es un ajuste de sesión', () => {
    expect(readSource('settings/MidiSection.tsx')).toContain(
      'onChange={(e) => setMidiOctave(Number(e.target.value))}',
    );
    const liveInput = readSource('state/live-input.ts');
    // OJO: live-input.ts SÍ tiene store.dispatch en otras funciones (notas en
    // vivo) — por eso el cheque va sobre el CUERPO de setMidiOctave, no sobre
    // el archivo entero, o daría un falso positivo por dispatches ajenos.
    const body = functionBodyAfter(liveInput, 'export function setMidiOctave(octave: number): void {');
    expect(body).not.toContain('store.dispatch');
  });

  it('InputSection:139 (ganancia de escucha) no toca el ProjectStore: setInputGain es el monitor en vivo, no InputRoute.gain', () => {
    expect(readSource('settings/InputSection.tsx')).toContain(
      'onChange={(e) => setInputGain(Number(e.target.value))}',
    );
    const monitor = readSource('state/input-monitor.ts');
    const body = functionBodyAfter(monitor, 'export function setInputGain(gain: number): void {');
    expect(body).not.toContain('store.dispatch');
  });

  it('MidiSection:375 (ganancia de InputRoute) SÍ toca el ProjectStore, por patchInputRoute — mergeKey ya probada en input-route-merge.test.ts', () => {
    expect(readSource('settings/MidiSection.tsx')).toContain(
      'declared && patchInputRoute(declared.id, { gain: Number(e.target.value) })',
    );
  });

  it('Mixer:1543 (pan del send) SÍ toca el ProjectStore, por el patch local con mergeKey — probado arriba en este archivo', () => {
    expect(readSource('editors/mixer/Mixer.tsx')).toContain(
      "onChange={(e) => patch({ pan: Number(e.target.value) }, 'pan')}",
    );
  });
});
