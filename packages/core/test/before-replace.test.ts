/**
 * `subscribeBeforeReplace`: el aviso de «el proyecto va a ser sustituido».
 *
 * Existe para quien tiene que decidir sobre el mundo que SE VA —el barrido de
 * archivos de grabación de la UI—, y estas son las tres propiedades de las que
 * depende esa decisión:
 *
 *  1. El listener ve el proyecto y el historial VIEJOS (aún no se ha mutado).
 *  2. Corre una vez por sustitución, y solo por sustitución (no por dispatch).
 *  3. Un listener que revienta no cancela la sustitución.
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore, applyCommand, createChannel, createEmptyProject } from '../src';

function projectWithSample(): { project: ReturnType<typeof createEmptyProject>; id: string } {
  const project = createEmptyProject('Viejo');
  const channel = createChannel('sampler', 0, 'Uno');
  applyCommand(project, { type: 'addChannel', channel });
  applyCommand(project, {
    type: 'registerSample',
    sample: { id: 's1', name: 's1', path: 'recording:a.wav', hash: 's1', duration: 1 },
  });
  return { project, id: channel.id };
}

describe('subscribeBeforeReplace', () => {
  it('el listener ve el proyecto y el historial de ANTES de la sustitución', () => {
    const store = new ProjectStore();
    const { project } = projectWithSample();
    store.replaceProject(project);
    store.dispatch({ type: 'setTempo', tempo: 140 });

    let visto: string[] = [];
    let epochVisto = -1;
    const epochAntes = store.historyEpoch;
    store.subscribeBeforeReplace(() => {
      // El proyecto viejo sigue en pie, con su sample…
      visto = Object.keys(store.project.samples);
      // …y su historial también: el epoch todavía no se ha incrementado.
      epochVisto = store.historyEpoch;
    });

    store.replaceProject(createEmptyProject('Nuevo'));

    expect(visto).toEqual(['s1']);
    expect(epochVisto).toBe(epochAntes);
    expect(store.historyEpoch).toBe(epochAntes + 1);
  });

  it('corre una vez por sustitución, y no por dispatch', () => {
    const store = new ProjectStore();
    let avisos = 0;
    store.subscribeBeforeReplace(() => avisos++);

    store.dispatch({ type: 'setTempo', tempo: 120 });
    expect(avisos).toBe(0);

    store.replaceProject(createEmptyProject('A'));
    store.replaceProject(createEmptyProject('B'));
    expect(avisos).toBe(2);
  });

  it('un listener que revienta no cancela la sustitución ni corta a los demás', () => {
    const store = new ProjectStore();
    let trasElRoto = 0;
    store.subscribeBeforeReplace(() => {
      throw new Error('este listener está roto');
    });
    store.subscribeBeforeReplace(() => trasElRoto++);

    store.replaceProject(createEmptyProject('Nuevo'));

    expect(Object.keys(store.project.channels)).toHaveLength(0);
    expect(trasElRoto).toBe(1);
  });

  it('la baja deja de avisar', () => {
    const store = new ProjectStore();
    let avisos = 0;
    const baja = store.subscribeBeforeReplace(() => avisos++);
    store.replaceProject(createEmptyProject('A'));
    baja();
    store.replaceProject(createEmptyProject('B'));
    expect(avisos).toBe(1);
  });
});
