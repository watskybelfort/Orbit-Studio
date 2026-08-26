/**
 * El pack de fábrica sonando DE VERDAD: los WAV del disco, cargados en el
 * kernel, tocados por el piano roll.
 *
 * Los otros tests miran las piezas por separado — que la síntesis grabe a la
 * altura que dice, que el manifest sea coherente, que el motor elija la zona
 * correcta. Este junta las tres y comprueba lo único que le importa a quien
 * usa esto: que al pulsar una tecla suene ESA nota, con ESA grabación.
 *
 * Ahí hay un fallo que ninguna de las piezas ve sola: si la nota que declara el
 * manifest no está en la misma convención que la tecla del piano roll, todo
 * "funciona" y el instrumento entero suena a dos octavas de donde debe. Es
 * exactamente lo que pasaba antes de esto: un bajo grabado en C2 y colocado en
 * la tecla 60 sonaba dos octavas por debajo de lo que decía la pantalla.
 *
 * **No se detecta la altura, se COMPARA con la grabación.** Un detector de
 * altura sobre una cuerda pulsada salta de la primera parcial a la segunda
 * entre dos lecturas del mismo sample, y eso aparece como un error de octava
 * exacta que es de la medida y no del audio — justo el error que hay que poder
 * ver. Aquí se correlaciona la salida del sampler con la grabación remuestreada
 * a la velocidad que le tocaría: si la zona elegida o la transposición fueran
 * otras, la correlación se hunde. Es una medida sin criterio propio.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createKeymapZone,
  midiToHz,
  newId,
  normalizeKeymap,
  spreadKeymapRanges,
  type Note,
} from '@orbit/core';
import { compileProject } from '../../engine/src/compile';
import { KernelCore, MAX_BLOCK } from '../../engine/src/kernel-core';
import { INSTRUMENTS, midiDeHz, rootsFor } from '../generate/instruments';
import {
  entrySamples,
  loadManifest,
  sampleIdFor,
  type SoundEntry,
  type SoundSample,
} from '../src/index';

const PACK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'factory');
const MANIFEST = path.join(PACK, 'manifest.json');
const SR = 44100;

const hayPack = fs.existsSync(MANIFEST);

type Wav = { left: Float32Array; right: Float32Array; rate: number };

/**
 * Los WAV decodificados, cacheados.
 *
 * No es una optimización por gusto: sin ella este archivo decodifica los mismos
 * 144 archivos cientos de veces —una por nota tocada— y el conjunto se pone a
 * rozar el tiempo máximo de un test. Un test que a veces tarda de más es peor
 * que uno lento: falla cuando la máquina está ocupada y no cuando hay un fallo.
 */
const cache = new Map<string, Wav>();

function leerWav(file: string): Wav {
  const guardado = cache.get(file);
  if (guardado) return guardado;
  const wav = decodificarWav(file);
  cache.set(file, wav);
  return wav;
}

/** Lector mínimo de WAV PCM 16 bits (lo que escribe el generador). */
function decodificarWav(file: string): Wav {
  const buf = fs.readFileSync(path.join(PACK, file));
  const ascii = (off: number, n: number) => buf.toString('ascii', off, off + n);
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error(`${file}: no es un WAV`);
  let off = 12;
  let canales = 1;
  let rate = SR;
  let bits = 16;
  let left = new Float32Array(0);
  let right = new Float32Array(0);
  while (off + 8 <= buf.length) {
    const id = ascii(off, 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      canales = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`${file}: se esperaba 16 bits, hay ${bits}`);
      const muestras = Math.floor(size / 2 / canales);
      left = new Float32Array(muestras);
      right = new Float32Array(muestras);
      let p = off + 8;
      for (let i = 0; i < muestras; i++) {
        left[i] = buf.readInt16LE(p) / 32768;
        p += 2;
        right[i] = canales > 1 ? buf.readInt16LE(p) / 32768 : left[i]!;
        if (canales > 1) p += 2;
      }
    }
    off += 8 + size + (size % 2);
  }
  return { left, right, rate };
}

/** La grabación leída a `razon` veces su velocidad (igual que el sampler). */
function remuestrear(src: Float32Array, razon: number, n: number, desde = 0): Float32Array {
  const out = new Float32Array(n);
  let pos = desde;
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(pos);
    if (idx + 1 >= src.length) break;
    const frac = pos - idx;
    out[i] = src[idx]! * (1 - frac) + src[idx + 1]! * frac;
    pos += razon;
  }
  return out;
}

