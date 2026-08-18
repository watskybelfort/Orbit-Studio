/**
 * QA de presencia: un colaborador headless real que entra a una sala, publica
 * su cursor en la Playlist y la bandera de Claude, y va imprimiendo la
 * actividad que recibe de los demás. Para verificar los dos sentidos contra
 * la app viva.
 * Uso: npx tsx tools/qa/presence-peer.ts <CODIGO-SALA> [segundos] [nombre]
 *
 * El nombre importa: el color sale de él, así que dos peers con el mismo
 * nombre son justo el caso que tiene que resolver pickDistinctColor.
 */

import { ProjectStore } from '@orbit/core';
import { CollabSession, colorForName, pickDistinctColor } from '@orbit/collab';

const code = process.argv[2];
const seconds = Number(process.argv[3] ?? '60');
const name = process.argv[4] ?? 'Remoto QA';
if (!code) {
  console.error('Falta el código de sala');
  process.exit(1);
}

const store = new ProjectStore();
const session = new CollabSession(store, { user: { name, color: colorForName(name) } });

session.onPeersChanged((peers) => {
  // Un cliente de verdad se aparta si comparte color con alguien de clientId
  // más bajo (la misma regla que aplica la app), así que el peer de QA la hace
  // también: si no, dos "Productor" saldrían del mismo color y no se estaría
  // probando nada.
  const self = peers.find((p) => p.isSelf);
  if (self) {
    const next = pickDistinctColor(
      { clientId: self.clientId, color: self.user.color },
      peers.filter((p) => !p.isSelf).map((p) => ({ clientId: p.clientId, color: p.user.color })),
    );
    if (next !== self.user.color) {
      session.setUserColor(next);
      console.log(`color propio -> ${next}`);
    }
  }
  for (const p of peers) {
    if (p.isSelf) continue;
    console.log(
      `PEER ${p.user.name} · actividad=${JSON.stringify(p.activity ?? null)} · claude=${p.claudeActive ?? false}`,
    );
  }
});

await session.connect('ws://localhost:7900', code);
console.log(`conectado a ${code} como "${name}" (${colorForName(name)})`);

// Cursor en la playlist (beat 2.5) + Claude trabajando "conmigo".
session.setActivity({ editor: 'Playlist', beat: 2.5 });
session.awareness.setLocalStateField('claude', true);

setTimeout(() => {
  session.destroy();
  console.log('peer QA desconectado');
  process.exit(0);
}, seconds * 1000);
