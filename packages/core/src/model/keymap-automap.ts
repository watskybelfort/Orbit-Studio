/**
 * Auto-mapa: leer la nota del NOMBRE del archivo y montar el keymap solo.
 *
 * Es la diferencia entre que el multisample se use y que no se use. Soltar
 * veinte muestras de un piano y tener que decirle a cada una qué nota es, y
 * luego arrastrar cuarenta bordes, no lo hace nadie dos veces.
 *
 * Los nombres de sample del mundo real son un pantano —`Piano_C3.wav`,
 * `Gtr-A#2-hard.wav`, `EP C4 v3.wav`, `808_F1.wav`— así que esto se toma en
 * serio los falsos positivos: `Bass2.wav` NO es un si, y `Deep4.wav` no es un
 * re. Un candidato solo cuenta si empieza donde no hay letra ni dígito
 * pegados por delante y le siguen inmediatamente su alteración y su octava.
 *
 * **La octava sigue la convención de la casa: C5 = 60**, la misma que enseña
 * el piano roll. Una librería numerada a la yamaha (C3 = 60) sale dos octavas
 * abajo — entera, no descolocada—, y eso se arregla con el desplazamiento de
 * octavas de las opciones, que es un control y no cuarenta arrastres.
 */

import { createKeymapZone, spreadKeymapRanges, spreadKeymapVelocities, type KeymapZone } from './keymap';
import type { Id } from './types';

const SEMITONE: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
};

/**
 * Candidato a nota dentro de un nombre: letra, alteración opcional y octava.
 * `s` como sostenido lo usan las librerías que no pueden meter `#` en el
 * nombre del archivo (`Cs3.wav`), y `-1` es una octava legal.
 */
