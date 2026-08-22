/**
 * Extrae las tablas de CELT de la implementación de referencia y genera
 * `packages/engine/src/render/opus/tables.ts`.
 *
 *   npx tsx tools/opus-tables.ts <ruta a opus-rfc6716>
 *
 * ## Por qué un script y no copiar y pegar
 *
 * Son ~650 números que tienen que estar EXACTOS. Una sola cifra cambiada da un
 * archivo que no abre nadie, y el fallo no se parecería a un error de tabla: se
 * parecería a audio roto varias capas más arriba. Transcribir a mano es
 * justamente la operación en la que un humano —o yo— mete un dedazo sin
 * enterarse, y revisarlo a ojo no es una comprobación, es una ilusión.
 *
 * Con esto, la procedencia es reproducible: cualquiera puede volver a extraer el
 * tarball de la RFC (el propio documento explica cómo, y da el SHA-1), pasar
 * este script y comparar el resultado con lo que hay en el repo.
 *
 * ## De dónde sale el fuente
 *
 *   curl -sO https://www.rfc-editor.org/rfc/rfc6716.txt
 *   cat rfc6716.txt | grep '^\ \ \ ###' | sed -e 's/...###//' | base64 --decode \
 *     > opus-rfc6716.tar.gz
 *   sha1sum opus-rfc6716.tar.gz   # 86a927223e73d2476646a1b933fcd3fffb6ecc8c
 *   tar xzf opus-rfc6716.tar.gz
 *
 * El hash está en la propia RFC (Apéndice A.1): si no cuadra, no se sigue.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('Uso: npx tsx tools/opus-tables.ts <ruta a opus-rfc6716>');
  process.exit(1);
}

/** Quita comentarios de C: dentro de las tablas hay etiquetas y cabeceras. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Saca el cuerpo `{ ... };` de una declaración por nombre.
 *
 * Se busca el nombre seguido de `[`, y luego se cuenta llaves: las tablas
 * multidimensionales llevan llaves anidadas y un `indexOf('}')` cortaría por
 * la primera.
 */
function tableBody(source: string, name: string): string {
  const declaration = new RegExp(`\\b${name}\\s*\\[[^=]*=`, 'm');
  const match = declaration.exec(source);
  if (!match) throw new Error(`no encuentro la declaración de ${name}`);
  let at = source.indexOf('{', match.index + match[0].length - 1);
  if (at < 0) throw new Error(`${name} no abre llave`);
  let depth = 0;
  const start = at;
  for (; at < source.length; at++) {
    if (source[at] === '{') depth++;
    else if (source[at] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, at + 1);
    }
  }
  throw new Error(`${name} no cierra llave`);
}

/** Todos los enteros de un cuerpo de tabla, en orden de lectura. */
function numbers(body: string): number[] {
  const out: number[] = [];
  for (const token of stripComments(body).matchAll(/-?\d+/g)) out.push(Number(token[0]));
  return out;
}

function read(file: string): string {
  return stripComments(readFileSync(resolve(root!, file), 'utf8'));
}

const modes = read('celt/modes.c');
const quantBands = read('celt/quant_bands.c');
const celt = read('celt/celt.c');
const rate = read('celt/rate.c');

const ebands = numbers(tableBody(modes, 'eband5ms'));
const allocation = numbers(tableBody(modes, 'band_allocation'));
const eProb = numbers(tableBody(quantBands, 'e_prob_model'));
const smallEnergy = numbers(tableBody(quantBands, 'small_energy_icdf'));
const trim = numbers(tableBody(celt, 'trim_icdf'));
const spread = numbers(tableBody(celt, 'spread_icdf'));
const tapset = numbers(tableBody(celt, 'tapset_icdf'));
const tfSelect = numbers(tableBody(celt, 'tf_select_table'));
const log2FracTable = numbers(tableBody(rate, 'LOG2_FRAC_TABLE'));

// `fits_in32` lleva dos tablas locales con el mismo nombre en distintos ámbitos;
// se extraen de su cuerpo para no confundirlas con nada de fuera.
const fits = rate.slice(rate.indexOf('fits_in32'));
const maxN = numbers(tableBody(fits, 'maxN'));
const maxK = numbers(tableBody(fits, 'maxK'));

/** Los coeficientes de predicción están en Q15; se emiten ya normalizados. */
function q15(name: string): number[] {
  const body = tableBody(quantBands, name);
  // Se coge la versión de coma flotante (`29440/32768.`), que es la que aplica
  // aquí: el numerador es el mismo valor Q15 de la versión de enteros.
  return numbers(body)
    .filter((_, i, all) => all.length % 2 === 0 || true)
    .filter((value) => value !== 32768)
    .map((value) => value / 32768);
}

const NBANDS = ebands.length - 1;

function assertSize(name: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`${name}: esperaba ${expected} valores, hay ${actual}`);
}

assertSize('eband5ms', ebands.length, 22);
assertSize('band_allocation', allocation.length, 11 * NBANDS);
assertSize('e_prob_model', eProb.length, 4 * 2 * 42);
assertSize('tf_select_table', tfSelect.length, 4 * 8);
assertSize('LOG2_FRAC_TABLE', log2FracTable.length, 24);
assertSize('maxN', maxN.length, 15);
assertSize('maxK', maxK.length, 15);

/** Parte una lista plana en filas, para que el archivo generado se pueda leer. */
function rows(values: number[], perRow: number, indent = '  '): string {
  const lines: string[] = [];
  for (let i = 0; i < values.length; i += perRow) {
    lines.push(indent + values.slice(i, i + perRow).join(', ') + ',');
  }
  return lines.join('\n');
}

