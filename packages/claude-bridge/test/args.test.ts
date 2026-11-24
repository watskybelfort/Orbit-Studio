/**
 * Los argumentos de las tools los escribe un modelo: lo normal es equivocarse
 * de TIPO (`bpm: "120"`), no de nombre. Estos tests fijan la diferencia entre
 * "falta" y "llegó otra cosa", que es la que ahorra el viaje de ida y vuelta.
 */

import { describe, expect, it } from 'vitest';
import {
  ToolError,
  describeArg,
  optNumber,
  optString,
  reqArray,
  reqNumber,
  reqString,
} from '../src/args';

describe('validación de argumentos de las tools', () => {
  it('un parámetro ausente se llama ausente', () => {
    expect(() => reqString({}, 'kind')).toThrow(/Falta el parámetro "kind" \(string\)/);
    expect(() => reqNumber({}, 'bpm')).toThrow(/Falta el parámetro "bpm" \(número\)/);
    expect(() => reqArray({}, 'notes')).toThrow(/Falta el parámetro "notes" \(lista\)/);
    expect(() => reqString({ kind: null }, 'kind')).toThrow(/Falta el parámetro "kind"/);
  });

  it('un parámetro del tipo equivocado dice qué llegó, no que falte', () => {
    expect(() => reqString({ kind: 42 }, 'kind')).toThrow(
      /"kind" debe ser un string \(llegó 42\)/,
    );
    expect(() => reqNumber({ bpm: '120' }, 'bpm')).toThrow(
      /"bpm" debe ser un número finito \(llegó el texto "120"\)/,
    );
    expect(() => reqArray({ notes: 'x' }, 'notes')).toThrow(
      /"notes" debe ser una lista \(llegó el texto "x"\)/,
    );
  });

  it('un número no finito se nombra como NaN, no como ausente', () => {
    expect(() => reqNumber({ bpm: Number.NaN }, 'bpm')).toThrow(
      /"bpm" debe ser un número finito \(llegó NaN\)/,
    );
    expect(() => optNumber({ pan: 'centro' }, 'pan')).toThrow(/debe ser un número finito/);
  });

  it('un string vacío no se confunde con uno ausente', () => {
    expect(() => reqString({ name: '' }, 'name')).toThrow(/"name" no puede estar vacío/);
    expect(optString({ name: '' }, 'name')).toBe('');
  });

  it('describeArg nombra listas, objetos, null y textos largos sin volcarlos', () => {
    expect(describeArg([1, 2])).toBe('una lista');
    expect(describeArg({ a: 1 })).toBe('un objeto');
    expect(describeArg(null)).toBe('null');
    expect(describeArg(true)).toBe('boolean');
    expect(describeArg('x'.repeat(100))).toMatch(/…"$/);
  });

  it('los errores son ToolError (el relay los distingue de un fallo interno)', () => {
    expect(() => reqNumber({}, 'bpm')).toThrow(ToolError);
  });
});
