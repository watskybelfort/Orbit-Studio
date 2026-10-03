/**
 * El almacén de grabaciones del proceso principal: `userData/recordings` y su
 * papelera `.papelera/`. Vive aparte de `index.ts` para poder probarlo contra
 * una carpeta temporal sin levantar Electron (mismo criterio que `path-guard`).
 *
 * Tres contratos, y el porqué de cada uno:
 *
 * 1. **`discard` no es borrar**: mueve a `.papelera/`. Es una baja REVERSIBLE
 *    durante una ventana de retención, y no por prudencia genérica — es lo que
 *    cubre la única duda que ningún cálculo del renderer puede cerrar: el
 *    `.orbit` guardado, la versión restaurable, la otra ventana de la app (que
 *    con nombres por contenido puede estar escribiendo el MISMO archivo). Sin
 *    reversibilidad, «reversible» es una palabra. **La ventana corre desde el
 *    DESCARTE, no desde la escritura**: un archivo escrito hace meses y
 *    descartado hoy tiene sus 90 días por delante, o la reversibilidad no
 *    cubriría ni su propio caso.
 * 2. **`read` resuelve también la papelera**: si el archivo ya no está donde
 *    debía pero sí en `.papelera/`, se lee de ahí. Es la otra mitad del
 *    contrato de arriba.
 * 3. **La papelera se purga** (por antigüedad y por bytes) o es la fuga con
 *    otro nombre. Los umbrales, medidos, más abajo.
 *
 * Y dos guardas que no se negocian, porque este proceso desconfía a propósito
 * de las rutas que le pasa el renderer:
 *
 * - Ninguna operación sale de su carpeta (`isRealPathWithin`, la misma que
 *   `recording:read` ya usaba), en las DOS puntas de un descarte.
 * - **La papelera misma tiene que estar dentro de `recordings/`** resuelta de
 *   verdad: `.papelera` puede ser un junction plantado hacia una carpeta
 *   hermana, y con él `read` serviría bytes de fuera y `purgeTrash` BORRARÍA
 *   archivos ajenos. Se valida antes de leer, antes de mover y antes de
 *   purgar; si la papelera no pasa la guarda, se trata como si no existiera.
 */

import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRealPathWithin } from './path-guard';

/** Dentro de `recordings/`; el nombre se compara tal cual. */
export const RECORDINGS_TRASH = '.papelera';

/**
 * Tope de la BASE del nombre de archivo, en bytes UTF-8, dejando fuera la
 * extensión. Es el borde que se encontró al meter el hash de contenido en el
 * nombre:
 *
 * - Medido en NTFS: `Pista <220 caracteres>.wav` (230) se escribía bien, y el
 *   mismo nombre con el sha1 encima (271) fallaba con ENOENT: cada COMPONENTE
 *   de NTFS acota a 255 caracteres, y el `writeFile` no trunca nada.
 * - Y en ext4 el tope son 255 BYTES, no caracteres: un nombre con emojis o
 *   CJK gasta hasta 4 bytes por punto de código, así que el presupuesto va en
 *   bytes y no en longitud de cadena.
 *
 * 200 bytes de base + la extensión caben en los dos límites con margen. El
 * recorte va por DELANTE de la base: nuestros nombres llevan el digest de
 * contenido al FINAL (`Pista Voz <sha1>.wav`), y recortar la cola dejaría el
 * digest mutilado — o sea perder exactamente la unicidad que el hash pone.
 * El `SampleRef.name` del modelo se guarda entero aparte, así que al usuario
 * no le desaparece el nombre de la pista.
 */
export const RECORDING_NAME_BASE_BUDGET_BYTES = 200;

