/**
 * Traduce el `onProgress(fraction)` de `renderStems` en "qué pista se está
 * renderizando ahora" para poder avisar al usuario stem a stem aunque las
 * `N` pistas se pidan en UNA sola llamada.
 *
 * `renderStems` (packages/engine/src/render/offline.ts) llama a
 * `renderProject` una vez por índice con el MISMO `opts.onProgress`, y cada
 * `renderProject` reinicia la fracción en 0 y cierra siempre con un
 * `onProgress(1)` incondicional — y si una pista revienta a mitad de render
 * (no llega a su propio cierre), `renderStems` manda ese `onProgress(1)` por
 * ella al capturar la excepción, para que la numeración de las pistas
 * siguientes no se corra. Ese `1` es la única señal disponible de "la próxima
 * llamada que llegue es ya de la pista siguiente" — no hay forma de saber el
 * índice desde fuera salvo contando esas transiciones.
 *
 * Aislado en su propio módulo (en vez de vivir dentro de render-worker.ts)
 * porque ese worker referencia `self` en la carga del módulo y no se puede
 * importar en Node/vitest para probarlo: esta función sí, al no tocar nada
 * del entorno de worker.
 */
export function trackStemProgress(
  total: number,
  onStemStart: (index: number) => void,
): (fraction: number) => void {
  let current = -1;
  let announced = false;
  return (fraction: number): void => {
    if (!announced) {
      current = Math.min(total - 1, current + 1);
      announced = true;
      onStemStart(current);
    }
    if (fraction >= 1) announced = false;
  };
}
