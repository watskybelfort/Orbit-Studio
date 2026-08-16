/**
 * Relay MCP stdio ⇄ WebSocket de Orbit Studio.
 *
 * Claude Code lanza este proceso (via .mcp.json: `npx tsx .../mcp-stdio.ts`) y
 * le habla MCP por stdio; cada tool call se reenvía por WebSocket al host que
 * corre dentro del main de Electron (ws://127.0.0.1:7855), que a su vez lo
 * ejecuta en el renderer contra el ProjectStore vivo.
 *
 *   Claude Code ──(stdio MCP)── este relay ──(WS 7855)── Electron ──(IPC)── ProjectStore
 *
 * Se usa el Server de bajo nivel del SDK (no McpServer) porque las tools de
 * tools.ts están definidas con JSON Schema puro, no con zod.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { TOOLS } from '../tools';

const PORT = Number(process.env['ORBIT_BRIDGE_PORT'] ?? '7855');
const URL_WS = `ws://127.0.0.1:${PORT}`;
const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_MS = 400;
const CALL_TIMEOUT_MS = 90_000; // > los 60 s del timeout main→renderer

const NOT_OPEN_MSG =
  `Orbit Studio no está abierto (no se pudo conectar a ${URL_WS}). ` +
  'Abre la app Orbit Studio y vuelve a intentarlo.';

// ── Cliente WebSocket con reconexión perezosa ────────────────────────────────

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let socket: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
const pending = new Map<string, Pending>();

function failAllPending(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

function connectOnce(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_WS);
    let settled = false;

    ws.on('open', () => {
      settled = true;
      resolve(ws);
    });
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData de ws
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const { id, result, error } = (msg ?? {}) as {
        id?: unknown;
        result?: { text?: unknown };
        error?: unknown;
      };
      if (typeof id !== 'string') return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (typeof error === 'string') p.reject(new Error(error));
      else if (result && typeof result.text === 'string') p.resolve(result.text);
      else p.reject(new Error('Respuesta inválida de Orbit Studio'));
    });
    ws.on('close', () => {
      if (socket === ws) socket = null;
      failAllPending('Se perdió la conexión con Orbit Studio (la app se cerró o reinició)');
      if (!settled) {
        settled = true;
        reject(new Error(NOT_OPEN_MSG));
      }
    });
    ws.on('error', () => {
      // 'close' llega después y resuelve el estado; aquí solo evitamos el throw.
    });
  });
}

async function ensureConnected(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;
  connecting = (async () => {
    let lastError: Error = new Error(NOT_OPEN_MSG);
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      try {
        const ws = await connectOnce();
        socket = ws;
        return ws;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
      }
    }
    throw lastError;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Reenvía una tool call a la app y espera su texto de respuesta. */
async function callOrbit(tool: string, args: unknown): Promise<string> {
  const ws = await ensureConnected();
  const id = randomUUID();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Orbit Studio no respondió a "${tool}" en ${CALL_TIMEOUT_MS / 1000} s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, tool, args }), (err) => {
      if (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(NOT_OPEN_MSG));
      }
    });
  });
}

// ── Servidor MCP stdio ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new Server(
    { name: 'orbit-studio', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const text = await callOrbit(name, args ?? {});
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    // Claude Code cerró la sesión: liberar el socket y salir limpios.
    try {
      socket?.close();
    } catch {
      // ignorar
    }
    process.exit(0);
  };
  await server.connect(transport);
  // stderr para no ensuciar el canal MCP de stdout.
  console.error(`[orbit-studio mcp] listo; relay hacia ${URL_WS}`);
}

main().catch((err: unknown) => {
  console.error('[orbit-studio mcp] error fatal:', err);
  process.exit(1);
});
