/**
 * El parseo de flags de los scripts de QA.
 *
 * El caso que da nombre a este archivo es `--accept --force`: antes guardaba
 * "--force" como motivo del cambio de sonido y además activaba el bypass de la
 * guarda de arquitectura. Los dos efectos, de un solo gesto.
 *
 *   npx vitest run tools/qa/cli-args.test.ts
 */

import { describe, expect, it } from 'vitest';
import { numeroDeFlag, textoDeFlag, tieneFlag, valorDeFlag } from './cli-args';

describe('valorDeFlag', () => {
  it('lee el valor que sigue al flag', () => {
    expect(valorDeFlag(['--only', 'fx-vinyl'], 'only')).toBe('fx-vinyl');
  });

  it('devuelve undefined si el flag no está', () => {
    expect(valorDeFlag(['--accept', 'motivo'], 'only')).toBeUndefined();
  });

  it('NO se come el flag siguiente como si fuera un valor', () => {
    expect(valorDeFlag(['--accept', '--force'], 'accept')).toBeUndefined();
  });

  it('devuelve undefined si el flag es lo último de la línea', () => {
    expect(valorDeFlag(['--accept'], 'accept')).toBeUndefined();
  });

  it('acepta valores que solo empiezan por un guion (un negativo no es un flag)', () => {
    expect(valorDeFlag(['--offset', '-3'], 'offset')).toBe('-3');
  });
});

describe('textoDeFlag', () => {
  it('recorta los espacios de alrededor', () => {
    expect(textoDeFlag(['--accept', '  el vinilo ya no da silencio  '], 'accept')).toBe(
      'el vinilo ya no da silencio',
    );
  });

  it('rechaza un motivo que es solo espacios', () => {
    expect(textoDeFlag(['--accept', '   '], 'accept')).toBeUndefined();
  });

  it('rechaza la cadena vacía', () => {
    expect(textoDeFlag(['--accept', ''], 'accept')).toBeUndefined();
  });

  it('rechaza el flag siguiente tomado como motivo', () => {
    expect(textoDeFlag(['--accept', '--force'], 'accept')).toBeUndefined();
  });
});

describe('numeroDeFlag', () => {
  it('lee un número positivo', () => {
    expect(numeroDeFlag(['--ppm', '5000'], 'ppm', 1000)).toBe(5000);
  });

  it('cae al respaldo si falta el flag', () => {
    expect(numeroDeFlag([], 'ppm', 1000)).toBe(1000);
  });

  it('cae al respaldo si no es un número', () => {
    expect(numeroDeFlag(['--ppm', 'mucho'], 'ppm', 1000)).toBe(1000);
  });

  it('cae al respaldo con cero y con negativos', () => {
    expect(numeroDeFlag(['--ppm', '0'], 'ppm', 1000)).toBe(1000);
    expect(numeroDeFlag(['--ppm', '-5'], 'ppm', 1000)).toBe(1000);
  });

  it('cae al respaldo si lo que sigue es otro flag', () => {
    expect(numeroDeFlag(['--ppm', '--verbose'], 'ppm', 1000)).toBe(1000);
  });
});

describe('la regresión de `--accept --force`', () => {
  const argv = ['node', 'golden-update.ts', '--accept', '--force'];

  it('no deja ningún motivo utilizable, así que no se puede escribir', () => {
    expect(textoDeFlag(argv, 'accept')).toBeUndefined();
  });

  it('pero sigue viendo que se pidió --accept, para poder explicar por qué no vale', () => {
    expect(tieneFlag(argv, 'accept')).toBe(true);
  });

  it('y sigue viendo el --force, que era un flag de verdad', () => {
    expect(tieneFlag(argv, 'force')).toBe(true);
  });
});
