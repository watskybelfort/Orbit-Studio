/**
 * La forma de un beat entero.
 *
 * Un loop de cuatro compases no es un beat: le falta lo que pasa ANTES y
 * DESPUÉS. Aquí vive esa parte —qué secciones hay, en qué orden y cuántos
 * compases dura cada una— separada de cómo suenan, que es cosa de las recetas.
 *
 * La regla que lo ordena todo: una sección no es un adorno, es una PROMESA de
 * lo que viene. Un drop sin nada que lo anuncie no cae, cae de golpe; una
 * vuelta que no baja no deja sitio para volver a subir. De ahí salen las tres
 * invariantes que se prueban: todo empieza presentando, todo drop tiene algo
 * que lo anuncia justo antes, y todo acaba dejando ir.
 */

/**
 * - `intro`   presenta el tema (melodía sola, o casi).
 * - `build`   sube: hats más rápidos, redoble de caja, sin bombo al final.
 * - `drop`    todo sonando: es a lo que iba el tema.
 * - `break`   baja para dejar respirar antes de volver a subir.
 * - `outro`   deja ir.
 */
export const SECTION_KINDS = ['intro', 'build', 'drop', 'break', 'outro'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export interface Section {
  kind: SectionKind;
  /** Compases que dura. */
  bars: number;
  /** Compás en el que empieza (0 = el primero del tema). */
  startBar: number;
}

/** Qué suena en cada sección, de 0 (nada) a 1 (todo). */
export interface SectionDensity {
  /** Bombo y caja. */
  drums: number;
  /** Hats: además de nivel, marca si van al doble. */
  hats: number;
  doubleHats: boolean;
  /** 808 / bajo. */
  bass: number;
  /** Melodía / acordes. */
  melody: number;
  /** Redoble de caja al cerrar la sección (el que anuncia el drop). */
  roll: boolean;
}

const DENSITY: Record<SectionKind, SectionDensity> = {
  // La intro presenta la melodía: sin bombo, con hats flojos para marcar.
  intro: { drums: 0, hats: 0.5, doubleHats: false, bass: 0, melody: 0.9, roll: false },
  // El build sube: hats al doble, 808 asomando y redoble al cerrar.
  build: { drums: 0.35, hats: 0.9, doubleHats: true, bass: 0.6, melody: 1, roll: true },
  drop: { drums: 1, hats: 1, doubleHats: false, bass: 1, melody: 1, roll: false },
  // La vuelta baja de verdad: sin 808 y con la batería a media asta.
  break: { drums: 0.5, hats: 0.6, doubleHats: false, bass: 0, melody: 0.8, roll: false },
  outro: { drums: 0.3, hats: 0.4, doubleHats: false, bass: 0.4, melody: 0.6, roll: false },
};

export function densityOf(kind: SectionKind): SectionDensity {
  return DENSITY[kind];
}

/**
 * Las formas que se reparten. Todas cumplen las tres invariantes de arriba, y
 * están escritas como las escribiría alguien montando el tema: la primera es la
 * de manual, la segunda mete una vuelta larga en medio y la tercera va al grano
 * (la de una demo corta).
 */
const SHAPES: { kind: SectionKind; bars: number }[][] = [
  [
    { kind: 'intro', bars: 4 },
    { kind: 'build', bars: 4 },
    { kind: 'drop', bars: 8 },
    { kind: 'break', bars: 4 },
    { kind: 'build', bars: 4 },
    { kind: 'drop', bars: 8 },
    { kind: 'outro', bars: 4 },
  ],
  [
    { kind: 'intro', bars: 8 },
    { kind: 'build', bars: 4 },
    { kind: 'drop', bars: 8 },
    { kind: 'break', bars: 8 },
    { kind: 'drop', bars: 8 },
    { kind: 'outro', bars: 4 },
  ],
  [
    { kind: 'intro', bars: 4 },
    { kind: 'build', bars: 4 },
    { kind: 'drop', bars: 8 },
    { kind: 'outro', bars: 4 },
  ],
];

/** Cuántas formas distintas hay (para que el pack no repita hasta agotarlas). */
export const SHAPE_COUNT = SHAPES.length;

/**
 * La forma número `index` (se envuelve). Devuelve las secciones ya colocadas en
 * el tiempo, con su compás de arranque.
 */
export function planSections(index = 0): Section[] {
  const shape = SHAPES[((index % SHAPES.length) + SHAPES.length) % SHAPES.length]!;
  let startBar = 0;
  return shape.map((s) => {
    const section = { kind: s.kind, bars: s.bars, startBar };
    startBar += s.bars;
    return section;
  });
}

/** Compases que dura el tema entero. */
export function totalBars(sections: readonly Section[]): number {
  return sections.reduce((sum, s) => sum + s.bars, 0);
}

/** La sección que suena en ese compás, o null si el tema ya acabó. */
export function sectionAt(sections: readonly Section[], bar: number): Section | null {
  for (const s of sections) {
    if (bar >= s.startBar && bar < s.startBar + s.bars) return s;
  }
  return null;
}

/**
 * ¿Es este el ÚLTIMO compás de su sección? Es donde van el redoble del build y
 * el plato de cierre: la frase se cierra en el compás, no en la sección.
 */
export function isLastBarOfSection(sections: readonly Section[], bar: number): boolean {
  const s = sectionAt(sections, bar);
  return s !== null && bar === s.startBar + s.bars - 1;
}
