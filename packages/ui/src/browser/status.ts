/**
 * Texto de los avisos de estado del Browser.
 *
 * Vive fuera de `Browser.tsx` porque es la parte que puede romperse en
 * silencio: el aviso «No se pudo leer X» sin el motivo obliga a adivinar si fue
 * un permiso, una carpeta que ya no está o un disco desconectado, y eso es lo
 * que este helper arregla. Un `.tsx` de mil cuatrocientas líneas no se prueba;
 * esta función sí (ver `test/browser-status.test.ts`).
 */

/**
 * Motivo de un error para pegar detrás de un aviso (`: …`), o cadena vacía si
 * el error no trae uno.
 *
 * Lo que se lanza no siempre es un `Error`: un `throw 'boom'`, un objeto suelto
 * o un `Error('')` no aportan texto, y pegarles `String(err)` escribiría
 * «undefined» o «[object Object]» en la barra de estado, que es peor que no
 * decir nada. Los espacios de los extremos se recortan porque un mensaje vacío
 * o solo con saltos de línea dejaría un «: » colgando.
 */
export function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : '';
  return message ? `: ${message}` : '';
}
