/**
 * Autenticación del host WS del puente (127.0.0.1:7855).
 *
 * Sin token, cualquier proceso local podía ejecutar las 20 tools o leerse el
 * proyecto entero. Aquí se comprueba el handshake sobre un socket real: solo
 * quien presenta el token de la sesión llega a `dispatch`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startBridgeHost, type BridgeHost } from '../src/node/ws-host';
import { clearBridgeInfo } from '../src/node/bridge-auth';

const PORT = 17855;
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = 'token-de-sesion';

// No pisar un ~/.orbit/bridge.json real si la app está viva mientras corren tests.
beforeAll(() => {
  process.env['ORBIT_BRIDGE_INFO'] = join(tmpdir(), `orbit-bridge-test-${process.pid}.json`);
});

let host: BridgeHost | null = null;
afterEach(() => {
  host?.close();
  host = null;
  clearBridgeInfo();
});

function open(opts?: WebSocket.ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>));
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('startBridgeHost: autenticación', () => {
  it('ejecuta la tool tras presentar el token correcto', async () => {
    const calls: string[] = [];
    host = startBridgeHost({
      port: PORT,
      token: TOKEN,
      dispatch: ({ tool }) => {
        calls.push(tool);
        return Promise.resolve({ text: `ok:${tool}` });
      },
    });
    const ws = await open();
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    ws.send(JSON.stringify({ id: '1', tool: 'get_project', args: {} }));
    const reply = await nextMessage(ws);
    expect(reply).toEqual({ id: '1', result: { text: 'ok:get_project' } });
    expect(calls).toEqual(['get_project']);
    ws.close();
  });

  it('cierra la conexión (1008) si el primer mensaje no trae el token', async () => {
    const calls: string[] = [];
    host = startBridgeHost({
      port: PORT,
      token: TOKEN,
      dispatch: ({ tool }) => {
        calls.push(tool);
        return Promise.resolve({ text: 'x' });
      },
    });
    const ws = await open();
    const code = closeCode(ws);
    ws.send(JSON.stringify({ id: '1', tool: 'get_project', args: {} }));
    expect(await code).toBe(1008);
    expect(calls).toEqual([]); // la tool NUNCA se ejecutó
  });

  it('rechaza (1008) un token equivocado', async () => {
    host = startBridgeHost({ port: PORT, token: TOKEN, dispatch: () => Promise.resolve({ text: 'x' }) });
    const ws = await open();
    const code = closeCode(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'incorrecto' }));
    expect(await code).toBe(1008);
  });

  it('rechaza (1008) conexiones con cabecera Origin (clientes navegador)', async () => {
    host = startBridgeHost({ port: PORT, token: TOKEN, dispatch: () => Promise.resolve({ text: 'x' }) });
    const ws = new WebSocket(URL, { headers: { origin: 'https://evil.example' } });
    expect(await closeCode(ws)).toBe(1008);
  });
});
