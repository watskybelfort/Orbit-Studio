/**
 * Operaciones sobre las secciones del arreglo.
 *
 * Una sección con nombre y nada más es una etiqueta. Lo que la convierte en
 * herramienta es que las operaciones se la lleven ENTERA: duplicar un drop
 * copia sus clips y empuja lo que venía detrás, borrar una vuelta cierra el
 * hueco, y moverla arrastra su contenido. Eso es exactamente lo que uno hace a
 * mano cuando alarga un tema, y a mano es donde se cuelan los descuadres.
 *
 * Todo lo de aquí devuelve COMANDOS, no muta nada: quien llama los mete en un
 * `batch` y el bus se encarga del undo. Y todo es puro, para poder probar que
 * los beats cuadran sin levantar la app.
 */

import type { Command } from './commands';
import { newId } from './ids';
import type { ArrangementSection, Clip, Id, Marker, Project } from './model/types';

/** Tolerancia para comparar beats (los arrastres dejan colas de coma flotante). */
const EPS = 1e-6;

/** Secciones de ese arrangement, ordenadas por inicio. */
export function sectionsOf(project: Project, arrangementId: Id): ArrangementSection[] {
  return Object.values(project.sections)
    .filter((s) => s.arrangementId === arrangementId)
    .sort((a, b) => a.start - b.start);
}

/** Pistas de playlist de ese arrangement (para saber qué clips le pertenecen). */
function trackIdsOf(project: Project, arrangementId: Id): Set<Id> {
  const ids = new Set<Id>();
  for (const track of Object.values(project.playlistTracks)) {
    if (track.arrangementId === arrangementId) ids.add(track.id);
  }
  return ids;
}

/**
 * Clips de ese arrangement que EMPIEZAN dentro de `[from, to)`.
 *
 * Por el inicio y no por el solape: un clip que arranca antes de la sección y
 * se mete dentro pertenece a lo de antes, y llevárselo al duplicar dejaría un
 * agujero en la sección anterior. La regla es la misma que usa cualquiera al
 * seleccionar "lo que hay en el drop": lo que empieza ahí.
 */
export function clipsInSpan(
  project: Project,
  arrangementId: Id,
  from: number,
  to: number,
): Clip[] {
  const tracks = trackIdsOf(project, arrangementId);
  return Object.values(project.clips)
    .filter((c) => tracks.has(c.playlistTrackId) && c.start >= from - EPS && c.start < to - EPS)
    .sort((a, b) => a.start - b.start);
}

/** Clips de ese arrangement que empiezan en `at` o después. */
function clipsFrom(project: Project, arrangementId: Id, at: number): Clip[] {
  const tracks = trackIdsOf(project, arrangementId);
  return Object.values(project.clips).filter(
    (c) => tracks.has(c.playlistTrackId) && c.start >= at - EPS,
  );
}

/** Marcadores en `at` o después. Los marcadores son globales, no por arrangement. */
function markersFrom(project: Project, at: number): Marker[] {
  return Object.values(project.markers).filter((m) => m.time >= at - EPS);
}

/**
 * Empuja todo lo que hay de `at` en adelante `delta` beats (negativo = tira
 * hacia atrás): clips, secciones y marcadores.
 *
 * Los marcadores van dentro a propósito. Son los cambios de tempo y de compás:
 * si al duplicar un drop se quedan donde estaban, el tema entero se descuadra a
 * partir de ahí y cuesta media hora encontrar por qué.
 */
function shiftCommands(
  project: Project,
  arrangementId: Id,
  at: number,
  delta: number,
  exceptSectionIds: ReadonlySet<Id> = new Set(),
): Command[] {
  if (Math.abs(delta) < EPS) return [];
  const out: Command[] = [];

  const clipPatches = clipsFrom(project, arrangementId, at).map((c) => ({
    id: c.id,
    start: Math.max(0, c.start + delta),
  }));
  if (clipPatches.length > 0) out.push({ type: 'patchClips', patches: clipPatches });

  const sectionPatches = sectionsOf(project, arrangementId)
    .filter((s) => s.start >= at - EPS && !exceptSectionIds.has(s.id))
    .map((s) => ({ id: s.id, start: Math.max(0, s.start + delta) }));
  if (sectionPatches.length > 0) out.push({ type: 'patchSections', patches: sectionPatches });

  for (const marker of markersFrom(project, at)) {
    out.push({
      type: 'patchMarker',
      markerId: marker.id,
      patch: { time: Math.max(0, marker.time + delta) },
    });
  }
  return out;
}

/**
 * Duplica la sección justo detrás de sí misma, con sus clips, empujando a la
 * derecha todo lo que venía después.
 *
 * Es "alargar el tema por aquí": el segundo drop aparece pegado al primero y
 * nada de lo de detrás se pisa.
 */
