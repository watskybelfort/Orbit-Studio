/**
 * Iconos de Orbit Studio — set propio dibujado a mano (nada copiado de librerías).
 *
 * Lenguaje visual («estilo Mac», acorde a tokens.css / shell.css):
 *   - Retícula 24×24 con área viva 3.5…20.5 (los engranajes/aspas pueden
 *     asomar hasta 3.2/20.8 para compensar su peso óptico).
 *   - Línea fina: strokeWidth 1.6, extremos y uniones redondeados.
 *   - Monocromo: TODO sale de currentColor (el CSS decide --text-dim /
 *     --text / --accent). Sin fills salvo puntos pequeños (breakpoints,
 *     pines MIDI), que también usan currentColor.
 *   - Radios pequeños (1.2–2) en rects, coherentes con --radius de la UI.
 *   - Tamaño por defecto 16 px: encaja en .tbtn (26 px alto) y .menu-item.
 */

import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Lado del icono en px (el svg es cuadrado). Por defecto 16. */
  size?: number;
}

/** Base común: svg 24×24, trazo currentColor 1.6, todo redondeado. */
export function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ── Transporte ──────────────────────────────────────────────────────────── */

/** Triángulo de reproducción. */
export function IconPlay(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 5.2 L18.6 12 L8 18.8 Z" />
    </Icon>
  );
}

/** Cuadrado de stop (algo menor que Maximize para no confundirse). */
export function IconStop(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </Icon>
  );
}

/** Patrón: bloque de 4 steps (2×2) como en un secuenciador. */
export function IconPattern(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="5" width="6" height="6" rx="1.5" />
      <rect x="13" y="5" width="6" height="6" rx="1.5" />
      <rect x="5" y="13" width="6" height="6" rx="1.5" />
      <rect x="13" y="13" width="6" height="6" rx="1.5" />
    </Icon>
  );
}

/** Canción: líneas de arreglo escalonadas. */
export function IconSong(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 6.5 H14" />
      <path d="M8.5 12 H19.5" />
      <path d="M4.5 17.5 H12" />
    </Icon>
  );
}

/** Metrónomo: cuerpo trapezoidal con péndulo (misma idea que el de 12px). */
export function IconMetronome(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.4 4.5 H14.6 L18.3 19.5 H5.7 Z" />
      <path d="M12 15.5 L15 6.5" />
    </Icon>
  );
}

/* ── Ventanas / editores ─────────────────────────────────────────────────── */

/** Channel Rack: filas de canal (botón redondo + pista). */
export function IconChannelRack(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.7" cy="6.5" r="1.7" />
      <path d="M10.2 6.5 H20" />
      <circle cx="5.7" cy="12" r="1.7" />
      <path d="M10.2 12 H20" />
      <circle cx="5.7" cy="17.5" r="1.7" />
      <path d="M10.2 17.5 H20" />
    </Icon>
  );
}

/** Piano Roll: teclado con teclas negras insinuadas. */
export function IconPianoRoll(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M8 5.5 V12.5" />
      <path d="M12 5.5 V12.5" />
      <path d="M16 5.5 V12.5" />
    </Icon>
  );
}

/** Playlist: clips (bloques) colocados en pistas. */
export function IconPlaylist(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="9.5" height="4.6" rx="1.3" />
      <rect x="9.5" y="9.7" width="11" height="4.6" rx="1.3" />
      <rect x="3.5" y="14.9" width="7.5" height="4.6" rx="1.3" />
    </Icon>
  );
}

/** Mixer: tres faders verticales con el thumb a distinta altura. */
export function IconMixer(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4.5 V19.5" />
      <path d="M3.8 14 H8.2" />
      <path d="M12 4.5 V19.5" />
      <path d="M9.8 8 H14.2" />
      <path d="M18 4.5 V19.5" />
      <path d="M15.8 16 H20.2" />
    </Icon>
  );
}

/** Browser: carpeta con una mini forma de onda dentro. */
export function IconBrowser(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 17.3 V6.7 A1.7 1.7 0 0 1 5.2 5 H9.2 L11.6 8 H18.8 A1.7 1.7 0 0 1 20.5 9.7 V17.3 A1.7 1.7 0 0 1 18.8 19 H5.2 A1.7 1.7 0 0 1 3.5 17.3 Z" />
      <path d="M8.5 12 V15" />
      <path d="M12 10.5 V16.5" />
      <path d="M15.5 11.5 V15.5" />
    </Icon>
  );
}

/** Claude: chispa/asterisco de seis brazos. */
export function IconClaude(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 V19.5" />
      <path d="M5.5 8.25 L18.5 15.75" />
      <path d="M18.5 8.25 L5.5 15.75" />
    </Icon>
  );
}

/** Ajustes: engranaje fino (cuerpo + eje + 8 dientes radiales). */
export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M18 12 H20.8" />
      <path d="M16.24 16.24 L18.22 18.22" />
      <path d="M12 18 V20.8" />
      <path d="M7.76 16.24 L5.78 18.22" />
      <path d="M6 12 H3.2" />
      <path d="M7.76 7.76 L5.78 5.78" />
      <path d="M12 6 V3.2" />
      <path d="M16.24 7.76 L18.22 5.78" />
    </Icon>
  );
}

