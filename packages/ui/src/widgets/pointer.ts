/**
 * setPointerCapture sin excepción: con punteros sintéticos (QA por CDP) o ya
 * levantados (toque rápido), el DOM lanza NotFoundError y mataría el manejador
 * entero antes de hacer su trabajo. Capturar es una mejora, nunca un requisito.
 */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // sin captura: los manejadores siguen funcionando con eventos burbujeados
  }
}
