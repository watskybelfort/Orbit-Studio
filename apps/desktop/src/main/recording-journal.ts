/**
 * Diario de una toma EN CURSO: PCM crudo a disco mientras se graba.
 *
 * Hasta aquí la toma vivía solo en memoria y el primer `recording:save` ocurría
 * al parar. Un crash de la app con el micro abierto se llevaba la única copia
 * de lo cantado. Este módulo escribe el audio en crudo (float32, dos archivos
 * L/R por ruta) en `recordings/.diario/` cada medio segundo, y al arrancar la
 * UI puede ofrecerlo.
 *
 * Contratos:
 *
 * - El diario NUNCA es la copia buena: al guardar la toma se borra. Si queda
 *   uno al arrancar es porque la app se cerró a mitad, y `list()` lo cuenta.
 * - Cada append es un trozo completo; un crash puede dejar el último trozo a
 *   medias, así que `read` recorta a frames enteros (múltiplo de 8 bytes:
 *   2 canales × 4 bytes) y a la longitud del canal más corto.
 * - Todas las rutas se validan contra la carpeta del diario; el id lo genera
 *   el renderer y aquí se exige su forma.
 */

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRealPathWithin } from './path-guard';

/** Subcarpeta de `recordings/`; no se barre con la papelera. */
export const JOURNAL_DIR = '.diario';
/** Un diario huérfano más viejo que esto ya no se ofrece. */
export const JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Un append legítimo es medio segundo de audio: 8 MB es margen de sobra. */
export const JOURNAL_MAX_APPEND_BYTES = 8 * 1024 * 1024;
/** Tope por archivo (una toma de ~10 min estéreo a 48k son ~230 MB). */
export const JOURNAL_MAX_FILE_BYTES = 512 * 1024 * 1024;

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const MAX_ROUTES = 8;

export interface JournalRouteMeta {
  index: number;
  name: string;
}

export interface JournalMeta {
  id: string;
  title: string;
  projectId: string;
  arrangementId: string;
  tempo: number;
  sampleRate: number;
  /** Beat donde empezó la toma. */
  start: number;
  latency: number;
  loop: { start: number; end: number } | null;
  routes: JournalRouteMeta[];
  startedAt: number;
}

export interface JournalInfo extends JournalMeta {
  /** Frames válidos (los dos canales coinciden). */
  frames: number;
  bytes: number;
  modifiedAt: number;
}

export interface JournalRouteAudio {
  index: number;
  name: string;
  left: ArrayBuffer;
  right: ArrayBuffer;
}

export interface JournalRead {
  meta: JournalMeta;
  frames: number;
  routes: JournalRouteAudio[];
}

export interface RecordingJournal {
  start(meta: JournalMeta): Promise<void>;
  append(id: string, routeIndex: number, left: Uint8Array, right: Uint8Array): Promise<void>;
  finish(id: string): Promise<void>;
  list(): Promise<JournalInfo[]>;
  read(id: string): Promise<JournalRead>;
  discard(id: string): Promise<void>;
  purge(now?: number, ttlMs?: number): Promise<string[]>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** JSON → meta, o null. Del renderer solo se acepta lo que tiene forma. */
export function parseJournalMeta(value: unknown, expectedId?: string): JournalMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  const id = m['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (expectedId !== undefined && id !== expectedId) return null;
  if (typeof m['title'] !== 'string' || typeof m['projectId'] !== 'string') return null;
  if (typeof m['arrangementId'] !== 'string') return null;
  if (!isFiniteNumber(m['tempo']) || m['tempo'] <= 0) return null;
  if (!isFiniteNumber(m['sampleRate']) || m['sampleRate'] < 8000 || m['sampleRate'] > 192000) return null;
  if (!isFiniteNumber(m['start']) || m['start'] < 0) return null;
  if (!isFiniteNumber(m['latency']) || m['latency'] < 0) return null;
  const loopRaw = m['loop'];
  let loop: JournalMeta['loop'] = null;
  if (typeof loopRaw === 'object' && loopRaw !== null) {
    const l = loopRaw as Record<string, unknown>;
    if (isFiniteNumber(l['start']) && isFiniteNumber(l['end']) && l['end'] > l['start']) {
      loop = { start: l['start'], end: l['end'] };
    }
  }
  const routesRaw = m['routes'];
  if (!Array.isArray(routesRaw) || routesRaw.length === 0 || routesRaw.length > MAX_ROUTES) return null;
  const routes: JournalRouteMeta[] = [];
  for (const route of routesRaw) {
    if (typeof route !== 'object' || route === null) return null;
    const r = route as Record<string, unknown>;
    if (!Number.isInteger(r['index']) || (r['index'] as number) < 0 || (r['index'] as number) > 31) return null;
    if (typeof r['name'] !== 'string') return null;
    routes.push({ index: r['index'] as number, name: r['name'].slice(0, 200) });
  }
  if (!isFiniteNumber(m['startedAt'])) return null;
  return {
    id,
    title: m['title'].slice(0, 300),
    projectId: m['projectId'],
    arrangementId: m['arrangementId'],
    tempo: m['tempo'],
    sampleRate: m['sampleRate'],
    start: m['start'],
    latency: m['latency'],
    loop,
    routes,
    startedAt: m['startedAt'],
  };
}

export function createRecordingJournal(dir: () => string): RecordingJournal {
  const root = dir;
  const journalDir = () => join(root(), JOURNAL_DIR);

  /** Ninguna operación sale de `.diario/`. */
  async function pathOf(id: string, file: string): Promise<string> {
    if (!ID_RE.test(id)) throw new Error('Diario: id inválido');
    const base = journalDir();
    const target = resolve(join(base, file));
    if (!(await isRealPathWithin(target, base))) {
      throw new Error('Diario: ruta fuera de la carpeta de grabaciones');
    }
    return target;
  }

  function metaFile(id: string): string {
    return `${id}.json`;
  }
  function channelFile(id: string, routeIndex: number, side: 'L' | 'R'): string {
    return `${id}.${routeIndex}.${side}.f32`;
  }

  async function start(meta: JournalMeta): Promise<void> {
    const clean = parseJournalMeta(meta);
    if (!clean || clean.id !== meta.id) throw new Error('Diario: metadatos inválidos');
    await mkdir(journalDir(), { recursive: true });
    const json = JSON.stringify(clean);
    if (json.length > 16 * 1024) throw new Error('Diario: metadatos demasiado grandes');
    await writeFile(await pathOf(clean.id, metaFile(clean.id)), json, 'utf8');
    for (const route of clean.routes) {
      await writeFile(await pathOf(clean.id, channelFile(clean.id, route.index, 'L')), new Uint8Array(0));
      await writeFile(await pathOf(clean.id, channelFile(clean.id, route.index, 'R')), new Uint8Array(0));
    }
  }

  async function append(id: string, routeIndex: number, left: Uint8Array, right: Uint8Array): Promise<void> {
    if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex > 31) {
      throw new Error('Diario: ruta inválida');
    }
    if (left.byteLength !== right.byteLength) {
      throw new Error('Diario: los canales no miden lo mismo');
    }
    if (left.byteLength % 4 !== 0 || left.byteLength === 0) {
      throw new Error('Diario: el trozo no es float32 estéreo');
    }
    if (left.byteLength > JOURNAL_MAX_APPEND_BYTES) {
      throw new Error('Diario: trozo demasiado grande');
    }
    const l = await pathOf(id, channelFile(id, routeIndex, 'L'));
    const r = await pathOf(id, channelFile(id, routeIndex, 'R'));
    for (const file of [l, r]) {
      const info = await stat(file).catch(() => null);
      if (!info) throw new Error('Diario: la toma no existe');
      if (info.size + left.byteLength > JOURNAL_MAX_FILE_BYTES) {
        throw new Error('Diario: la toma pasa del tope de tamaño');
      }
    }
    await appendFile(l, left);
    await appendFile(r, right);
  }

