// Driver CDP mínimo para Orbit Studio: evalúa JS en el renderer y captura PNG.
// Uso: node cdp.mjs eval "<expresión JS>"
//      node cdp.mjs shot <salida.png>
//      node cdp.mjs shot <salida.png> "<JS previo>"  (evalúa, espera 600ms, captura)
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const [, , cmd, arg1, arg2] = process.argv;

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'));
if (!page) {
  console.error('No hay página del renderer en CDP. Targets:', targets.map((t) => t.url));
  process.exit(1);
}

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

ws.on('open', async () => {
  try {
    if (cmd === 'eval') {
      const r = await send('Runtime.evaluate', {
        expression: arg1,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(JSON.stringify(r.result?.value ?? r.result, null, 1));
    } else if (cmd === 'shot') {
      if (arg2) {
        await send('Runtime.evaluate', { expression: arg2, awaitPromise: true });
        await new Promise((r) => setTimeout(r, 700));
      }
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(arg1, Buffer.from(shot.data, 'base64'));
      console.log('OK ->', arg1);
    } else {
      console.error('cmd desconocido:', cmd);
      process.exit(1);
    }
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('FALLO:', err.message);
    ws.close();
    process.exit(1);
  }
});
