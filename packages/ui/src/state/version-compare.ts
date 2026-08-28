/**
 * Qué dos cosas se están comparando.
 *
 * El diff musical de core ya sabía contar lo que cambió entre dos proyectos,
 * pero hasta ahora un lado era siempre el proyecto de AHORA. Comparar dos
 * versiones cualesquiera necesita algo más aburrido y más fácil de equivocar:
 * resolver qué es cada lado (una versión guardada o el proyecto en marcha),
 * saber en qué DIRECCIÓN se está mirando y decirlo, porque "+3 notas" leído al
 * revés es exactamente la mentira contraria.
 *
 * Todo esto es puro y vive aparte para poder probarlo sin Electron delante.
 */

/** El lado que no es un archivo: el proyecto tal y como está ahora mismo. */
export const CURRENT_KEY = '';

/** Una versión de la lista (lo mínimo que hace falta aquí). */
export interface ComparableVersion {
  file: string;
  label: string;
  at: number;
}

/** Un lado de la comparación, ya resuelto. */
export interface ComparePick {
  /** Archivo de la versión, o CURRENT_KEY para el proyecto de ahora. */
  key: string;
  label: string;
  /** Momento de la versión; null para el proyecto de ahora (es el presente). */
  at: number | null;
}

/**
 * Resuelve una clave contra la lista. Devuelve null si la versión ya no está
 * (se borró mientras el desplegable la tenía elegida): mejor no comparar que
 * comparar contra algo que no existe.
 */
export function resolvePick(key: string, entries: ComparableVersion[]): ComparePick | null {
  if (key === CURRENT_KEY) return { key: CURRENT_KEY, label: 'El proyecto de ahora', at: null };
  const found = entries.find((entry) => entry.file === key);
  return found ? { key: found.file, label: found.label, at: found.at } : null;
}

/**
 * Hacia dónde se está mirando en el tiempo. El proyecto de ahora es el presente
 * y por tanto lo más nuevo que hay.
 */
export type CompareDirection = 'forward' | 'backward' | 'same';

export function compareDirection(from: ComparePick, to: ComparePick): CompareDirection {
  if (from.key === to.key) return 'same';
  const a = from.at ?? Number.POSITIVE_INFINITY;
  const b = to.at ?? Number.POSITIVE_INFINITY;
  if (a === b) return 'same';
  return a < b ? 'forward' : 'backward';
}

/** El encabezado del panel: siempre con la dirección delante. */
export function compareTitle(from: ComparePick, to: ComparePick): string {
  if (from.key === to.key) return `«${from.label}» consigo misma`;
  return `De «${from.label}» a «${to.label}»`;
}

/**
 * La coletilla que evita el malentendido: mirando hacia atrás, un "+3 notas"
 * significa que esas notas están en la versión VIEJA y no en la nueva.
 */
export function compareHint(direction: CompareDirection): string | null {
  if (direction === 'same') return 'Es lo mismo a los dos lados.';
  if (direction === 'backward') {
    return 'Vas hacia atrás en el tiempo: lo que sale como añadido es lo que había antes y ya no está.';
  }
  return null;
}

/**
 * Elección por defecto: la versión más reciente contra el proyecto de ahora
 * (que es la pregunta que uno se hace el 90% de las veces).
 */
export function defaultPair(entries: ComparableVersion[]): { from: string; to: string } {
  const newest = [...entries].sort((a, b) => b.at - a.at)[0];
  return { from: newest?.file ?? CURRENT_KEY, to: CURRENT_KEY };
}

/**
 * ── Comparación de VERSIONES DE LA APP (semver-ish) ──────────────────────
 *
 * Esto es otra cosa que lo de arriba: ahí "versión" es una instantánea del
 * proyecto (un .orbit guardado con nombre); aquí es el número de release de
 * la propia app ("3.4.0" vs lo que diga la última release de GitHub). Vive en
 * el mismo archivo porque sigue siendo "comparar dos versiones y decir en qué
 * dirección", y para no duplicar una tercera vez la lógica de comparar — pero
 * las dos mitades del archivo no comparten datos entre sí.
 */

/**
 * Trocea "3.4.0", "v3.4.0" o "3.4.0-beta.1" en sus números. El sufijo tras
 * `-` o `+` no cuenta para el orden (una "3.4.0-beta.1" y una "3.4.0" se
 * consideran la misma versión a efectos de "¿hay algo más nuevo?"). Un trozo
 * que no es un número cuenta como 0: una versión rara no revienta la
 * comparación, simplemente no gana ni pierde por ese trozo.
 */
export function parseVersionParts(version: string): number[] {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
  return core.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Compara dos versiones: -1 si `a` es más vieja, 0 igual, 1 si es más nueva. */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** ¿`remote` es estrictamente más nueva que `local`? La pregunta del aviso. */
export function isNewerVersion(remote: string, local: string): boolean {
  return compareSemver(remote, local) > 0;
}
