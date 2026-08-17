/**
 * Parseo y saneado del contrato de un plugin JS de usuario (SDK de efectos).
 *
 * Contrato del archivo (JS plano en userData/plugins):
 * - OBLIGATORIO: `function createEffect(sampleRate)` que devuelve
 *   `{ setParams(p)?, process(l, r, n) }` procesando los Float32Array in situ.
 * - Opcional: `const name = 'Mi efecto'` y
 *   `const params = [{ key, label, min, max, default }, ...]` (mismo shape que
 *   ParamSpec de @orbit/core; curve/unit/options son opcionales).
 *
 * Módulo puro a propósito: sin imports de Vite (CSS, ?worker) ni del estado de
 * la app, para poder testearlo bajo Node con vitest.
 */

import type { ParamSpec } from '@orbit/core';

export interface ParsedPlugin {
  /** `const name` del archivo, o null si no lo declara (se usa el nombre del .js). */
  name: string | null;
  /** Perillas declaradas por el plugin, ya saneadas. */
  params: ParamSpec[];
  /** Qué fábricas trae: un archivo puede ser efecto, instrumento o los dos. */
  effect: boolean;
  instrument: boolean;
}

/** Tope defensivo de perillas que la UI pinta por plugin. */
const MAX_PARAMS = 32;

/**
 * Sanea UNA entrada del array `params` del plugin. Devuelve null (entrada
 * descartada) si falta la key, algún número no es finito o el rango es
 * degenerado; el default fuera de rango se recorta a [min, max].
 */
function sanitizeParam(raw: unknown): ParamSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const key = typeof r['key'] === 'string' ? r['key'].trim() : '';
  if (key === '') return null;

  const min = r['min'];
  const max = r['max'];
  const def = r['default'];
  if (typeof min !== 'number' || !Number.isFinite(min)) return null;
  if (typeof max !== 'number' || !Number.isFinite(max)) return null;
  if (typeof def !== 'number' || !Number.isFinite(def)) return null;
  // Rango degenerado (min >= max): la perilla no puede normalizar.
  if (min >= max) return null;

  const spec: ParamSpec = {
    key,
    label: typeof r['label'] === 'string' && r['label'].trim() !== '' ? r['label'].trim() : key,
    min,
    max,
    default: Math.min(max, Math.max(min, def)),
  };
  // Extras opcionales: solo pasan si tienen la forma exacta del ParamSpec.
  if (r['curve'] === 'lin' || r['curve'] === 'exp') spec.curve = r['curve'];
  if (typeof r['unit'] === 'string' && r['unit'].trim() !== '') spec.unit = r['unit'].trim();
  if (
    Array.isArray(r['options']) &&
    r['options'].length > 0 &&
    r['options'].every((o) => typeof o === 'string')
  ) {
    spec.options = r['options'] as string[];
  }
  return spec;
}

/**
 * Evalúa la fuente de un plugin y extrae su metadata (name/params) saneada.
 * Devuelve null si el código no compila, lanza al evaluarse o no define
 * `createEffect` — plugin descartado (el llamante avisa por consola).
 *
 * Nota: se evalúa con `new Function` en el hilo UI SOLO para leer la metadata;
 * el DSP corre en el worklet, que compila la fuente por su cuenta y hace
 * bypass automático si el plugin lanza.
 */
/** Nonce del objeto de metadata: un `return` prematuro del plugin no lo trae. */
const META_MARKER = '__orbit_plugin_meta__';

export function parsePluginSource(source: string): ParsedPlugin | null {
  let raw: unknown;
  try {
    raw = new Function(
      `${source}\n;return {` +
        ` marker: '${META_MARKER}',` +
        ` factory: typeof createEffect === 'function',` +
        ` instrument: typeof createInstrument === 'function',` +
        ` name: typeof name !== 'undefined' ? String(name) : null,` +
        ` params: Array.isArray(typeof params !== 'undefined' ? params : null) ? params : [] };`,
    )();
  } catch {
    return null; // sintaxis rota o el top-level lanza
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const meta = raw as {
    marker?: unknown;
    factory?: unknown;
    instrument?: unknown;
    name?: unknown;
    params?: unknown;
  };
  if (meta.marker !== META_MARKER) return null; // el plugin cortó con un return propio
  // Un archivo vale si trae efecto, instrumento o los dos; sin ninguna de las
  // dos fábricas no hay nada que registrar.
  const isEffect = meta.factory === true;
  const isInstrument = meta.instrument === true;
  if (!isEffect && !isInstrument) return null;

  const name = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : null;
  const params: ParamSpec[] = [];
  const seen = new Set<string>();
  if (Array.isArray(meta.params)) {
    for (const entry of meta.params) {
      if (params.length >= MAX_PARAMS) break;
      const spec = sanitizeParam(entry);
      if (spec && !seen.has(spec.key)) {
        seen.add(spec.key);
        params.push(spec);
      }
    }
  }
  return { name, params, effect: isEffect, instrument: isInstrument };
}

/** Params por defecto de un plugin (espejo de defaultEffectParams del core). */
export function defaultPluginParams(specs: ParamSpec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of specs) out[spec.key] = spec.default;
  return out;
}
