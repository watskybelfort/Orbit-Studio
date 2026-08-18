/**
 * QA del guardia de roles: un colaborador que MIENTE sobre el suyo.
 *
 * Entra en la sala (el servidor le dará "invitado", porque productor es quien
 * la abrió), se autoproclama productor —que es exactamente lo que se podía
 * hacer hasta v1.8— e intenta un cambio que su rol real no permite: subir el
 * fader del master.
 *
 * Lo que hay que ver: que el servidor RETIRA esa entrada del log, que el
 * proyecto del intruso vuelve solo a lo que dice la sala, y que en la app no
 * se mueve nada.
 *
 * Uso: npx tsx tools/qa/rogue-peer.ts <CODIGO-SALA> [nombre]
 * Servidor: ORBIT_COLLAB_URL (por defecto ws://localhost:7900).
 */

import { ProjectStore } from '@orbit/core';
import { CollabSession, colorForName } from '@orbit/collab';

const code = process.argv[2];
const name = process.argv[3] ?? 'Intruso QA';
const url = process.env.ORBIT_COLLAB_URL ?? 'ws://localhost:7900';
if (!code) {
  console.error('Falta el código de sala');
  process.exit(1);
}

const store = new ProjectStore();
let assigned = '(sin asignar)';
const session = new CollabSession(store, {
  user: { name, color: colorForName(name) },
  onRole: (role) => {
    assigned = role;
    console.log(`el servidor me asigna: ${role}`);
  },
  onRejected: (reason) => console.log(`aviso del servidor: ${reason}`),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await session.connect(url, code);
console.log(`conectado a ${code} como "${name}"`);
await sleep(500);

// La mentira: el cliente se pone el rol que quiere. Antes de v1.8 con esto
// bastaba, porque el rol viajaba sellado en cada entrada y nadie lo contrastaba.
session.setRole('productor');
console.log(`me declaro productor (de verdad soy ${assigned})`);

const before = store.project.mixer[0]?.volume ?? 1;
store.dispatch(
  { type: 'patchMixerTrack', trackIndex: 0, patch: { volume: 1.9 } },
  { label: 'QA intruso sube el master' },
);
console.log(`master en local tras el cambio: ${store.project.mixer[0]?.volume ?? '?'}`);

await sleep(2000);
const after = store.project.mixer[0]?.volume ?? 1;
console.log(`master tras la respuesta de la sala: ${after}`);
console.log(
  after === before
    ? 'OK: la sala retiró el cambio y el intruso volvió a lo que dice el log'
    : 'FALLO: el cambio sobrevivió',
);

session.destroy();
process.exit(after === before ? 0 : 1);
