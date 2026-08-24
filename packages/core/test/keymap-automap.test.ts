/**
 * Leer la nota del nombre del archivo.
 *
 * Aquí lo que importa son los FALSOS POSITIVOS. Colocar `Bass2.wav` en el si
 * de la segunda octava no es un fallo que se vea al mirar: se ve tocando, con
 * el instrumento ya montado y veinte muestras encima. Más vale dejar una
 * muestra fuera del mapa y decirlo que colocarla donde no va.
 */

import { describe, expect, it } from 'vitest';
import {
  autoMapKeymap,
  noteToMidi,
  parseMidiNumberFromName,
  parseNoteFromName,
  zonesForNote,
} from '../src/index';

describe('parseNoteFromName', () => {
  it('lee los nombres normales de una librería', () => {
    expect(parseNoteFromName('Piano_C3.wav')).toBe(noteToMidi('C3'));
    expect(parseNoteFromName('Piano-A4.wav')).toBe(noteToMidi('A4'));
    expect(parseNoteFromName('EP C5.wav')).toBe(noteToMidi('C5'));
    expect(parseNoteFromName('808_F1.wav')).toBe(noteToMidi('F1'));
  });

  it('entiende sostenidos y bemoles, y la `s` de los que no pueden poner #', () => {
    expect(parseNoteFromName('Gtr_A#2.wav')).toBe(noteToMidi('A#2'));
    expect(parseNoteFromName('Gtr_Bb2.wav')).toBe(noteToMidi('Bb2'));
    // `Cs3` es `C#3`: hay sistemas de archivos donde `#` da problemas.
    expect(parseNoteFromName('Strings_Cs3.wav')).toBe(noteToMidi('C#3'));
  });

  it('no le importan mayúsculas ni la extensión', () => {
    expect(parseNoteFromName('piano_c3')).toBe(noteToMidi('C3'));
    expect(parseNoteFromName('PIANO_C3.WAV')).toBe(noteToMidi('C3'));
    expect(parseNoteFromName('piano_c3.flac')).toBe(noteToMidi('C3'));
  });

  it('NO se inventa notas dentro de palabras', () => {
    // El caso que arruina un auto-mapa entero.
    expect(parseNoteFromName('Bass2.wav')).toBeNull();
    expect(parseNoteFromName('Deep4.wav')).toBeNull();
    expect(parseNoteFromName('Grand3.wav')).toBeNull();
    expect(parseNoteFromName('Attack1.wav')).toBeNull();
    expect(parseNoteFromName('Take5.wav')).toBeNull();
  });

  it('sin octava no hay nota: una letra suelta no dice dónde va', () => {
    expect(parseNoteFromName('Piano_C.wav')).toBeNull();
    expect(parseNoteFromName('kit_A.wav')).toBeNull();
  });

  it('con dos candidatos gana el último', () => {
    // `F1` es el pad del que salió la muestra; `C3` es la nota. Ese orden
    // —contexto delante, nota detrás— es el que se repite.
    expect(parseNoteFromName('F1_Piano_C3.wav')).toBe(noteToMidi('C3'));
  });

  it('aguanta el sufijo de capa pegado a la nota', () => {
    expect(parseNoteFromName('Piano_C3v2.wav')).toBe(noteToMidi('C3'));
    expect(parseNoteFromName('Piano_C3_vel3.wav')).toBe(noteToMidi('C3'));
  });

  it('deja pasar una octava de margen para que la rescate el desplazamiento', () => {
    // Con la convención de la casa (C5 = 60) el suelo del teclado es C0. Un
    // archivo `C-1` viene de la científica (C4 = 60) y sale a -12: se devuelve
    // tal cual para que el auto-mapa lo suba una octava, en vez de tirarlo aquí.
    expect(parseNoteFromName('Sub_C0.wav')).toBe(0);
    expect(parseNoteFromName('Sub_C-1.wav')).toBe(-12);
    expect(parseNoteFromName('raro_C99.wav')).toBeNull();
  });

  it('un nombre sin nada devuelve null', () => {
    expect(parseNoteFromName('loop.wav')).toBeNull();
    expect(parseNoteFromName('')).toBeNull();
  });

  it('la CARPETA no cuenta: la nota va en el nombre del archivo', () => {
    // El peor falso positivo de todos, y el que solo aparece al soltar una
    // carpeta entera: la nota está en el nombre del directorio y las treinta
    // muestras aterrizan en la misma tecla. El instrumento se apila en un do y
    // nada en pantalla lo explica.
    expect(parseNoteFromName('C:\\Packs\\Piano C3\\take01.wav')).toBeNull();
    expect(parseNoteFromName('/home/yo/Piano C3/take01.wav')).toBeNull();
    expect(parseNoteFromName('Piano C3/take01.wav')).toBeNull();
    expect(parseMidiNumberFromName('C:\\Packs\\Kit 48\\golpe.wav')).toBeNull();
  });

  it('pero la nota del archivo sigue leyéndose dentro de una ruta', () => {
    expect(parseNoteFromName('C:\\Packs\\Lo que sea\\Piano_C3.wav')).toBe(noteToMidi('C3'));
    expect(parseNoteFromName('instrumentos/piano/Piano_A4.wav')).toBe(noteToMidi('A4'));
    expect(parseMidiNumberFromName('C:\\Packs\\Kit 48\\golpe_60.wav')).toBe(60);
  });
});

