/**
 * El almacén de grabaciones (`main/recording-store.ts`) contra una carpeta
 * temporal de verdad, sin Electron. Lo que se fija aquí:
 *
 *  1. `discard` es una baja REVERSIBLE: mueve a `.papelera/` y `read` lo sigue
 *     sirviendo desde ahí — sin el fallback, «reversible» es una palabra.
 *  2. Los bordes que ya costaron: fallo parcial (lo movido se confirma y lo
 *     demás no), archivo ya movido por una confirmación anterior, y rutas que
 *     se salen de `recordings/` (rechazadas en read Y en discard).
 *  3. La purga por antigüedad y por bytes, con los umbrales medidos que
 *     documenta el módulo (y con límites inyectables para probar el de bytes
 *     sin escribir dos gigas).
 *  4. El nombre de archivo acotado: con el hash de contenido encima se pasó
 *     del límite de componente y `writeFile` fallaba con ENOENT. El recorte
 *     conserva digest y extensión completos, y dos contenidos distintos no
 *     pueden quedar con el mismo nombre.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECORDING_NAME_BASE_BUDGET_BYTES,
  RECORDINGS_TRASH,
  RECORDINGS_TRASH_TTL_MS,
  createRecordingStore,
  sanitizeRecordingName,
} from '../src/main/recording-store';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbit-rec-'));
});

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

const store = () => createRecordingStore(() => root);

const bytes = (fill: number, length = 64) => new Uint8Array(length).fill(fill);

async function listarRelativo(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe('save/read: escribir y volver a leer', () => {
  it('el primer save a una carpeta que aún no existe pasa la guarda', async () => {
    // El repro de la sonda de revisión: `save` guarda ANTES de crear la
    // carpeta, y con la base inexistente la comparación se desalineaba. Aquí
    // además el padre se alcanza por DOS nombres distintos —lo que en el repro
    // era el alias corto de `%TEMP%` (MXRNIN~1 vs su forma larga), aquí un
    // link a la carpeta real—: resolver el destino por ancestro real y la base
    // a pelo deja las dos cadenas apuntando al mismo sitio sin que la
    // comparación lo vea.
    const real = await mkdtemp(join(tmpdir(), 'orbit-rec-real-'));
    const alias = join(tmpdir(), `orbit-rec-alias-${Date.now()}`);
    await symlink(real, alias, 'junction');
    try {
      const s = createRecordingStore(() => join(alias, 'recordings'));
      const file = await s.save('primera.wav', bytes(5));
      expect(new Uint8Array(await s.read(file))).toEqual(bytes(5));
      // Y el archivo vive de verdad en la carpeta REAL.
      expect(new Uint8Array(await readFile(join(real, 'recordings', file)))).toEqual(bytes(5));
    } finally {
      await rm(alias, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });

  it('roundtrip por nombre, con sanitizado del nombre', async () => {
    const s = store();
    const file = await s.save('Toma rara: ¿sí?.wav', bytes(7));
    expect(file).toBe('Toma rara- ¿sí-.wav');
    const read = new Uint8Array(await s.read(file));
    expect(read).toEqual(bytes(7));
  });

  it('lo que no está, no está: error claro, no un ENOENT crudo', async () => {
    await expect(store().read('nunca-existio.wav')).rejects.toThrow(/no encontró/);
  });
});

describe('discard: baja REVERSIBLE, no borrado', () => {
  it('mueve a la papelera y read lo sigue sirviendo desde ahí', async () => {
    const s = store();
    const file = await s.save('toma.wav', bytes(1));
    const discarded = await s.discard([file]);

    expect(discarded).toEqual([file]);
    // Ya no está en la carpeta viva…
    expect(await listarRelativo(root)).toEqual([RECORDINGS_TRASH]);
    // …pero el audio sigue vivo: es el contrato de reversibilidad.
    expect(new Uint8Array(await s.read(file))).toEqual(bytes(1));
    expect(await listarRelativo(join(root, RECORDINGS_TRASH))).toEqual([file]);
  });

  it('un archivo ya movido por una confirmación anterior cuenta como hecho', async () => {
    const s = store();
    const file = await s.save('toma.wav', bytes(1));
    await s.discard([file]);
    // Segunda confirmación (dos planes que se cruzaron): no revienta y el
    // estado pedido —en la papelera— se reconoce como cumplido.
    await expect(s.discard([file])).resolves.toEqual([file]);
  });

  it('fallo parcial: lo movido se confirma, lo ausente no, y nada se atasca', async () => {
    const s = store();
    const a = await s.save('a.wav', bytes(1));
    const b = await s.save('b.wav', bytes(2));

    const discarded = await s.discard([a, 'no-existe.wav', b]);

    expect(discarded).toEqual([a, b]);
    expect(await listarRelativo(join(root, RECORDINGS_TRASH))).toEqual([a, b].sort());
  });

  it('dos descartes cruzados del mismo archivo no pierden el audio', async () => {
    // La carrera que costó un dato perdido: dos planes que se cruzan sobre el
    // MISMO nombre. Con un `rm` previo al `rename`, el segundo borraba la
    // copia que el primero acababa de mover y luego fallaba su rename — el
    // archivo no quedaba ni vivo ni en la papelera. Con `rename` atómico no
    // hay ventana de pérdida: solo puede quedar una copia, y queda.
    for (let i = 0; i < 20; i++) {
      const nombre = `cruzado-${i}.wav`;
      const s1 = store();
      const s2 = store();
      await s1.save(nombre, bytes(i));

      const [r1, r2] = await Promise.all([s1.discard([nombre]), s2.discard([nombre])]);

      // Al menos una confirmación, y el audio legible en la papelera.
      expect([...r1, ...r2].length).toBeGreaterThan(0);
      expect(new Uint8Array(await s1.read(nombre))).toEqual(bytes(i));
      expect(await listarRelativo(root)).not.toContain(nombre);
    }
  });

  it('si la fecha de retención no se puede registrar, no se descarta y el archivo sigue vivo', async () => {
    // `utimes` revienta (EPERM de permisos, FS raro): sin fecha no hay ventana
    // de reversibilidad, y un archivo en la papelera sin reloj se purgaría por
    // su fecha de ESCRITURA —confirmar el descarte aquí es confirmar una
    // pérdida—. Se queda vivo y el libro del renderer lo reintenta.
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs/promises')>();
      return { ...real, utimes: () => Promise.reject(new Error('EPERM')) };
    });
    const { createRecordingStore } = await import('../src/main/recording-store');
    const s = createRecordingStore(() => root);
    const file = await s.save('viejo.wav', bytes(1));

    await expect(s.discard([file])).resolves.toEqual([]);
    expect(await listarRelativo(root)).toContain(file);
    expect(new Uint8Array(await s.read(file))).toEqual(bytes(1));
  });

  it('una purga suspendida entre su stat y su rm no borra una baja posterior', async () => {
    // La repro de la sonda de revisión, hecha determinista: la purga saca el
    // `stat` de una copia VIEJA de la papelera y queda pendiente; un descarte
    // la sustituye por una baja NUEVA con su ventana recién puesta; la purga
    // sigue con metadatos RANCIOS. El re-stat justo antes de tirar es el que
    // lo cierra —y la exclusión por almacén evita que el entrelazado exista
    // dentro de una instancia—. Aquí el descarte va por OTRA instancia, que es
    // el caso que la exclusión no cubre.
    const file = 'misma-copia.wav';
    const s = store();
    await s.save(file, bytes(1));
    await s.discard([file]);
    const hace = new Date(Date.now() - RECORDINGS_TRASH_TTL_MS * 2);
    await utimes(join(root, RECORDINGS_TRASH, file), hace, hace);
    await s.save(file, bytes(2)); // la baja nueva, mismo nombre

    // Se congela la purga en el `stat` de su enumeración: captura el mtime
    // viejo y se queda esperando.
    let purgaEnSuStat: () => void = () => undefined;
    const enStat = new Promise<void>((r) => (purgaEnSuStat = r));
    let soltarPurga: () => void = () => undefined;
    const libre = new Promise<void>((r) => (soltarPurga = r));
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs/promises')>();
      let primero = true;
      return {
        ...real,
        stat: async (p: Parameters<typeof real.stat>[0]) => {
          const info = await real.stat(p);
          if (primero && String(p).includes(RECORDINGS_TRASH)) {
            primero = false;
            purgaEnSuStat();
            await libre;
          }
          return info;
        },
      };
    });
    const { createRecordingStore } = await import('../src/main/recording-store');
    const s1 = createRecordingStore(() => root);
    const s2 = createRecordingStore(() => root);

    const purga = s1.purgeTrash();
    await enStat; // la purga ya tiene el stat viejo y está parada
    const descarte = await s2.discard([file]); // la baja nueva, completa
    expect(descarte).toEqual([file]);
    soltarPurga(); // la purga sigue con sus metadatos rancios
    await purga;

    // La copia recién descartada está viva en la papelera: con los metadatos
    // rancios, la purga la habría borrado y el audio no quedaría ni vivo ni
    // descartado.
    expect(new Uint8Array(await s1.read(file))).toEqual(bytes(2));
  });

  it('una ruta que se sale de recordings no se toca, ni se lee ni se descarta', async () => {
    const s = store();
    // Un archivo FUERA de la carpeta de grabaciones, como si el renderer
    // intentara leer/descartar `../otra-cosa.wav`.
    const fuera = join(root, '..', 'orbit-rec-fuera.wav');
    await writeFile(fuera, bytes(9));
    try {
      await expect(s.read('../orbit-rec-fuera.wav')).rejects.toThrow(
        /solo sirve archivos de la carpeta de grabaciones/,
      );
      const discarded = await s.discard(['../orbit-rec-fuera.wav']);
      expect(discarded).toEqual([]);
      // Intacto donde estaba.
      expect(new Uint8Array(await readFile(fuera))).toEqual(bytes(9));
    } finally {
      await rm(fuera, { force: true });
    }
  });
});

describe('purgeTrash: la papelera no es la fuga con otro nombre', () => {
  it('tira lo que pasa de la ventana de retención, y solo eso', async () => {
    const s = store();
    const viejo = await s.save('viejo.wav', bytes(1));
    const nuevo = await s.save('nuevo.wav', bytes(2));
    await s.discard([viejo, nuevo]);
    const trash = join(root, RECORDINGS_TRASH);
    const hace = (ms: number) => new Date(Date.now() - ms);
    await utimes(join(trash, viejo), hace(RECORDINGS_TRASH_TTL_MS * 2), hace(RECORDINGS_TRASH_TTL_MS * 2));

    const { removed } = await s.purgeTrash();

    expect(removed).toEqual([viejo]);
    expect(await listarRelativo(trash)).toEqual([nuevo]);
  });

  it('la ventana corre desde el DESCARTE: un archivo viejo descartado hoy tiene sus 90 días', async () => {
    const s = store();
    const file = await s.save('viejo.wav', bytes(1));
    // Escrito hace MÁS de la ventana…
    const hace = new Date(Date.now() - (RECORDINGS_TRASH_TTL_MS + 24 * 60 * 60 * 1000));
    await utimes(join(root, file), hace, hace);
    // …pero descartado HOY. Si el reloj de la retención fuera el de la
    // escritura, la reversibilidad perdería su ventana en el primer arranque.
    await s.discard([file]);

    const { removed } = await s.purgeTrash();

    expect(removed).toEqual([]);
    expect(await listarRelativo(join(root, RECORDINGS_TRASH))).toEqual([file]);
  });

  it('con el tope de bytes pisado, tira lo más viejo primero', async () => {
    const s = store();
    const primero = await s.save('primero.wav', bytes(1, 300));
    const segundo = await s.save('segundo.wav', bytes(2, 300));
    await s.discard([primero, segundo]);

    // Los dos pesan 600; con techo 500 el más viejo es el que se va. Los
    // límites se inyectan para no escribir dos gigas de verdad: el valor de
    // producción y su medida, en la cabecera del módulo.
    const { removed } = await s.purgeTrash(Date.now(), {
      ttlMs: RECORDINGS_TRASH_TTL_MS,
      maxBytes: 500,
    });

    expect(removed).toEqual([primero]);
    expect(await listarRelativo(join(root, RECORDINGS_TRASH))).toEqual([segundo]);
  });

  it('sin papelera no hay nada que purgar', async () => {
    await expect(store().purgeTrash()).resolves.toEqual({ removed: [], bytes: 0 });
  });
});

describe('una papelera plantada como junction hacia fuera no vale', () => {
  /**
   * `.papelera` → carpeta HERMANA (fuera de `recordings/`). Con un junction
   * así, sin la comprobación de contención de la papelera misma, `read`
   * serviría bytes de fuera y `purgeTrash` borraría archivos ajenos.
   */
  async function papeleraJunctionada(): Promise<string> {
    const hermana = await mkdtemp(join(tmpdir(), 'orbit-rec-fuera-'));
    await writeFile(join(hermana, 'outside.wav'), bytes(9, 3));
    // 'junction' funciona sin privilegios en Windows; en Linux es un symlink.
    await symlink(hermana, join(root, RECORDINGS_TRASH), 'junction');
    return hermana;
  }

  it('read no sirve bytes de la carpeta de fuera', async () => {
    const hermana = await papeleraJunctionada();
    try {
      await expect(store().read('outside.wav')).rejects.toThrow(/no encontró/);
    } finally {
      await rm(hermana, { recursive: true, force: true });
    }
  });

  it('purgeTrash no borra archivos de la carpeta de fuera', async () => {
    const hermana = await papeleraJunctionada();
    try {
      await expect(store().purgeTrash()).resolves.toEqual({ removed: [], bytes: 0 });
      expect(await listarRelativo(hermana)).toEqual(['outside.wav']);
    } finally {
      await rm(hermana, { recursive: true, force: true });
    }
  });

  it('discard no mueve nada hacia la carpeta de fuera', async () => {
    const hermana = await papeleraJunctionada();
    const s = store();
    const file = await s.save('viva.wav', bytes(1));
    try {
      await expect(s.discard([file])).resolves.toEqual([]);
      // Sigue viva donde estaba: mejor no dar de baja que darla hacia fuera.
      expect(new Uint8Array(await s.read(file))).toEqual(bytes(1));
      expect(await listarRelativo(hermana)).toEqual(['outside.wav']);
    } finally {
      await rm(hermana, { recursive: true, force: true });
    }
  });
});

