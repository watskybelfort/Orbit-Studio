/**
 * Cable de enrutado: arrastrar desde una pista de la Playlist hasta un canal
 * del Mixer para que el AUDIO de esa pista (tomas de voz, audio importado,
 * pistas congeladas) suene por ese canal.
 *
 * El enlace ya existía en el modelo (`PlaylistTrack.mixerTrack`, que el motor
 * usa en `compile.ts` para cada clip de audio), pero solo se llegaba a él por un
 * desplegable dentro del menú del clic derecho: grabar una voz y no encontrarla
 * en el Mixer era lo normal. El cable lo hace visible y directo.
 *
 * Aquí está el estado del gesto (zustand, fuera de React) y las piezas puras
 * —la curva del cable, qué canal hay bajo el cursor, el texto de destino—. La
 * superficie que lo dibuja es `shell/RouteCableOverlay.tsx`; los canales del
 * Mixer se marcan con `data-mixer-insert`.
 */
import type { Id, Project } from '@orbit/core';
import { create } from 'zustand';

export interface CableDrag {
  trackId: Id;
  trackName: string;
  /** Color de la pista: el cable lleva el color de lo que conecta. */
  color: string;
  /** Punto de salida (centro del conector), en px de la ventana. */
  x0: number;
  y0: number;
  /** Punta del cable (cursor). */
  x: number;
  y: number;
  /** Canal del Mixer bajo la punta, si hay uno. */
  hover: number | null;
}

export const useRouteCable = create<{ drag: CableDrag | null }>(() => ({ drag: null }));

/** Atributo que marca un canal del Mixer como destino del cable. */
export const MIXER_INSERT_ATTR = 'data-mixer-insert';

/** El canal del Mixer que contiene `el`, o `null`. */
export function mixerInsertOf(el: Element | null): number | null {
  const host = el?.closest(`[${MIXER_INSERT_ATTR}]`);
  if (!host) return null;
  const raw = host.getAttribute(MIXER_INSERT_ATTR);
  if (raw === null || raw.trim() === '') return null;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Curva del cable: una bezier que cuelga un poco, como un cable de verdad, y
 * más cuanto más largo. Siempre sale en horizontal del conector.
 */
export function cablePath(x0: number, y0: number, x1: number, y1: number): string {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const reach = Math.max(30, Math.abs(x1 - x0) * 0.45);
  const sag = Math.min(90, dist * 0.18);
  const dir = x1 >= x0 ? 1 : -1;
  const f = (n: number) => Number(n.toFixed(1));
  return `M ${f(x0)} ${f(y0)} C ${f(x0 + dir * reach)} ${f(y0 + sag)} ${f(x1 - dir * reach)} ${f(y1 + sag)} ${f(x1)} ${f(y1)}`;
}

/** Cómo se nombra un canal del Mixer en la UI. */
export function mixerTargetLabel(index: number, name: string | undefined): string {
  if (index === 0) return 'Master';
  // «3 · Insert 3» repite lo mismo: el nombre de fábrica ya lleva el número.
  if (!name || name.trim() === '' || /^insert\s*\d+$/i.test(name.trim())) return `Insert ${index}`;
  return `${index} · ${name}`;
}

export function beginCableDrag(start: Omit<CableDrag, 'x' | 'y' | 'hover'>): void {
  useRouteCable.setState({ drag: { ...start, x: start.x0, y: start.y0, hover: null } });
}

/**
 * Mueve la punta. `pick` dice qué canal hay en un punto (en la app,
 * `document.elementFromPoint`; la superficie del cable no recibe eventos, así
 * que lo que se encuentra es lo que hay DEBAJO).
 */
export function moveCable(x: number, y: number, pick: (x: number, y: number) => number | null): void {
  const drag = useRouteCable.getState().drag;
  if (!drag) return;
  const hover = pick(x, y);
  useRouteCable.setState({ drag: { ...drag, x, y, hover } });
}

/** Suelta el cable y devuelve el canal sobre el que cayó (o `null`). */
export function endCableDrag(): number | null {
  const drag = useRouteCable.getState().drag;
  useRouteCable.setState({ drag: null });
  return drag?.hover ?? null;
}

export function cancelCableDrag(): void {
  useRouteCable.setState({ drag: null });
}

/**
 * Qué pistas de la Playlist (del arreglo activo) mandan su audio a cada canal
 * del Mixer. Solo los enlaces EXPLÍCITOS (canal > 0): al Master van todas las
 * que no se tocaron y listarlas ahí sería ruido.
 */
export function playlistSourcesByInsert(project: Project): Map<number, { name: string; color: string }[]> {
  const out = new Map<number, { name: string; color: string }[]>();
  const tracks = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === project.activeArrangementId)
    .sort((a, b) => a.order - b.order);
  for (const t of tracks) {
    const index = t.mixerTrack ?? 0;
    if (index <= 0 || index >= project.mixer.length) continue;
    const list = out.get(index) ?? [];
    list.push({ name: t.name, color: t.color });
    out.set(index, list);
  }
  return out;
}

