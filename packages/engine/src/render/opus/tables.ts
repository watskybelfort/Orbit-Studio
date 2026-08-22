/**
 * Tablas de CELT. **Generado por `tools/opus-tables.ts` — no editar a mano.**
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
 * (`86a927223e73d2476646a1b933fcd3fffb6ecc8c`).
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
export const NB_BANDS = 21;

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
  0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12,
  14, 16, 20, 24, 28, 34, 40, 48, 60, 78, 100,
] as const;

/**
 * Tabla de asignación de bits por banda y por "calidad" (11 niveles).
 *
 * Cada fila es un reparto completo entre las 21 bandas. El asignador interpola
 * entre dos filas para llegar al bitrate pedido; por eso la fila 0 es todo
 * ceros y la última reparte a manos llenas.
 */
export const BAND_ALLOCATION = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  90, 80, 75, 69, 63, 56, 49, 40, 34, 29, 20, 18, 10, 0, 0, 0, 0, 0, 0, 0, 0,
  110, 100, 90, 84, 78, 71, 65, 58, 51, 45, 39, 32, 26, 20, 12, 0, 0, 0, 0, 0, 0,
  118, 110, 103, 93, 86, 80, 75, 70, 65, 59, 53, 47, 40, 31, 23, 15, 4, 0, 0, 0, 0,
  126, 119, 112, 104, 95, 89, 83, 78, 72, 66, 60, 54, 47, 39, 32, 25, 17, 12, 1, 0, 0,
  134, 127, 120, 114, 103, 97, 91, 85, 78, 72, 66, 60, 54, 47, 41, 35, 29, 23, 16, 10, 1,
  144, 137, 130, 124, 113, 107, 101, 95, 88, 82, 76, 70, 64, 57, 51, 45, 39, 33, 26, 15, 1,
  152, 145, 138, 132, 123, 117, 111, 105, 98, 92, 86, 80, 74, 67, 61, 55, 49, 43, 36, 20, 1,
  162, 155, 148, 142, 133, 127, 121, 115, 108, 102, 96, 90, 84, 77, 71, 65, 59, 53, 46, 30, 1,
  172, 165, 158, 152, 143, 137, 131, 125, 118, 112, 106, 100, 94, 87, 81, 75, 69, 63, 56, 45, 20,
  200, 200, 200, 200, 200, 200, 200, 200, 198, 193, 188, 183, 178, 173, 168, 163, 158, 153, 148, 129, 104,
] as const;

/**
 * Modelo de probabilidad de la energía gruesa, por tamaño de trama.
 *
 * Índices: `[LM][intra][2*banda + (0: probabilidad, 1: decaimiento)]`, con LM de
 * 0 a 3 para 120/240/480/960 muestras. El par "inter/intra" existe porque una
 * trama que predice de la anterior gasta muchos menos bits que una que no.
 */
export const E_PROB_MODEL = [
    [
    [72, 127, 65, 129, 66, 128, 65, 128, 64, 128, 62, 128, 64, 128, 64, 128, 92, 78, 92, 79, 92, 78, 90, 79, 116, 41, 115, 40, 114, 40, 132, 26, 132, 26, 145, 17, 161, 12, 176, 10, 177, 11],
    [24, 179, 48, 138, 54, 135, 54, 132, 53, 134, 56, 133, 55, 132, 55, 132, 61, 114, 70, 96, 74, 88, 75, 88, 87, 74, 89, 66, 91, 67, 100, 59, 108, 50, 120, 40, 122, 37, 97, 43, 78, 50],
  ],
    [
    [83, 78, 84, 81, 88, 75, 86, 74, 87, 71, 90, 73, 93, 74, 93, 74, 109, 40, 114, 36, 117, 34, 117, 34, 143, 17, 145, 18, 146, 19, 162, 12, 165, 10, 178, 7, 189, 6, 190, 8, 177, 9],
    [23, 178, 54, 115, 63, 102, 66, 98, 69, 99, 74, 89, 71, 91, 73, 91, 78, 89, 86, 80, 92, 66, 93, 64, 102, 59, 103, 60, 104, 60, 117, 52, 123, 44, 138, 35, 133, 31, 97, 38, 77, 45],
  ],
    [
    [61, 90, 93, 60, 105, 42, 107, 41, 110, 45, 116, 38, 113, 38, 112, 38, 124, 26, 132, 27, 136, 19, 140, 20, 155, 14, 159, 16, 158, 18, 170, 13, 177, 10, 187, 8, 192, 6, 175, 9, 159, 10],
    [21, 178, 59, 110, 71, 86, 75, 85, 84, 83, 91, 66, 88, 73, 87, 72, 92, 75, 98, 72, 105, 58, 107, 54, 115, 52, 114, 55, 112, 56, 129, 51, 132, 40, 150, 33, 140, 29, 98, 35, 77, 42],
  ],
    [
    [42, 121, 96, 66, 108, 43, 111, 40, 117, 44, 123, 32, 120, 36, 119, 33, 127, 33, 134, 34, 139, 21, 147, 23, 152, 20, 158, 25, 154, 26, 166, 21, 173, 16, 184, 13, 184, 10, 150, 13, 139, 15],
    [22, 178, 63, 114, 74, 82, 84, 83, 92, 82, 103, 62, 96, 72, 96, 67, 101, 73, 107, 72, 113, 55, 118, 52, 125, 52, 118, 52, 117, 55, 135, 49, 137, 39, 157, 32, 145, 29, 97, 33, 77, 40],
  ],
  ] as const;