describe('el nombre se acota conservando el digest', () => {
  it('una etiqueta de 220 caracteres + sha1 cabe: el digest y la extensión van completos', () => {
    const etiqueta = 'Pista ' + 'x'.repeat(220);
    const digest = 'a'.repeat(40);
    const file = sanitizeRecordingName(`${etiqueta} ${digest}.wav`);

    // Con el nombre sin acotar esto eran 271 caracteres y `writeFile` fallaba
    // con ENOENT (el componente de NTFS acota a 255; ext4 acota a 255 bytes).
    expect(file.endsWith(` ${digest}.wav`)).toBe(true);
    expect(file.length).toBeLessThanOrEqual(RECORDING_NAME_BASE_BUDGET_BYTES + 45);
    expect(new TextEncoder().encode(file).length).toBeLessThanOrEqual(255);
  });

  it('el recorte va por DELANTE: recortar la cola dejaría dos contenidos con el mismo nombre', () => {
    const etiqueta = 'Pista ' + 'x'.repeat(220);
    const a = sanitizeRecordingName(`${etiqueta} ${'a'.repeat(40)}.wav`);
    const b = sanitizeRecordingName(`${etiqueta} ${'b'.repeat(40)}.wav`);
    expect(a).not.toBe(b);
  });

  it('un nombre corto no se toca', () => {
    expect(sanitizeRecordingName('Toma 14.03.22 Voz.wav')).toBe('Toma 14.03.22 Voz.wav');
  });

  it('con emoji y CJK el recorte corta por puntos de código y sigue cabiendo en bytes', () => {
    const etiqueta = '🎹'.repeat(120);
    const digest = 'c'.repeat(40);
    const file = sanitizeRecordingName(`${etiqueta} ${digest}.wav`);
    expect(file.endsWith(` ${digest}.wav`)).toBe(true);
    // 200 bytes de base + espacio + digest + extensión: dentro de los 255
    // bytes de ext4 y de los 255 caracteres de NTFS.
    expect(new TextEncoder().encode(file).length).toBeLessThanOrEqual(255);
    expect(file).toContain('🎹'); // el punto de código no quedó partido
  });

  it('dos escrituras largas de contenido distinto son dos archivos de verdad', async () => {
    const s = store();
    const etiqueta = 'Pista ' + 'x'.repeat(220);
    const uno = await s.save(`${etiqueta} ${'a'.repeat(40)}.wav`, bytes(1));
    const dos = await s.save(`${etiqueta} ${'b'.repeat(40)}.wav`, bytes(2));

    expect(uno).not.toBe(dos);
    expect(new Uint8Array(await s.read(uno))).toEqual(bytes(1));
    expect(new Uint8Array(await s.read(dos))).toEqual(bytes(2));
    // Y caben en disco de verdad: esto fallaba con ENOENT antes de acotar.
    expect((await stat(join(root, uno))).size).toBe(64);
    expect((await stat(join(root, dos))).size).toBe(64);
  });
});
