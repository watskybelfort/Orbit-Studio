/**
 * Escritura ATÓMICA de un archivo: se escribe a un temporal en el MISMO
 * directorio y se sustituye con un `rename`.
 *
 * **Por qué.** Escribir directamente el destino lo TRUNCA en cuanto falla a
 * medias: sin espacio en disco, un fallo de E/S o el proceso muriendo durante
 * la escritura, el archivo bueno deja de existir y queda uno que no abre. Con
 * una escritura parcial del `.orbit` eso es la canción perdida sin copia:
 * mostrar un error no devuelve el contenido (BUG 040, reproducido con un
 * ENOSPC tras tres bytes: el original quedó con el prefijo del nuevo).
 *
 * **Por qué así.**
 *
 * - **Temporal en el mismo directorio**, no en la carpeta del sistema: el
 *   `rename` solo es atómico dentro del MISMO volumen, y `/tmp` en Linux está
 *   en otro (`EXDEV`). Con el temporal al lado, o el archivo viejo está entero
 *   o el nuevo está entero: nunca hay un tercero.
 * - **`rename` sin borrar antes el destino.** Renombrar encima es la
 *   sustitución (en POSIX por definición; en Windows, libuv usa
 *   `MoveFileExW` con `MOVEFILE_REPLACE_EXISTING`, medido). Un `rm` previo
 *   abriría una ventana en la que el destino ya no está, y cualquier fallo
 *   posterior —el propio `rename` incluido— dejaría al usuario sin archivo.
 *   También perdía datos con dos escrituras cruzadas (ver el papel de
 *   grabaciones, `recording-store.ts`).
 * - **Nombre único por escritura** (`.<archivo>.<uuid>.tmp`): dos escrituras
 *   simultáneas —un guardado manual y el autosave, dos ventanas— no se pisan
 *   el temporal ni se dejan un `.tmp` propietario del otro.
 * - **Ante un fallo se limpia el temporal y se relanza el error.** El destino
 *   sigue siendo el de antes, intacto, y el renderer recibe el motivo.
 */

import { rename, rm, writeFile } from 'node:fs/promises';
import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** Temporal de una escritura, al lado del destino y con nombre único. */
function tempDe(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
}

/**
 * Escribe `data` en `target` sin dejar nunca un destino a medias.
 *
 * @param encoding texto a escribir; omitirlo trata `data` como bytes.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  encoding?: 'utf8',
): Promise<void> {
  const tmp = tempDe(target);
  try {
    await writeFile(tmp, data, encoding ?? undefined);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * El mismo contrato en síncrono, para el arranque temprano (ajustes): también
 * hay un temporal que limpiar si algo falla.
 */
export function writeFileAtomicSync(target: string, data: string): void {
  const tmp = tempDe(target);
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // sin permisos para limpiar el temporal: el destino sigue intacto
    }
    throw err;
  }
}