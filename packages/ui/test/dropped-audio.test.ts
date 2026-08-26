/**
 * Lo que decide un arrastre del Explorador, probado sin Explorador.
 *
 * Aquí no se prueba que Chromium entregue los bytes —eso lo hace él—, sino las
 * decisiones que se toman ANTES de tocar nada: qué entra, qué se rechaza y con
 * qué frase, qué pasa con una carpeta, y con qué nombre se guarda lo que entra.
 * Son las tres que, si fallan, fallan en silencio: un archivo que desaparece
 * sin decir por qué, una carpeta que parece que no hizo nada, y un nombre que
 * pisa el sample de otro proyecto.
 */

import { describe, expect, it } from 'vitest';
import {
  describeTriage,
  extensionOf,
  hasSystemFiles,
  MAX_DROPPED_BYTES,
  MAX_DROPPED_FILES,
  rejectionReason,
  stemOf,
  storedNameFor,
  triageDrop,
} from '../src/browser/dropped-audio';

/** Un File de mentira: lo justo que mira el triaje. */
const archivo = (name: string, size = 1024): File => ({ name, size }) as File;

/** DataTransfer de mentira, con `items` opcional (para el caso sin carpetas). */
function fakeDt(files: File[], carpetas: string[] = [], conItems = true): DataTransfer {
  const items = [
    ...files.map((f) => ({
      kind: 'file' as const,
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory: false }),
    })),
    ...carpetas.map((name) => ({
      kind: 'file' as const,
      getAsFile: () => archivo(name),
      webkitGetAsEntry: () => ({ isDirectory: true }),
    })),
  ];
  return {
    types: ['Files'],
    files,
    items: conItems ? items : [],
  } as unknown as DataTransfer;
}

describe('qué entra por un arrastre del sistema', () => {
  it('acepta las extensiones que Orbit sabe abrir', () => {
    for (const ext of ['.wav', '.mp3', '.ogg', '.flac', '.WAV', '.Flac']) {
      expect(rejectionReason({ name: `x${ext}`, size: 10 }), ext).toBeNull();
    }
  });

  it('rechaza lo que no es audio, y lo dice con el nombre de la extensión', () => {
    expect(rejectionReason({ name: 'notas.txt', size: 10 })).toMatch(/\.txt/);
    expect(rejectionReason({ name: 'tema.mid', size: 10 })).toMatch(/\.mid/);
    // Sin extensión no se adivina: mirar dentro costaría leer el archivo, y de
    // eso ya se encarga el decodificador del motor.
    expect(rejectionReason({ name: 'sin_punto', size: 10 })).toMatch(/extensión/);
    // Un punto inicial es un archivo oculto, no una extensión.
    expect(rejectionReason({ name: '.gitignore', size: 10 })).toMatch(/extensión/);
  });

  it('rechaza el vacío y lo que pasa del tope de tamaño', () => {
    expect(rejectionReason({ name: 'x.wav', size: 0 })).toMatch(/vacío/);
    expect(rejectionReason({ name: 'x.wav', size: MAX_DROPPED_BYTES + 1 })).toMatch(/MB/);
    expect(rejectionReason({ name: 'x.wav', size: MAX_DROPPED_BYTES })).toBeNull();
  });
});

describe('el triaje de un arrastre', () => {
  it('separa lo bueno de lo malo y conserva el orden', () => {
    const t = triageDrop(fakeDt([archivo('a.wav'), archivo('leeme.txt'), archivo('b.mp3')]));
    expect(t.accepted.map((f) => f.name)).toEqual(['a.wav', 'b.mp3']);
    expect(t.rejected).toEqual([{ name: 'leeme.txt', reason: expect.stringMatching(/\.txt/) }]);
  });

  it('una carpeta se cuenta aparte, no se rechaza como archivo raro', () => {
    // Es la diferencia entre "esto no vale" y "esto va por otra puerta": una
    // carpeta se REGISTRA y así se indexa entera, no se copia archivo a archivo.
    const t = triageDrop(fakeDt([archivo('a.wav')], ['Mis Samples']));
    expect(t.folders).toBe(1);
    expect(t.rejected).toEqual([]);
    expect(describeTriage(t, []).join(' ')).toMatch(/Añadir carpeta/);
  });

  it('sin `items` cae a `files` y no cuenta nada dos veces', () => {
    // Cada archivo aparece en `items` Y en `files`. Recorrer los dos lo
    // importaría por duplicado, con su copia en disco y su zona de keymap.
    const t = triageDrop(fakeDt([archivo('a.wav'), archivo('b.wav')], [], false));
    expect(t.accepted).toHaveLength(2);
  });

  it('corta en el tope y dice cuántos se quedaron fuera', () => {
    const muchos = Array.from({ length: MAX_DROPPED_FILES + 3 }, (_, i) => archivo(`s${i}.wav`));
    const t = triageDrop(fakeDt(muchos));
    expect(t.accepted).toHaveLength(MAX_DROPPED_FILES);
    expect(t.rejected).toHaveLength(3);
    expect(t.rejected[0]!.reason).toMatch(/tope/);
  });

  it('sabe si el arrastre trae archivos del sistema', () => {
    expect(hasSystemFiles(fakeDt([archivo('a.wav')]))).toBe(true);
    expect(
      hasSystemFiles({ types: ['application/x-orbit-sound'] } as unknown as DataTransfer),
    ).toBe(false);
  });
});

describe('con qué nombre se guarda lo importado', () => {
  it('es el del contenido, no el del archivo', () => {
    // Dos `kick.wav` distintos son dos archivos distintos: guardar por nombre
    // haría que el segundo pisara al primero y el proyecto de la semana pasada
    // sonaría con otro bombo sin que nada avisara.
    expect(storedNameFor('aa11', '.wav')).toBe('importado-aa11.wav');
    expect(storedNameFor('bb22', '.wav')).not.toBe(storedNameFor('aa11', '.wav'));
  });

  it('el mismo archivo dos veces cae en el mismo sitio', () => {
    expect(storedNameFor('aa11', '.wav')).toBe(storedNameFor('aa11', '.wav'));
  });

  it('no lleva el nombre original, que es lo que lee el auto-mapa', () => {
    // Un `Piano_C3-ab12cd.wav` le daría a leer un hash lleno de letras que son
    // notas y números que parecen octavas.
    expect(storedNameFor('ab12cd', '.wav')).not.toMatch(/piano/i);
  });
});

describe('extensionOf y stemOf', () => {
  it('parten el nombre por el último punto', () => {
    expect(extensionOf('a.b.wav')).toBe('.wav');
    expect(stemOf('a.b.wav')).toBe('a.b');
    expect(extensionOf('sin')).toBe('');
    expect(stemOf('sin')).toBe('sin');
    expect(extensionOf('.oculto')).toBe('');
    expect(stemOf('.oculto')).toBe('.oculto');
  });
});
