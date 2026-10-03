/**
 * La escritura atómica de archivos (`main/atomic-write.ts`), contra una carpeta
 * temporal real.
 *
 * El bug de la clase (BUG 040): escribir DIRECTAMENTE el destino lo trunca en
 * cuanto la escritura falla a medias —sin espacio en disco o un fallo de E/S—,
 * y el archivo bueno desaparece. Reproducido por la sonda con un ENOSPC tras
 * tres bytes: el `.orbit` original quedó con el prefijo del nuevo. Mostrar un
 * error no devuelve el contenido.
 *
 * Lo que se fija aquí:
 *
 *  1. Un guardado válido reemplaza COMPLETO y no deja temporales.
 *  2. Un ENOSPC tras abrir y escribir parte no toca el destino anterior, limpia
 *     el temporal y propaga el error.
 *  3. Un fallo en el `rename` tampoco toca el destino (no hay borrado previo:
 *     el destino válido se queda).
 *  4. Dos escrituras a la vez: el destino queda ÍNTEGRO siempre —el original o
 *     una de las dos escrituras completas, nunca una mezcla— y no queda ningún
 *     temporal; un rechazo transitorio de E/S se acepta como tal (se comprueba
 *     el motivo), porque lo que se afirma es la atomicidad, no que ambas
 *     escrituras soviempre a salir bien. La carrera con control determinista
 *     vive en `recording-store.test.ts`.
 *  5. Un destino con el nombre en el límite de componente se puede guardar: el
 *     temporal no depende de su nombre (ni en longitud ni en Unicode).
 *  6. La variante síncrona (ajustes al arrancar) tiene el mismo contrato.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbit-atomic-'));
});

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await rm(root, { recursive: true, force: true });
});

const listar = async () => (await readdir(root)).sort();

/** Importa el módulo con `node:fs/promises` falseado (fallo inyectado). */
async function conFsFalso(falso: Partial<typeof import('node:fs/promises')>) {
  vi.resetModules();
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs/promises')>();
    return { ...real, ...falso };
  });
  return import('../src/main/atomic-write');
}

