/**
 * MARCA DE BORRADO de un patch, y el valor que la cumple.
 *
 * Un patch puede quitar un campo opcional (`groupId` de un canal, `busTrack` de una
 * carpeta, `sampleId` de un canal…). Su inverso tiene que decirlo, y no puede
 * decirlo con `undefined`: los comandos de la sala **se serializan** y
 * `JSON.stringify` borra toda clave que vale `undefined`, así que el peer recibía
 * `{ patch: {} }` y no deshacía nada.
 *
 * Antes lo tapaba un caso particular de carpetas, que reponía 0/false. Eso no
 * cubría el resto de familias y además no era el estado real: lo que había antes
 * de "darle un bus" es que no había bus. Aquí la representación es explícita y la
 * cumple un solo sitio (`applyPatch` en `commands.ts`).
 *
 * Vive en `model/` y no junto al bus a propósito: el motor solo puede usar el
 * modelo de core, nunca el bus (regla de dependencias del repo, comprobada por
 * `tools/eslint/package-graph.test.ts`).
 */
export const UNSET = '\u0000unset';

/** ¿Es este valor la marca de borrado? */
export function esUnset(valor: unknown): boolean {
  return valor === UNSET;
}