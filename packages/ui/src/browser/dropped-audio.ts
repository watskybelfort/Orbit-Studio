/**
 * Archivos de audio soltados desde el Explorador del sistema.
 *
 * La pregunta que abría esto era de seguridad: el proceso principal desconfía a
 * propósito de las rutas que le pasa el renderer —las carpetas de sonidos solo
 * entran por el diálogo nativo, y `folder:read` no sirve nada que caiga fuera
 * de ellas—, porque en este renderer corre código que no es nuestro: los
 * plugins JS del usuario. Aceptar "lee este archivo, te paso la ruta" habría
 * convertido un plugin de tremolo en un lector del disco entero.
 *
 * La respuesta es que NO HACE FALTA abrir esa puerta. Un arrastre de verdad
 * trae objetos `File`, que son `Blob`: los bytes se leen aquí mismo porque
 * Chromium los concede al haber un gesto físico del usuario sobre la ventana.
 * El main no ve una ruta, no lee nada y no se entera de que esto existe.
 *
 * Lo que sí hay que resolver es el día siguiente: un `File` soltado se acaba
 * cuando se cierra la app, y un proyecto que apunte a él saldría MUDO al
 * reabrirlo. Por eso lo que se suelta se IMPORTA — los bytes se copian a la
 * carpeta de la app, la misma donde ya viven las tomas y los bounces— y a
 * partir de ahí es un sample más: rehidrata al reabrir, viaja por hash a una
 * sala de colaboración y sale en el export. El original puede estar en un USB
 * que mañana no esté.
 */

import type { SoundEntry } from '@orbit/sound-library';
import { sha1Hex } from './sound-actions';

/**
 * Lo que se acepta soltar. Es la MISMA lista que escanea el main en una carpeta
 * registrada (`AUDIO_EXT`), y lo es a propósito: las dos puertas por las que
 * entra audio de fuera tienen que decir que sí a las mismas cosas, o el usuario
 * descubre que un `.m4a` se ve en el Browser y no se puede soltar (o al revés)
 * sin ninguna razón que pueda adivinar.
 */
export const DROPPABLE_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac'] as const;

/**
 * Tope de archivos por arrastre. Coincide con el de zonas de un keymap: soltar
 * más no es un instrumento, es una librería, y quien suelta una carpeta de mil
 * prefiere que se lo digan a que la app se quede pensando un minuto.
 */
export const MAX_DROPPED_FILES = 128;

/**
 * Tope por archivo. No es una guarda de seguridad —los bytes ya están en el
 * proceso—, es que un sample de 256 MB no es un sample: es alguien que ha
 * soltado el archivo que no era, y leerlo entero, hashearlo y copiarlo congela
 * la ventana un buen rato antes de que se note el error.
 */
export const MAX_DROPPED_BYTES = 256 * 1024 * 1024;

/** Un archivo que no entra, y por qué (se le enseña al usuario tal cual). */
export interface RejectedFile {
  name: string;
  reason: string;
}

export interface DropTriage {
  /** Los que se van a importar, en el orden en que llegaron. */
  accepted: File[];
  rejected: RejectedFile[];
  /** Cuántas CARPETAS venían en el arrastre (esas tienen otro camino). */
  folders: number;
}

/** La extensión en minúsculas, con el punto, o cadena vacía si no tiene. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** El nombre sin la extensión (lo que se le enseña a la gente). */
export function stemOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/**
 * Por qué NO entra este archivo, o `null` si entra.
 *
 * Se decide por el nombre y el tamaño y nada más: mirar dentro costaría leerlo,
 * y de eso ya se encarga el decodificador del motor, que es quien sabe de
 * verdad si un `.wav` es un `.wav`.
 */
export function rejectionReason(file: { name: string; size: number }): string | null {
  const ext = extensionOf(file.name);
  if (ext === '') return 'sin extensión: no se sabe qué es';
  if (!(DROPPABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `${ext} no es audio que Orbit sepa abrir`;
  }
  if (file.size === 0) return 'está vacío';
  if (file.size > MAX_DROPPED_BYTES) {
    return `pesa ${(file.size / 1024 / 1024).toFixed(0)} MB (el tope son ${MAX_DROPPED_BYTES / 1024 / 1024})`;
  }
  return null;
}

/** ¿Este arrastre trae archivos del sistema (y no una selección del Browser)? */
export function hasSystemFiles(dt: DataTransfer): boolean {
  return dt.types.includes('Files');
}

/**
 * Reparte lo que trae un arrastre en lo que entra, lo que no y por qué.
 *
 * **Tiene que llamarse DENTRO del manejador del drop, antes de cualquier
 * `await`.** `webkitGetAsEntry` es lo único que distingue una carpeta de un
 * archivo, y solo responde mientras el evento está vivo: en cuanto se cede el
 * turno, `dataTransfer` se vacía y una carpeta pasa por archivo raro. De ahí
 * que esto sea síncrono y devuelva datos planos en vez de leer nada.
 */
export function triageDrop(dt: DataTransfer): DropTriage {
  const accepted: File[] = [];
  const rejected: RejectedFile[] = [];
  let folders = 0;

  // `items` es lo que sabe de carpetas; `files` es el respaldo cuando no lo hay
  // (y en los tests). Se recorre uno de los dos, nunca los dos: cada archivo
  // aparece en ambos y contarlo dos veces lo importaría dos veces.
  const items = dt.items;
  const entradas: { file: File | null; carpeta: boolean }[] = [];
  if (items && items.length > 0) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.() ?? null;
      entradas.push({ file: item.getAsFile(), carpeta: entry?.isDirectory === true });
    }
  } else {
    for (const file of Array.from(dt.files)) entradas.push({ file, carpeta: false });
  }

  for (const { file, carpeta } of entradas) {
    if (carpeta) {
      folders++;
      continue;
    }
    if (!file) continue;
    if (accepted.length >= MAX_DROPPED_FILES) {
      rejected.push({ name: file.name, reason: `pasa del tope de ${MAX_DROPPED_FILES}` });
      continue;
    }
    const motivo = rejectionReason(file);
    if (motivo === null) accepted.push(file);
    else rejected.push({ name: file.name, reason: motivo });
  }

  return { accepted, rejected, folders };
}

