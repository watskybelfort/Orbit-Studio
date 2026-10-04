/**
 * BUG 012 — un clientID que se libera al irse su dueño queda reclamable por cualquiera.
 *
 * Cuando alguien se va, sus clientIDs quedan libres, y el primero que los anunciara se
 * los quedaba. Así que un recién llegado podía reclamar el clientID del que acababa de
 * caerse y todos veían SU nombre y SU rol bajo el ID del otro (medido en la tarjeta: el
 * host recibía `user: {name: 'Impostor'}, role: 'productor'` bajo el ID del usuario
 * caído). Suplantación visual y de referencias de seguimiento; el rol autoritativo
 * seguía siendo el de la conexión, así que esto no escalaba permisos.
 *
 * La corrección ata el ID liberado a la credencial que lo tenía (la invitación con la
 * que se pasó la puerta), que es lo que pedía la tarjeta: solo esa credencial puede
 * recuperarlo. Así el que reconecta con su invitación —y su mismo doc— conserva su
 * presencia, y otro con OTRA invitación no puede quedarse con ella.
 *
 * LIMITACIÓN CONOCIDA: en una sala sin contraseña todos los sockets entran sin
 * credencial, y para el servidor son la misma cosa; ahí la separación por identidad no
 * existe y el primero que llega se lo queda. Es el mismo límite que tiene la autoría
 * de 011 con una invitación multiuso. Afirmar que no lo hay sería falso.
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

const ROOM = 'P4X8TN';
const SYNC = 0;
const AWARENESS = 1;

let handle: ServerHandle | null = null;
let dir: string | null = null;
const peers: Peer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
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
  private readonly ws: WebSocket;
  private readonly awareness: awarenessProtocol.Awareness;
  readonly controles: ControlMessage[] = [];

  constructor(
    port: number,
    readonly name: string,
    clientId?: number,
  ) {
    // Con `clientId` se finge el mismo doc de otra sesión (Yjs no lo persiste, pero un
    // cliente que lo guardara reconectaría con el mismo clientID).
    if (clientId !== undefined) this.doc.clientID = clientId;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${ROOM}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('error', () => undefined);
    peers.push(this);
  }

  get clientID(): number {
    return this.doc.clientID;
  }

  /** Abre el socket y arranca el sync. La presencia se anuncia aparte, y después. */
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
  }

  /** Pasa la puerta con una invitación: es lo que ata su credencial a este socket. */
  async entrarCon(token: string): Promise<void> {
    this.send(encodeControl({ type: 'joinInvite', token }));
    await sleep(250);
  }

  control(msg: ControlMessage): void {
    this.send(encodeControl(msg));
  }

  /** Anuncia presencia con un clientID y un reloj, como el cliente real. */
  anunciarse(clientID = this.doc.clientID, clock = 1, nombre = this.name): void {
    this.awareness.setLocalState({ user: { name: nombre, color: '#fff' } });
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    // Con otro clientID o con reloj forzado el update va reescrito a pelo: es lo que
    // hace un cliente modificado para quitarse de sí (la librería no lo permite).
    const cuerpo =
      clock === 1 && clientID === this.doc.clientID
        ? update
        : awarenessConClientId(update, clientID, clock);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, AWARENESS);
    encoding.writeVarUint8Array(encoder, cuerpo);
    this.send(encoding.toUint8Array(encoder));
  }

  /** Un 'remove' de presencia a pelo, para quien no es el dueño. */
  sendRetirar(id: number): void {
    const cuerpo = encoding.createEncoder();
    encoding.writeVarUint(cuerpo, 1); // el update de awareness lleva la CUENTA de clientes
    encoding.writeVarUint(cuerpo, id);
    // Una retirada es un estado `null` con reloj ALTO: con reloj 0, y-protocols lo
    // toma por un anuncio viejo y lo ignora, así que ni siquiera se intentaría nada.
    encoding.writeVarUint(cuerpo, 1000);
    encoding.writeVarString(cuerpo, JSON.stringify(null));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, AWARENESS);
    encoding.writeVarUint8Array(encoder, encoding.toUint8Array(cuerpo));
    this.send(encoding.toUint8Array(encoder));
  }

  /** Lo que ve de la sala: id → nombre. */
  get presencia(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [id, state] of this.awareness.getStates()) {
      const user = (state as { user?: { name?: unknown } }).user;
      out.set(id, typeof user?.name === 'string' ? user.name : '?');
    }
    return out;
  }

  close(): void {
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
      if (control !== null) this.controles.push(control);
    }
  }
}

/**
 * El mismo update de awareness pero anunciando OTRO clientID: se reescribe la entrada,
 * que es `{clientID, clock, state}` dentro de una lista con la CUENTA de clientes
 * delante. Los tres campos se leen en ese orden —si se lee el primero como si fuera el
 * reloj, la cadena JSON sale desalineada y el servidor descarta el mensaje entero—,
 * que es lo que pasaba antes de corregirlo: el test pasaba sin comprobar nada.
 */
function awarenessConClientId(update: Uint8Array, clientID: number, clock: number): Uint8Array {
  const decoder = decoding.createDecoder(update);
  const cuentas = decoding.readVarUint(decoder);
  if (cuentas !== 1) throw new Error('este helper solo reescribe updates de un cliente');
  decoding.readVarUint(decoder); // el clientID original, que es justo lo que se cambia
  const originalClock = decoding.readVarUint(decoder);
  const json = decoding.readVarString(decoder);
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, clientID);
  encoding.writeVarUint(inner, clock > originalClock ? clock : originalClock + 1);
  encoding.writeVarString(inner, json);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeUint8Array(encoder, encoding.toUint8Array(inner));
  return encoding.toUint8Array(encoder);
}