/** Correlación de Pearson: 1 = la misma forma de onda (a cualquier volumen). */
function correlacion(a: Float32Array, b: Float32Array, desdeA: number, desdeB: number, n: number): number {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let cuenta = 0;
  for (let i = 0; i < n; i++) {
    const x = a[desdeA + i];
    const y = b[desdeB + i];
    if (x === undefined || y === undefined) break;
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
    cuenta++;
  }
  if (cuenta < 64) return 0;
  const cov = sab / cuenta - (sa / cuenta) * (sb / cuenta);
  const va = saa / cuenta - (sa / cuenta) ** 2;
  const vb = sbb / cuenta - (sb / cuenta) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/**
 * La mejor correlación probando desplazamientos pequeños. El sampler arranca
 * en el bloque de la nota, no en la muestra exacta, así que hay que buscarle
 * el sitio — pero solo unos milisegundos.
 */
function mejorCorrelacion(salida: Float32Array, esperado: Float32Array, desde: number): number {
  let mejor = 0;
  for (let lag = 0; lag <= 300; lag++) {
    const r = correlacion(salida, esperado, desde + lag, 0, 8192);
    if (r > mejor) mejor = r;
  }
  return mejor;
}

function rms(xs: Float32Array): number {
  let s = 0;
  for (const v of xs) s += v * v;
  return Math.sqrt(s / Math.max(1, xs.length));
}

/**
 * Cómo de brillante es una señal, sin FFT: la frecuencia cuadrática media.
 *
 * Para un seno de f hercios, la energía de la diferencia entre muestras
 * consecutivas dividida por la de la señal vale 2·(1−cos(2πf/sr)) — o sea que
 * sube con la frecuencia y no depende del volumen. No hace falta más para
 * decir cuál de dos tomas es la oscura, y sale de mirar la señal como está,
 * que es justo lo que aquí interesa: lo que le llega al altavoz después del
 * sampler, del canal y del máster.
 */
function brilloRms(xs: Float32Array): number {
  let dif = 0;
  let total = 0;
  for (let i = Math.round(0.01 * SR) + 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!;
    dif += d * d;
    total += xs[i]! * xs[i]!;
  }
  return total > 0 ? Math.sqrt(dif / total) : 0;
}

/**
 * Monta el canal tal como lo monta la app al soltar el instrumento en el rack
 * —mismas zonas, mismo reparto— y toca una tecla.
 */
function tocar(entry: SoundEntry, key: number, velocity = 0.9, bloques = 120): Float32Array {
  const project = createEmptyProject();
  const channel = createChannel('sampler', 0, entry.name);
  const tomas = entrySamples(entry);
  channel.sampleId = sampleIdFor(entry, entry.file);
  // El mismo keymap que monta la app: las franjas de fuerza salen del
  // manifest igual que las raíces. El pack SABE con qué pulsación grabó cada
  // toma, y adivinarlo sería tirar un dato cierto.
  channel.keymap = normalizeKeymap(
    spreadKeymapRanges(
      tomas.map((s) =>
        createKeymapZone(sampleIdFor(entry, s.file), {
          keyRoot: s.rootMidi,
          velLow: s.velLow ?? 0,
          velHigh: s.velHigh ?? 1,
        }),
      ),
    ),
  );
  applyCommand(project, { type: 'addChannel', channel });
  for (const s of tomas) {
    const id = sampleIdFor(entry, s.file);
    applyCommand(project, {
      type: 'registerSample',
      sample: { id, name: id, path: `factory:${s.file}`, hash: id, duration: s.durationSec },
    });
  }
  const patternId = project.patternOrder[0]!;
  const note: Note = { id: newId(), start: 0, duration: 4, key, velocity, pan: 0, slide: false };
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id, notes: [note] });

  const core = new KernelCore(SR);
  for (const s of tomas) {
    const wav = leerWav(s.file);
    core.handleMessage({
      type: 'loadSample',
      sampleId: sampleIdFor(entry, s.file),
      left: wav.left,
      right: wav.right,
      sampleRate: wav.rate,
    });
  }
  core.handleMessage({
    type: 'snapshot',
    project: compileProject(project, { mode: 'pattern', patternId }),
  });
  core.handleMessage({ type: 'play', fromBeat: 0 });

  const out = new Float32Array(bloques * MAX_BLOCK);
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < bloques; b++) {
    core.process(l, r, MAX_BLOCK);
    out.set(l, b * MAX_BLOCK);
  }
  return out;
}

