/**
 * La rueda de tono guardada en el proyecto.
 *
 * Lo que se prueba aquí es el viaje de ida y vuelta al disco, porque un número
 * de este campo no acaba en una etiqueta: acaba en la ALTURA de cada nota del
 * canal. Un `NaN` o un 400 que se cuelen al abrir no dan un canal raro, dan un
 * canal mudo —la voz nace a una frecuencia imposible— y eso solo se descubre
 * pulsando una tecla.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  BEND_MAX,
  createChannel,
  createEmptyProject,
  parseProject,
  serializeProject,
  type Project,
} from '../src/index';

function conCanal(): { project: Project; channelId: string } {
  const project = createEmptyProject();
  const channel = createChannel('sub808', 0, 'Bajo');
  applyCommand(project, { type: 'addChannel', channel });
  return { project, channelId: channel.id };
}

/** Guarda, abre, y devuelve el bend del canal tal como quedó. */
function idaYVuelta(bend: unknown): number | undefined {
  const { project, channelId } = conCanal();
  (project.channels[channelId] as { bend?: unknown }).bend = bend;
  return parseProject(serializeProject(project)).channels[channelId]!.bend;
}

describe('la rueda va y vuelve del disco', () => {
  it('un valor normal se conserva', () => {
    expect(idaYVuelta(2)).toBe(2);
    expect(idaYVuelta(-7.5)).toBe(-7.5);
  });

  it('sin doblar es la AUSENCIA del campo, no un cero guardado', () => {
    // No es cosmética: el kernel distingue "este canal no dice nada de la
    // rueda" de "este canal dice que está centrada". Lo primero respeta el
    // gesto en vivo al recompilar; lo segundo lo soltaría de golpe.
    expect(idaYVuelta(0)).toBeUndefined();
    expect(idaYVuelta(undefined)).toBeUndefined();
  });

  it('un .orbit de antes de que esto existiera abre sin doblar', () => {
    const { project, channelId } = conCanal();
    const back = parseProject(serializeProject(project));
    expect(back.channels[channelId]!.bend).toBeUndefined();
  });

  it('lo que no es un número se cae en vez de llegar al motor', () => {
    expect(idaYVuelta(Number.NaN)).toBeUndefined();
    expect(idaYVuelta(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('lo que se pasa de rango se acota, no se descarta', () => {
    // Acotar y no descartar porque un archivo con 400 quiere decir "arriba del
    // todo": dejarlo en el borde es lo que esperaba quien lo escribió.
    expect(idaYVuelta(400)).toBe(BEND_MAX);
    expect(idaYVuelta(-400)).toBe(-BEND_MAX);
  });

  it('viaja por `patchChannel`, sin comando propio', () => {
    // Como el keymap y los cortes del Slicer: sin comando nuevo trae undo y
    // colaboración gratis.
    const { project, channelId } = conCanal();
    applyCommand(project, { type: 'patchChannel', channelId, patch: { bend: 3 } });
    expect(project.channels[channelId]!.bend).toBe(3);
  });
});