/** El token de la última invitación creada por este peer. */
function tokenDe(peer: Peer): string | undefined {
  for (let i = peer.controles.length - 1; i >= 0; i--) {
    const c = peer.controles[i]!;
    if (c.type === 'inviteCreated') return c.token;
  }
  return undefined;
}

async function serve(): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-012-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

/**
 * Abre la sala con contraseña y saca dos invitaciones: la del invitado que se va (con
 * dos usos, para que pueda volver) y la de un tercero. Sin credenciales distintas no se
 * puede hablar de identidades: dos sockets anónimos son la misma cosa para el servidor.
 */
async function salaConInvitaciones(
  server: ServerHandle,
): Promise<{ host: Peer; tokenInvitado: string; tokenTercero: string }> {
  const host = new Peer(server.port, 'host');
  await host.open();
  host.control({ type: 'setPassword', auth: await makeRoomAuth('secreto') });
  await sleep(250);
  host.control({ type: 'createInvite', ttlMs: 600000, uses: 2 });
  await sleep(300);
  const tokenInvitado = tokenDe(host);
  host.control({ type: 'createInvite', ttlMs: 600000, uses: 1 });
  await sleep(300);
  const tokenTercero = tokenDe(host);
  if (tokenInvitado === undefined || tokenTercero === undefined) {
    throw new Error('la sala no devolvió las invitaciones');
  }
  return { host, tokenInvitado, tokenTercero };
}

describe('012 · un clientID liberado no se puede reclamar de otro', () => {
  it('el que llega con OTRA invitación no aparece bajo el ID del caído', async () => {
    const server = await serve();
    const { host, tokenInvitado, tokenTercero } = await salaConInvitaciones(server);

    // El invitado pasa la puerta, anuncia su presencia y se cae.
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    await invitado.entrarCon(tokenInvitado);
    invitado.anunciarse();
    const idCaido = invitado.clientID;
    await sleep(250);
    expect(host.presencia.get(idCaido)).toBe('invitado');

    invitado.close();
    await sleep(300);

    // Otro, con SU propia invitación, intenta quedarse con ese ID.
    const impostor = new Peer(server.port, 'Impostor');
    await impostor.open();
    await impostor.entrarCon(tokenTercero);
    impostor.anunciarse();
    impostor.anunciarse(idCaido, 100, 'Impostor');
    await sleep(400);

    // El host NO ve «Impostor» bajo el ID del caído: ese ID ya no es suyo.
    expect(host.presencia.get(idCaido)).not.toBe('Impostor');
    // Y el impostor sigue viéndose solo con SU propio ID, que es lo correcto.
    expect(host.presencia.get(impostor.clientID)).toBe('Impostor');
  });

  it('pero el que vuelve con SU invitación recupera su clientID', async () => {
    const server = await serve();
    const { host, tokenInvitado } = await salaConInvitaciones(server);

    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    await invitado.entrarCon(tokenInvitado);
    invitado.anunciarse();
    const idViejo = invitado.clientID;
    await sleep(250);
    invitado.close();
    await sleep(300);

    // Vuelve con la MISMA invitación y el MISMO doc (el clienteID no persistió).
    const vuelve = new Peer(server.port, 'invitado', idViejo);
    await vuelve.open();
    await vuelve.entrarCon(tokenInvitado);
    vuelve.anunciarse(idViejo, 100, 'invitado');
    await sleep(400);

    expect(vuelve.clientID).toBe(idViejo);
    expect(host.presencia.get(idViejo)).toBe('invitado');
  });

  it('un clientID nuevo lo puede reclamar quien quiera (no se tapa de más)', async () => {
    const server = await serve();
    const { host, tokenTercero } = await salaConInvitaciones(server);

    const tercero = new Peer(server.port, 'tercero');
    await tercero.open();
    await tercero.entrarCon(tokenTercero);
    tercero.anunciarse();
    await sleep(300);

    // Nadie lo había soltado: es un ID libre de verdad y se concede sin problema.
    expect(host.presencia.get(tercero.clientID)).toBe('tercero');
  });

  it('el dueño de verdad sí puede seguir moviendo su propia presencia', async () => {
    const server = await serve();
    const { host, tokenInvitado } = await salaConInvitaciones(server);

    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    await invitado.entrarCon(tokenInvitado);
    invitado.anunciarse();
    const id = invitado.clientID;
    await sleep(250);

    // Cambia su nombre sin cambiar de ID: entra (el ID es suyo).
    invitado.anunciarse(id, 5, 'invitado-2');
    await sleep(300);
    expect(host.presencia.get(id)).toBe('invitado-2');
  });

  it('retirar la presencia de otro tampoco cuela', async () => {
    const server = await serve();
    const { host, tokenInvitado, tokenTercero } = await salaConInvitaciones(server);

    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();
    await invitado.entrarCon(tokenInvitado);
    invitado.anunciarse();
    const id = invitado.clientID;
    await sleep(250);

    const impostor = new Peer(server.port, 'Impostor');
    await impostor.open();
    await impostor.entrarCon(tokenTercero);
    impostor.anunciarse();
    impostor.sendRetirar(id);
    await sleep(350);

    // Sigue ahí: solo el dueño puede retirar su presencia.
    expect(host.presencia.get(id)).toBe('invitado');
  });
});