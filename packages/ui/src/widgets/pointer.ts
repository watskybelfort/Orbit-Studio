/**
 * setPointerCapture sin excepción: con punteros sintéticos (QA por CDP) o ya
 * levantados (toque rápido), el DOM lanza NotFoundError y mataría el manejador
 * entero antes de hacer su trabajo. Capturar es una mejora, nunca un requisito.
 *
 * Devuelve si la captura llegó a cuajar. Importa: sin captura el gesto solo
 * sigue vivo mientras el puntero esté encima del elemento, así que quien
 * necesite arrastrar fuera (una ventana, un fader) sabe por el `false` que le
 * toca escuchar en el documento o asumir que el gesto puede cortarse.
 */
export function capturePointer(el: Element, pointerId: number): boolean {
  try {
    el.setPointerCapture(pointerId);
    return true;
  } catch {
    // sin captura: los manejadores siguen funcionando con eventos burbujeados
    return false;
  }
}