export function duplicateSectionCommands(project: Project, sectionId: Id): Command[] {
  const section = project.sections[sectionId];
  if (!section) return [];
  const end = section.start + section.length;

  // El hueco se abre ANTES de copiar, y la copia se calcula contra las
  // posiciones de ahora: por eso se leen los clips primero.
  const sourceClips = clipsInSpan(project, section.arrangementId, section.start, end);
  const copy: ArrangementSection = {
    ...section,
    id: newId(),
    start: end,
  };
  const copies: Clip[] = sourceClips.map((c) => ({
    ...c,
    id: newId(),
    start: c.start + section.length,
    ...(c.points ? { points: c.points.map((p) => ({ ...p })) } : null),
    // frozenFrom no viaja: apunta a los clips que una pista congelada dejó
    // escondidos y la copia no es su dueña (misma regla que el portapapeles).
  }));
  for (const c of copies) delete c.frozenFrom;

  return [
    ...shiftCommands(project, section.arrangementId, end, section.length),
    { type: 'addSections', sections: [copy] },
    ...(copies.length > 0 ? [{ type: 'addClips' as const, clips: copies }] : []),
  ];
}

export interface RemoveSectionOptions {
  /** Borrar también los clips que empiezan dentro. */
  withClips?: boolean;
  /** Cerrar el hueco tirando de lo que venía detrás. */
  ripple?: boolean;
}

/**
 * Borra una sección. Sin opciones quita solo la etiqueta; con `withClips` se
 * lleva lo que sonaba dentro, y con `ripple` además cierra el hueco.
 */
export function removeSectionCommands(
  project: Project,
  sectionId: Id,
  { withClips = false, ripple = false }: RemoveSectionOptions = {},
): Command[] {
  const section = project.sections[sectionId];
  if (!section) return [];
  const end = section.start + section.length;
  const out: Command[] = [{ type: 'removeSections', sectionIds: [sectionId] }];

  if (withClips) {
    const inside = clipsInSpan(project, section.arrangementId, section.start, end);
    if (inside.length > 0) {
      out.push({ type: 'removeClips', clipIds: inside.map((c) => c.id) });
    }
  }
  if (ripple) {
    // El desplazamiento se calcula sobre el proyecto de AHORA (los comandos aún
    // no se han aplicado), así que la sección que se va se excluye a mano: si
    // no, se le mandaría un patch a algo que el comando anterior ya borró.
    out.push(
      ...shiftCommands(project, section.arrangementId, end, -section.length, new Set([sectionId])),
    );
  }
  return out;
}

/**
 * Mueve una sección a `newStart` llevándose sus clips.
 *
 * No abre ni cierra huecos: es un desplazamiento, no un reordenado. Lo que haya
 * en el destino se queda donde está — igual que al arrastrar clips, donde
 * superponer es una decisión del usuario y no un error que haya que impedir.
 */
export function moveSectionCommands(
  project: Project,
  sectionId: Id,
  newStart: number,
): Command[] {
  const section = project.sections[sectionId];
  if (!section) return [];
  const start = Math.max(0, newStart);
  const delta = start - section.start;
  if (Math.abs(delta) < EPS) return [];

  const inside = clipsInSpan(
    project,
    section.arrangementId,
    section.start,
    section.start + section.length,
  );
  const out: Command[] = [
    { type: 'patchSections', patches: [{ id: sectionId, start }] },
  ];
  if (inside.length > 0) {
    out.push({
      type: 'patchClips',
      patches: inside.map((c) => ({ id: c.id, start: Math.max(0, c.start + delta) })),
    });
  }
  return out;
}

/**
 * Redimensiona una sección estirando o encogiendo el hueco: lo que venga
 * detrás se mueve con ella, para que las secciones no se solapen solas al
 * alargar una.
 */
export function resizeSectionCommands(
  project: Project,
  sectionId: Id,
  newLength: number,
  ripple = true,
): Command[] {
  const section = project.sections[sectionId];
  if (!section) return [];
  const length = Math.max(0.25, newLength);
  const delta = length - section.length;
  if (Math.abs(delta) < EPS) return [];
  const end = section.start + section.length;

  return [
    { type: 'patchSections', patches: [{ id: sectionId, length }] },
    ...(ripple
      ? shiftCommands(project, section.arrangementId, end, delta, new Set([sectionId]))
      : []),
  ];
}

/**
 * Crea una sección de golpe a partir de una forma (la del generador de beats o
 * la que dibuje el usuario), en compases.
 *
 * `barLen` es cuántos beats tiene un compás AHORA: la forma se piensa en
 * compases porque es como se piensa un tema, pero el modelo vive en beats.
 */
export function sectionsFromShape(
  arrangementId: Id,
  shape: readonly { kind: ArrangementSection['kind']; name: string; bars: number }[],
  barLen: number,
  startBeat = 0,
): ArrangementSection[] {
  let start = startBeat;
  return shape.map((s) => {
    const section: ArrangementSection = {
      id: newId(),
      arrangementId,
      name: s.name,
      start,
      length: Math.max(0.25, s.bars * barLen),
      ...(s.kind ? { kind: s.kind } : null),
    };
    start += section.length;
    return section;
  });
}
