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
 * La metadata (name/params/qué fábricas trae) se lee de forma ESTÁTICA: NO se
 * ejecuta el código del plugin. Antes se evaluaba con `new Function` en el hilo
 * del renderer solo para leerla, pero eso corría el top-level del plugin (con
 * acceso a window/fetch/window.orbit) con solo dejar el .js en la carpeta y
 * reiniciar. Ahora se detectan las fábricas por su declaración y se leen name y
 * params como LITERALES; el DSP sigue corriendo en el worklet, que compila la
 * fuente por su cuenta y hace bypass si el plugin lanza.
 *
 * Limitación consciente del parseo estático: `params` tiene que ser un ARRAY
 * literal en línea (como en la doc). Si se declara con una variable o una
 * expresión, no se leen las perillas (el plugin funciona igual, sin knobs).
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

// ── Lector de literales (no ejecuta código) ──────────────────────────────────
// Lee lo justo del contrato de `params`: arrays, objetos (claves identificador o
// string), strings, números (incluidos NaN/Infinity), booleanos, null/undefined.
// Cualquier otra cosa (un identificador, una llamada) hace fallar el parseo, y la
// entrada se descarta. Nunca corre nada del plugin.

const FAIL = Symbol('fail');

class LiteralReader {
  private i = 0;
  constructor(private readonly s: string) {}

  private ws(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '/' && this.s[this.i + 1] === '/') {
        this.i += 2;
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && this.s[this.i + 1] === '*') {
        this.i += 2;
        while (this.i < this.s.length && !(this.s[this.i] === '*' && this.s[this.i + 1] === '/')) this.i++;
        this.i += 2;
        continue;
      }
      break;
    }
  }

  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) return FAIL;
    if (c === '[') return this.array();
    if (c === '{') return this.object();
    if (c === '"' || c === "'") return this.string(c);
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return this.number();
    return this.word();
  }

  private array(): unknown {
    this.i++; // [
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      const v = this.value();
      if (v === FAIL) return FAIL;
      out.push(v);
      this.ws();
      const c = this.s[this.i];
      if (c === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === ']') {
          this.i++;
          return out;
        }
        continue;
      }
      if (c === ']') {
        this.i++;
        return out;
      }
      return FAIL;
    }
  }

  private object(): unknown {
    this.i++; // {
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      const key = c === '"' || c === "'" ? this.string(c) : this.identifier();
      if (key === FAIL || typeof key !== 'string') return FAIL;
      this.ws();
      if (this.s[this.i] !== ':') return FAIL;
      this.i++;
      const v = this.value();
      if (v === FAIL) return FAIL;
      out[key] = v;
      this.ws();
      const d = this.s[this.i];
      if (d === ',') {
        this.i++;
        this.ws();
        if (this.s[this.i] === '}') {
          this.i++;
          return out;
        }
        continue;
      }
      if (d === '}') {
        this.i++;
        return out;
      }
      return FAIL;
    }
  }

  private string(q: string): unknown {
    this.i++; // comilla de apertura
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i++]!;
      if (c === '\\') {
        const e = this.s[this.i++];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '');
        continue;
      }
      if (c === q) return out;
      out += c;
    }
    return FAIL; // string sin cerrar
  }

  private number(): unknown {
    const start = this.i;
    if (this.s[this.i] === '+' || this.s[this.i] === '-') this.i++;
    if (this.s.startsWith('Infinity', this.i)) {
      this.i += 8;
      return this.s[start] === '-' ? -Infinity : Infinity;
    }
    while (this.i < this.s.length && /[0-9.eE+-]/.test(this.s[this.i]!)) this.i++;
    const raw = this.s.slice(start, this.i);
    if (raw === '' || raw === '+' || raw === '-' || raw === '.') return FAIL;
    const num = Number(raw);
    return Number.isNaN(num) ? FAIL : num;
  }

  private word(): unknown {
    const id = this.identifier();
    switch (id) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'undefined':
        return undefined;
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      default:
        return FAIL; // cualquier otro identificador NO es un literal
    }
  }

  private identifier(): string | typeof FAIL {
    const start = this.i;
    while (this.i < this.s.length && /[\w$]/.test(this.s[this.i]!)) this.i++;
    return this.i === start ? FAIL : this.s.slice(start, this.i);
  }
}

/** ¿El archivo DECLARA una fábrica con ese nombre (no una simple asignación de valor)? */
function hasFactory(source: string, fn: string): boolean {
  const decl = new RegExp(`\\bfunction\\s+${fn}\\b`);
  const assign = new RegExp(`\\b${fn}\\s*=\\s*(?:async\\s+)?(?:function\\b|\\(|[\\w$]+\\s*=>)`);
  return decl.test(source) || assign.test(source);
}

/** Lee `const name = '...'` como literal string. */
function parseName(source: string): string | null {
  const m = /(?:const|let|var)\s+name\s*=\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1/.exec(source);
  if (!m) return null;
  const val = m[2]!.replace(/\\(.)/g, '$1').trim();
  return val !== '' ? val : null;
}

/** Lee `const params = [ ... ]` como array de literales, o null si no es un array literal. */
function parseParams(source: string): unknown[] | null {
  const m = /(?:const|let|var)\s+params\s*=\s*(?=\[)/.exec(source);
  if (!m) return null;
  const value = new LiteralReader(source.slice(m.index + m[0].length)).value();
  return Array.isArray(value) ? value : null;
}

/**
 * Extrae la metadata (name/params/fábricas) de la fuente de un plugin SIN
 * ejecutarla. Devuelve null si el archivo no declara ninguna fábrica
 * (`createEffect`/`createInstrument`) — no hay nada que registrar.
 */
export function parsePluginSource(source: string): ParsedPlugin | null {
  if (typeof source !== 'string') return null;
  const isEffect = hasFactory(source, 'createEffect');
  const isInstrument = hasFactory(source, 'createInstrument');
  if (!isEffect && !isInstrument) return null;

  const name = parseName(source);
  const rawParams = parseParams(source);
  const params: ParamSpec[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rawParams)) {
    for (const entry of rawParams) {
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