/**
 * Una velocidad que caiga DENTRO de la franja de una toma: el centro.
 *
 * Sin esto, todas las pruebas de aquí tocarían a 0,9 y estarían midiendo
 * siempre la capa fuerte: la floja existiría en el manifest, en el disco y en
 * el instalador sin que ningún test la llegara a tocar nunca.
 */
function velocidadDe(toma: SoundSample): number {
  return ((toma.velLow ?? 0) + (toma.velHigh ?? 1)) / 2;
}

describe.skipIf(!hayPack)('el pack de fábrica, tocado', () => {
  const manifest = loadManifest(fs.readFileSync(MANIFEST, 'utf8'));
  const instrumentos = manifest.entries.filter((e) => e.category === 'instrumentos');

  describe('el ancla: la nota del manifest es la frecuencia a la que se grabó', () => {
    // Todo lo demás de este archivo compara la salida CON el manifest, así que
    // un desfase uniforme —las 24 tomas etiquetadas una octava de más— pasaría
    // sin despeinarse: el sampler transpondría 0 semitonos igual. El ancla
    // tiene que venir de fuera, y es esta — la frecuencia a la que el
    // sintetizador grabó de verdad cada toma, contra la que el piano roll le
    // atribuye a esa tecla.
    for (const spec of INSTRUMENTS) {
      it(`${spec.slug}`, () => {
        const entry = manifest.entries.find((e) => e.id === `instrumentos/${spec.slug}`);
        expect(entry, `${spec.slug} no está en el manifest`).toBeDefined();
        const raices = rootsFor(spec);
        // Las notas sin repetir: cada altura trae ahora una toma por capa de
        // fuerza, y las dos declaran la misma nota.
        expect([...new Set(entry!.samples?.map((s) => s.rootMidi))]).toEqual(
          raices.map(midiDeHz),
        );
        for (const hz of raices) {
          const midi = midiDeHz(hz);
          expect(
            Math.abs(midiToHz(midi) - hz) / hz,
            `${spec.slug}: MIDI ${midi} son ${midiToHz(midi).toFixed(2)} Hz y se grabó a ${hz.toFixed(2)}`,
          ).toBeLessThan(0.001);
        }
      });
    }
  });

  describe('cada tecla toca la grabación que le toca, a la velocidad que le toca', () => {
    for (const entry of instrumentos) {
      it(`${entry.id}`, () => {
        for (const toma of entry.samples!) {
          const grabacion = leerWav(toma.file).left;
          // Tocada con una fuerza de SU franja: es lo que la trae al aire.
          const vel = velocidadDe(toma);
          const donde = `${entry.id} @ MIDI ${toma.rootMidi} vel ${vel}`;

          // 1. En la RAÍZ de su zona, la grabación suena TAL CUAL. Si el
          //    `rootMidi` del manifest no estuviera en la convención del piano
          //    roll, aquí saldría leída a otra velocidad y la correlación se
          //    hundiría — que es el fallo que se busca.
          const enRaiz = tocar(entry, toma.rootMidi, vel);
          expect(rms(enRaiz), `${donde}: mudo`).toBeGreaterThan(1e-4);
          expect(
            mejorCorrelacion(enRaiz, grabacion, 0),
            `${donde}: no suena su grabación sin transponer`,
          ).toBeGreaterThan(0.9);

          // 2. Cinco semitonos arriba es la MISMA grabación leída más rápido.
          const arriba = tocar(entry, toma.rootMidi + 5, vel);
          expect(
            mejorCorrelacion(arriba, remuestrear(grabacion, Math.pow(2, 5 / 12), 20000), 0),
            `${donde}+5: la transposición no cuadra`,
          ).toBeGreaterThan(0.85);
        }
      });
    }
  });

  describe('la misma tecla, floja y fuerte, no suena igual', () => {
    // Esta es la prueba de las capas de velocidad del lado de quien toca: la
    // misma nota, el mismo canal, y lo único que cambia es cuánto aprietas.
    //
    // Los dos fallos que caza no dan error por su cuenta. Si el keymap no
    // separase las capas, sonarían las DOS a la vez —el timbre flojo y el
    // fuerte sumados, la nota al doble de volumen—. Y si la síntesis hubiera
    // grabado dos veces lo mismo, saldrían dos señales de idéntico timbre y
    // distinto volumen: el manifest perfecto, el instalador 28 MB más gordo y
    // en el teclado nada.
    for (const entry of instrumentos) {
      it(`${entry.id}`, () => {
        const tomas = entry.samples!;
        const nota = tomas.find((s) => s.file === entry.file)!.rootMidi;
        const floja = tomas.find((s) => s.rootMidi === nota && velocidadDe(s) < 0.5)!;
        const fuerte = tomas.find((s) => s.rootMidi === nota && velocidadDe(s) > 0.5)!;

        const salidaFloja = tocar(entry, nota, 0.25);
        const salidaFuerte = tocar(entry, nota, 0.9);

        // 1. Cada pulsación trae SU grabación, no la de al lado.
        expect(
          mejorCorrelacion(salidaFloja, leerWav(floja.file).left, 0),
          `${entry.id}: pulsando flojo no suena la capa floja`,
        ).toBeGreaterThan(0.9);
        expect(
          mejorCorrelacion(salidaFuerte, leerWav(fuerte.file).left, 0),
          `${entry.id}: pulsando fuerte no suena la capa fuerte`,
        ).toBeGreaterThan(0.9);

        // 2. Y lo que sale por el máster es MÁS OSCURO, que es el motivo de
        //    haber grabado dos veces cada altura.
        const oscura = brilloRms(salidaFloja);
        const clara = brilloRms(salidaFuerte);
        expect(
          oscura / clara,
          `${entry.id}: pulsar flojo no oscurece, solo baja el volumen`,
        ).toBeLessThan(0.98);
      });
    }
  });

  it('la zona que suena es la de la raíz MÁS CERCANA, no otra', () => {
    // Con tres tomas repartidas, tocar la raíz de la de arriba no puede sonar
    // con la de abajo estirada dos octavas: eso sonaría, pero sonaría a lo que
    // este trabajo vino a quitar.
    for (const entry of instrumentos) {
      const tomas = entry.samples!;
      for (const toma of tomas) {
        const vel = velocidadDe(toma);
        const salida = tocar(entry, toma.rootMidi, vel);
        const suya = mejorCorrelacion(salida, leerWav(toma.file).left, 0);
        for (const otra of tomas) {
          if (otra.file === toma.file) continue;
          // Solo contra las tomas de su MISMA capa de fuerza. Las de la otra
          // capa ni siquiera están sonando, y la de la misma nota se le parece
          // mucho a propósito —es la misma cuerda golpeada distinto—, así que
          // meterlas aquí no diría nada de lo que esta prueba busca, que es la
          // elección de RAÍZ. Que flojo y fuerte suenen distinto se prueba
          // aparte, y midiendo el timbre.
          if (velocidadDe(otra) !== vel) continue;
          const razon = Math.pow(2, (toma.rootMidi - otra.rootMidi) / 12);
          const ajena = mejorCorrelacion(
            salida,
            remuestrear(leerWav(otra.file).left, razon, 20000),
            0,
          );
          expect(
            suya,
            `${entry.id} @ MIDI ${toma.rootMidi}: se parece más a ${otra.file} que a la suya`,
          ).toBeGreaterThan(ajena);
        }
      }
    }
  });

  it('el teclado entero suena: ninguna tecla cae en un hueco', () => {
    // `spreadKeymapRanges` estira la zona más grave hacia abajo y la más aguda
    // hacia arriba, así que no puede quedar ni una tecla muda entre medias.
    for (const entry of instrumentos) {
      for (const key of [0, 24, 40, 55, 60, 70, 88, 110, 127]) {
        // Y a las dos fuerzas: un hueco en la franja deja la tecla muda solo a
        // una de las dos capas, y tocando siempre a 0,9 eso no se ve nunca.
        for (const vel of [0.2, 0.9]) {
          const out = tocar(entry, key, vel, 40);
          const donde = `${entry.id} @ ${key} vel ${vel}`;
          expect(rms(out), donde).toBeGreaterThan(1e-5);
          expect(out.some((v) => !Number.isFinite(v)), donde).toBe(false);
        }
      }
    }
  });
});
