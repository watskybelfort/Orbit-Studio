import { describe, expect, it } from 'vitest';
import { reasonOf } from '../src/browser/status';
import { readSource } from './read-source';

describe('motivo del aviso del Browser', () => {
  it('pega el mensaje del error detrás del aviso', () => {
    expect(reasonOf(new Error('EACCES: permission denied'))).toBe(': EACCES: permission denied');
    expect(`No se pudo leer /samples${reasonOf(new Error('ENOENT'))}`).toBe(
      'No se pudo leer /samples: ENOENT',
    );
  });

  it('no inventa un motivo cuando el error no trae texto', () => {
    // Un `throw` de una cadena o de un objeto suelto no es un Error; pegarlo
    // tal cual escribiría «undefined» o «[object Object]» en la barra.
    expect(reasonOf('boom')).toBe('');
    expect(reasonOf({ code: 'EACCES' })).toBe('');
    expect(reasonOf(undefined)).toBe('');
    expect(reasonOf(null)).toBe('');
    expect(reasonOf(new Error(''))).toBe('');
    // Un mensaje que es solo espacios dejaría un «: » colgando.
    expect(reasonOf(new Error('   \n '))).toBe('');
  });

  it('recorta los extremos pero conserva el mensaje de varias líneas', () => {
    expect(reasonOf(new Error('  EPERM\nen /Users/x  '))).toBe(': EPERM\nen /Users/x');
  });

  it('el Browser usa el helper en los dos sitios que fallan al leer una carpeta', () => {
    // La lectura inicial (en segundo plano) y el reescaneo manual avisan por
    // caminos distintos: si uno se queda sin el motivo, la mitad de los casos
    // vuelve a decir solo «No se pudo … X».
    const src = readSource('browser/Browser.tsx');
    expect(src).toMatch(/\.catch\(\(err: unknown\) => setStatus\(`No se pudo leer \$\{dir\}\$\{reasonOf\(err\)\}`\)\)/);
    expect(src).toMatch(/setStatus\(`No se pudo escanear \$\{dir\}\$\{reasonOf\(err\)\}`\)/);
    // Una sola definición, en el módulo puro: si vuelve a haber copia local,
    // el test del helper deja de proteger lo que pinta el panel.
    expect(src).not.toMatch(/function reasonOf/);
    expect(src).toMatch(/import \{ reasonOf \} from '\.\/status';/);
  });
});
