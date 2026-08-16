/**
 * QA de presencia: un colaborador headless real que entra a una sala, publica
 * su cursor en la Playlist y la bandera de Claude, y va imprimiendo la
 * actividad que recibe de los demás. Para verificar los dos sentidos contra
 * la app viva.
 * Uso: npx tsx tools/qa/presence-peer.ts <CODIGO-SALA> [segundos]
 */

import { ProjectStore } from '@orbit/core';
import { CollabSession } from '@orbit/collab';

const code = process.argv[2];
const seconds = Number(process.argv[3] ?? '60');
if (!code) {
  console.error('Falta el código de sala');
  process.exit(1);
}

const store = new ProjectStore();
const session = new CollabSession(store, { user: { name: 'Remoto QA', color: '#e6675a' } });

session.onPeersChanged((peers) => {
  for (const p of peers) {
    if (p.isSelf) continue;
    console.log(
      `PEER ${p.user.name} · actividad=${JSON.stringify(p.activity ?? null)} · claude=${p.claudeActive ?? false}`,
    );
  }
});

await session.connect('ws://localhost:7900', code);
console.log(`conectado a ${code} como "Remoto QA"`);

// Cursor en la playlist (beat 2.5) + Claude trabajando "conmigo".
session.setActivity({ editor: 'Playlist', beat: 2.5 });
session.awareness.setLocalStateField('claude', true);

setTimeout(() => {
  session.destroy();
  console.log('peer QA desconectado');
  process.exit(0);
}, seconds * 1000);
