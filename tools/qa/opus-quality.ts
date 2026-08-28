/**
 * Cuánto se pierde por bit: el encoder de Orbit contra libopus, señal a señal.
 *
 *   npx tsx tools/qa/opus-quality.ts
 *
 * `opus-verify.ts` responde a la pregunta binaria —¿lo abre alguien que no
 * seamos nosotros?— y esa ya está contestada. Esta responde a la otra: **¿cómo
 * de bien lo hace?**, que es la que hay que poder contestar antes de tocar una
 * sola decisión del codificador. Afinar sin medir es cambiar cosas.
 *
 * El método es el mismo por los dos lados, y eso es lo que lo hace justo: la
 * MISMA señal se codifica con Orbit y con libopus al MISMO bitrate, las dos se
 * decodifican con ffmpeg, y las dos se comparan con el original alineando el
 * retardo y la ganancia óptima.
 *
 * ## Salen DOS números por caso, y no son intercambiables
 *
 * **SNR** — energía de señal partido energía del error. Mide **forma de onda**:
 * cuánto se parece la muestra que sale a la que entró. Es exacta, es sensible a
 * la fase y a un desalineado, y es la que caza una catástrofe.
 *
 * Y tiene un punto ciego que se puede demostrar en dos líneas: **es invariante
 * a cómo se reparte el error dentro de una banda**. Cualquier cambio del
 * codificador que coja el mismo error y lo mueva de unos bins a otros de la
 * misma banda sale exactamente igual. Eso no es un caso raro: es lo que hace la
 * dispersión del PVQ, cuya rotación es ortogonal y por tanto conserva la norma.
 * En la v3.4 la dispersión adaptativa se midió sólo con SNR, salió −0,02 dB, y
 * se quedó sin decidir. La medida no dijo que no sirviera: dijo que no la veía.
 *
 * **Patrón** — relación patrón/distorsión perceptual, en dB, también hacia
 * arriba mejor. No es una diferencia: se calcula el patrón de excitación del
 * original y el de la copia POR SEPARADO, cada uno pasado por un modelo de oído
 * (PEAQ simplificado: ponderación de oído externo y medio, bandas de 0,25 Bark,
 * dispersión frecuencial dependiente del nivel, suavizado temporal, ruido
 * interno), y se restan DESPUÉS, en el dominio comprimido de la sonoridad.
 * Restar después es justo lo que le deja ver el reparto dentro de la banda, y
 * también dónde cae el error respecto a lo que lo tapa. Es ciega a la fase.
 *
 * **Cuál manda para decidir**: la de patrón. La SNR se queda como red de
 * seguridad — si un cambio mejora el patrón y hunde la SNR varios dB, es que ha
 * roto algo, no que haya afinado nada. Y ninguna de las dos es una nota de
 * calidad absoluta: valen para comparar dos versiones del MISMO encoder y para
 * ver si la distancia a libopus se acorta o se ensancha.
 *
 * Los dos puntos ciegos de la SNR están probados a mano, sin ffmpeg y sin
 * codificar nada, en `packages/engine/test/opus-perceptual.test.ts`.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';
import {
  CASOS,
  DURACION,
  MAX_LAG,
  SENALES,
  conLibopus,
  decodificar,
  findFfmpeg,
  izquierdo,
  media,
  nombreCaso,
} from './opus-bench';
import { patronDb, snrDb } from './opus-metrics';

const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-q-'));

interface Fila {
  senal: string;
  caso: string;
  snrOrbit: number;
  snrLibopus: number;
  patronOrbit: number;
  patronLibopus: number;
}

const filas: Fila[] = [];

try {
  for (const senal of SENALES) {
    console.log(`\n· ${senal.nombre} — ${senal.porque}`);
    for (const { channels, bitrate } of CASOS) {
      const caso = nombreCaso(channels, bitrate);
      const pcm = senal.hacer(channels, DURACION);
      const etiqueta = `${senal.nombre}-${channels}-${bitrate}`;

      const nuestro = join(dir, `${etiqueta}.orbit.opus`);
      writeFileSync(nuestro, encodeOpusFile(pcm, { channels, bitrate, frameSize: 960 }));

      const original = izquierdo(pcm, channels);
      const orbit = decodificar(ffmpeg, dir, nuestro, channels, `${etiqueta}-o`);
      const libopus = decodificar(
        ffmpeg,
        dir,
        conLibopus(ffmpeg, dir, pcm, channels, bitrate, etiqueta),
        channels,
        `${etiqueta}-l`,
      );

      const fila: Fila = {
        senal: senal.nombre,
        caso,
        snrOrbit: snrDb(original, orbit, MAX_LAG),
        snrLibopus: snrDb(original, libopus, MAX_LAG),
        patronOrbit: patronDb(original, orbit, 48000, MAX_LAG),
        patronLibopus: patronDb(original, libopus, 48000, MAX_LAG),
      };
      filas.push(fila);
      const dSnr = fila.snrOrbit - fila.snrLibopus;
      const dPatron = fila.patronOrbit - fila.patronLibopus;
      const signo = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
      console.log(
        `  ${caso.padEnd(12)}` +
        `  SNR ${fila.snrOrbit.toFixed(2).padStart(6)} / ${fila.snrLibopus.toFixed(2).padStart(6)}` +
        ` = ${signo(dSnr).padStart(6)} dB` +
        `  ·  patrón ${fila.patronOrbit.toFixed(2).padStart(6)} / ` +
        `${fila.patronLibopus.toFixed(2).padStart(6)} = ${signo(dPatron).padStart(6)} dB`,
      );
    }
  }
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const brechaSnr = filas.map((f) => f.snrOrbit - f.snrLibopus);
const brechaPatron = filas.map((f) => f.patronOrbit - f.patronLibopus);
console.log(`\n── Resumen ──`);
console.log(`  SNR      Orbit ${media(filas.map((f) => f.snrOrbit)).toFixed(2).padStart(6)} dB · ` +
  `libopus ${media(filas.map((f) => f.snrLibopus)).toFixed(2).padStart(6)} dB · ` +
  `distancia ${media(brechaSnr).toFixed(2)} dB · la peor ${Math.min(...brechaSnr).toFixed(2)} dB`);
console.log(`  patrón   Orbit ${media(filas.map((f) => f.patronOrbit)).toFixed(2).padStart(6)} dB · ` +
  `libopus ${media(filas.map((f) => f.patronLibopus)).toFixed(2).padStart(6)} dB · ` +
  `distancia ${media(brechaPatron).toFixed(2)} dB · la peor ${Math.min(...brechaPatron).toFixed(2)} dB`);
console.log(
  '\n  Para decidir manda el patrón; la SNR es la red de seguridad. Y ninguna\n' +
  '  de las dos es una nota de calidad: valen para comparar dos versiones del\n' +
  '  mismo encoder y para ver si la distancia a libopus se acorta.\n',
);
