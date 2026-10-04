/**
 * BUG 015 — una clave de idempotencia repetida dividía la sala en dos proyectos.
 *
 * La clave de una entrada del log es `client:seq`, y la escriben dos enteros del
 * cliente. Con una clave repetida, `process()` (la pasada de los que ya estaban)
 * aplicaba la primera entrada y se saltaba la segunda, pero `join()` (la de quien
 * entraba tarde) se las aplicaba las dos: el mismo registro acababa en un cliente a
 * 150 y en otro a 160 (medido en la tarjeta con `setTempo`), y guardar o exportar
 * dependía de quién estuviera en la sala.
 *
 * Aquí las tres pasadas del log —unirse, re-derivar y procesar— aplican la misma
 * regla: la PRIMERA aparición de una clave gana. Con eso, da igual cuándo se entre.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyCommand,
  createEmptyProject,
  parseProject,
  ProjectStore,
  serializeProject,
  type Command,
  type Project,
} from '@orbit/core';
import { CommandLogBinding, applyLogAlProyecto, type LogEntry } from '../src/command-log';

function cloneProject(p: Project): Project {
  return parseProject(serializeProject(p));
}

interface Link {
  hold(): void;
  release(): void;
}

/** Enlaza dos docs por update, como el relé de un servidor. */
function linkDocs(docA: Y.Doc, docB: Y.Doc): Link {
  const origin = { link: true };
  let holding = false;
  const aToB: Uint8Array[] = [];
  const bToA: Uint8Array[] = [];
  docA.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) aToB.push(u);
    else Y.applyUpdate(docB, u, origin);
  });
  docB.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) bToA.push(u);
    else Y.applyUpdate(docA, u, origin);
  });
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const u of aToB.splice(0)) Y.applyUpdate(docB, u, origin);
      for (const u of bToA.splice(0)) Y.applyUpdate(docA, u, origin);
    },
  };
}

/** Una entrada del log escrita A PELO, con la clave que se le quiera dar. */
function meterCrudo(doc: Y.Doc, entry: LogEntry): void {
  doc.getArray<LogEntry>('commands').push([entry]);
}

function entrada(client: number, seq: number, cmd: Command, user = 'ana'): LogEntry {
  return { cmd, origin: 'test', user, client, seq, role: 'productor' };
}

