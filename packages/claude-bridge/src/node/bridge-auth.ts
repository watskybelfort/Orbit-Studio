/**
 * Handshake del puente Claude ⇄ Orbit Studio.
 *
 * El host WS (127.0.0.1:7855) no basta con que escuche solo en localhost:
 * cualquier OTRO proceso local (o una página web vía `new WebSocket`) podría
 * conectarse y ejecutar las tools o leerse el proyecto entero. Para evitarlo, el
 * main genera un token por sesión y lo deja en un archivo que solo el usuario
 * puede leer; el relay MCP lo lee y lo presenta al conectar. El host rechaza
 * cualquier conexión que no traiga ese token.
 *
 * El archivo vive en ~/.orbit/bridge.json (no en userData) para que el relay
 * —que Claude Code lanza como proceso aparte, sin Electron— lo encuentre sin
 * tener que replicar cómo Electron nombra userData.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BridgeInfo {
  port: number;
  token: string;
}

/** ORBIT_BRIDGE_INFO permite redirigir el archivo (tests, QA); por defecto ~/.orbit. */
export function bridgeInfoPath(): string {
  return process.env['ORBIT_BRIDGE_INFO'] ?? join(homedir(), '.orbit', 'bridge.json');
}

/** Token de sesión: aleatorio, se regenera en cada arranque de la app. */
export function generateBridgeToken(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
}

/** El main deja aquí puerto + token; el archivo queda legible solo por el usuario. */
export function writeBridgeInfo(info: BridgeInfo): void {
  const path = bridgeInfoPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info), { mode: 0o600 });
}

/** Lo lee el relay para saber a qué puerto ir y qué token presentar. */
export function readBridgeInfo(): BridgeInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(bridgeInfoPath(), 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as BridgeInfo).port === 'number' &&
      typeof (parsed as BridgeInfo).token === 'string'
    ) {
      return parsed as BridgeInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearBridgeInfo(): void {
  try {
    rmSync(bridgeInfoPath());
  } catch {
    // no existía: nada que limpiar
  }
}
