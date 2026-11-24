/**
 * Validación de argumentos de las tools MCP, compartida por el executor y las
 * tools del compositor: un solo sitio que decide qué es un número válido o un
 * string requerido, para que dos tools no rechacen lo mismo con dos criterios.
 */
export class ToolError extends Error {}

export function asObject(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('Los argumentos deben ser un objeto JSON');
  }
  return args as Record<string, unknown>;
}

export function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolError(`Falta el parámetro "${key}" (string)`);
  }
  return v;
}

export function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`"${key}" debe ser string`);
  return v;
}

// Cotas de tamaño: los args de las tools los manda un cliente MCP (o el modelo
// con un JSON mal formado) y el JSON Schema de tools.ts es solo consejo para el
// modelo — nadie lo valida en runtime. Sin estos topes, un set_notes con
// millones de notas, un start de 1e12 o un set_steps gigantesco congelaban o
// tumbaban el renderer (o reservaban un buffer astronómico en el render).
export const MAX_NOTES_PER_CALL = 4096;
export const MAX_STEPS_LEN = 4096;
export const MAX_POINTS = 4096;
/** Tope superior de posiciones/duraciones en beats (≈ miles de compases). */
export const MAX_BEATS = 100_000;

export function reqArray(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ToolError(`Falta el parámetro "${key}" (lista)`);
  return v;
}

export function reqNumber(o: Record<string, unknown>, key: string): number {

  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ToolError(`Falta el parámetro "${key}" (número)`);
  }
  return v;
}

/** Número finito y acotado a [min, max]: lanza si se sale (no clampa). */
export function boundedNumber(o: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = reqNumber(o, key);
  if (v < min || v > max) throw new ToolError(`"${key}" fuera de rango [${min}, ${max}]: ${v}`);
  return v;
}

/** Como `boundedNumber`, pero para parámetros opcionales (ausente = undefined). */
export function optBoundedNumber(
  o: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (o[key] === undefined || o[key] === null) return undefined;
  return boundedNumber(o, key, min, max);
}

export function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`"${key}" debe ser número`);
  return v;
}

export function optBoolean(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`"${key}" debe ser boolean`);
  return v;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Número compacto para respuestas (2 decimales máx, sin ceros de cola). */
export function f(x: number, decimals = 2): string {
  const p = Math.pow(10, decimals);
  return String(Math.round(x * p) / p);
}

/** Valida un objeto de params contra los specs del registro y los clampa. */
