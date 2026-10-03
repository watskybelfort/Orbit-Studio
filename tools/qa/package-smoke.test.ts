import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const prefix = resolve(tmpdir(), 'orbit-package-smoke-');
const script = readFileSync(new URL('./package-smoke.mjs', import.meta.url));
const manifest = { version: '1.0.0', entries: [{ id: 'kick', file: 'drums/kick.wav', name: 'Kick' }] };

function put(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function fixture() {
  const root = mkdtempSync(prefix);
  roots.push(root);
  const source = join(root, 'packages/sound-library/factory');
  const dist = join(root, 'apps/desktop/dist');
  const unpacked = join(dist, 'win-unpacked');
  const pack = join(unpacked, 'resources/sound-library');
  const executable = join(root, 'tools/qa/package-smoke.mjs');
  put(executable, script);
  for (const dir of [source, pack]) {
    put(join(dir, 'manifest.json'), JSON.stringify(manifest));
    put(join(dir, 'drums/kick.wav'), Buffer.from([1, 2, 3, 4]));
  }
  put(join(unpacked, 'Orbit Studio.exe'), 'placeholder: no se ejecuta');
  const run = (...args: string[]) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', windowsHide: true });
  return { root, source, dist, unpacked, pack, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Solo los directorios concretos creados por mkdtemp en este test.
    if (!resolve(root).startsWith(prefix) || dirname(root) !== dirname(prefix)) throw new Error('Directorio temporal fuera del ámbito');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('029: smoke comprueba el pack real, además de contar entradas', () => {
  it('acepta manifest y audio idénticos, aunque cambie el formato del JSON', () => {
    const f = fixture();
    put(join(f.pack, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASÓ');
  });

  it.each(['id', 'file', 'name', 'version'] as const)('rechaza pack viejo con igual cantidad y distinto %s', (field) => {
    const f = fixture();
    const old = structuredClone(manifest);
    if (field === 'version') old.version = '0.1.0';
    else old.entries[0]![field] = field === 'file' ? 'drums/old.wav' : 'old';
    put(join(f.pack, 'drums/old.wav'), Buffer.from([1, 2, 3, 4]));
    put(join(f.pack, 'manifest.json'), JSON.stringify(old));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no coincide');
  });

  it('rechaza bytes antiguos con los mismos nombres, manifest y longitud', () => {
    const f = fixture();
    put(join(f.pack, 'drums/kick.wav'), Buffer.from([4, 3, 2, 1]));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drums/kick.wav');
    expect(result.stderr).toContain('contenido');
  });

  it('sigue rechazando un audio ausente en el paquete', () => {
    const f = fixture();
    rmSync(join(f.pack, 'drums/kick.wav'));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('drums/kick.wav');
  });
});

describe('030: detección de artefactos sin elegir una versión antigua por orden', () => {
  it('con dos instaladores falla y pide ruta explícita', () => {
    const f = fixture();
    put(join(f.dist, 'Orbit Studio Setup 3.0.0.exe'), 'viejo');
    put(join(f.dist, 'Orbit Studio Setup 4.0.0.exe'), 'nuevo');
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('varios instaladores');
    expect(result.stderr).toContain('explícita');
  });

  it('ruta explícita identifica el instalador aunque haya otros anteriores', () => {
    const f = fixture();
    put(join(f.dist, 'Orbit Studio Setup 3.0.0.exe'), 'viejo');
    const current = join(f.dist, 'Orbit Studio Setup 4.0.0.exe');
    put(current, 'nuevo');
    const result = f.run(f.unpacked, current);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`instalador: ${current}`);
    expect(result.stdout).not.toContain('3.0.0.exe');
  });

  it('una ruta explícita ausente es error, no un smoke exitoso', () => {
    const f = fixture();
    const result = f.run(f.unpacked, join(f.dist, 'missing.exe'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('instalador');
  });

  it('un solo instalador se identifica, ignorando carpetas con sufijo exe', () => {
    const f = fixture();
    mkdirSync(join(f.dist, '0-carpeta.exe'));
    const current = join(f.dist, 'Orbit Studio Setup.exe');
    put(current, 'instalador');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`instalador: ${current}`);
  });

  it('dos unpacked también requieren destino explícito', () => {
    const f = fixture();
    mkdirSync(join(f.dist, 'old-unpacked'));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('varias carpetas');
    expect(f.run(f.unpacked).status).toBe(0);
  });
});
