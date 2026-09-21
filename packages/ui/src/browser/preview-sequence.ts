/**
 * Token de secuencia para el preview del Browser.
 *
 * `preview()` espera a que `loadIntoEngine` lea y decodifique el archivo antes
 * de mandar `engine.previewSample`. Con dos clics seguidos, la carga del
 * PRIMERO puede terminar después de la del segundo y su preview sonaría encima
 * del que el usuario acaba de pedir. El token no cancela la carga lenta (no
 * hay nada que cancelar en `loadIntoEngine`): solo hace que, al volver, se
 * descarte sin sonar. Mismo espíritu que el contador de generación de
 * `collab/sample-sync.ts`, aquí sin estado global.
 */

export interface PreviewSequence {
  /** Arranca una carga nueva y devuelve su token. */
  begin(): number;
  /** ¿Sigue siendo la carga más nueva? Las viejas se descartan al volver. */
  isCurrent(token: number): boolean;
}

export function createPreviewSequence(): PreviewSequence {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (token) => token === current,
  };
}