/** Exportar: flecha bajando a una bandeja. */
export function IconExport(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 V14" />
      <path d="M8.5 10.5 L12 14 L15.5 10.5" />
      <path d="M4.5 14.5 V17.8 A1.7 1.7 0 0 0 6.2 19.5 H17.8 A1.7 1.7 0 0 0 19.5 17.8 V14.5" />
    </Icon>
  );
}

/** Colaboración: dos personas (la segunda asoma detrás). */
export function IconCollab(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="7.8" r="2.9" />
      <path d="M3.5 19.5 V18.4 A4.4 4.4 0 0 1 7.9 14 H10.1 A4.4 4.4 0 0 1 14.5 18.4 V19.5" />
      <path d="M15.9 5 A2.9 2.9 0 0 1 15.9 10.8" />
      <path d="M20.5 19.5 V18.4 A4.4 4.4 0 0 0 17.2 14.14" />
    </Icon>
  );
}

/** Automatización: curva con breakpoints (puntos rellenos). */
export function IconAutomation(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 17.5 C9.5 17.5 8.5 6.5 13 6.5 H19.5" />
      <circle cx="4.5" cy="17.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="13" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="6.5" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/* ── Archivo ─────────────────────────────────────────────────────────────── */

/** Guardar: disquete minimal (esquina recortada, persiana y bolsillo). */
export function IconSave(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.3 4.5 H6.2 A1.7 1.7 0 0 0 4.5 6.2 V17.8 A1.7 1.7 0 0 0 6.2 19.5 H17.8 A1.7 1.7 0 0 0 19.5 17.8 V8.7 Z" />
      <path d="M8.7 4.5 V8.2 H14 V4.5" />
      <path d="M8 19.5 V14.2 H16 V19.5" />
    </Icon>
  );
}

/** Abrir: carpeta abierta (frente inclinado sobre el fondo). */
export function IconOpen(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 17.4 V6.7 A1.7 1.7 0 0 1 5.2 5 H8.9 L11.2 7.8 H17.3 A1.7 1.7 0 0 1 19 9.5 V11" />
      <path d="M3.5 17.4 L6.1 11 H20.5 L17.9 17.4 Z" />
    </Icon>
  );
}

/** Nuevo: hoja con esquina doblada y un +. */
export function IconNew(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 4.5 H7 A1.7 1.7 0 0 0 5.3 6.2 V17.8 A1.7 1.7 0 0 0 7 19.5 H17 A1.7 1.7 0 0 0 18.7 17.8 V10 Z" />
      <path d="M13.2 4.5 V10 H18.7" />
      <path d="M12 12.2 V17" />
      <path d="M9.6 14.6 H14.4" />
    </Icon>
  );
}

/* ── Controles de ventana ────────────────────────────────────────────────── */

/** Cerrar: aspa. */
export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.2 7.2 L16.8 16.8" />
      <path d="M16.8 7.2 L7.2 16.8" />
    </Icon>
  );
}

/** Minimizar: guion. */
export function IconMinimize(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 12 H17.5" />
    </Icon>
  );
}

/** Maximizar: cuadrado. */
export function IconMaximize(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />
    </Icon>
  );
}

/** Restaurar: dos cuadrados superpuestos. */
export function IconRestore(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="9" width="9.5" height="9.5" rx="1.6" />
      <path d="M9 5.5 H16.9 A1.6 1.6 0 0 1 18.5 7.1 V15" />
    </Icon>
  );
}

/* ── Varios ──────────────────────────────────────────────────────────────── */

/** Loop: dos flechas circulares (repetición). */
export function IconLoop(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.5 3.5 L20 7 L16.5 10.5" />
      <path d="M20 7 H8.5 A4.5 4.5 0 0 0 4 11.5 V12" />
      <path d="M7.5 13.5 L4 17 L7.5 20.5" />
      <path d="M4 17 H15.5 A4.5 4.5 0 0 0 20 12.5 V12" />
    </Icon>
  );
}

/** Perilla: cuerpo, aguja y las dos marcas de fin de recorrido (arco 270°). */
export function IconKnob(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 12 L16.2 7.8" />
      <path d="M7.05 16.95 L5.6 18.4" />
      <path d="M16.95 16.95 L18.4 18.4" />
    </Icon>
  );
}

/** Forma de onda: barras simétricas alrededor del eje. */
export function IconWave(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 9.5 V14.5" />
      <path d="M8 6.5 V17.5" />
      <path d="M11.5 4.5 V19.5" />
      <path d="M15 8 V16" />
      <path d="M18.5 10 V14" />
    </Icon>
  );
}

/** MIDI: conector DIN de 5 pines simplificado (aro, pines y muesca). */
export function IconMidi(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="7.7" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8.95" cy="8.95" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.05" cy="8.95" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16.3" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <path d="M10.7 18.6 H13.3" />
    </Icon>
  );
}