  async function readMeta(id: string): Promise<JournalMeta> {
    const file = await pathOf(id, metaFile(id));
    const raw = await readFile(file, 'utf8');
    const meta = parseJournalMeta(JSON.parse(raw), id);
    if (!meta) throw new Error('Diario: metadatos corruptos');
    return meta;
  }

  async function read(id: string): Promise<JournalRead> {
    const meta = await readMeta(id);
    const routes: JournalRouteAudio[] = [];
    let frames = Infinity;
    for (const route of meta.routes) {
      const l = await readFile(await pathOf(id, channelFile(id, route.index, 'L')));
      const r = await readFile(await pathOf(id, channelFile(id, route.index, 'R')));
      // Un crash a mitad de append deja un frame partido en el último canal.
      // Los archivos son PLANARES (L y R separados): un frame son 4 bytes en
      // CADA archivo, no 8 en uno.
      const valid = Math.min(l.byteLength, r.byteLength);
      const whole = Math.floor(valid / 4) * 4;
      frames = Math.min(frames, whole / 4);
      routes.push({
        index: route.index,
        name: route.name,
        left: l.buffer.slice(l.byteOffset, l.byteOffset + whole) as ArrayBuffer,
        right: r.buffer.slice(r.byteOffset, r.byteOffset + whole) as ArrayBuffer,
      });
    }
    if (!Number.isFinite(frames)) frames = 0;
    return { meta, frames, routes };
  }

  async function finish(id: string): Promise<void> {
    const meta = await readMeta(id).catch(() => null);
    const files = [metaFile(id)];
    if (meta) {
      for (const route of meta.routes) {
        files.push(channelFile(id, route.index, 'L'), channelFile(id, route.index, 'R'));
      }
    }
    for (const file of files) {
      await rm(await pathOf(id, file), { force: true });
    }
  }

  async function list(): Promise<JournalInfo[]> {
    let entries;
    try {
      entries = await readdir(journalDir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: JournalInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      try {
        const meta = await readMeta(id);
        let frames = Infinity;
        let bytes = 0;
        let modifiedAt = 0;
        for (const route of meta.routes) {
          const l = await stat(await pathOf(id, channelFile(id, route.index, 'L')));
          const r = await stat(await pathOf(id, channelFile(id, route.index, 'R')));
          const whole = Math.floor(Math.min(l.size, r.size) / 4) * 4;
          frames = Math.min(frames, whole / 4);
          bytes += l.size + r.size;
          modifiedAt = Math.max(modifiedAt, l.mtimeMs, r.mtimeMs);
        }
        if (!Number.isFinite(frames) || frames <= 0) continue;
        out.push({ ...meta, frames, bytes, modifiedAt });
      } catch {
        // Un diario corrupto no puede impedir recuperar los demás.
      }
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  async function purge(now = Date.now(), ttlMs = JOURNAL_TTL_MS): Promise<string[]> {
    const removed: string[] = [];
    for (const journal of await list()) {
      if (now - journal.modifiedAt <= ttlMs) continue;
      try {
        await finish(journal.id);
        removed.push(journal.id);
      } catch {
        // Se queda: la opción conservadora.
      }
    }
    return removed;
  }

  return { start, append, finish, list, read, discard: finish, purge };
}
