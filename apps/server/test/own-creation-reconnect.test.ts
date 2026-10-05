/**
 * BUG 011 — la autoría se ataba al SOCKET, así que un corte de red dejaba al autor sin
 * poder deshacer su propio trabajo.
 *
 * El servidor recuerda qué entidad creó cada conexión para juzgar si un borrado con
 * `own:true` es legítimo (013 cerró que no se crea ese campo, y la verdad la lleva el
 * servidor). La guardaba con el `connKey`, que es efímero: al cerrar el socket y abrir
 * otro con la misma invitación, el autor era otro para el servidor y le rechazaba su
 * propio borrado («como invitado no puedes borrar pistas ni patrones»), mientras el
 * índice se quedaba con las entradas del socket cerrado para siempre (medido: el log
 * conservaba solo el `addChannel` y el borrado se denegaba).
 *
 * Aquí la autoría se ata a la INVITACIÓN, que es una credencial verificada por
 * `consumeInvite`: quien la presenta es el mismo autor. Y el índice se poda de las
 * entidades que ya no existen, para que no crezca sin límite.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  MESSAGE_CONTROL,
  encodeControl,
  makeRoomAuth,
  parseControl,
  type ControlMessage,
} from '@orbit/collab';

import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'J7M2QD';
const SYNC = 0;
const AWARENESS = 1;

let handle: ServerHandle | null = null;
let dir: string | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  if (handle) await handle.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Peer {
  readonly doc = new Y.Doc();
  readonly ws: WebSocket;
  private readonly awareness: awarenessProtocol.Awareness;
  readonly denegados: string[] = [];
  readonly controles: ControlMessage[] = [];
  /** El último mensaje de control recibido (para pedir invitaciones). */
  control: ControlMessage | null = null;
  /**
   * El `seq` de cada entrada, como el binding real: numerar SIEMPRE es lo que hace
   * que las claves sean únicas (BUG 015). Con un `seq` fijo, dos entradas del mismo
   * cliente eran la misma clave y el servidor se negaba a aplicar la segunda.
   */
  private seq = 0;

  constructor(port: number, readonly name: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${ROOM}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('error', () => undefined);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    });
    sockets.push(this.ws);
  }

  async open(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.ws.once('open', () => resolve());
        this.ws.once('error', reject);
      });
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
    this.awareness.setLocalStateField('user', { name: this.name, color: '#fff' });
    const aEncoder = encoding.createEncoder();
    encoding.writeVarUint(aEncoder, AWARENESS);
    encoding.writeVarUint8Array(
      aEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(aEncoder));
    await sleep(250);
  }

  enviarControl(msg: ControlMessage): void {
    this.send(encodeControl(msg));
  }

  /** Una entrada al log, escrita a pelo (como haría un cliente). */
  meterCrudo(cmd: unknown): void {
    this.doc.transact(() => {
      this.doc.getArray<unknown>('commands').push([{ id: `e${Math.random().toString(36).slice(2)}`, client: this.doc.clientID, seq: this.seq++, role: 'invitado', own: true, cmd }]);
    });
  }

  get log(): { cmd: Record<string, unknown> }[] {
    return this.doc.getArray<{ cmd: Record<string, unknown> }>('commands').toArray();
  }

  cerrar(): void {
    this.ws.close();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private send(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
    } else if (type === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    } else if (type === MESSAGE_CONTROL) {
      const control = parseControl(decoding.readVarString(decoder));
      if (control === null) return;
      this.control = control;
      this.controles.push(control);
      if (control.type === 'denied' && control.reason !== undefined) {
        this.denegados.push(control.reason);
      }
    }
  }
}

/** El token de la invitación creada, buscado entre los controles recibidos. */
function tokenDe(peer: Peer): string | undefined {
  for (let i = peer.controles.length - 1; i >= 0; i--) {
    const c = peer.controles[i]!;
    if (c.type === 'inviteCreated') return c.token;
  }
  return undefined;
}

async function serve(): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-011-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

function patron(id: string, nombre: string): Record<string, unknown> {
  return { id, name: nombre, color: '#5aa9e6', length: 4, notes: {} };
}

function pista(id: string, order: number): Record<string, unknown> {
  return {
    id,
    arrangementId: 'ar1',
    name: id,
    color: '#fff',
    height: 56,
    muted: false,
    order,
  };
}

