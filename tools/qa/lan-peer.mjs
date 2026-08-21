/**
 * Vecino falso para probar el descubrimiento sin abrir dos Orbits.
 *
 * Manda las mismas balizas que la app por UDP —en unicast a 127.0.0.1, que es
 * lo que llega estando en la misma máquina: el socket de la app apaga el
 * loopback del multicast a propósito, para no verse a sí misma— y, si se le
 * pide, una invitación.
 *
 *   node tools/qa/lan-peer.mjs "Ana" 20            # se anuncia 20 s
 *   node tools/qa/lan-peer.mjs "Ana" 20 K3P9QF     # además invita a esa sala
 */

import { createSocket } from 'node:dgram';

const PORT = 47900;
const HOST = '127.0.0.1';
const VERSION = 1;

const name = process.argv[2] ?? 'Vecino de prueba';
const seconds = Number(process.argv[3] ?? 15);
const room = process.argv[4];
const id = `qa${Math.random().toString(36).slice(2, 10)}`;

const sock = createSocket({ type: 'udp4', reuseAddr: true });

function send(msg) {
  const payload = Buffer.from(JSON.stringify({ v: VERSION, ...msg }));
  sock.send(payload, PORT, HOST, (err) => {
    if (err) console.error('[lan-peer] no se pudo enviar:', err.message);
  });
}

console.log(`[lan-peer] "${name}" (${id}) anunciándose ${seconds}s en ${HOST}:${PORT}`);
send({ kind: 'hello', id, name });
const beacon = setInterval(() => send({ kind: 'hello', id, name }), 2000);

if (room) {
  setTimeout(() => {
    console.log(`[lan-peer] invitando a la sala ${room}`);
    send({ kind: 'invite', id, name, room, url: `ws://${HOST}:7900` });
  }, 3000);
}

setTimeout(() => {
  clearInterval(beacon);
  sock.close();
  console.log('[lan-peer] fin');
}, seconds * 1000);
