/**
 * Catálogo de atajos, en un solo sitio.
 *
 * Hasta ahora los atajos solo existían escritos en `docs/FEATURES.md §15`: para
 * saber que Alt+G abre la riff machine había que salir de la app y leer un
 * markdown. Este archivo es la fuente que pinta `Ayuda → Atajos de teclado`, y
 * la regla al añadir un atajo nuevo es apuntarlo aquí.
 *
 * Es una LISTA, no el cableado: quien ejecuta las teclas sigue siendo
 * `useShortcuts` y el keydown de cada editor. Duplicar el conocimiento tiene ese
 * riesgo —que se desincronicen— y por eso las entradas dicen también dónde
 * viven, para poder comprobarlas.
 */

export interface ShortcutRow {
  /** Combinación, tal y como se escribiría en un menú. */
  keys: string;
  /** Qué hace, en una línea. */
  what: string;
  /** Dónde funciona ('' = en toda la app). */
  where?: string;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Proyecto',
    rows: [
      { keys: 'Ctrl+N', what: 'Proyecto nuevo (pregunta si hay cambios sin guardar)' },
      { keys: 'Ctrl+O', what: 'Abrir un proyecto' },
      { keys: 'Ctrl+S', what: 'Guardar' },
      { keys: 'Ctrl+Shift+S', what: 'Guardar como…' },
      { keys: 'Ctrl+E', what: 'Repetir el último export, sin diálogo' },
      { keys: 'Ctrl+K', what: 'Paleta de comandos (funciona incluso escribiendo)' },
      { keys: 'F1', what: 'Esta lista de atajos' },
      { keys: 'Alt', what: 'Abrir la barra de menús (luego, flechas)' },
    ],
  },
  {
    title: 'Transporte',
    rows: [
      { keys: 'Espacio', what: 'Reproducir / parar' },
      { keys: 'L', what: 'Cambiar entre patrón (PAT) y canción (SONG)' },
    ],
  },
  {
    title: 'Deshacer y portapapeles',
    rows: [
      { keys: 'Ctrl+Z', what: 'Deshacer lo tuyo (el undo va por origen)' },
      { keys: 'Ctrl+Y · Ctrl+Shift+Z', what: 'Rehacer' },
      { keys: 'Ctrl+C', what: 'Copiar la selección', where: 'Piano Roll / Playlist' },
      { keys: 'Ctrl+X', what: 'Cortar la selección', where: 'Piano Roll / Playlist' },
      {
        keys: 'Ctrl+V',
        what: 'Pegar en el caret (en la Playlist, en la pista bajo el ratón)',
        where: 'Piano Roll / Playlist',
      },
      { keys: 'Ctrl+B', what: 'Duplicar la selección a continuación', where: 'Piano Roll / Playlist' },
      { keys: 'Ctrl+A', what: 'Seleccionar todo', where: 'Piano Roll / Playlist' },
      { keys: 'Supr', what: 'Borrar la selección', where: 'Piano Roll / Playlist' },
    ],
  },
  {
    title: 'Ventanas',
    rows: [
      { keys: 'F5', what: 'Playlist' },
      { keys: 'F6', what: 'Channel Rack' },
      { keys: 'F7', what: 'Piano Roll' },
      { keys: 'F8', what: 'Vista Live' },
      { keys: 'F9', what: 'Mixer' },
      { keys: 'F10', what: 'Ajustes' },
    ],
  },
  {
    title: 'Piano Roll',
    rows: [
      { keys: 'P · B · C', what: 'Herramienta: dibujar, pincel, cortar' },
      { keys: 'Q', what: 'Cuantizar a la rejilla del snap' },
      { keys: 'Alt+C', what: 'Acorde sobre la selección' },
      { keys: 'Alt+A', what: 'Arpegiador (Esc lo cancela)' },
      { keys: 'Alt+G', what: 'Riff machine' },
      { keys: 'Ctrl+rueda', what: 'Zoom horizontal' },
    ],
  },
  {
    title: 'Playlist',
    rows: [
      { keys: 'Ctrl+clic', what: 'Meter o sacar un clip de la selección' },
      { keys: 'Ctrl+arrastre', what: 'En vacío, rectángulo de selección; sobre un clip, duplicarlo' },
      { keys: 'Alt+arrastre', what: 'Mover sin snap' },
      { keys: 'M', what: 'Mutear o activar la selección' },
      { keys: 'Esc', what: 'Quitar la selección' },
    ],
  },
  {
    title: 'Patrones',
    rows: [
      { keys: 'Ctrl+Shift+Supr', what: 'Borrar el patrón activo, con sus clips' },
    ],
  },
];
