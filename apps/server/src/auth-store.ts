/**
 * Dónde vive la contraseña de una sala.
 *
 * En un archivo aparte del .bin (`<código>.auth.json`) y no dentro del Y.Doc,
 * por una razón: el doc lo replican TODOS los clientes. Cualquier cosa que se
 * meta ahí acaba en la máquina de cada invitado, y el registro de la puerta es
 * justo lo que no debe salir del servidor.
 *
 * Lo que se guarda no abre nada por sí solo (ver room-auth.ts en @orbit/collab:
 * es SHA-256 de la clave que firma), pero aun así se escribe con permisos de
 * solo-el-dueño donde el sistema los respeta.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoomAuth, type RoomAuthRecord } from '@orbit/collab';

/** Nombre del archivo de la puerta de una sala. */
export function authFileName(code: string): string {
  return `${code}.auth.json`;
}

export function authFilePath(dir: string, code: string): string {
  return join(dir, authFileName(code));
}

/**
 * Lee y escribe registros de puerta, con una caché en memoria: el registro se
 * consulta en CADA conexión y una sala popular no tiene por qué golpear el
 * disco cada vez.
 */
export class RoomAuthStore {
  private readonly cache = new Map<string, RoomAuthRecord | null>();

  /** La carpeta se pide al usarla: `roomsDir` se decide al arrancar el server. */
  constructor(private readonly dirOf: () => string) {}

  /** El registro de la sala, o null si no tiene contraseña. */
  get(code: string): RoomAuthRecord | null {
    const cached = this.cache.get(code);
    if (cached !== undefined) return cached;
    const record = this.read(code);
    this.cache.set(code, record);
    return record;
  }

  /** Pone (o quita, con null) la contraseña de la sala. Devuelve si quedó protegida. */
  set(code: string, record: RoomAuthRecord | null): boolean {
    const file = authFilePath(this.dirOf(), code);
    if (record === null) {
      try {
        rmSync(file, { force: true });
      } catch {
        // si no se puede borrar, al menos la caché no miente: se relee abajo
      }
      this.cache.set(code, null);
      return false;
    }
    mkdirSync(this.dirOf(), { recursive: true });
    // Atómico como el .bin: un corte a mitad de escritura no puede dejar una
    // sala con la puerta a medio poner (ni abierta ni cerrada).
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
    this.cache.set(code, record);
    return true;
  }

  /** ¿Esta sala pide contraseña? */
  isProtected(code: string): boolean {
    return this.get(code) !== null;
  }

  /** Olvida lo cacheado (para tests y para releer tras un cambio de carpeta). */
  forget(): void {
    this.cache.clear();
  }

  private read(code: string): RoomAuthRecord | null {
    const file = authFilePath(this.dirOf(), code);
    if (!existsSync(file)) return null;
    try {
      // Un archivo corrupto NO puede dejar la sala abierta de par en par por
      // accidente: si no se entiende, se trata como puerta que no se puede
      // abrir en vez de como sala sin contraseña.
      const parsed = parseRoomAuth(JSON.parse(readFileSync(file, 'utf8')));
      if (parsed) return parsed;
      console.error(`[auth] ${authFileName(code)} ilegible: la sala queda cerrada`);
      return BROKEN;
    } catch (err) {
      console.error(`[auth] ${authFileName(code)} ilegible: la sala queda cerrada`, err);
      return BROKEN;
    }
  }
}

/**
 * Registro imposible de satisfacer, para un archivo corrupto: pide una
 * contraseña que ninguna prueba puede cumplir (storedKey de 32 ceros no es el
 * SHA-256 de nada que se pueda derivar sin la preimagen). Cerrado por dentro es
 * mejor que abierto por error.
 */
const BROKEN: RoomAuthRecord = {
  v: 1,
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iterations: 210_000,
  storedKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};
