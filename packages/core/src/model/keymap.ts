/**
 * Keymaps: un canal de sampler con VARIAS muestras repartidas por el teclado
 * y por la fuerza con la que pegas.
 *
 * Hasta ahora un sampler tenía UN sample y lo estiraba con keytrack: un piano
 * grabado en do sonaba a chipmunk dos octavas arriba y a monstruo dos abajo,
 * porque estirar la velocidad de lectura mueve también las formantes y el
 * tiempo del ataque. Un keymap parte el teclado en zonas y le da a cada una su
 * grabación, que es como suenan de verdad los instrumentos muestreados.
 *
 * Una zona es un rectángulo en el plano (tecla × velocidad). Las zonas PUEDEN
 * solaparse y eso no es un error: es como se hacen las capas —un sample suave
 * y otro fuerte sonando a la vez en la franja de en medio— y como se apilan
 * dos micros de la misma toma. Todas las que caigan bajo la nota suenan.
 *
 * Todo lo de aquí es puro: mismas zonas y misma nota, misma elección.
 */

import { newId } from '../ids';
import type { Id } from './types';

/** Tope de zonas por canal. Más que esto no es un instrumento, es una librería. */
export const MAX_KEYMAP_ZONES = 128;

/** Una muestra colocada en su trozo del teclado. */
export interface KeymapZone {
  id: Id;
  sampleId: Id;
  /** Tecla más grave que la dispara (MIDI 0..127, inclusive). */
  keyLow: number;
  /** Tecla más aguda que la dispara (inclusive). */
  keyHigh: number;
  /**
   * Nota a la que este sample suena SIN transponer. No tiene por qué estar
   * dentro del rango: se graba un do y se estira hacia arriba y hacia abajo.
   */
  keyRoot: number;
  /** Velocidad mínima que la dispara (0..1, inclusive). */
  velLow: number;
  /** Velocidad máxima (0..1, inclusive). */
  velHigh: number;
  /** Afinación fina de la zona, en semitonos (para cuadrar tomas dispares). */
  tune: number;
  /** Ganancia lineal de la zona (para igualar tomas de volumen distinto). */
  gain: number;
}

const clampKey = (v: number): number => Math.min(127, Math.max(0, Math.round(v)));
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Zona nueva que cubre el teclado entero, lista para acotar. */
export function createKeymapZone(sampleId: Id, patch: Partial<KeymapZone> = {}): KeymapZone {
  return normalizeKeymapZone({
    id: newId(),
    sampleId,
    keyLow: 0,
    keyHigh: 127,
    keyRoot: 60,
    velLow: 0,
    velHigh: 1,
    tune: 0,
    gain: 1,
    ...patch,
  });
}

/**
 * Deja una zona utilizable: rangos dentro de sus límites y del derecho.
 *
 * Un rango invertido (`keyLow` por encima de `keyHigh`) no se rechaza, se da
 * la vuelta: sale de arrastrar el borde izquierdo más allá del derecho, que es
 * un gesto normal, y dejarlo invertido haría una zona que no suena nunca.
 */
export function normalizeKeymapZone(zone: KeymapZone): KeymapZone {
  const a = clampKey(zone.keyLow);
  const b = clampKey(zone.keyHigh);
  const lo = clamp01(zone.velLow);
  const hi = clamp01(zone.velHigh);
  return {
    id: zone.id,
    sampleId: zone.sampleId,
    keyLow: Math.min(a, b),
    keyHigh: Math.max(a, b),
    keyRoot: clampKey(zone.keyRoot),
    velLow: Math.min(lo, hi),
    velHigh: Math.max(lo, hi),
    // Media octava de margen: más que eso no es afinar, es elegir otra nota
    // (y para eso está `keyRoot`).
    tune: Math.min(6, Math.max(-6, zone.tune)),
    gain: Math.min(4, Math.max(0, zone.gain)),
  };
}

/**
 * Deja un keymap utilizable, o `undefined` si no queda nada: zonas
 * normalizadas, sin las que no apuntan a ningún sample, ordenadas por dónde
 * empiezan y recortadas al tope.
 */
export function normalizeKeymap(
  zones: readonly KeymapZone[] | undefined | null,
): KeymapZone[] | undefined {
  if (!zones || zones.length === 0) return undefined;
  const out = zones
    .filter((z) => typeof z?.sampleId === 'string' && z.sampleId.length > 0)
    .map(normalizeKeymapZone)
    .slice(0, MAX_KEYMAP_ZONES);
  return out.length > 0 ? sortKeymap(out) : undefined;
}

