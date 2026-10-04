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
 * **La marca es un sobre (envelope), no una cadena reservada.** Antes era
 * `'\u0000unset'`, y un nombre de canal que fuese exactamente ese texto se
 * convertía en `undefined` al deshacer: la marca se chocaba con texto legítimo. Un
 * objeto no se puede confundir con un valor de campo (`volume` es número, `name`
 * es cadena), así que donde antes se colaba una cadena rara ahora solo puede
 * colarse el sobre, y además el validador lo reconoce para admitirlo en patches.
 *
 * Vive en `model/` y no junto al bus a propósito: el motor solo puede usar el
 * modelo de core, nunca el bus (regla de dependencias del repo, comprobada por
 * `tools/eslint/package-graph.test.ts`).
 */

/** La clave del sobre. Con nombre improbable para que nadie lo escriba por error. */
const CLAVE = '$orbitUnset';

/** El sobre de borrado: lo que viaja por el cable y lo que se compara. */
export const UNSET: Readonly<{ readonly [CLAVE]: true }> = Object.freeze({ [CLAVE]: true } as {
  readonly [CLAVE]: true;
});

/**
 * ¿Es este valor la marca de borrado?
 *
 * Se mira la forma completa (un objeto con ESA clave y nada más): un objeto del
 * proyecto que lleve la clave por casualidad no es una orden de borrar, y
 * `{ $orbitUnset: true, valor: 3 }` tampoco.
 */
export function esUnset(valor: unknown): boolean {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false;
  const claves = Object.keys(valor as Record<string, unknown>);
  return claves.length === 1 && (valor as Record<string, unknown>)[CLAVE] === true;
}