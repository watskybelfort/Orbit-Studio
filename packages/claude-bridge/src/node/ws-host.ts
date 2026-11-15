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
import { clearBridgeInfo, writeBridgeInfo } from './bridge-auth';

export const BRIDGE_DEFAULT_PORT = 7855;

export interface BridgeDispatch {
  (req: { tool: string; args: unknown }): Promise<{ text: string } | { error: string }>;
}

export interface BridgeHostOptions {
  /** Puerto local (por defecto 7855). */
  port?: number;
  /**
   * Token de sesión. Si se da, toda conexión debe presentarlo como primer
   * mensaje ({ type:'auth', token }) o se cierra; además se publica junto al
   * puerto en ~/.orbit/bridge.json para que el relay lo lea. Sin token no hay
   * autenticación (solo para tests/uso embebido).
   */
  token?: string;
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
  const requireAuth = typeof opts.token === 'string' && opts.token.length > 0;
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const clients = new Set<WebSocket>();

  /*
   * El token se PUBLICA cuando el puerto está escuchando, no antes.
   *
   * Si se escribía primero y el puerto estaba ocupado (otra app, o un proceso
   * local que llegó antes), el relay leía el token del archivo y se lo mandaba
   * al impostor que tenía el 7855. Publicar en `listening` cierra esa ventana:
   * si no hay puerto, no hay bridge.json y el relay dice "Orbit no está
   * abierto" en vez de autenticarse contra un desconocido.
   */
  let closed = false;
  if (requireAuth) {
    wss.on('listening', () => {
      if (!closed) writeBridgeInfo({ port, token: opts.token! });
    });
  }

  const notify = () => opts.onStatus?.({ connected: clients.size > 0 });

  wss.on('connection', (socket, req) => {
    // Un WebSocket desde una página web SIEMPRE manda cabecera Origin; el relay
    // Node no. Rechazarlas corta el vector navegador aunque supieran el token.
    if (req.headers.origin) {
      socket.close(1008, 'Origin no permitido');
      return;
    }
    let authed = !requireAuth;
    /**
     * Una tool a la vez por conexión.
     *
     * El executor y el renderer asumen un proyecto estable durante la llamada;
     * dos `generate_pack` en paralelo elegían el mismo slug y el segundo pisaba
     * al primero, y `load_sample` atribuía a una llamada los canales de la otra.
     * El protocolo MCP permite paralelismo, así que la serialización va aquí.
     */
    let chain: Promise<unknown> = Promise.resolve();
    // Sin token la conexión se acepta de entrada (autenticación implícita):
    // hay que registrarla YA, o `onStatus` no dice nunca "conectado" y
    // `close()` no cierra a nadie. Con token, el alta llega en el handshake.
    if (authed) {
      clients.add(socket);
      notify();
    }

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- RawData de ws
        msg = JSON.parse(String(raw));
      } catch {
        safeSend(socket, { error: 'Mensaje no es JSON válido' });
        return;
      }
      // Handshake: el PRIMER mensaje de una conexión no autenticada debe traer
      // el token. Cualquier otra cosa antes de autenticarse cierra el socket.
      if (!authed) {
        const { type, token } = (msg ?? {}) as { type?: unknown; token?: unknown };
        if (type === 'auth' && typeof token === 'string' && token === opts.token) {
          authed = true;
          clients.add(socket);
          notify();
          return;
        }
        safeSend(socket, { error: 'No autenticado' });
        socket.close(1008, 'No autenticado');
        return;
      }
      const { id, tool, args } = (msg ?? {}) as { id?: unknown; tool?: unknown; args?: unknown };
      if (typeof id !== 'string' || typeof tool !== 'string') {
        safeSend(socket, { error: 'Petición inválida: se espera { id, tool, args? }' });
        return;
      }
      // Serializada por conexión (ver `chain`): la siguiente espera a que
      // termine la anterior, pase lo que pase con ella.
      chain = chain
        .then(() => opts.dispatch({ tool, args }))
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
      closed = true;
      for (const socket of clients) {
        try {
          socket.close();
        } catch {
          // ignorar: cerrar es best-effort
        }
      }
      clients.clear();
      wss.close();
      if (requireAuth) clearBridgeInfo();
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