const NOTE_TOKEN = /(?:^|[^a-z0-9#])([a-g])(#|b|s)?(-?\d{1,2})/gi;

/**
 * El NOMBRE del archivo, sin la carpeta y sin la extensión.
 *
 * Quitar la carpeta es lo que impide el peor falso positivo de todos: soltar
 * `C:\Packs\Piano C3\take01.wav`, `take02.wav`, `take03.wav`… y que las
 * treinta muestras aterricen en el do de la tercera octava porque la nota está
 * en el NOMBRE DE LA CARPETA. El instrumento entero se apila en una tecla y no
 * hay nada en pantalla que lo explique. Con la carpeta fuera, esas muestras se
 * quedan en "no he sabido leer la nota", que es la verdad.
 *
 * (Sí quita la extensión: `sample.a4` no es un la.)
 */
function baseName(fileName: string): string {
  const cut = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  return fileName.slice(cut + 1).replace(/\.[a-z0-9]+$/i, '');
}

/**
 * Nota MIDI que anuncia un nombre de archivo, o `null` si no anuncia ninguna.
 *
 * Con varios candidatos gana el ÚLTIMO: en `F1_Piano_C3.wav` el `F1` es el pad
 * del que salió la muestra y el `C3` es la nota, y ese orden —contexto delante,
 * nota detrás— es el que se repite en las librerías.
 */
export function parseNoteFromName(fileName: string): number | null {
  const base = baseName(fileName);
  let found: number | null = null;
  NOTE_TOKEN.lastIndex = 0;
  for (let m = NOTE_TOKEN.exec(base); m !== null; m = NOTE_TOKEN.exec(base)) {
    const letter = SEMITONE[m[1]!.toLowerCase()];
    if (letter === undefined) continue;
    const accidental = m[2]?.toLowerCase();
    const shift = accidental === 'b' ? -1 : accidental === '#' || accidental === 's' ? 1 : 0;
    const octave = parseInt(m[3]!, 10);
    const midi = letter + shift + octave * 12; // C5 = 60, convención de la casa
    // Se acepta una octava de margen por cada lado del rango MIDI: un archivo
    // `C-1` viene de la convención científica (C4 = 60) y con esta sale a -12.
    // Devolverlo tal cual deja que el desplazamiento de octavas lo rescate; el
    // que siga fuera después lo descarta el auto-mapa, y lo dice.
    if (midi < -12 || midi > 139) continue;
    found = midi;

    // El token puede solaparse con el siguiente candidato (`C3D4`): se retoma
    // justo después de la letra para no saltarse nada.
    NOTE_TOKEN.lastIndex = m.index + m[0]!.length;
  }
  return found;
}

/**
 * Número MIDI suelto en el nombre (`Piano_60.wav`), para las librerías que
 * numeran en vez de nombrar.
 *
 * Solo se usa cuando NINGÚN nombre del juego traía nota escrita, y aun así el
 * auto-mapa le pide al conjunto que parezca un teclado antes de fiarse (ver
 * `looksLikeNotes`): un número suelto es casi siempre un índice
 * (`Piano_01.wav`) y confundirlo con una nota deja el instrumento amontonado
 * en el sótano del teclado.
 */
export function parseMidiNumberFromName(fileName: string): number | null {
  const base = baseName(fileName);
  const matches = base.match(/(?:^|[^0-9])(\d{1,3})(?![0-9])/g);
  if (!matches) return null;
  let found: number | null = null;
  for (const raw of matches) {
    const n = parseInt(raw.replace(/[^0-9]/g, ''), 10);
    if (n >= 0 && n <= 127) found = n;
  }
  return found;
}

/**
 * Nota más grave que se acepta de una librería NUMERADA. 21 es el la más grave
 * de un piano en la convención científica: por debajo de ahí nadie numera
 * muestras, pero sí empiezan ahí los contadores (`Kit_01`, `Kit_02`…).
 */
const MIN_NUMBERED_ROOT = 21;

/**
 * ¿Estos números sueltos parecen notas, o parecen un contador de tomas?
 *
 * Se les pide dos cosas, y cada una tapa un desastre distinto que se ve al
 * soltar una carpeta entera:
 *  - **repartirse al menos una octava**, porque `take01`, `take02`, `take03`
 *    son tomas y no notas, y colocarlas en las teclas 1, 2 y 3 amontona el
 *    instrumento en el sótano del teclado;
 *  - **no empezar por abajo del todo**, porque `Kit_01`…`Kit_24` sí se
 *    reparten dos octavas y siguen siendo un contador.
 *
 * Con menos de dos muestras no hay forma de distinguirlo, así que no se
 * intenta: mejor decir que no se ha sabido leer.
 */
function looksLikeNotes(values: readonly number[]): boolean {
  if (values.length < 2) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo >= MIN_NUMBERED_ROOT && hi - lo >= 12;
}

export interface AutoMapSample {
  id: Id;
  /**
   * Nombre del archivo. Da igual que traiga extensión o ruta: de la ruta solo
   * se mira el último tramo, a propósito (ver `baseName`).
   */
  name: string;
}

export interface AutoMapOptions {
  /**
   * Octavas que se le suman a lo leído. Para librerías con otra convención de
   * octava (la yamaha, C3 = 60, pide +2).
   */
  octaveOffset?: number;
  /**
   * Repartir por velocidad las muestras que caen en la misma nota. Con
   * `Piano_C3_v1/v2/v3` salen tres capas; el orden alfabético del nombre se
   * toma como de más suave a más fuerte, que es como las numeran todas.
   */
  velocityLayers?: boolean;
}

export interface AutoMapResult {
  /** Zonas listas, con sus rangos ya repartidos. */
  zones: KeymapZone[];
  /** Nombres de los que no se pudo sacar nota (se quedan fuera del mapa). */
  unreadable: string[];
  /** De dónde salió la nota: del nombre escrito o de un número suelto. */
  source: 'name' | 'midi' | 'none';
}

/**
 * Monta el keymap de un juego de muestras leyendo sus nombres.
 *
 * Lo que no sabe leer NO lo coloca en cualquier sitio: sale en `unreadable`
 * para que la UI lo diga. Un instrumento con una nota en el sitio equivocado
 * es peor que un instrumento al que le falta una nota, porque la primera vez
 * que se nota es tocando.
 */
export function autoMapKeymap(
  samples: readonly AutoMapSample[],
  options: AutoMapOptions = {},
): AutoMapResult {
  const offset = Math.round(options.octaveOffset ?? 0) * 12;

  const read = (parse: (name: string) => number | null) => {
    const hits: { sample: AutoMapSample; root: number }[] = [];
    const misses: string[] = [];
    for (const s of samples) {
      const midi = parse(s.name);
      const root = midi === null ? null : midi + offset;
      // Fuera del teclado después del desplazamiento: no se acerca a la tecla
      // más próxima, se deja fuera y se dice. Una nota amontonada en el borde
      // del teclado suena mal y no se ve hasta que se toca.
      if (root === null || root < 0 || root > 127) misses.push(s.name);
      else hits.push({ sample: s, root });
    }
    return { hits, misses };
  };

  let source: AutoMapResult['source'] = 'name';
  let { hits, misses } = read(parseNoteFromName);
  if (hits.length === 0) {
    // Nadie traía nota escrita: se prueba con los números sueltos, y solo si
    // esos números parecen notas de verdad (ver `looksLikeNotes`).
    const numeric = read(parseMidiNumberFromName);
    if (numeric.hits.length > 0 && looksLikeNotes(numeric.hits.map((h) => h.root - offset))) {
      source = 'midi';
      hits = numeric.hits;
      misses = numeric.misses;
    } else {
      return { zones: [], unreadable: samples.map((s) => s.name), source: 'none' };
    }
  }

  // Alfabético dentro de la misma nota: `..._v1` antes que `..._v3`, que es
  // como se numeran las capas de velocidad en todas las librerías.
  hits.sort((a, b) => a.root - b.root || a.sample.name.localeCompare(b.sample.name));

  let zones = hits.map(({ sample, root }) => createKeymapZone(sample.id, { keyRoot: root }));

  zones = spreadKeymapRanges(zones);
  if (options.velocityLayers !== false) zones = spreadKeymapVelocities(zones);
  return { zones, unreadable: misses, source };
}
