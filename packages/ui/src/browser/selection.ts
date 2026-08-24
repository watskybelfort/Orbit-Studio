/**
 * Selección múltiple del Browser: qué sonidos están marcados y cuáles se
 * arrastran al tirar de uno.
 *
 * Aquí no hay React ni DOM, y vive aparte por lo de siempre: esto es
 * aritmética sobre una lista y un conjunto, y es donde están los dos errores
 * que se pagan caros — arrastrar algo que no se ve (seleccionas diez, filtras,
 * y el arrastre se lleva los que el filtro escondió) y arrastrar en un orden
 * que no es el de la pantalla (el orden decide qué muestra va en qué tecla del
 * keymap, así que barajarlo deja el piano con las notas cambiadas de sitio).
 *
 * El gesto es el de cualquier lista: clic normal deja una, Ctrl/Cmd mete y
 * saca, Mayús coge el tramo desde la última que tocaste.
 */

export interface SelectionState {
  ids: ReadonlySet<string>;
  /**
   * Desde dónde mide el tramo un Mayús+clic. Es la última que se tocó a
   * propósito, no la última que entró: así se puede abrir y cerrar un tramo
   * varias veces desde el mismo sitio, que es como se usa.
   */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchor: null };

/** Clic normal: la selección pasa a ser solo esa. */
export function selectOne(id: string): SelectionState {
  return { ids: new Set([id]), anchor: id };
}

/** Ctrl/Cmd: entra o sale, y pasa a ser el ancla del próximo tramo. */
export function toggleOne(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Mayús: todo lo que hay entre el ancla y esta, EN EL ORDEN DE LA PANTALLA.
 *
 * El ancla no se mueve: repetir el Mayús+clic más arriba o más abajo redibuja
 * el tramo desde el mismo sitio en vez de irlo arrastrando.
 */
export function selectRange(
  state: SelectionState,
  visibleIds: readonly string[],
  id: string,
): SelectionState {
  const to = visibleIds.indexOf(id);
  if (to < 0) return state;
  const from = state.anchor === null ? -1 : visibleIds.indexOf(state.anchor);
  // Sin ancla a la vista (o sin ancla) un Mayús+clic es un clic normal.
  if (from < 0) return selectOne(id);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return { ids: new Set(visibleIds.slice(lo, hi + 1)), anchor: state.anchor };
}

/** La selección en el orden en que se ve, sin lo que el filtro haya escondido. */
export function orderedSelection(
  state: SelectionState,
  visibleIds: readonly string[],
): string[] {
  return visibleIds.filter((id) => state.ids.has(id));
}

/**
 * Qué se lleva un arrastre que empieza en `id`.
 *
 * Si esa entrada está seleccionada, va el grupo entero; si no, va ella sola.
 * Es la convención que ya usa la playlist con los clips, y la que evita el
 * accidente de tirar de un sonido cualquiera y arrastrar sin querer los veinte
 * que quedaban marcados de antes.
 */
export function dragSetFor(
  state: SelectionState,
  visibleIds: readonly string[],
  id: string,
): string[] {
  if (!state.ids.has(id)) return [id];
  const group = orderedSelection(state, visibleIds);
  // La selección puede haberse quedado sin nada a la vista: entonces manda la
  // entrada de la que se tira, que es lo que el usuario tiene bajo el dedo.
  return group.length > 0 ? group : [id];
}

/**
 * Quita de la selección lo que ya no está a la vista.
 *
 * Sin esto, marcar diez sonidos y escribir en el buscador dejaba marcados los
 * que el filtro acababa de esconder: el contador decía diez, la pantalla
 * enseñaba dos, y el arrastre se llevaba los diez.
 */
export function pruneSelection(
  state: SelectionState,
  visibleIds: readonly string[],
): SelectionState {
  const visible = new Set(visibleIds);
  let changed = false;
  const ids = new Set<string>();
  for (const id of state.ids) {
    if (visible.has(id)) ids.add(id);
    else changed = true;
  }
  const anchor = state.anchor !== null && visible.has(state.anchor) ? state.anchor : null;
  if (!changed && anchor === state.anchor) return state;
  return { ids, anchor };
}