describe('015 · una clave repetida no divide la sala', () => {
  it('quien entra tarde acaba igual que quien ya estaba', () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' });
    bindA.start(); // publica el snapshot base

    // Ana mete dos entradas con la MISMA clave: la segunda es la impostura.
    meterCrudo(docA, entrada(11, 0, { type: 'setTempo', tempo: 150 }));
    meterCrudo(docA, entrada(11, 0, { type: 'setTempo', tempo: 160 }));
    expect(storeA.project.tempo).toBe(150);

    // Entra Beto con el estado ya hecho (lo que hace el sync al entrar).
    const storeB = new ProjectStore();
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' });
    bindB.start();

    // Gana la primera, que es lo que aplica el que ya estaba.
    expect(storeB.project.tempo).toBe(150);
    expect(serializeProject(storeB.project)).toBe(serializeProject(storeA.project));
    bindA.destroy();
    bindB.destroy();
  });

  it('y también cuando hay que re-derivar por un cruce de ediciones', () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    const storeB = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const link = linkDocs(docA, docB);
    const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' });
    const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' });
    bindA.start();
    bindB.start();

    // Ana escribe las dos de la clave repetida sin que le lleguen todavía a Beto.
    link.hold();
    meterCrudo(docA, entrada(11, 0, { type: 'setTempo', tempo: 150 }));
    meterCrudo(docA, entrada(11, 0, { type: 'setTempo', tempo: 160 }));
    // Beto, mientras, mete lo suyo: al soltarse, en el doc de Beto lo de Ana queda
    // DETRÁS de lo suyo, que es lo que obliga a re-derivar (replay).
    meterCrudo(docB, entrada(22, 0, { type: 'setSwing', swing: 0.3 }));
    link.release();

    expect(storeB.project.swing).toBe(0.3);
    expect(storeA.project.tempo).toBe(150);
    // La re-derivación también se salta la repetida: mismo resultado en los dos.
    expect(storeB.project.tempo).toBe(150);
    expect(serializeProject(storeB.project)).toBe(serializeProject(storeA.project));
    bindA.destroy();
    bindB.destroy();
  });

  it('tras compactar, el que entra sigue viendo lo mismo', () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    // Umbral 1: en cuanto hay una entrada, el host compacta (snapshot + log vacío).
    const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }, {
      compactThreshold: 1,
    });
    bindA.start();
    meterCrudo(docA, entrada(11, 0, { type: 'setTempo', tempo: 150 }));
    meterCrudo(docA, entrada(11, 0, { type: 'setTempo', tempo: 160 }));
    expect(docA.getArray('commands').length).toBe(0); // el snapshot se lo tragó todo
    expect(storeA.project.tempo).toBe(150);

    const storeB = new ProjectStore();
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' });
    bindB.start();

    expect(storeB.project.tempo).toBe(150);
    expect(serializeProject(storeB.project)).toBe(serializeProject(storeA.project));
    bindA.destroy();
    bindB.destroy();
  });

  it('si las dos repetidas llegan en un mismo envío, tampoco se aplican las dos', async () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    const storeB = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' });
    const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' });
    bindA.start();
    bindB.start();

    // Las dos entradas en UNA transacción: llegan a Beto en un solo update, y la
    // pasada que las juzga tiene que aplicar la misma regla que al entrar tarde.
    docA.transact(() => {
      docA.getArray<LogEntry>('commands').push([
        entrada(11, 0, { type: 'setTempo', tempo: 150 }),
        entrada(11, 0, { type: 'setTempo', tempo: 160 }),
      ]);
    });

    expect(storeA.project.tempo).toBe(150);
    expect(storeB.project.tempo).toBe(150);
    expect(serializeProject(storeB.project)).toBe(serializeProject(storeA.project));
    bindA.destroy();
    bindB.destroy();
  });

  it('la regla compartida: la primera clave gana y solo se registra una vez', () => {
    // Se prueba directamente porque `join` y `replay` la comparten: el caso de la
    // re-derivación por un cruce no se puede montar solo con dos docs enlazados (el
    // orden de Yjs no depende del momento de insertar), y esta función ES la regla.
    const proyecto = createEmptyProject('Directo');
    const aplicadas: Command[] = [];
    const claves = applyLogAlProyecto(
      proyecto,
      [
        entrada(11, 0, { type: 'setTempo', tempo: 150 }),
        entrada(22, 0, { type: 'setSwing', swing: 0.2 }),
        entrada(11, 0, { type: 'setTempo', tempo: 160 }),
        entrada(22, 1, { type: 'setTempo', tempo: 170 }),
        entrada(11, 0, { type: 'setTempo', tempo: 180 }),
      ],
      () => true,
      (p, cmd) => {
        aplicadas.push(cmd);
        applyCommand(p, cmd);
      },
    );
    // Tres entradas repetidas (11:0) se quedan en la primera; las de Beto, todas.
    expect(aplicadas).toEqual([
      { type: 'setTempo', tempo: 150 },
      { type: 'setSwing', swing: 0.2 },
      { type: 'setTempo', tempo: 170 },
    ]);
    expect([...claves].sort()).toEqual(['11:0', '22:0', '22:1']);
    expect(proyecto.tempo).toBe(170);
  });

  it('las claves de verdad (cada cliente con su seq) no se tozan', () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    const storeB = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' });
    const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' });
    bindA.start();
    bindB.start();

    // Mismo `seq`, distinto `client`: son entradas DISTINTAS y ambas cuentan.
    storeA.dispatch({ type: 'setTempo', tempo: 150 });
    storeB.dispatch({ type: 'setTempo', tempo: 160 });
    expect(storeA.project.tempo).toBe(160);
    expect(storeB.project.tempo).toBe(160);
    expect(serializeProject(storeB.project)).toBe(serializeProject(storeA.project));
    bindA.destroy();
    bindB.destroy();
  });
});