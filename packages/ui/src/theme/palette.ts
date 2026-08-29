/**
 * Los colores literales de la interfaz, todos aquí.
 *
 * La regla 4 de CLAUDE.md dice que ningún componente lleva un color escrito a
 * mano: el color sale de una variable CSS de `theme/tokens.css`. Pero quedan
 * tres sitios donde hace falta un valor de verdad en JavaScript y no una
 * variable, y los tres viven en este archivo en vez de repartidos por el árbol:
 *
 *  1. **Los mismos valores por defecto que tokens.css**, para cuando el
 *     componente tiene que enseñar el color antes de que exista un override
 *     (`<input type="color">` no acepta `var(--accent)`, necesita `#rrggbb`).
 *     Estaban copiados en cuatro sitios; si tokens.css cambiaba, se quedaban
 *     atrás y el picker mostraba un azul distinto al de la ventana.
 *  2. **La paleta del selector de acento**, que no es un token: son las ocho
 *     propuestas que se le ofrecen al usuario.
 *  3. **Los colores por papel de las secciones del playlist** (intro, drop…),
 *     que son datos del proyecto, no del tema.
 *
 * Si mueves un valor de aquí, mueve también el token de `tokens.css`: son el
 * mismo color visto desde los dos lados.
 */

/** Igual que `--accent` en tokens.css. */
export const ACCENT_DEFAULT = '#5aa9e6';

/** Igual que `--glass-tint` en tokens.css. */
export const GLASS_TINT_DEFAULT = '#101114';

/** Las ocho propuestas del selector de acento (Ajustes → Acento). */
export const ACCENT_PRESETS: readonly string[] = [
  ACCENT_DEFAULT,
  '#e6675a',
  '#7ce65a',
  '#e6c95a',
  '#b45ae6',
  '#5ae6c9',
  '#e65aa9',
  '#e6935a',
];

/** Color de cada papel en la franja de secciones del playlist. */
export const SECTION_COLORS: Record<string, string> = {
  intro: ACCENT_DEFAULT,
  build: '#e6c95a',
  drop: '#e6675a',
  break: '#7ce65a',
  outro: '#b45ae6',
};

/** Una sección dibujada a mano nace con el neutro. */
export const SECTION_COLOR_DEFAULT = ACCENT_DEFAULT;

/** Color de un canal que todavía no eligió el suyo. */
export const CHANNEL_COLOR_DEFAULT = ACCENT_DEFAULT;

/**
 * Lo que pinta un lienzo cuando la variable CSS que iba a leer viene vacía.
 * `INK` es el negro con el que arranca la paleta antes de la primera lectura;
 * `INK_MUTED` es el gris con el que sigue dibujando si el tema no define esa
 * ranura — verse gris es mejor que no verse.
 */
export const CANVAS_FALLBACK_INK = '#000';
export const CANVAS_FALLBACK_MUTED = '#888';
