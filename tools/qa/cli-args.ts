/**
 * Parseo de flags de línea de comandos para los scripts de `tools/qa`.
 *
 * Existe por un fallo concreto: `arg('accept')` devolvía `process.argv[i + 1]`
 * a ciegas, así que `npm run golden:update -- --accept --force` guardaba
 * `"--force"` como motivo del cambio de sonido **y** activaba a la vez el
 * `--force` que salta la guarda de arquitectura. Un solo gesto —el que
 * cualquiera teclea sin pensar, «acepto y fuerzo»— y la línea base quedaba
 * reescrita desde una plataforma sin reproducibilidad medida, con un motivo
 * que no explica nada.
 *
 * La regla, entonces: **un flag nunca es el valor de otro flag.** Vive aquí y
 * no dentro de cada script para que el siguiente comando que necesite leer un
 * argumento la herede en vez de reinventarla mal.
 */

/** `--nombre <valor>`. Devuelve `undefined` si falta, o si lo que sigue es otro flag. */
export function valorDeFlag(argv: readonly string[], nombre: string): string | undefined {
  const i = argv.indexOf(`--${nombre}`);
  if (i < 0) return undefined;
  const valor = argv[i + 1];
  return valor === undefined || valor.startsWith('--') ? undefined : valor;
}

/**
 * Como `valorDeFlag`, pero además exige que quede texto tras recortar espacios.
 * Para argumentos que se GUARDAN y que alguien va a leer después: un motivo de
 * `" "` es tan inútil como no ponerlo, y peor, porque aparenta que lo hay.
 */
export function textoDeFlag(argv: readonly string[], nombre: string): string | undefined {
  const valor = valorDeFlag(argv, nombre)?.trim();
  return valor ? valor : undefined;
}

/** `--nombre <número>`, con respaldo si falta, no es finito o no es positivo. */
export function numeroDeFlag(argv: readonly string[], nombre: string, respaldo: number): number {
  const crudo = valorDeFlag(argv, nombre);
  if (crudo === undefined) return respaldo;
  const n = Number(crudo);
  return Number.isFinite(n) && n > 0 ? n : respaldo;
}

/** `--nombre` presente, se le haya dado valor o no. */
export function tieneFlag(argv: readonly string[], nombre: string): boolean {
  return argv.includes(`--${nombre}`);
}