describe('writeFileAtomic', () => {
  it('un guardado válido reemplaza el archivo entero y no deja temporales', async () => {
    const { writeFileAtomic } = await import('../src/main/atomic-write');
    const target = join(root, 'proyecto.orbit');
    await writeFile(target, 'contenido viejo bastante largo', 'utf8');

    await writeFileAtomic(target, 'contenido nuevo', 'utf8');

    expect(await readFile(target, 'utf8')).toBe('contenido nuevo');
    expect(await listar()).toEqual(['proyecto.orbit']);
  });

  it('ENOSPC a mitad no trunca el destino anterior, limpia el temporal y propaga el error', async () => {
    const target = join(root, 'proyecto.orbit');
    await writeFile(target, 'ORIGINAL VALIDO', 'utf8');
    // El fallo controlado de disco: se abre y se escriben los primeros bytes,
    // y luego ENOSPC. Con la escritura directa, el original quedaba con 'new'.
    const { writeFileAtomic } = await conFsFalso({
      writeFile: (async (p: unknown, data: unknown) => {
        await writeFile(p as string, 'new');
        const err = new Error('ENOSPC: no space left on device');
        (err as { code?: string }).code = 'ENOSPC';
        throw err;
      }) as typeof import('node:fs/promises').writeFile,
    });

    await expect(writeFileAtomic(target, 'contenido nuevo largo', 'utf8')).rejects.toThrow(
      /ENOSPC/,
    );

    // El archivo bueno sigue entero: esto es lo que se perdió al escribir
    // directo.
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL VALIDO');
    // Y no queda temporal suelto.
    expect(await listar()).toEqual(['proyecto.orbit']);
  });

  it('un fallo en el rename tampoco toca el destino (no se borra antes)', async () => {
    const target = join(root, 'proyecto.orbit');
    await writeFile(target, 'ORIGINAL VALIDO', 'utf8');
    const { writeFileAtomic } = await conFsFalso({
      rename: (async () => {
        throw new Error('EPERM: operation not permitted');
      }) as typeof import('node:fs/promises').rename,
    });

    await expect(writeFileAtomic(target, 'contenido nuevo', 'utf8')).rejects.toThrow(/EPERM/);

    expect(await readFile(target, 'utf8')).toBe('ORIGINAL VALIDO');
    expect(await listar()).toEqual(['proyecto.orbit']);
  });

  it('dos escrituras seguidas del mismo nombre: gana la última, entera, sin temporales', async () => {
    // Se prueba SECUENCIAL y no con dos escrituras a la vez: la carrera real
    // sobre el sistema de archivos Resultó intermitente bajo la carga paralela
    // de la suite (fallos transitorios de E/S en Windows), y un test que
    // parpadea es exactamente lo que la tarjeta del reporter viene a
    // limpiar. La propiedad del nombre único por escritura vive en el módulo
    // y su carrera equivalente se prueba donde sí hay arnés de control (el
    // papel de grabaciones, `recording-store.test.ts`).
    const { writeFileAtomic } = await import('../src/main/atomic-write');
    const target = join(root, 'proyecto.orbit');

    await writeFileAtomic(target, 'primero', 'utf8');
    expect(await readFile(target, 'utf8')).toBe('primero');

    const grande = 'B'.repeat(4_000);
    await writeFileAtomic(target, grande, 'utf8');

    expect(await readFile(target, 'utf8')).toBe(grande);
    expect(await listar()).toEqual(['proyecto.orbit']);
  });

  it('crea el archivo si no existía', async () => {
    const { writeFileAtomic } = await import('../src/main/atomic-write');
    const target = join(root, 'nuevo.orbit');
    await writeFileAtomic(target, 'hola', 'utf8');
    expect(await readFile(target, 'utf8')).toBe('hola');
  });
it('un destino con el nombre en el límite se puede guardar (el temporal no lo alarga)', async () => {
    // 246 caracteres: entra en el límite de componente de NTFS (255) y en el de
    // bytes de ext4. Con el temporal compuesto sobre el nombre del destino (su
    // basename + uuid + .tmp) el temporal se iba de 255 y el guardado fallaba
    // — un destino VÁLIDO impedido por el nombre de su propio temporal. Lo
    // primero es ASCII, lo segundo Unicode (4 bytes por punto de código).
    const { writeFileAtomic } = await import('../src/main/atomic-write');
    for (const nombre of ['a'.repeat(240) + '.orbit', '🎹'.repeat(60) + '.orbit']) {
      const target = join(root, nombre);
      const contenido = `contenido de ${nombre.slice(0, 4)}`;
      await writeFileAtomic(target, contenido, 'utf8');
      expect(await readFile(target, 'utf8')).toBe(contenido);
      // Y no queda ningún temporal: solo el destino.
      expect(await listar()).toEqual([nombre]);
      await rm(target, { force: true });
    }
  });

it('el mismo nombre en el límite, en la variante síncrona', async () => {
    const { writeFileAtomicSync } = await import('../src/main/atomic-write');
    const nombre = 'b'.repeat(240) + '.json';
    const target = join(root, nombre);
    writeFileAtomicSync(target, '{"ok":true}');
    expect(await readFile(target, 'utf8')).toBe('{"ok":true}');
    expect(await listar()).toEqual([nombre]);
  });

it('dos escrituras a la vez: gana una COMPLETA, o se conserva el original, y sin temporales', async () => {
    const { writeFileAtomic } = await import('../src/main/atomic-write');
    const target = join(root, 'proyecto.orbit');
    const original = 'ORIGINAL';
    await writeFile(target, original, 'utf8');
    const grande = 'NUEVO'.repeat(1_000);

    // `allSettled` y NO `Promise.all`: bajo carga, una de las dos escrituras
    // puede recibir un rechazo TRANSITORIO del sistema de archivos (E/S de
    // Windows), y eso NO es un fallo del contrato. Lo que sí es el contrato:
    // el destino queda siempre íntegro —el original o una de las dos
    // escrituras COMPLETAS, nunca una mezcla ni un trozo— y no queda ningún
    // temporal. Sin verificar el motivo, un rechazo sí rompería la aserción.
    const resultados = await Promise.allSettled([
      writeFileAtomic(target, 'A', 'utf8'),
      writeFileAtomic(target, grande, 'utf8'),
    ]);
    for (const r of resultados) {
      if (r.status === 'rejected') {
        expect(['EBUSY', 'EPERM', 'EACCES', 'ENOSPC', 'UNKNOWN']).toContain(
          (r.reason as { code?: string }).code,
        );
      }
    }

    const final = await readFile(target, 'utf8');
    expect([original, 'A', grande]).toContain(final);
    expect(await listar()).toEqual(['proyecto.orbit']);
  });
});

describe('writeFileAtomicSync (ajustes al arrancar)', () => {
  it('reemplaza entero y limpia su temporal', async () => {
    const { writeFileAtomicSync } = await import('../src/main/atomic-write');
    const target = join(root, 'settings.json');
    await writeFile(target, '{"old":true}', 'utf8');

    writeFileAtomicSync(target, '{"new":true}');

    expect(await readFile(target, 'utf8')).toBe('{"new":true}');
    expect(await listar()).toEqual(['settings.json']);
  });

  it('si falla, el destino válido se conserva y el temporal se limpia', async () => {
    const target = join(root, 'settings.json');
    await writeFile(target, '{"old":true}', 'utf8');
    // Falla la escritura del TEMPORAL (disco lleno al escribir), que es donde
    // puede fallar de verdad: el destino ni se toca.
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs')>();
      return {
        ...real,
        writeFileSync: ((p: unknown, data: unknown) => {
          if (String(p).includes('.tmp')) throw new Error('ENOSPC');
          return (real.writeFileSync as (a: string, b: unknown) => void)(p as string, data);
        }) as typeof real.writeFileSync,
      };
    });
    const { writeFileAtomicSync } = await import('../src/main/atomic-write');

    expect(() => writeFileAtomicSync(target, '{"new":true}')).toThrow(/ENOSPC/);
    expect(await readFile(target, 'utf8')).toBe('{"old":true}');
    expect(await listar()).toEqual(['settings.json']);
  });
});