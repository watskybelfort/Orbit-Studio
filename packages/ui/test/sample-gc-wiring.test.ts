/**
 * Que la recolección de samples EN SESIÓN esté enganchada donde la auditoría
 * v3.5 (tarea db8986f2 / ac6c9c8f) dijo que faltaba: borrar un canal,
 * deshacer y rehacer. `sample-gc-session.test.ts` prueba el MECANISMO contra
 * el store y el motor reales; esto prueba que el código de verdad —el que
 * corre un clic o un Ctrl+Z de verdad— lo LLAMA. Sin esto, alguien podría
 * reescribir `deleteChannel` o el atajo de undo sin la llamada y los tests
 * del mecanismo seguirían en verde, exactamente el mismo punto ciego que
 * dejó pasar la v1 de este arreglo (ver `drop-handlers-sync.test.ts`, mismo
 * patrón: leer el código fuente de verdad en vez de montar el componente).
 */

import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';


/** El cuerpo de la función/flecha que arranca en `startMarker`, por llaves. */
function functionBodyAfter(source: string, startMarker: string): string {
  const at = source.indexOf(startMarker);
  if (at < 0) throw new Error(`no se encontró "${startMarker}" en el archivo`);
  const braceStart = source.indexOf('{', at);
  if (braceStart < 0) throw new Error(`"${startMarker}" no abre con { detrás`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`la función que abre en "${startMarker}" nunca cierra`);
}

describe('collectSessionSamples está enganchado en el código real', () => {
  it('ChannelRack.tsx importa collectSessionSamples de sound-actions', () => {
    const file = readSource('editors/rack/ChannelRack.tsx');
    expect(file).toMatch(/collectSessionSamples/);
    expect(file).toMatch(/from ['"]\.\.\/\.\.\/browser\/sound-actions['"]/);
  });

  it('deleteChannel() llama a collectSessionSamples() tras el dispatch de removeChannel', () => {
    const file = readSource('editors/rack/ChannelRack.tsx');
    const body = functionBodyAfter(file, 'const deleteChannel = (channelId: Id) => {');
    expect(body).toContain("store.dispatch({ type: 'removeChannel'");
    expect(body).toContain('collectSessionSamples()');
    // En ese orden: primero se borra, luego se recolecta sobre el proyecto YA
    // sin el canal — al revés, contaría el sample como todavía en uso.
    expect(body.indexOf("type: 'removeChannel'")).toBeLessThan(
      body.indexOf('collectSessionSamples()'),
    );
  });

  it('useShortcuts.ts llama a collectSessionSamples() tras undo() y tras redo()', () => {
    const file = readSource('hooks/useShortcuts.ts');
    expect(file).toMatch(/collectSessionSamples/);

    const undoAt = file.indexOf('store.undo()');
    const redoAt = file.indexOf('store.redo()');
    expect(undoAt).toBeGreaterThanOrEqual(0);
    expect(redoAt).toBeGreaterThanOrEqual(0);

    const afterUndo = file.slice(undoAt, redoAt);
    expect(afterUndo).toContain('collectSessionSamples()');

    const afterRedo = file.slice(redoAt, redoAt + 400);
    expect(afterRedo).toContain('collectSessionSamples()');
  });
});