/**
 * Purga de la papelera al arrancar. Dos umbrales, medidos sobre el almacén
 * real de una instalación de uso normal (13 archivos / 88 MB escritos en un
 * mes, tomas de 0,2 a 40 MB, medidos el 03-10-2026 en `userData/recordings`):
 *
 * - **90 días**: la ventana de retención cubre el caso que la política de
 *   `state/sample-gc.ts` nombra como duda irreductible — «el `.orbit` guardado
 *   hace tres meses»—. Más corta y la reversibilidad deja de cubrir su propio
 *   ejemplo; más larga y la cota de bytes es la que manda de todas formas.
 * - **2 GiB**: con los 88 MB/mes medidos son ~2 años de uso normal, y una
 *   sesión de capturas largas tira a lo sumo cientos de MB. Es el techo que
 *   convierte la papelera en «acotada» en vez de en la fuga con otro nombre.
 *
 * Al pasar los dos, se tira lo más VIEJO primero: la retención es la que da
 * sentido al tope de bytes. Y la edad del archivo es su edad EN LA PAPELERA
 * (al mover se le pone el reloj en cero): si fuera la de la escritura, un
 * archivo viejo descartado hoy perdería su ventana de reversibilidad en el
 * primer arranque.
 */
export const RECORDINGS_TRASH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const RECORDINGS_TRASH_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Nombre de archivo seguro para el almacén: sanitizado y acotado, conservando
 * el digest y la extensión completos. Pura, para poder probarla tal cual.
 */
export function sanitizeRecordingName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'toma.wav';
  // `.` y `..` no llevan separadores pero se salen igual (o apuntan a la
  // carpeta misma): no son nombres de archivo.
  if (safe === '.' || safe === '..') return 'toma.wav';
  const dot = safe.lastIndexOf('.');
  // `.wav` de `toma.wav` es extensión; un `.gitignore` sin base no lo es.
  const hasExt = dot > 0;
  const ext = hasExt ? safe.slice(dot) : '';
  const baseName = hasExt ? safe.slice(0, dot) : safe;
  return `${truncateFromFront(baseName, RECORDING_NAME_BASE_BUDGET_BYTES)}${ext}`;
}

/**
 * Corta por DELANTE hasta que la base cabe en `budget` bytes UTF-8, por puntos
 * de código (cortar en mitad de un par sustituto deja un carácter inválido).
 */
function truncateFromFront(text: string, budgetBytes: number): string {
  const points = [...text];
  const utf8 = new TextEncoder();
  let bytes = 0;
  let keepFrom = points.length;
  for (let i = points.length - 1; i >= 0; i--) {
    bytes += utf8.encode(points[i]!).length;
    if (bytes > budgetBytes) break;
    keepFrom = i;
  }
  return points.slice(keepFrom).join('');
}

export interface RecordingStore {
  /** Escribe (piso por nombre, que con nombres por contenido es idempotente) y devuelve el nombre de archivo real. */
  save(name: string, bytes: Uint8Array): Promise<string>;
  /** Lee del almacén o, si no está, de la papelera. */
  read(file: string): Promise<ArrayBuffer>;
  /** Baja REVERSIBLE: mueve a `.papelera/`. Devuelve los que de verdad movió. */
  discard(files: readonly string[]): Promise<string[]>;
  /** Purga de la papelera por antigüedad y por bytes. Devuelve lo que tiró. */
  purgeTrash(
    now?: number,
    limits?: { ttlMs: number; maxBytes: number },
  ): Promise<{ removed: string[]; bytes: number }>;
}

/**
 * Crea el almacén sobre una carpeta. `dir` es función porque `userData` puede
 * reubicarse entre instancias de test.
 */
