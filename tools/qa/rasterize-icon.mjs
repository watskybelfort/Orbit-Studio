// Rasteriza packages/ui/src/icons/app-icon.svg a un .ico multi-tamaño usando
// el renderer vivo de Orbit Studio por CDP (mismo Chromium que pinta la app).
// Entradas PNG dentro del ICO (válido de Vista en adelante; Electron lo acepta).
// Uso: node rasterize-icon.mjs  (requiere la app con ORBIT_DEBUG_PORT=9223)
import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Este script vive en tools/qa/, así que la raíz del repo son dos niveles
// arriba. Se deduce del propio archivo y no de una ruta escrita a mano: así
// funciona en cualquier clon, esté donde esté.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = readFileSync(`${REPO}/packages/ui/src/icons/app-icon.svg`, 'utf8');

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'));
if (!page) throw new Error('No hay renderer en CDP');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
});

await new Promise((r) => ws.on('open', r));

const expr = `(async () => {
  const svg = ${JSON.stringify(svg)};
  const sizes = ${JSON.stringify(SIZES)};
  const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg no carga')); img.src = url; });
  return sizes.map((s) => {
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, s, s);
    return { size: s, b64: c.toDataURL('image/png').split(',')[1] };
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) throw new Error('eval fallo: ' + JSON.stringify(r.exceptionDetails));
const pngs = r.result.value.map((e) => ({ size: e.size, buf: Buffer.from(e.b64, 'base64') }));

// Ensamblar ICO: ICONDIR + ICONDIRENTRY*N + blobs PNG.
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reservado
header.writeUInt16LE(1, 2); // tipo icono
header.writeUInt16LE(count, 4);
const entries = [];
let offset = 6 + 16 * count;
for (const { size, buf } of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // paleta
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); // planos
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += buf.length;
}
const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
mkdirSync(`${REPO}/apps/desktop/resources`, { recursive: true });
writeFileSync(`${REPO}/apps/desktop/resources/icon.ico`, ico);
// PNG de 256 suelto: útil para Linux/mac y para el README si hace falta.
writeFileSync(`${REPO}/apps/desktop/resources/icon-256.png`, pngs.find((p) => p.size === 256).buf);
console.log(`OK icon.ico (${ico.length} bytes, ${count} tamaños) + icon-256.png`);
ws.close();
process.exit(0);
