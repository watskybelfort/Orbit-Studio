// QA del puente Claude: habla el protocolo del relay contra la app viva.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const ws = new WebSocket('ws://127.0.0.1:7855');
const pending = new Map();
let seq = 0;

function call(tool, args) {
  return new Promise((resolve, reject) => {
    const id = `qa-${seq++}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, tool, args }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout en ${tool}`));
    }, 30000);
  });
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result.text);
});

ws.on('open', async () => {
  try {
    console.log('— get_project inicial —');
    console.log(await call('get_project', {}));

    console.log('\n— montar un beat de prueba —');
    console.log(await call('set_tempo', { bpm: 140 }));
    console.log(await call('add_channel', { kind: 'drums', name: 'Drums QA' }));
    console.log(await call('add_channel', { kind: 'sub808', name: '808 QA' }));
    console.log(
      await call('set_steps', {
        patternId: 'Patrón 1',
        channelId: 'Drums QA',
        steps: 'x---x---x---x---',
        key: 36,
      }),
    );
    console.log(
      await call('set_steps', {
        patternId: 'Patrón 1',
        channelId: 'Drums QA',
        steps: '--x---x---x---x-',
        key: 42,
      }),
    );
    console.log(
      await call('set_notes', {
        patternId: 'Patrón 1',
        channelId: '808 QA',
        notes: [
          { start: 0, duration: 1.5, note: 'F2' },
          { start: 2, duration: 2, note: 'G#2', slide: true },
        ],
      }),
    );
    console.log(await call('add_effect', { trackIndex: 0, slotIndex: 0, kind: 'limiter' }));
    console.log(
      await call('arrange_clip', { action: 'add', patternId: 'Patrón 1', trackIndex: 0, startBeat: 0 }),
    );
    console.log('\n— analyze_mix —');
    console.log(await call('analyze_mix', {}));
    console.log('\n— resumen final —');
    console.log(await call('get_project', {}));
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error('FALLO:', err.message);
    ws.close();
    process.exit(1);
  }
});

ws.on('error', (e) => {
  console.error('No se pudo conectar al host del bridge:', e.message);
  process.exit(1);
});