export function createRecordingStore(dir: () => string): RecordingStore {
  const trashDir = () => join(dir(), RECORDINGS_TRASH);

  /**
   * Exclusión mutua entre lo que barre y lo que mueve. Sin ella hay una
   * carrera con pérdida reproducida: `purgeTrash` saca el `stat` de una copia
   * vieja, un `discard` la sustituye por una baja NUEVA con su ventana
   * recién puesta, y la purga sigue con el `stat` rancio y tira la copia
   * recién descartada. Serializándolas, la purga o ve el mundo de antes (y
   * entonces lo que tira era de verdad viejo) o el de después (y lo nuevo
   * tiene su fecha): ninguna purga puede borrar una baja posterior.
   *
   * Es por ALMACÉN, que es lo que hay en la app: `index.ts` crea UNA
   * instancia y por ella pasan el arranque y todos los IPC. Si algún día
   * hubiera dos procesos sobre la misma carpeta, esto pide un lock de archivo.
   */
  let trashLock: Promise<unknown> = Promise.resolve();
  function withTrashLock<T>(run: () => Promise<T>): Promise<T> {
    const next = trashLock.then(run, run);
    trashLock = next.catch(() => undefined);
    return next;
  }

  /**
   * ¿La papelera está de verdad DENTRO de `recordings/`? Un `.papelera` que
   * sea un junction hacia una carpeta hermana resuelve hacia fuera, y con él
   * `read` serviría bytes ajenos y `purgeTrash` BORRARÍA archivos ajenos. Se
   * comprueba en cada operación que toque la papelera; si no pasa, la papelera
   * se trata como inexistente: mejor no reutilizarla que reutilizarla mal.
   */
  async function trashOk(): Promise<boolean> {
    return isRealPathWithin(trashDir(), dir());
  }

  async function save(name: string, bytes: Uint8Array): Promise<string> {
    const safe = sanitizeRecordingName(name);
    const target = resolve(join(dir(), safe));
    // Coherente con las demás guardas: el sanitizado quita separadores, pero la
    // comprobación de contención no depende de que la regex acierte siempre.
    if (!(await isRealPathWithin(target, dir()))) {
      throw new Error('recording:save solo escribe dentro de la carpeta de grabaciones');
    }
    await mkdir(dir(), { recursive: true });
    await writeFile(target, bytes);
    return safe;
  }

  async function read(file: string): Promise<ArrayBuffer> {
    // El fallback a la papelera solo existe si la papelera es de verdad: un
    // `.papelera` plantado como junction hacia fuera no puede servir bytes.
    const candidates: [string, string][] = [[resolve(join(dir(), file)), dir()]];
    if (await trashOk()) candidates.push([resolve(join(trashDir(), file)), trashDir()]);
    let guarded = false;
    for (const [target, root] of candidates) {
      if (!(await isRealPathWithin(target, root))) continue;
      guarded = true;
      try {
        const buf = await readFile(target);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      } catch {
        // No está en esta carpeta: sigue la papelera.
      }
    }
    // Nadie pasó la guarda: el nombre se sale de las carpetas. Este error es
    // el de siempre, no uno de «no encontrado» — es la diferencia entre
    // «ya no está» y «me estás pidiendo leer fuera».
    if (!guarded) {
      throw new Error('recording:read solo sirve archivos de la carpeta de grabaciones');
    }
    throw new Error(`recording:read no encontró el archivo: ${file}`);
  }

  async function discardLocked(files: readonly string[]): Promise<string[]> {
    if (!(await trashOk())) return [];
    await mkdir(trashDir(), { recursive: true });
    const discarded: string[] = [];
    for (const file of files) {
      const from = resolve(join(dir(), file));
      // La misma guarda que `read`, en las DOS puntas: ni se sale a leer, ni
      // se sale a escribir la papelera.
      if (!(await isRealPathWithin(from, dir()))) continue;
      const to = resolve(join(trashDir(), file));
      if (!(await isRealPathWithin(to, trashDir()))) continue;
      try {
        // ¿Sigue en la carpeta viva? Si no, puede que una confirmación anterior
        // ya lo haya movido: si está en la papelera es exactamente el estado
        // pedido y cuenta como hecho.
        await stat(from);
      } catch {
        try {
          await stat(to);
          discarded.push(file);
        } catch {
          /* ni está ni se espera: no se confirma */
        }
        continue;
      }
      try {
        // Primero la FECHA de la ventana y después el movimiento. Si la fecha
        // no se puede registrar, el descarte NO se confirma: un archivo en la
        // papelera sin reloj de retención se purgaría por su fecha de
        // escritura —la ventana desaparecería en el primer arranque—, que es
        // peor que dejarlo vivo y reintentarlo en el próximo barrido. Y poniendo
        // la fecha antes del `rename` no queda ventana de crash entre las dos:
        // el archivo o está vivo (sin mover) o está en la papelera YA fechado.
        await utimes(from, new Date(), new Date());
      } catch {
        // No se pudo fechar: puede que otra confirmación cruzada ya haya
        // movido el archivo (el `utimes` falla también sobre un `from` que ya
        // no existe) — si está en la papelera, el estado pedido se cumplió.
        try {
          await stat(to);
          discarded.push(file);
        } catch {
          /* sin fecha no hay descarte: sigue vivo y no se confirma */
        }
        continue;
      }
      try {
        // `rename` es atómico y SUSTITUYE destino existente (libuv lo hace con
        // MOVEFILE_REPLACE_EXISTING en Windows; en POSIX la sustitución es
        // atómica por definición). NO hay `rm` previo a propósito: entre un
        // `rm` y el `rename`, otra confirmación cruzada puede dejar su copia en
        // la papelera y el `rm` se la borraría — pérdida de audio reproducida
        // con dos discard en paralelo sobre la misma carpeta. Si ya había uno
        // con ese nombre, se pisa: con nombres por contenido, mismo nombre es
        // el MISMO contenido (lo distinto con ese nombre ya se pisó en la
        // carpeta viva, antes de que existiera esta papelera).
        await rename(from, to);
        discarded.push(file);
      } catch {
        // No se movió (una confirmación cruzada se llevó el archivo, disco,
        // permisos): si ya está en la papelera el estado pedido se cumplió
        // igual; si no, sigue donde estaba, no se confirma y el libro del
        // renderer lo reintenta en el próximo barrido.
        try {
          await stat(to);
          discarded.push(file);
        } catch {
          /* no se confirma */
        }
      }
    }
    return discarded;
  }

  /** `discard`, serializado con la purga (ver `withTrashLock`). */
  function discard(files: readonly string[]): Promise<string[]> {
    return withTrashLock(() => discardLocked(files));
  }

  async function purgeTrashLocked(
    now = Date.now(),
    // Los límites se pueden inyectar para TESTS (probar el tope de bytes sin
    // escribir dos gigas); los de producción y su medición, en la cabecera.
    limits: { ttlMs: number; maxBytes: number } = {
      ttlMs: RECORDINGS_TRASH_TTL_MS,
      maxBytes: RECORDINGS_TRASH_MAX_BYTES,
    },
  ): Promise<{ removed: string[]; bytes: number }> {
    // La papelera primero: un `.papelera` junctionado hacia fuera convierte
    // esta función en un borrador de archivos ajenos.
    if (!(await trashOk())) return { removed: [], bytes: 0 };
    let entries;
    try {
      entries = await readdir(trashDir(), { withFileTypes: true });
    } catch {
      return { removed: [], bytes: 0 };
    }
    const files: { file: string; bytes: number; at: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const info = await stat(join(trashDir(), entry.name));
        files.push({ file: entry.name, bytes: info.size, at: info.mtimeMs });
      } catch {
        /* desapareció entre readdir y stat */
      }
    }
    // Más viejo primero: la retención es la que da sentido al tope de bytes.
    files.sort((a, b) => a.at - b.at);
    const removed: string[] = [];
    let bytes = files.reduce((sum, f) => sum + f.bytes, 0);
    for (const f of files) {
      const tooOld = now - f.at > limits.ttlMs;
      const tooBig = bytes > limits.maxBytes;
      if (!tooOld && !tooBig) continue;
      try {
        // Re-`stat` justo antes de tirar: el `stat` de la enumeración puede ser
        // rancio (otro proceso, otra instancia de test), y tirar con
        // metadatos viejos borraría una baja NUEVA con su ventana recién
        // puesta. Con la exclusión de arriba esto no puede pasar dentro del
        // almacén; aquí se cierra también el borde de dos instancias.
        const fresh = await stat(join(trashDir(), f.file));
        if (fresh.mtimeMs !== f.at) continue;
        await rm(join(trashDir(), f.file), { force: true });
        removed.push(f.file);
        bytes -= f.bytes;
      } catch {
        /* no se pudo tirar: se queda, que es la opción conservadora */
      }
    }
    return { removed, bytes };
  }

  /** `purgeTrash`, serializado con los descartes (ver `withTrashLock`). */
  function purgeTrash(
    now?: number,
    limits?: { ttlMs: number; maxBytes: number },
  ): Promise<{ removed: string[]; bytes: number }> {
    return withTrashLock(() => purgeTrashLocked(now, limits));
  }

  return { save, read, discard, purgeTrash };
}