describe('parseMidiNumberFromName', () => {
  it('lee el número suelto de las librerías numeradas', () => {
    expect(parseMidiNumberFromName('Piano_60.wav')).toBe(60);
    expect(parseMidiNumberFromName('036.wav')).toBe(36);
  });

  it('descarta lo que no cabe en MIDI', () => {
    expect(parseMidiNumberFromName('Piano_500.wav')).toBeNull();
    expect(parseMidiNumberFromName('sin-numeros.wav')).toBeNull();
  });
});

describe('autoMapKeymap', () => {
  const piano = [
    { id: 's1', name: 'Piano_C3.wav' },
    { id: 's2', name: 'Piano_C4.wav' },
    { id: 's3', name: 'Piano_C5.wav' },
  ];

  it('monta el mapa y cubre el teclado entero', () => {
    const { zones, unreadable, source } = autoMapKeymap(piano);
    expect(source).toBe('name');
    expect(unreadable).toEqual([]);
    expect(zones).toHaveLength(3);
    for (let key = 0; key <= 127; key++) {
      expect(zonesForNote(zones, key, 0.8)).toHaveLength(1);
    }
  });

  it('cada muestra se queda con su nota', () => {
    const { zones } = autoMapKeymap(piano);
    const roots = zones.map((z) => z.keyRoot).sort((a, b) => a - b);
    expect(roots).toEqual([noteToMidi('C3'), noteToMidi('C4'), noteToMidi('C5')]);
  });

  it('lo que no sabe leer lo DICE, no lo coloca en cualquier sitio', () => {
    const { zones, unreadable } = autoMapKeymap([...piano, { id: 's4', name: 'ruido.wav' }]);
    expect(unreadable).toEqual(['ruido.wav']);
    expect(zones).toHaveLength(3);
    expect(zones.some((z) => z.sampleId === 's4')).toBe(false);
  });

  it('el desplazamiento de octavas arregla otra convención de golpe', () => {
    const sinOffset = autoMapKeymap(piano).zones.map((z) => z.keyRoot);
    const conOffset = autoMapKeymap(piano, { octaveOffset: 2 }).zones.map((z) => z.keyRoot);
    expect(conOffset).toEqual(sinOffset.map((r) => r + 24));
  });

  it('las tomas de la misma nota salen como capas de velocidad', () => {
    const { zones } = autoMapKeymap([
      { id: 'a', name: 'EP_C4_v1.wav' },
      { id: 'b', name: 'EP_C4_v2.wav' },
      { id: 'c', name: 'EP_C4_v3.wav' },
    ]);
    expect(zones).toHaveLength(3);
    // Cualquier golpe dispara UNA capa: dos sonarían al doble de volumen.
    for (const v of [0, 0.2, 0.5, 0.8, 1]) {
      expect(zonesForNote(zones, 60, v)).toHaveLength(1);
    }
    // Y el orden alfabético del nombre es de más suave a más fuerte.
    const suave = zones.find((z) => z.velLow === 0)!;
    expect(suave.sampleId).toBe('a');
  });

  it('se pueden pedir las capas apiladas en vez de repartidas', () => {
    const { zones } = autoMapKeymap(
      [
        { id: 'a', name: 'EP_C4_cerca.wav' },
        { id: 'b', name: 'EP_C4_lejos.wav' },
      ],
      { velocityLayers: false },
    );
    // Dos micros de la misma toma: suenan los dos a la vez, a propósito.
    expect(zonesForNote(zones, 60, 0.8)).toHaveLength(2);
  });

  it('cae a los números solo si NADIE traía nota escrita', () => {
    const numerado = autoMapKeymap([
      { id: 'a', name: 'Harp_48.wav' },
      { id: 'b', name: 'Harp_60.wav' },
    ]);
    expect(numerado.source).toBe('midi');
    expect(numerado.zones.map((z) => z.keyRoot).sort((a, b) => a - b)).toEqual([48, 60]);

    // Con UNA sola que traiga nota escrita, mandan los nombres: un número
    // suelto es casi siempre un índice de archivo, no una nota.
    const mixto = autoMapKeymap([
      { id: 'a', name: 'Harp_C3.wav' },
      { id: 'b', name: 'Harp_02.wav' },
    ]);
    expect(mixto.source).toBe('name');
    expect(mixto.unreadable).toEqual(['Harp_02.wav']);
  });

  it('un contador de tomas NO es una escala', () => {
    // `take01/02/03` se repartían por las teclas 1, 2 y 3: el instrumento
    // entero amontonado en el sótano del teclado, sonando cinco octavas por
    // debajo de donde debía y sin nada que lo explicara.
    const tomas = autoMapKeymap([
      { id: 'a', name: 'take01.wav' },
      { id: 'b', name: 'take02.wav' },
      { id: 'c', name: 'take03.wav' },
    ]);
    expect(tomas.source).toBe('none');
    expect(tomas.unreadable).toHaveLength(3);

    // Y uno que se reparte dos octavas pero empieza en 1 sigue siendo un
    // contador, no un teclado.
    const kit = autoMapKeymap([
      { id: 'a', name: 'Kit_01.wav' },
      { id: 'b', name: 'Kit_24.wav' },
    ]);
    expect(kit.source).toBe('none');
  });

  it('con una sola muestra numerada no se adivina', () => {
    // Con un número suelto no hay forma de saber si es la nota 60 o el archivo
    // número 60, y colocarlo mal transpone el instrumento entero.
    const r = autoMapKeymap([{ id: 'a', name: 'Harp_60.wav' }]);
    expect(r.source).toBe('none');
    expect(r.unreadable).toEqual(['Harp_60.wav']);
  });

  it('sin nada legible devuelve mapa vacío y lo dice', () => {
    const r = autoMapKeymap([{ id: 'a', name: 'loop.wav' }, { id: 'b', name: 'perc.wav' }]);
    expect(r.source).toBe('none');
    expect(r.zones).toEqual([]);
    expect(r.unreadable).toEqual(['loop.wav', 'perc.wav']);
  });

  it('sin muestras no revienta', () => {
    const r = autoMapKeymap([]);
    expect(r.zones).toEqual([]);
    expect(r.source).toBe('none');
  });

  it('una carpeta entera con la nota SOLO en la carpeta no se coloca', () => {
    // El caso completo del fallo, tal como llega al soltar un directorio.
    const r = autoMapKeymap([
      { id: 'a', name: 'C:\\Packs\\Piano C3\\take01.wav' },
      { id: 'b', name: 'C:\\Packs\\Piano C3\\take02.wav' },
      { id: 'c', name: 'C:\\Packs\\Piano C3\\take03.wav' },
    ]);
    expect(r.source).toBe('none');
    expect(r.zones).toEqual([]);
    expect(r.unreadable).toHaveLength(3);
  });

  it('y una carpeta bien nombrada se coloca entera', () => {
    const r = autoMapKeymap([
      { id: 'a', name: 'C:\\Packs\\Mi Piano\\Piano_C3.wav' },
      { id: 'b', name: 'C:\\Packs\\Mi Piano\\Piano_C4.wav' },
      { id: 'c', name: 'C:\\Packs\\Mi Piano\\Piano_C5.wav' },
    ]);
    expect(r.unreadable).toEqual([]);
    expect(r.zones.map((z) => z.keyRoot).sort((a, b) => a - b)).toEqual([
      noteToMidi('C3'),
      noteToMidi('C4'),
      noteToMidi('C5'),
    ]);
  });
});

describe('notas fuera del teclado', () => {
  it('sin desplazamiento se quedan fuera y se dicen', () => {
    const r = autoMapKeymap([
      { id: 'a', name: 'Sub_C-1.wav' },
      { id: 'b', name: 'Sub_C1.wav' },
    ]);
    expect(r.unreadable).toEqual(['Sub_C-1.wav']);
    expect(r.zones).toHaveLength(1);
  });

  it('con el desplazamiento entran', () => {
    const r = autoMapKeymap(
      [
        { id: 'a', name: 'Sub_C-1.wav' },
        { id: 'b', name: 'Sub_C1.wav' },
      ],
      { octaveOffset: 1 },
    );
    expect(r.unreadable).toEqual([]);
    expect(r.zones).toHaveLength(2);
    expect(r.zones.map((z) => z.keyRoot).sort((a, b) => a - b)).toEqual([0, 24]);
  });
});
