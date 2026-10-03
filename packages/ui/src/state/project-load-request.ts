/** Árbitro de intención para abrir/restaurar. No conoce el store ni el DOM:
 * el llamador aporta su epoch y puede liberar UI al ceder a otra solicitud. */
export function createProjectLoadRequests() {
  let sequence = 0;
  let onSuperseded: (() => void) | null = null;
  return {
    begin(epoch: number, release?: () => void) {
      // Ceder mientras la solicitud anterior aún es dueña de su estado; la
      // nueva publicará su busy/aviso DESPUÉS de este tramo síncrono.
      const previous = onSuperseded;
      onSuperseded = null;
      previous?.();
      const token = ++sequence;
      onSuperseded = release ?? null;
      return {
        isCurrent: (currentEpoch: number) => token === sequence && epoch === currentEpoch,
        finish: () => { if (token === sequence) onSuperseded = null; },
      };
    },
  };
}

export const projectLoadRequests = createProjectLoadRequests();