describe('011 · la autoría sobrevive al corte de red del autor', () => {
  it('el invitado que vuelve con su invitación deshace lo suyo y no lo ajeno', async () => {
    const server = await serve();

    // 1. El productor pide una invitación de un uso (dos usos: entra y puede volver).
    const host = new Peer(server.port, 'host');
    await host.open();
    await sleep(150);
    host.enviarControl({ type: 'setPassword', auth: await makeRoomAuth('secreto') });
    await sleep(250);
    host.enviarControl({ type: 'createInvite', ttlMs: 600000, uses: 2 });
    await sleep(350);
    const token = tokenDe(host);
    expect(token).toBeDefined();

    // 2. Entra el invitado y publica una pista (suya).
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    invitado.enviarControl({ type: 'joinInvite', token: token! });
    await sleep(350);
    invitado.meterCrudo({ type: 'addPlaylistTrack', track: { id: 't-inv', arrangementId: 'ar1', name: 'Mía', color: '#fff', height: 56, muted: false, order: 0 } });
    await sleep(350);
    expect(invitado.log.some((e) => e.cmd.type === 'addPlaylistTrack')).toBe(true);

    // 3. Se corta la red del invitado y vuelve CON LA MISMA INVITACIÓN.
    invitado.cerrar();
    await sleep(250);
    const vuelve = new Peer(server.port, 'invitado-2');
    await vuelve.open();
    vuelve.enviarControl({ type: 'joinInvite', token: token! });
    await sleep(400);

    // 4. Intenta borrar SU pista. Antes esto se denegaba ('como invitado no puedes
    //    borrar pistas ni patrones') porque la autoría era del socket cerrado.
    vuelve.meterCrudo({ type: 'removePlaylistTrack', trackId: 't-inv', own: true });
    await sleep(400);

    // Sigue en el log y no hay ningún `denied`: es suyo y el servidor lo reconoce.
    expect(vuelve.log.some((e) => e.cmd.type === 'removePlaylistTrack')).toBe(true);
    expect(vuelve.denegados).toEqual([]);
  });

  it('pero el borrado de lo de OTRO sigue denegado para el que volvió', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    await sleep(150);
    host.enviarControl({ type: 'setPassword', auth: await makeRoomAuth('secreto') });
    await sleep(250);
    host.enviarControl({ type: 'createInvite', ttlMs: 600000, uses: 2 });
    await sleep(350);
    const token = tokenDe(host);
    expect(token).toBeDefined();

    // El invitado crea su pista.
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    invitado.enviarControl({ type: 'joinInvite', token: token! });
    await sleep(350);
    invitado.meterCrudo({ type: 'addPlaylistTrack', track: { id: 't-inv', arrangementId: 'ar1', name: 'Mía', color: '#fff', height: 56, muted: false, order: 0 } });
    await sleep(300);

    // El PRODUCTOR crea otra pista (suya) y borra la del invitado: puede, es productor.
    host.meterCrudo({ type: 'addPlaylistTrack', track: { id: 't-host', arrangementId: 'ar1', name: 'Del host', color: '#fff', height: 56, muted: false, order: 1 } });
    await sleep(300);

    // El invitado vuelve y tries borrar la DEL HOST: no es suya.
    invitado.cerrar();
    await sleep(250);
    const vuelve = new Peer(server.port, 'invitado-2');
    await vuelve.open();
    vuelve.enviarControl({ type: 'joinInvite', token: token! });
    await sleep(400);
    vuelve.meterCrudo({ type: 'removePlaylistTrack', trackId: 't-host', own: true });
    await sleep(400);

    expect(vuelve.log.some((e) => e.cmd.type === 'removePlaylistTrack')).toBe(false);
    expect(vuelve.denegados.join(' ')).toMatch(/invitado|borrar|productor/);
  });

  it('borrar una entidad suelta su autoría del índice (S10, la parte que faltaba)', async () => {
    // Esta es la parte de S10 que quedaba abierta, y el test que la cubría NO LA
    // CUBRÍA: afirmaba sobre `meta.get('project')`, una clave que nadie escribe (el
    // proyecto va en `meta.snapshot`), así que leía `undefined`,
    // `String(undefined ?? '')` daba `''` y `expect('').not.toContain('"c1"')`
    // pasaba por vacuidad. Medido con una sonda sobre `Map.prototype.delete`: la
    // poda no borraba NUNCA.
    //
    // No se afirma sobre el TAMAÑO del índice —es privado de `Room`, y `ServerHandle`
    // no expone las salas, así que no hay forma limpia de mirarlo sin abrir la
    // clase—. Se afirma sobre el `delete`, que es la operación cuya ausencia era el
    // bug: una vez concededora, el índice suelta la entidad que ya no existe.
    //
    // Y una nota sobre la prueba que NO es esta, porque es la que se escribió primero
    // y es capaz de pasar sin el arreglo: «el invitado borra `p1`, el productor
    // recrea `p1`, el invitado lo vuelve a borrar con `own` y se deniega» FUNCIONA
    // sin la poda, porque al recrearlo, el alta del PRODUCTOR SOBREESCRIBE la
    // autoría de `p1` en el índice. La basura de la autoría vieja no se nota por ahí.
    // Lo que la distingue de verdad es el crecimiento, y eso se mide como se puede:
    // contando los `delete`.
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    await sleep(150);
    host.enviarControl({ type: 'setPassword', auth: await makeRoomAuth('secreto') });
    await sleep(250);
    host.enviarControl({ type: 'createInvite', ttlMs: 600000, uses: 2 });
    await sleep(350);
    const token = tokenDe(host);
    expect(token).toBeDefined();

    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    invitado.enviarControl({ type: 'joinInvite', token: token! });
    await sleep(350);

    // Se espía `Map.prototype.delete` porque es lo único que empuja la puerta desde
    // fuera: `Room.ownCreations` es un `Map` y no hay getter. Se filtra por la clave
    // para no contar los `delete` que hace Yjs por su cuenta.
    const borradas: unknown[] = [];
    const real = Map.prototype.delete;
    Map.prototype.delete = function espia(this: Map<unknown, unknown>, key: unknown): boolean {
      borradas.push(key);
      return real.call(this, key);
    };

    try {
      // El invitado crea una pista y la borra enseguida (puede: es suya).
      invitado.meterCrudo({ type: 'addPlaylistTrack', track: pista('t-efimera', 0) });
      await sleep(350);
      invitado.meterCrudo({ type: 'removePlaylistTrack', trackId: 't-efimera', own: true });
      await sleep(450);

      // El borrado entró (era suyo de verdad)...
      expect(host.log.some((e) => e.cmd.type === 'removePlaylistTrack')).toBe(true);
      expect(invitado.denegados).toEqual([]);
      // ...y al concederlo el índice soltó la entidad, que ya no existe.
      expect(borradas).toContain('t-efimera');
    } finally {
      Map.prototype.delete = real;
    }
  });

  it('el mismo id quitado y repuesto en un lote conserva la autoría del que lo repuso', async () => {
    // El orden de la poda: primero lo que borra, después lo que crea. Si fuera al
    // revés, un lote que quita y vuelve a poner el mismo id se quedaría SIN autoría
    // de una entidad que existe, y su autor no podría deshacerla — que es el bug
    // que `87975f7` vino a cerrar, reintroducido por el otro lado.
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    await sleep(150);
    host.enviarControl({ type: 'setPassword', auth: await makeRoomAuth('secreto') });
    await sleep(250);
    host.enviarControl({ type: 'createInvite', ttlMs: 600000, uses: 2 });
    await sleep(350);
    const token = tokenDe(host);
    expect(token).toBeDefined();

    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    invitado.enviarControl({ type: 'joinInvite', token: token! });
    await sleep(350);

    // El invitado se quita y se repone su propia pista en un solo lote.
    invitado.meterCrudo({ type: 'addPlaylistTrack', track: pista('t1', 0) });
    await sleep(350);
    invitado.meterCrudo({
      type: 'batch',
      label: 'reponer',
      commands: [
        { type: 'removePlaylistTrack', trackId: 't1', own: true },
        { type: 'addPlaylistTrack', track: pista('t1', 0) },
      ],
    });
    await sleep(450);
    expect(invitado.denegados).toEqual([]);

    // Y la pista sigue siendo suya: puede deshacerla.
    invitado.meterCrudo({ type: 'removePlaylistTrack', trackId: 't1', own: true });
    await sleep(450);
    expect(host.log.filter((e) => e.cmd.type === 'removePlaylistTrack').length).toBe(1);
    expect(invitado.denegados).toEqual([]);
  });
});
