/**
 * Lógica pura de la selección de clips de la Playlist.
 *
 * Aquí no hay React ni canvas: solo la aritmética que decide qué cae dentro de
 * un rectángulo y cuánto puede desplazarse un grupo sin salirse. Es la parte
 * que se puede equivocar en silencio (un clip que se cuela, un grupo que se
 * apelmaza contra el borde), así que vive aparte y con tests.
 */

/** Lo justo de un clip para seleccionarlo: dónde empieza, cuánto dura y dónde vive. */
export interface SelectableClip {
  id: string;
  start: number;
  length: number;
  trackIndex: number;
}

/** Rectángulo del marquee, en beats (horizontal) e índices de fila (vertical). */
export interface MarqueeRect {
  fromBeat: number;
  toBeat: number;
  fromTrack: number;
  toTrack: number;
}

/**
 * Clips que toca el rectángulo. Toca = se solapan de verdad los dos tramos;
 * un clip que solo roza el borde (acaba exactamente donde empieza el
 * rectángulo) NO entra, que es lo que uno espera al arrastrar hasta pegarlo.
 */
export function clipsInMarquee(
  clips: readonly SelectableClip[],
  rect: MarqueeRect,
): string[] {
  const b0 = Math.min(rect.fromBeat, rect.toBeat);
  const b1 = Math.max(rect.fromBeat, rect.toBeat);
  const t0 = Math.min(rect.fromTrack, rect.toTrack);
  const t1 = Math.max(rect.fromTrack, rect.toTrack);
  return clips
    .filter(
      (c) =>
        c.trackIndex >= t0 &&
        c.trackIndex <= t1 &&
        c.start < b1 &&
        c.start + c.length > b0,
    )
    .map((c) => c.id);
}

/** Dónde estaba un clip al empezar el arrastre. */
export interface MoveAnchor {
  start: number;
  trackIndex: number;
}

export interface GroupDelta {
  /** Desplazamiento en beats que se aplica a TODOS. */
  beats: number;
  /** Desplazamiento en filas que se aplica a TODOS. */
  tracks: number;
}

/**
 * Acota el desplazamiento de un grupo al que primero topa.
 *
 * La alternativa —acotar clip a clip— parece igual y no lo es: los del borde
 * se quedan clavados mientras el resto sigue, y el grupo se apelmaza encima de
 * ellos. Basta con que UNO no pueda para que no se mueva ninguno más allá.
 */
export function clampGroupMove(
  anchors: Iterable<MoveAnchor>,
  want: GroupDelta,
  trackCount: number,
): GroupDelta {
  let minStart = Infinity;
  let minTrack = Infinity;
  let maxTrack = -Infinity;
  let any = false;
  for (const a of anchors) {
    any = true;
    if (a.start < minStart) minStart = a.start;
    if (a.trackIndex < minTrack) minTrack = a.trackIndex;
    if (a.trackIndex > maxTrack) maxTrack = a.trackIndex;
  }
  if (!any) return { beats: 0, tracks: 0 };
  // El techo puede quedar por debajo del suelo si el grupo ya ocupa más filas
  // de las que hay (una pista borrada bajo el gesto): entonces no se mueve.
  const up = -minTrack;
  const down = trackCount - 1 - maxTrack;
  // El `|| 0` no sobra: `-minStart` con minStart a 0 da -0, y -0 no es 0 para
  // Object.is. Que "no moverse" tenga dos representaciones distintas es la
  // clase de detalle que luego aparece como un test que falla sin motivo.
  return {
    beats: Math.max(want.beats, -minStart) || 0,
    tracks: down < up ? 0 : Math.min(Math.max(want.tracks, up), down),
  };
}