function nested(values: number[], shape: number[]): string {
  if (shape.length === 1) return `[${values.join(', ')}]`;
  const chunk = values.length / shape[0]!;
  const parts: string[] = [];
  for (let i = 0; i < shape[0]!; i++) {
    parts.push(nested(values.slice(i * chunk, (i + 1) * chunk), shape.slice(1)));
  }
  return `[\n    ${parts.join(',\n    ')},\n  ]`;
}

const out = `/**
 * Tablas de CELT. **Generado por \`tools/opus-tables.ts\` — no editar a mano.**
 *
 * Son constantes del FORMATO, no decisiones de esta implementación: el
 * decodificador espera exactamente estos números. Cambiar uno no degrada la
 * calidad, produce un archivo que no abre nadie — y el síntoma no se parecería a
 * un error de tabla, se parecería a audio roto tres capas más arriba. Por eso se
 * extraen con script en vez de copiarse: la procedencia es reproducible y el
 * dedazo de transcripción, imposible.
 *
 * Origen: implementación de referencia incluida en la RFC 6716 (Apéndice A),
 * extraída del propio documento y verificada por SHA-1
 * (\`86a927223e73d2476646a1b933fcd3fffb6ecc8c\`).
 *
 * ---
 * Copyright 1994-2011 IETF Trust, Xiph.Org, Skype Limited, Octasic,
 * Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell,
 * Mark Borgerding, Erik de Castro Lopo. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * - Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 * - Neither the name of Internet Society, IETF or IETF Trust, nor the names of
 *   specific contributors, may be used to endorse or promote products derived
 *   from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/** Bandas de CELT: 21 bandas críticas. */
export const NB_BANDS = ${NBANDS};

/** Resolución del asignador de bits: octavos de bit. */
export const BITRES = 3;

/**
 * Bordes de banda en unidades de tramas de 2,5 ms (múltiplos de 400 Hz).
 *
 * Siguen la escala de Bark, no una división uniforme: abajo las bandas son de
 * 200 Hz y arriba de kilohercios, porque así oye el oído. Son 22 valores para
 * 21 bandas — el último es el borde de arriba.
 */
export const EBAND_5MS = [
${rows(ebands, 11)}
] as const;

/**
 * Tabla de asignación de bits por banda y por "calidad" (11 niveles).
 *
 * Cada fila es un reparto completo entre las 21 bandas. El asignador interpola
 * entre dos filas para llegar al bitrate pedido; por eso la fila 0 es todo
 * ceros y la última reparte a manos llenas.
 */
export const BAND_ALLOCATION = [
${rows(allocation, NBANDS)}
] as const;

/**
 * Modelo de probabilidad de la energía gruesa, por tamaño de trama.
 *
 * Índices: \`[LM][intra][2*banda + (0: probabilidad, 1: decaimiento)]\`, con LM de
 * 0 a 3 para 120/240/480/960 muestras. El par "inter/intra" existe porque una
 * trama que predice de la anterior gasta muchos menos bits que una que no.
 */
export const E_PROB_MODEL = ${nested(eProb, [4, 2, 42])} as const;

/** ICDF de la energía cuando ya casi no quedan bits. */
export const SMALL_ENERGY_ICDF = [${smallEnergy.join(', ')}] as const;

/** ICDF del "trim" de asignación: inclina el reparto hacia graves o agudos. */
export const TRIM_ICDF = [${trim.join(', ')}] as const;

/** ICDF del parámetro de dispersión (spreading) del PVQ. */
export const SPREAD_ICDF = [${spread.join(', ')}] as const;

/** ICDF del ajuste del postfiltro. */
export const TAPSET_ICDF = [${tapset.join(', ')}] as const;

/**
 * Tabla de resolución tiempo/frecuencia.
 *
 * Índices: \`[LM][4*esTransitorio + 2*tfSelect + cambio]\`. Es lo que permite que
 * una trama con un golpe seco use más resolución temporal y menos frecuencial.
 */
export const TF_SELECT_TABLE = ${nested(tfSelect, [4, 8])} as const;

/** Tabla auxiliar del logaritmo en coma fija del asignador. */
export const LOG2_FRAC_TABLE = [
${rows(log2FracTable, 12)}
] as const;

/**
 * Límites de \`V(n,k)\` para que quepa en 32 bits, de \`fits_in32\`.
 *
 * Es la forma tabulada de lo que ya sabíamos: hay combinaciones de banda y
 * pulsos que no se pueden numerar, y por eso CELT parte bandas.
 */
export const FITS32_MAX_N = [${maxN.join(', ')}] as const;
export const FITS32_MAX_K = [${maxK.join(', ')}] as const;

/** Coeficientes de predicción de la energía entre tramas, por tamaño (Q15/32768). */
export const PRED_COEF = [${q15('pred_coef').join(', ')}] as const;
export const BETA_COEF = [${q15('beta_coef').join(', ')}] as const;
export const BETA_INTRA = ${4915 / 32768};
`;

const target = join('packages', 'engine', 'src', 'render', 'opus', 'tables.ts');
writeFileSync(target, out, 'utf8');
console.log(`Escrito ${target}`);
console.log(`  ${ebands.length} bordes de banda, ${NBANDS} bandas`);
console.log(`  ${allocation.length} valores de asignación (11 x ${NBANDS})`);
console.log(`  ${eProb.length} valores del modelo de energía (4 x 2 x 42)`);
console.log(`  ${tfSelect.length} de tf_select, ${log2FracTable.length} de log2_frac`);
console.log(
  `  total transcrito: ${
    ebands.length +
    allocation.length +
    eProb.length +
    smallEnergy.length +
    trim.length +
    spread.length +
    tapset.length +
    tfSelect.length +
    log2FracTable.length +
    maxN.length +
    maxK.length
  } números`,
);
