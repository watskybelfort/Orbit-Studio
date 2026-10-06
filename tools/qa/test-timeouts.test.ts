/**
 * El consumidor de `test-timeouts`, probado como caja negra (como los demás
 * `tools/qa/*.mjs`: se le pasa un fichero y se lee lo que escribe).
 *
 * Lo que se fija aquí es lo que la tarjeta pedía decidir con datos y no con
 * intuición: el umbral es una FRACCIÓN del timeout efectivo de cada test (no un
 * absoluto, que se vuelve inútil en cuanto un test declara 60 s), un timeout sin
 * resolver NO se sustituye por el default en silencio (eso daría una alarma falsa),
 * y avisar no es fallar: el código de salida es 0 aunque haya avisos.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERRAMIENTA = resolve('tools/qa/test-timeouts.mjs');
const REPORTER = resolve('tools/qa/test-timeout-reporter.mjs');

interface Corrida {
  codigo: number;
  salida: string;
}

/** Corre la herramienta con Node y devuelve lo que dijo y con qué código salió. */
function corre(args: string[]): Corrida {
  const r = spawnSync(process.execPath, [HERRAMIENTA, ...args], { encoding: 'utf8' });
  return { codigo: r.status ?? -1, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const dirs: string[] = [];

function temporal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-tt-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Escribe un fichero de mediciones con las filas dadas y devuelve su ruta. */
function crudo(filas: unknown[]): string {
  const ruta = join(temporal(), 'raw.json');
  writeFileSync(ruta, JSON.stringify({ filas }), 'utf8');
  return ruta;
}

function fila(nombre: string, duracion: number, timeout: number | null) {
  return { nombre, duracion, timeout, estado: 'pass' };
}

/** Cuántos avisos (`::warning::`) salieron. */
function cuantosAvisos(salida: string): number {
  return salida.split('\n').filter((l) => l.startsWith('::warning::')).length;
}

describe('test-timeouts · a quién avisa', () => {
  it('el umbral es una fracción del timeout EFECTIVO, no un absoluto', () => {
    const { codigo, salida } = corre([
      crudo([
        fila('con default al 52%', 2600, 5000), // avisa
        fila('con margen propio al 43%', 26_000, 60_000), // NO: dura 5x más y no avisa
        fila('casi al 49.98%', 2499, 5000), // NO
        fila('justo al 50%', 2500, 5000), // sí: el umbral es incluido
      ]),
    ]);
    expect(codigo).toBe(0);
    expect(cuantosAvisos(salida)).toBe(2);
    expect(salida).toContain('con default al 52%');
    expect(salida).toContain('justo al 50%');
    expect(salida).not.toContain('con margen propio');
    expect(salida).not.toContain('casi al 49.98%');
  });

  it('el aviso lleva el porcentaje, los dos números y el nombre del test', () => {
    const { salida } = corre([crudo([fila('suite > hijo', 3750, 5000)])]);
    const linea = salida.split('\n').find((l) => l.startsWith('::warning::')) ?? '';
    expect(linea).toContain('75%');
    expect(linea).toContain('3750 ms de 5000 ms');
    expect(linea).toContain('suite > hijo');
  });

  it('el umbral se puede mover, y el número de avisos cambia con él', () => {
    const entrada = crudo([fila('al 35%', 1750, 5000), fila('al 75%', 3750, 5000)]);
    expect(cuantosAvisos(corre([entrada]).salida)).toBe(1);
    expect(cuantosAvisos(corre([entrada, '--umbral', '0.3']).salida)).toBe(2);
    const tonto = corre([entrada, '--umbral', 'cero']);
    expect(tonto.codigo).not.toBe(0);
    expect(tonto.salida).toContain('--umbral');
  });

  it('un timeout sin resolver se cuenta aparte, NO se sustituye por el default', () => {
    const { salida } = corre([
      crudo([
        fila('con timeout', 1000, 5000),
        fila('sin timeout', 4000, null), // si se inventara un default, esto avisaría
        fila('timeout en cero', 4000, 0),
        fila('timeout en negativo', 4000, -1),
      ]),
    ]);
    expect(cuantosAvisos(salida)).toBe(0);
    expect(salida).toContain('Sin timeout resuelto: 3');
  });

  it('las filas que no son datos de un test se ignoran sin reventar', () => {
    const { codigo, salida } = corre([
      crudo([fila('buena', 10, 5000), null, 'texto', { nombre: 'sin duración' }, { duracion: 1 }]),
    ]);
    expect(codigo).toBe(0);
    // Solo cuenta la fila buena, y el resto no ha dumped la herramienta.
    expect(salida).toContain('0 de 1.');
  });

  it('avisa de los que YA pasaron del límite, que es lo urgente', () => {
    const { salida } = corre([crudo([fila('pasado', 5200, 5000), fila('justo', 5000, 5000)])]);
    expect(salida).toContain('2 test(s) ya han pasado de su timeout');
  });

  it('el resumen lleva el reparto, para comparar una corrida con otra', () => {
    const dir = temporal();
    const salida = join(dir, 'resumen.json');
    const { codigo } = corre([
      crudo([fila('a', 100, 5000), fila('b', 3000, 5000), fila('c', 5000, 5000)]),
      '--json',
      salida,
    ]);
    expect(codigo).toBe(0);
    const escrito = JSON.parse(readFileSync(salida, 'utf8'));
    expect(escrito.tests).toBe(3);
    expect(escrito.avisos).toHaveLength(2);
    expect(escrito.yaSuperado).toBe(1);
    expect(escrito.ratio.max).toBe(1);
  });

  it('sin fichero de entrada dice cómo generarlo y sale con 0', () => {
    const { codigo, salida } = corre(['no-existe-este.json']);
    expect(codigo).toBe(0);
    expect(salida).toContain('npm run test:timeouts');
  });

  it('avisa SIN fallar: el código de salida es 0 aunque haya avisos de verdad', () => {
    const { codigo, salida } = corre([crudo([fila('al 99%', 4950, 5000)])]);
    expect(codigo).toBe(0);
    expect(salida).toContain('no falla la CI');
    expect(cuantosAvisos(salida)).toBe(1);
  });
});

describe('test-timeouts · el contrato con Vitest', () => {
  it('el reporter deja duración y timeout efectivo, y el consumidor los entiende', () => {
    // Esto es lo que de verdad puede romperse: que Vitest cambie dónde guarda la
    // duración, o que el timeout efectivo deje de venir resuelto. Se mide de verdad,
    // corriendo un test de verdad con el reporter puesto.
    const dir = temporal();
    const salida = join(dir, 'raw.json');
    execFileSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'packages/core/test/schema-followup.test.ts',
        '--reporter=default',
        `--reporter=${REPORTER}`,
      ],
      { encoding: 'utf8', env: { ...process.env, ORBIT_TEST_TIMEOUTS_OUT: salida } },
    );
    const crudoReal = JSON.parse(readFileSync(salida, 'utf8'));
    expect(crudoReal.filas.length).toBeGreaterThan(5);
    for (const f of crudoReal.filas) {
      expect(typeof f.duracion).toBe('number');
      expect(typeof f.timeout).toBe('number');
      expect(f.timeout).toBeGreaterThan(0);
    }
    // Y el consumidor lee ese fichero sin quejarse.
    const resumenPath = join(dir, 'resumen.json');
    const { codigo, salida: informe } = corre([salida, '--json', resumenPath]);
    expect(codigo).toBe(0);
    expect(informe).toContain('Reparto:');
    expect(informe).toContain('no falla la CI');
    const resumenReal = JSON.parse(readFileSync(resumenPath, 'utf8'));
    expect(resumenReal.tests).toBe(crudoReal.filas.length);
    expect(resumenReal.sinTimeout).toBe(0);
  });
});