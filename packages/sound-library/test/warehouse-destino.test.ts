/**
 * `warehouse.ts --out <dir>`: el destino no se borra a ciegas.
 *
 * Antes del fix, `main()` hacía `fs.rmSync(dir, {recursive:true, force:true})`
 * nada más empezar: un `--out` apuntando a una carpeta con cosas dentro (una
 * víctima con su `NO-BORRAR.txt`) la borraba entera y la sustituía por el pack.
 * Ahora el destino tiene que ser un pack de ESTE generador (su `manifest.json`
 * con `pack: "Warehouse"`), estar vacío o no existir.
 *
 * La decisión vive en `motivoParaNoBorrar`, que es pura y no toca el disco; el
 * test la ejercita con estados fabricados y, para el camino real, con una
 * carpeta temporal que no llega a renderizar ni un WAV.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  leerDestino,
  motivoParaNoBorrar,
  verificacionDeDestino,
  type DestinoPack,
} from '../generate/warehouse';

function estado(patch: Partial<DestinoPack>): DestinoPack {
  return {
    dir: 'C:\\pack',
    existe: false,
    esDirectorio: false,
    entradas: [],
    manifestJson: null,
    ...patch,
  };
}

describe('warehouse --out: qué destinos se pueden reemplazar', () => {
  it('un destino que no existe o está vacío se puede', () => {
    expect(motivoParaNoBorrar(estado({ existe: false }))).toBeNull();
    expect(
      motivoParaNoBorrar(estado({ existe: true, esDirectorio: true, entradas: [] })),
    ).toBeNull();
  });

  it('un pack de este generador se puede reemplazar', () => {
    expect(
      motivoParaNoBorrar(
        estado({
          existe: true,
          esDirectorio: true,
          entradas: ['manifest.json', 'drums'],
          manifestJson: JSON.stringify({ version: '1.0.0', pack: 'Warehouse', entries: [] }),
        }),
      ),
    ).toBeNull();
  });

  it('una carpeta con cosas que no son un pack de Warehouse se rechaza', () => {
    const conBasura = motivoParaNoBorrar(
      estado({ existe: true, esDirectorio: true, entradas: ['NO-BORRAR.txt'] }),
    );
    expect(conBasura).toMatch(/no está vacía/i);
    expect(conBasura).toMatch(/no es un pack/i);

    // Manifest de OTRO pack: tampoco es suyo.
    expect(
      motivoParaNoBorrar(
        estado({
          existe: true,
          esDirectorio: true,
          entradas: ['manifest.json'],
          manifestJson: JSON.stringify({ pack: 'Hats de drill' }),
        }),
      ),
    ).toMatch(/no es un pack/i);

    // Manifest ilegible: mejor abortar que adivinar.
    expect(
      motivoParaNoBorrar(
        estado({
          existe: true,
          esDirectorio: true,
          entradas: ['manifest.json'],
          manifestJson: '{ roto',
        }),
      ),
    ).toMatch(/no es un pack/i);
  });

  it('un archivo donde debería ir la carpeta se rechaza', () => {
    expect(
      motivoParaNoBorrar(estado({ existe: true, esDirectorio: false })),
    ).toMatch(/no es una carpeta/i);
  });
});

describe('warehouse --out: la comprobación sobre el disco', () => {
  const dirs: string[] = [];

  function temporal(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-warehouse-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('no borra una carpeta con archivos que no son del pack', () => {
    const victima = join(temporal(), 'victima');
    mkdirSync(victima);
    writeFileSync(join(victima, 'NO-BORRAR.txt'), 'no me borres');

    const motivo = verificacionDeDestino(victima);
    expect(motivo).toMatch(/no está vacía/i);
    // Y de verdad no se ha tocado: sigue la carpeta y sigue el archivo.
    expect(existsSync(join(victima, 'NO-BORRAR.txt'))).toBe(true);
  });

  it('deja pasar un destino inexistente, uno vacío y un pack de Warehouse', () => {
    const base = temporal();
    expect(verificacionDeDestino(join(base, 'nuevo'))).toBeNull();

    const vacio = join(base, 'vacio');
    mkdirSync(vacio);
    expect(verificacionDeDestino(vacio)).toBeNull();

    const propio = join(base, 'propio');
    mkdirSync(propio);
    writeFileSync(
      join(propio, 'manifest.json'),
      JSON.stringify({ version: '1.0.0', pack: 'Warehouse', entries: [] }),
    );
    expect(verificacionDeDestino(propio)).toBeNull();
    expect(leerDestino(propio).manifestJson).not.toBeNull();
  });
});
