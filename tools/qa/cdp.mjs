// Driver CDP mínimo para Orbit Studio: evalúa JS en el renderer y captura PNG.
// Uso: node cdp.mjs eval "<expresión JS>"
//      node cdp.mjs shot <salida.png>
//      node cdp.mjs shot <salida.png> "<JS previo>"  (evalúa, espera 600ms, captura)
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const [, , cmd, ...args] = process.argv;

const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
// El puerto del dev server puede cambiar (rangos reservados de Windows), así
// que se busca cualquier página servida desde localhost en vez de uno fijo.
const page = targets.find(
  (t) =>
    t.type === 'page' &&
    (t.url.startsWith('http://localhost:') || t.url.startsWith('http://127.0.0.1:')),
);
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
    // Un frame real antes de capturar: Page.captureScreenshot puede devolver
    // el último frame compuesto y, tras abrir/maximizar una ventana, ese frame
    // todavía es el anterior. Dos rAF + un tick lo empujan; si la ventana está
    // oculta (rAF en pausa), un tope de tiempo evita quedarse esperando.
    const flush = async () => {
      await send('Page.bringToFront').catch(() => {});
      await Promise.race([
        send('Runtime.evaluate', {
          expression:
            'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))',
          awaitPromise: true,
        }),
        new Promise((r) => setTimeout(r, 500)),
      ]);
      // Un cambio de opacidad de ida y vuelta obliga a recomponer la capa
      // entera: sin esto, tras un cambio de contenido (elegir canal, abrir una
      // ventana) la captura mezclaba el frame viejo con el nuevo.
      await Promise.race([
        send('Runtime.evaluate', {
          expression:
            "new Promise(r => { const h = document.documentElement; h.style.opacity = '0.999'; requestAnimationFrame(() => requestAnimationFrame(() => { h.style.opacity = ''; setTimeout(r, 80); })); })",
          awaitPromise: true,
        }),
        new Promise((r) => setTimeout(r, 700)),
      ]).catch(() => {});
      await send('Runtime.evaluate', {
        expression: "document.documentElement.style.opacity = ''",
      }).catch(() => {});
    };
    if (cmd === 'eval') {
      const r = await send('Runtime.evaluate', {
        expression: args[0],
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(JSON.stringify(r.result?.value ?? r.result, null, 1));
    } else if (cmd === 'shot') {
      if (args[1]) {
        await send('Runtime.evaluate', { expression: args[1], awaitPromise: true });
        await new Promise((r) => setTimeout(r, 700));
      }
      await flush();
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(args[0], Buffer.from(shot.data, 'base64'));
      console.log('OK ->', args[0]);
    } else if (cmd === 'clip') {
      // Recorte con escala: para mirar de cerca una franja de la UI sin
      // capturar la ventana entera. args: salida x y w h [escala]
      const [out, x, y, w, h, scale = '2'] = args;
      await flush();
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: Number(x), y: Number(y), width: Number(w), height: Number(h), scale: Number(scale) },
      });
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('OK ->', out);
    } else if (cmd === 'emulate') {
      // Ancho de ventana sin tocar la ventana de Electron: emula el viewport y
      // captura. Uso: node cdp.mjs emulate <ancho> <alto> <salida.png>
      // (redimensionar la ventana real congelaba el renderer en este entorno).
      const [w, h, out] = args;
      await send('Emulation.setDeviceMetricsOverride', {
        width: Number(w),
        height: Number(h),
        deviceScaleFactor: 1,
        mobile: false,
      });
      await flush();
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (out) {
        writeFileSync(out, Buffer.from(shot.data, 'base64'));
        console.log('OK ->', out);
      } else {
        console.log('OK');
      }
    } else if (cmd === 'reset-viewport') {
      await send('Emulation.clearDeviceMetricsOverride');
      console.log('OK');
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