/** Orden de lectura: por tecla y, dentro de la misma, por velocidad. */
export function sortKeymap(zones: readonly KeymapZone[]): KeymapZone[] {
  return [...zones].sort(
    (a, b) => a.keyLow - b.keyLow || a.velLow - b.velLow || a.keyHigh - b.keyHigh,
  );
}

/**
 * Zonas que dispara una nota. Puede devolver varias —eso son las capas— y
 * puede no devolver ninguna: un hueco del mapa es silencio, no un error.
 */
export function zonesForNote(
  zones: readonly KeymapZone[],
  key: number,
  velocity: number,
): KeymapZone[] {
  const out: KeymapZone[] = [];
  for (const z of zones) {
    if (key < z.keyLow || key > z.keyHigh) continue;
    if (velocity < z.velLow || velocity > z.velHigh) continue;
    out.push(z);
  }
  return out;
}

/**
 * Semitonos que hay que transponer el sample de una zona para tocar `key`.
 * Es la única cuenta del keymap que llega hasta el motor.
 */
export function zoneTranspose(zone: KeymapZone, key: number): number {
  return key - zone.keyRoot + zone.tune;
}

/**
 * Reparte los rangos de tecla de un juego de zonas para que cubran el teclado
 * entero sin huecos: cada una manda desde el punto medio con su vecina de
 * abajo hasta el punto medio con la de arriba, y las de los extremos se
 * estiran hasta el final.
 *
 * Es lo que uno espera al soltar veinte muestras de un piano: que se repartan
 * solas y no haya que arrastrar cuarenta bordes.
 */
export function spreadKeymapRanges(zones: readonly KeymapZone[]): KeymapZone[] {
  // Los rangos se reparten entre RAÍCES DISTINTAS, no entre zonas: varias
  // zonas en la misma nota son capas de velocidad y comparten trozo de
  // teclado. Repartiendo por zona, dos capas de la misma nota se pisaban el
  // punto medio la una a la otra y salían con el rango del revés.
  const roots = [...new Set(zones.map((z) => z.keyRoot))].sort((a, b) => a - b);
  const range = new Map<number, { low: number; high: number }>();
  roots.forEach((root, i) => {
    const prev = roots[i - 1];
    const next = roots[i + 1];
    // El punto medio se parte hacia ARRIBA con el vecino de abajo y hacia
    // abajo con el de arriba, así que dos raíces contiguas no se pelean por la
    // misma tecla ni la dejan sin cubrir.
    range.set(root, {
      low: prev === undefined ? 0 : Math.floor((prev + root) / 2) + 1,
      high: next === undefined ? 127 : Math.floor((root + next) / 2),
    });
  });
  return sortKeymap(
    zones.map((zone) => {
      const r = range.get(zone.keyRoot)!;
      return normalizeKeymapZone({ ...zone, keyLow: r.low, keyHigh: r.high });
    }),
  );
}

/**
 * Reparte los rangos de VELOCIDAD entre las zonas que comparten raíz: con tres
 * tomas de la misma nota (suave, media, fuerte) salen tres capas contiguas.
 * Las que estén solas se quedan con la velocidad entera.
 */
export function spreadKeymapVelocities(zones: readonly KeymapZone[]): KeymapZone[] {
  const byRoot = new Map<number, KeymapZone[]>();
  for (const z of zones) {
    const list = byRoot.get(z.keyRoot);
    if (list) list.push(z);
    else byRoot.set(z.keyRoot, [z]);
  }
  const out: KeymapZone[] = [];
  for (const list of byRoot.values()) {
    if (list.length === 1) {
      out.push(normalizeKeymapZone({ ...list[0]!, velLow: 0, velHigh: 1 }));
      continue;
    }
    const n = list.length;
    list.forEach((zone, i) => {
      out.push(
        normalizeKeymapZone({
          ...zone,
          // El borde inferior de una capa es el superior de la anterior más un
          // pelo: sin ese hueco, una velocidad justo en la frontera dispararía
          // las dos y sonaría el doble de fuerte.
          velLow: i === 0 ? 0 : i / n + 1e-6,
          velHigh: (i + 1) / n,
        }),
      );
    });
  }
  return sortKeymap(out);
}
