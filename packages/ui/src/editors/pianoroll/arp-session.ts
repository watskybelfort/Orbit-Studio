/**
 * La sesión del arpegiador con el panel abierto, fuera del `.tsx`.
 *
 * El bug que justifica este módulo: `arpEntryOnTop` devolvía un booleano, y
 * "la entrada no está arriba" es AMBIGUO — puede ser que la pasada siga
 * aplicada pero debajo de otro cambio, o que el usuario la haya deshecho con
 * Ctrl+Z (y entonces viva en el redoStack). `cancelArp` leía el `false` como
 * "hay que restaurar a mano" y volvía a añadir `base` sobre un proyecto que ya
 * la tenía: 3 notas → pasada → Ctrl+Z → cancelar = 6 notas.
 *
 * Aquí la vista del historial se traduce a un estado sin ambigüedad
 * (`HistoryItem.done` ya dice si la entrada está aplicada) y de ahí salen las
 * dos decisiones: qué quitar antes de pintar una pasada nueva y qué hacer al
 * cancelar. `previewArpSession`/`cancelArpSession` reciben el store real (el
 * mínimo que usan: `historyView`, `undo`, `dispatch`) para que el test pueda
 * ejercitar la secuencia entera contra un `ProjectStore` de verdad.
 */

import {
  arpeggiate,
  type ArpeggiateOptions,
  type Command,
  type DispatchOptions,
  type HistoryView,
  type Note,
} from '@orbit/core';

/** Las notas tal y como estaban al abrir el panel, lo escrito ahora y su entrada. */
export interface ArpSession {
  /** Copia congelada de las notas de partida (con sus ids). */
  base: Note[];
  /** Ids de lo que hay escrito AHORA de esta pasada. */
  currentIds: string[];
  /** Entrada del historial que puso la pasada, si hay alguna. */
  entryId: string | null;
}

export type ArpEntryState =
  /** Nunca se aplicó una pasada (o se abrió sin entrada). */
  | 'none'
  /** La pasada es la última entrada aplicada. */
  | 'top'
  /** La pasada sigue aplicada, pero debajo de otro cambio. */
  | 'applied'
  /** El usuario deshizo la pasada: está en el futuro, rehacible. */
  | 'undone'
  /** La entrada cayó del historial (tope de 500) y ya no es recuperable. */
  | 'lost';

/**
 * ¿Dónde está la entrada del arpegio? `done` distingue "aplicada" de "deshecha";
 * `present - 1` distingue "arriba" de "enterrada". Sin esa distinción no se
 * puede saber si el proyecto tiene las notas originales o las generadas.
 */
export function arpEntryState(view: HistoryView, entryId: string | null): ArpEntryState {
  if (entryId === null) return 'none';
  const index = view.entries.findIndex((e) => e.id === entryId);
  if (index < 0) return 'lost';
  if (!view.entries[index]!.done) return 'undone';
  return index === view.present - 1 ? 'top' : 'applied';
}

/** Lo mínimo del `ProjectStore` que la sesión necesita (el real lo cumple). */
export interface ArpHost {
  historyView(): HistoryView;
  undo(): boolean;
  dispatch(cmd: Command, opts?: DispatchOptions): void;
}

/** Abre la sesión con las notas afectadas congeladas (copia, no referencia). */
export function openArpSession(base: readonly Note[]): ArpSession {
  const copy = base.map((n) => ({ ...n }));
  return { base: copy, currentIds: copy.map((n) => n.id), entryId: null };
}

/**
 * Pinta una pasada nueva. Devuelve los ids generados, o `null` si el arpegio
 * salió vacío (no se toca el proyecto).
 *
 * La pasada anterior se deshace solo si es la última aplicada; si sigue
 * aplicada pero debajo, se quitan sus ids a mano (el undo se llevaría por
 * delante el cambio posterior del usuario). Si está DESHECHA, el proyecto ya
 * tiene las notas originales: lo que hay que quitar son esas, nunca las
 * generadas que ya no existen — y jamás hay que volver a añadir `base`.
 */
export function previewArpSession(
  host: ArpHost,
  session: ArpSession,
  patternId: string,
  channelId: string,
  opts: ArpeggiateOptions,
): string[] | null {
  const state = arpEntryState(host.historyView(), session.entryId);
  let removeIds: string[];
  if (state === 'top') {
    host.undo();
    // Deshacer ha devuelto las ORIGINALES: lo que hay que quitar ahora son
    // esas, no las de la pasada anterior (que ya no existen).
    removeIds = session.base.map((n) => n.id);
  } else if (state === 'undone') {
    // El Ctrl+Z ya dejó las originales puestas: se quitan y se reemplazan.
    removeIds = session.base.map((n) => n.id);
  } else {
    removeIds = session.currentIds;
  }
  session.entryId = null;

  const generated = arpeggiate(session.base, opts);
  if (generated.length === 0) return null;
  const label = 'Arpegiar';
  host.dispatch(
    {
      type: 'batch',
      label,
      commands: [
        { type: 'removeNotes', patternId, channelId, noteIds: removeIds },
        { type: 'addNotes', patternId, channelId, notes: generated },
      ],
    },
    { label },
  );
  const { entries, present } = host.historyView();
  session.entryId = entries[present - 1]?.id ?? null;
  session.currentIds = generated.map((n) => n.id);
  return session.currentIds;
}

/**
 * Cancela: devuelve exactamente las notas de partida (ids incluidos).
 *
 * - Arriba: se deshace la pasada (además borra su rastro del historial).
 * - Aplicada pero debajo: se restaura a mano (cuesta una entrada más).
 * - Deshecha o nunca aplicada: no se toca nada; el proyecto ya está como al
 *   abrir el panel. Aquí estaba el bug: re-añadir `base` duplicaba las notas.
 */
export function cancelArpSession(
  host: ArpHost,
  session: ArpSession,
  patternId: string,
  channelId: string,
): void {
  const state = arpEntryState(host.historyView(), session.entryId);
  if (state === 'none' || state === 'undone') return;
  if (state === 'top') {
    host.undo();
    return;
  }
  const label = 'Deshacer arpegio';
  host.dispatch(
    {
      type: 'batch',
      label,
      commands: [
        { type: 'removeNotes', patternId, channelId, noteIds: session.currentIds },
        { type: 'addNotes', patternId, channelId, notes: session.base },
      ],
    },
    { label },
  );
}
