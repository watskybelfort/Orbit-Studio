/**
 * «Guardar y salir» del diálogo de cierre.
 *
 * El main no sabe serializar el proyecto: manda `app:save-and-close` y espera.
 * Si el usuario cancela el «Guardar como» (o la escritura falla), el renderer
 * sigue sucio y hay que devolverle el control al main para que el próximo
 * cierre vuelva a preguntar. Un solo runner por ventana: si el main repite el
 * evento —antes pasaba con el timeout de 8 s—, no se encolan dos guardados ni
 * se abren dos diálogos.
 */

export interface SaveAndCloseDeps {
  /** ¿Quedan cambios sin guardar? */
  dirty(): boolean;
  /** Guarda; resuelve tanto si escribió como si el usuario canceló. */
  save(): Promise<void>;
  /** Deja el flag del main en limpio antes de pedir el cierre. */
  flushClean(): Promise<unknown>;
  /** Pide cerrar la ventana; el main ya no encuentra nada que preguntar. */
  close(): Promise<unknown> | void;
  /** No quedó limpio: el main vuelve a preguntar en el próximo cierre. */
  cancel(): Promise<unknown> | void;
}

export function createSaveAndCloseRunner(deps: SaveAndCloseDeps): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (deps.dirty()) await deps.save();
      // `saveProject` no distingue cancelado de guardado: la verdad es el flag.
      if (deps.dirty()) {
        await deps.cancel();
        return;
      }
      // El main decide el cierre con SU copia del flag; se sincroniza antes de
      // pedirlo para que un IPC `app:dirty` en vuelo no reabra el aviso.
      await deps.flushClean();
      await deps.close();
    } catch {
      try {
        await deps.cancel();
      } catch {
        // Si ni cancelar responde, el próximo cierre volverá a preguntar.
      }
    } finally {
      inFlight = false;
    }
  };
}