/** ICDF de la energía cuando ya casi no quedan bits. */
export const SMALL_ENERGY_ICDF = [2, 1, 0] as const;

/** ICDF del "trim" de asignación: inclina el reparto hacia graves o agudos. */
export const TRIM_ICDF = [126, 124, 119, 109, 87, 41, 19, 9, 4, 2, 0] as const;

/** ICDF del parámetro de dispersión (spreading) del PVQ. */
export const SPREAD_ICDF = [25, 23, 2, 0] as const;

/** ICDF del ajuste del postfiltro. */
export const TAPSET_ICDF = [2, 1, 0] as const;

/**
 * Tabla de resolución tiempo/frecuencia.
 *
 * Índices: `[LM][4*esTransitorio + 2*tfSelect + cambio]`. Es lo que permite que
 * una trama con un golpe seco use más resolución temporal y menos frecuencial.
 */
export const TF_SELECT_TABLE = [
    [0, -1, 0, -1, 0, -1, 0, -1],
    [0, -1, 0, -2, 1, 0, 1, -1],
    [0, -2, 0, -3, 2, 0, 1, -1],
    [0, -2, 0, -3, 3, 0, 1, -1],
  ] as const;

/** Tabla auxiliar del logaritmo en coma fija del asignador. */
export const LOG2_FRAC_TABLE = [
  0, 8, 13, 16, 19, 21, 23, 24, 26, 27, 28, 29,
  30, 31, 32, 32, 33, 34, 34, 35, 36, 36, 37, 37,
] as const;

/**
 * Límites de `V(n,k)` para que quepa en 32 bits, de `fits_in32`.
 *
 * Es la forma tabulada de lo que ya sabíamos: hay combinaciones de banda y
 * pulsos que no se pueden numerar, y por eso CELT parte bandas.
 */
export const FITS32_MAX_N = [32767, 32767, 32767, 1476, 283, 109, 60, 40, 29, 24, 20, 18, 16, 14, 13] as const;
export const FITS32_MAX_K = [32767, 32767, 32767, 32767, 1172, 238, 95, 53, 36, 27, 22, 18, 16, 15, 13] as const;

/**
 * Energía media esperada de cada banda, en la escala logarítmica del códec.
 *
 * Se resta antes de cuantizar y se vuelve a sumar al reconstruir. Sirve para que
 * el residuo que viaja esté centrado en cero en música normal: sin esto, las
 * bandas graves mandarían siempre valores grandes y las agudas siempre pequeños,
 * y el modelo de Laplace no acertaría en ninguna.
 *
 * En la referencia está dos veces —enteros y coma flotante— y son la misma
 * tabla: la de flotante es la de enteros dividida por 16.
 */
export const E_MEANS = [
  6.4375, 6.25, 5.75, 5.3125, 5.0625,
  4.8125, 4.5, 4.375, 4.875, 4.6875,
  4.5625, 4.4375, 4.875, 4.625, 4.3125,
  4.5, 4.375, 4.625, 4.75, 4.4375,
  3.75, 3.75, 3.75, 3.75, 3.75,
] as const;

/** Coeficientes de predicción de la energía entre tramas, por tamaño (Q15/32768). */
export const PRED_COEF = [0.8984375, 0.796875, 0.6484375, 0.5] as const;
export const BETA_COEF = [0.920013427734375, 0.67999267578125, 0.3699951171875, 0.20001220703125] as const;
export const BETA_INTRA = 0.149993896484375;
