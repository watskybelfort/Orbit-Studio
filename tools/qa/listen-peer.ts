/**
 * QA del streaming del master: un oyente headless.
 *
 * Entra en la sala y se queda escuchando los trozos de audio que emite otro
 * (mensaje de tipo 3, ver packages/collab/src/audio-stream.ts). No reproduce
 * nada —aquí no hay altavoces—: cuenta lo que llega, mide su nivel y avisa de
 * los huecos, que es lo que hay que ver para saber si el camino entero
 * funciona (kernel → sala → servidor → oyente).
 *
 * Uso: npx tsx tools/qa/listen-peer.ts <CODIGO-SALA> [segundos] [nombre]
 * Servidor: ORBIT_COLLAB_URL (por defecto ws://localhost:7900).
 */

import { ProjectStore } from '@orbit/core';
import { CollabSession, colorForName } from '@orbit/collab';

const code = process.argv[2];
const seconds = Number(process.argv[3] ?? '15');
const name = process.argv[4] ?? 'Oyente QA';
const url = process.env.ORBIT_COLLAB_URL ?? 'ws://localhost:7900';
if (!code) {
  console.error('Falta el código de sala');
  process.exit(1);
}

const store = new ProjectStore();
let chunks = 0;
let samples = 0;
let peak = 0;
let energy = 0;
let gaps = 0;
let lastSeq: number | null = null;
let rate = 0;
let bytes = 0;
let codec = '';

const session = new CollabSession(store, {
  user: { name, color: colorForName(name) },
  onRole: (role) => console.log(`el servidor me asigna: ${role}`),
  onAudio: (chunk) => {
    chunks++;
    samples += chunk.samples.length;
    rate = chunk.sampleRate;
    bytes += chunk.bytes;
    codec = chunk.codec;
    if (lastSeq !== null && chunk.seq !== lastSeq + 1) gaps++;
    lastSeq = chunk.seq;
    for (const s of chunk.samples) {
      const v = Math.abs(s) / 32767;
      if (v > peak) peak = v;
      energy += v * v;
    }
  },
});

// La sala puede pedir contraseña: ORBIT_COLLAB_PASSWORD. No viaja — se
// firma con ella el desafío que manda el servidor.
await session.connect(url, code, process.env.ORBIT_COLLAB_PASSWORD ?? '');
console.log(`conectado a ${code} en ${url} como "${name}"; escuchando ${seconds} s…`);

setTimeout(() => {
  const rms = samples > 0 ? Math.sqrt(energy / samples) : 0;
  const db = (x: number) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(1)} dBFS` : '-inf');
  console.log(
    `trozos=${chunks} muestras=${samples} (${(samples / (rate || 1)).toFixed(2)} s de audio a ${rate} Hz)`,
  );
  console.log(`pico=${db(peak)} rms=${db(rms)} huecos=${gaps}`);
  const seconds = samples / (rate || 1);
  const kbps = seconds > 0 ? (bytes * 8) / seconds / 1000 : 0;
  console.log(
    `codec=${codec || '?'} · ${bytes} bytes (${kbps.toFixed(0)} kbit/s) · ` +
      `crudo serían ${((samples * 16) / seconds / 1000).toFixed(0)} kbit/s`,
  );
  console.log(
    chunks === 0
      ? 'NADA: nadie está emitiendo (o no llega)'
      : peak > 0
        ? 'OK: llega audio con señal'
        : 'llega el stream, pero en silencio (¿está sonando algo en el emisor?)',
  );
  session.destroy();
  process.exit(chunks > 0 ? 0 : 1);
}, seconds * 1000);
