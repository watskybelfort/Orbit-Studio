/**
 * Búsqueda de la paleta de comandos.
 *
 * Antes era `startsWith` sobre el título y, si no, `includes` sobre todo el
 * texto. Eso obliga a escribir el principio exacto: "atajos" no encontraba
 * "Atajos de teclado…" hasta la sexta letra, "pr" no llevaba a "Piano Roll" y
 * "gc" no llevaba a "Guardar como". Aquí se busca por SUBSECUENCIA —las letras
 * en orden, no necesariamente pegadas— y se puntúa, que es lo que hace que
 * "pr" ponga "Piano Roll" arriba en vez de sepultarlo entre veinte resultados.
 *
 * Módulo puro y con tests: la puntuación es exactamente lo que se puede
 * estropear sin que nadie lo note hasta que un comando "desaparece".
 */

import type { PaletteCommand } from './registry';

/** Minúsculas y sin acentos, igual que el buscador del Browser. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Un carácter que empieza palabra (o el principio del texto). */
function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  return /[\s\-_/:.(·]/.test(text[i - 1] ?? '');
}

/**
 * Puntúa `query` contra `text`. `null` = no casa.
 *
 * Premia lo que a ojo parece "el que buscaba": empezar por ahí, caer en el
 * principio de una palabra y venir seguido. Y penaliza los huecos, para que una
 * coincidencia repartida por toda la frase no le gane a una compacta.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0;
  let score = 0;
  let from = 0;
  let previous = -2;

  for (const ch of query) {
    const at = text.indexOf(ch, from);
    if (at === -1) return null;
    if (at === previous + 1) score += 8; // seguido
    if (at === 0) score += 15; // el propio principio
    if (isBoundary(text, at)) {
      /*
       * Principio de palabra. Y AQUÍ NO SE PENALIZA EL HUECO: escribir "pr"
       * para "Piano Roll" es saltar al principio de la palabra siguiente a
       * propósito, no despistarse. Con la penalización puesta, "pr" ponía
       * "Guardar proyecto" por delante —porque ahí las dos letras van
       * pegadas— y las iniciales, que es como se busca de verdad en una
       * paleta, no servían para nada.
       */
      score += 12;
    } else {
      score -= Math.min(6, at - from); // hueco (acotado: no castiga textos largos)
    }
    previous = at;
    from = at + 1;
  }
  // A igualdad de coincidencia, gana el título más corto: es el más específico.
  return score - text.length * 0.05;
}

/** Puntuación de un comando: el título manda; sinónimos y grupo cuentan menos. */
export function scoreCommand(cmd: PaletteCommand, query: string): number | null {
  const title = fuzzyScore(normalize(cmd.title), query);
  const extra = fuzzyScore(normalize(`${cmd.keywords ?? ''} ${cmd.group}`), query);
  if (title === null && extra === null) return null;
  return Math.max(title ?? -Infinity, extra === null ? -Infinity : extra * 0.5 - 5);
}

export interface SearchOptions {
  /** Ids de los últimos comandos usados, del más reciente al más viejo. */
  recent?: readonly string[];
  /** Tope de resultados. */
  limit?: number;
}

/**
 * Filtra y ordena.
 *
 * Sin nada escrito salen los últimos usados y detrás el resto en su orden: la
 * paleta se abre y lo de siempre ya está arriba, sin escribir nada. Con texto
 * manda la puntuación, y la recencia solo desempata — que un comando se haya
 * usado hace poco no puede colocarlo por delante de otro que casa mejor.
 */
export function searchCommands(
  commands: readonly PaletteCommand[],
  query: string,
  { recent = [], limit = 40 }: SearchOptions = {},
): PaletteCommand[] {
  const rank = new Map<string, number>();
  recent.forEach((id, i) => rank.set(id, i));

  const q = normalize(query.trim());
  if (q === '') {
    const used = commands
      .filter((c) => rank.has(c.id))
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const rest = commands.filter((c) => !rank.has(c.id));
    return [...used, ...rest].slice(0, limit);
  }

  const scored: { cmd: PaletteCommand; score: number; order: number }[] = [];
  commands.forEach((cmd, order) => {
    const score = scoreCommand(cmd, q);
    if (score !== null) scored.push({ cmd, score, order });
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = rank.get(a.cmd.id) ?? Infinity;
    const rb = rank.get(b.cmd.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return a.order - b.order; // estable: el orden de registro
  });
  return scored.slice(0, limit).map((s) => s.cmd);
}