/**
 * Con qué nombre se guarda un archivo importado: su CONTENIDO.
 *
 * No lleva el nombre original, y las dos razones pesan:
 *
 * 1. Dos archivos distintos se llaman `kick.wav` todos los días. Guardar por
 *    nombre haría que el segundo pisara al primero, y el proyecto de la semana
 *    pasada sonaría de repente con otro kick sin que nada avisara.
 * 2. Al revés, el MISMO archivo soltado dos veces cae en el mismo nombre, con
 *    el mismo id, y el proyecto no acaba con cuatro copias del mismo bombo.
 *
 * Y hay una tercera que solo se ve tocando: el auto-mapa saca la nota del
 * nombre del archivo. Un `Piano_C3-ab12cd.wav` le da a leer un `ab12cd` lleno
 * de letras que son notas y números que son octavas. El nombre bueno viaja
 * aparte, en `name`, y el del disco no dice nada a propósito.
 */
export function storedNameFor(hash: string, extension: string): string {
  return `importado-${hash}${extension}`;
}

/** Lo que salió de importar un arrastre. */
export interface ImportResult {
  /** Listas para pasar a `addKeymapZones`, `addSamplerChannels` o la playlist. */
  entries: SoundEntry[];
  failed: RejectedFile[];
}

/**
 * Copia a la carpeta de la app lo que se soltó y devuelve entradas de sonido
 * normales, indistinguibles de las de un pack.
 *
 * Se lee de una en una y no en paralelo: son copias a disco de archivos que
 * pueden pesar cientos de megas, y lanzarlas todas a la vez no las hace más
 * rápidas — hace que la ventana se quede sin memoria con veinte a medias.
 */
export async function importDroppedAudio(files: readonly File[]): Promise<ImportResult> {
  const api = window.orbit;
  if (!api) throw new Error('Importar archivos solo funciona dentro de Electron');
  const entries: SoundEntry[] = [];
  const failed: RejectedFile[] = [];

  for (const file of files) {
    try {
      const bytes = await file.arrayBuffer();
      const hash = await sha1Hex(bytes);
      if (hash === null) throw new Error('sin WebCrypto para identificar el archivo');
      const stored = storedNameFor(hash, extensionOf(file.name));
      // El main sanea el nombre y devuelve el que usó de verdad: se guarda ese,
      // no el que se pidió, o la ruta del proyecto apuntaría a donde no es.
      const escrito = await api.recording.save(stored, new Uint8Array(bytes));
      entries.push({
        id: `recording:${stemOf(escrito)}`,
        // El nombre que traía, que es el que la gente reconoce en la lista de
        // zonas — y del que el auto-mapa saca la nota.
        name: stemOf(file.name),
        // La categoría no la mira nadie en este camino: estas entradas se
        // fabrican al soltar y no llegan nunca al Browser. El tipo la pide.
        category: 'instrumentos',
        file: escrito,
        tags: [],
        // La de verdad la pone el motor al decodificar (`realDuration`), igual
        // que con los archivos de "Tus carpetas".
        durationSec: 0,
      });
    } catch (err) {
      failed.push({ name: file.name, reason: err instanceof Error ? err.message : 'no se pudo leer' });
    }
  }

  return { entries, failed };
}

/**
 * El resto del camino después del triaje: importa lo aceptado y deja los
 * avisos ya juntos, los del triaje y los de la copia.
 *
 * Va aparte de `triageDrop` porque el reparto tiene que ser SÍNCRONO —dentro
 * del manejador del drop, antes del primer await— y esto no. Partirlo en dos
 * es lo que deja esa regla a la vista en cada destino, en vez de escondida
 * dentro de una función que parece que se puede llamar cuando sea.
 */
export async function importTriaged(
  triage: DropTriage,
): Promise<{ entries: SoundEntry[]; avisos: string[] }> {
  if (triage.accepted.length === 0) {
    return { entries: [], avisos: describeTriage(triage, []) };
  }
  const { entries, failed } = await importDroppedAudio(triage.accepted);
  return { entries, avisos: describeTriage(triage, failed) };
}

/** Lo que hay que contarle al usuario de un arrastre que no entró entero. */
export function describeTriage(triage: DropTriage, failed: readonly RejectedFile[]): string[] {
  const avisos: string[] = [];
  if (triage.folders > 0) {
    // Una carpeta no se importa archivo a archivo: se REGISTRA, y así se
    // indexa entera, se busca y no se duplica en el disco de nadie.
    avisos.push(
      triage.folders === 1
        ? 'Una carpeta no entra soltándola: añádela en el Browser → Añadir carpeta'
        : `${triage.folders} carpetas no entran soltándolas: añádelas en el Browser → Añadir carpeta`,
    );
  }
  for (const r of [...triage.rejected, ...failed]) avisos.push(`${r.name}: ${r.reason}`);
  return avisos;
}
