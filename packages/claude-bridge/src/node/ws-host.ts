/**
 * Host WebSocket del puente Claude ⇄ Orbit Studio (lado app).
 *
 * Corre en el MAIN PROCESS de Electron. Escucha SOLO en 127.0.0.1 y habla un
 * protocolo JSON mínimo con el relay MCP stdio (node/mcp-stdio.ts):
 *
 *   petición:  { id: string, tool: string, args?: unknown }
 *   respuesta: { id: string, result: { text: string } } | { id: string, error: string }
 *
 * Cada petición se resuelve con el `dispatch` inyectado (que la reenvía por
 * IPC al renderer, donde vive el ToolExecutor). Errores de un cliente nunca
 * tiran el proceso; se soportan varias conexiones a la vez.
 */

import { WebSocketServer, type WebSocket } from 'ws';

export const BRIDGE_DEFAULT_PORT = 7855;

export interface BridgeDispatch {
  (req: { tool: string; args: unknown }): Promise<{ text: string } | { error: string }>;
}

export interface BridgeHostOptions {
  /** Puerto local (por defecto 7855). */
  port?: number;
  /** Ejecuta una tool y devuelve el resultado o un error legible. */
  dispatch: BridgeDispatch;
  /** Notifica si hay algún cliente MCP conectado (indicador de la UI). */
  onStatus?: (s: { connected: boolean }) => void;
}

export interface BridgeHost {
  port: number;
  close(): void;
}

export function startBridgeHost(opts: BridgeHostOptions): BridgeHost {
  const port = opts.port ?? BRIDGE_DEFAULT_PORT;
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const clients = new Set<WebSocket>();

  const notify = () => opts.onStatus?.({ connected: clients.size > 0 });

  wss.on('connection', (socket) => {
    clients.add(socket);
    notify();

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData de ws
        msg = JSON.parse(String(raw));
      } catch {
        safeSend(socket, { error: 'Mensaje no es JSON válido' });
        return;
      }
      const { id, tool, args } = (msg ?? {}) as { id?: unknown; tool?: unknown; args?: unknown };
      if (typeof id !== 'string' || typeof tool !== 'string') {
        safeSend(socket, { error: 'Petición inválida: se espera { id, tool, args? }' });
        return;
      }
      // Cada petición vuela por su cuenta: varias tools pueden estar en curso.
      void opts
        .dispatch({ tool, args })
        .then((result) => {
          if ('error' in result) safeSend(socket, { id, error: result.error });
          else safeSend(socket, { id, result });
        })
        .catch((err: unknown) => {
          safeSend(socket, { id, error: errorMessage(err) });
        });
    });

    socket.on('close', () => {
      clients.delete(socket);
      notify();
    });
    // Sin handler, un error de socket sería una excepción no capturada.
    socket.on('error', () => {
      clients.delete(socket);
      notify();
    });
  });

  wss.on('error', (err) => {
    // Típicamente EADDRINUSE (otra instancia de la app). No tirar el proceso.
    console.error(`[claude-bridge] error del servidor WS (puerto ${port}):`, err.message);
  });

  return {
    port,
    close() {
      for (const socket of clients) {
        try {
          socket.close();
        } catch {
          // ignorar: cerrar es best-effort
        }
      }
      clients.clear();
      wss.close();
      notify();
    },
  };
}

function safeSend(socket: WebSocket, payload: unknown): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // el socket pudo cerrarse entre medias; no es fatal
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
