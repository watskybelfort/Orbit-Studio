/**
 * Enrutado de entrada en el MODELO: qué canal físico entra en qué pista.
 *
 * Lo que hay que demostrar aquí es lo que hace que esto sea un concepto del
 * proyecto y no un ajuste suelto de la app:
 *
 * - que se mueve por el BUS DE COMANDOS y cada comando trae su inverso, o sea
 *   que tiene undo y viaja a la sala;
 * - que un `.orbit` guardado antes de que existiera abre igual y se resuelve
 *   al par de siempre;
 * - y que los índices de las rutas NO se mueven cuando el aparato no tiene sus
 *   canales, porque ese índice es lo que enlaza una toma con su pista.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_ROUTES,
  applyCommand,
  armedInputRoutes,
  createEmptyProject,
  createInputRoute,
  createPlaylistTrack,
  inputRouteLabel,
  inputRoutesSignature,
  normalizeProjectInputRoutes,
  parseProject,
  projectInputRoutes,
  resolveInputRoutes,
  serializeProject,
  type Command,
  type Project,
} from '../src/index';

function withRoutes(...channels: (number | [number, number])[]): Project {
  const project = createEmptyProject();
  for (const spec of channels) {
    const route = Array.isArray(spec)
      ? createInputRoute(spec[0], spec[1])
      : createInputRoute(spec);
    applyCommand(project, { type: 'addInputRoute', route });
  }
  return project;
}

describe('la entrada implícita (nada declarado)', () => {
  it('un proyecto nuevo no declara ninguna ruta', () => {
    const project = createEmptyProject();
    expect(project.inputRoutes).toEqual({});
    expect(project.inputRouteOrder).toEqual([]);
    expect(projectInputRoutes(project)).toHaveLength(0);
  });

  it('se resuelve al par 1-2, que es como grabó siempre', () => {
    const routes = resolveInputRoutes(createEmptyProject(), { channelCount: 8 });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.srcL).toBe(0);
    expect(routes[0]!.srcR).toBe(1);
    expect(routes[0]!.routeId).toBeNull();
    expect(routes[0]!.armed).toBe(true);
  });

  it('con un aparato MONO sale mono (el canal a los dos lados)', () => {
    const routes = resolveInputRoutes(createEmptyProject(), { channelCount: 1 });
    expect(routes[0]!.srcR).toBe(-1);
  });

  it('toma la pista, la ganancia y el monitor de los ajustes de la app', () => {
    // Es lo que hace que declarar rutas no cambie nada de lo que ya sonaba: la
    // implícita ES el estado de la pantalla de entrada.
    const routes = resolveInputRoutes(createEmptyProject(), {
      channelCount: 2,
      fallback: { mixerTrack: 5, gain: 0.5, monitor: true },
    });
    expect(routes[0]!.mixerTrack).toBe(5);
    expect(routes[0]!.gain).toBe(0.5);
    expect(routes[0]!.monitor).toBe(true);
  });

  it('nunca devuelve vacío: sin micro abierto también hay entrada', () => {
    expect(resolveInputRoutes(createEmptyProject())).toHaveLength(1);
  });
});

describe('rutas declaradas', () => {
  it('mandan sobre la implícita, en su orden', () => {
    const project = withRoutes(4, [6, 7]);
    const routes = resolveInputRoutes(project, { channelCount: 8 });
    expect(routes).toHaveLength(2);
    expect(routes[0]!.srcL).toBe(4);
    expect(routes[0]!.srcR).toBe(-1); // mono
    expect(routes[1]!.srcL).toBe(6);
    expect(routes[1]!.srcR).toBe(7);
  });

  it('una ruta que el aparato no tiene se marca, pero NO se quita de en medio', () => {
    // Si se filtrara, la segunda pasaría a ser la índice 0 y su toma caería en
    // la pista de la primera.
    const project = withRoutes(6, 0);
    const routes = resolveInputRoutes(project, { channelCount: 2 });
    expect(routes).toHaveLength(2);
    expect(routes[0]!.available).toBe(false);
    expect(routes[1]!.available).toBe(true);
    expect(routes[1]!.srcL).toBe(0);
  });

  it('sin saber cuántos canales hay, no se descarta ninguna', () => {
    const routes = resolveInputRoutes(withRoutes(6), {});
    expect(routes[0]!.available).toBe(true);
  });

  it('un par cuyo canal derecho falta tampoco está disponible', () => {
    const routes = resolveInputRoutes(withRoutes([1, 5]), { channelCount: 3 });
    expect(routes[0]!.available).toBe(false);
  });

  it('armadas = las que van a grabar, y solo las que existen', () => {
    const project = withRoutes(0, 3, 6);
    const ids = project.inputRouteOrder;
    applyCommand(project, { type: 'patchInputRoute', routeId: ids[1]!, patch: { armed: false } });
    const armed = armedInputRoutes(resolveInputRoutes(project, { channelCount: 4 }));
    // La 1 está armada y existe; la 2 está desarmada; la 3 no la trae el aparato.
    expect(armed.map((a) => a.index)).toEqual([0]);
  });

  it('la firma para el motor ignora el nombre (renombrar no es un mensaje)', () => {
    const project = withRoutes(2);
    const before = inputRoutesSignature(resolveInputRoutes(project, { channelCount: 4 }));
    applyCommand(project, {
      type: 'patchInputRoute',
      routeId: project.inputRouteOrder[0]!,
      patch: { name: 'Voz de Doc' },
    });
    const after = inputRoutesSignature(resolveInputRoutes(project, { channelCount: 4 }));
    expect(after).toBe(before);
  });
});

describe('el bus de comandos', () => {
  it('añadir devuelve el inverso que la quita', () => {
    const project = createEmptyProject();
    const route = createInputRoute(4, 5, 'Guitarra');
    const inverse = applyCommand(project, { type: 'addInputRoute', route });
    expect(project.inputRouteOrder).toEqual([route.id]);
    applyCommand(project, inverse);
    expect(project.inputRouteOrder).toEqual([]);
    expect(project.inputRoutes[route.id]).toBeUndefined();
  });

  it('quitar devuelve la ruta a SU SITIO, no al final', () => {
    // El índice de una entrada es lo que enlaza su toma con su pista: deshacer
    // tiene que devolverla donde estaba o la grabación cambiaría de destino.
    const project = withRoutes(0, 1, 2);
    const [, second] = project.inputRouteOrder;
    const before = [...project.inputRouteOrder];
    const inverse = applyCommand(project, { type: 'removeInputRoute', routeId: second! });
    expect(project.inputRouteOrder).toHaveLength(2);
    applyCommand(project, inverse);
    expect(project.inputRouteOrder).toEqual(before);
  });

  it('ajustar devuelve el valor viejo', () => {
    const project = withRoutes(0);
    const id = project.inputRouteOrder[0]!;
    const inverse = applyCommand(project, {
      type: 'patchInputRoute',
      routeId: id,
      patch: { mixerTrack: 7, armed: false },
    });
    expect(project.inputRoutes[id]!.mixerTrack).toBe(7);
    applyCommand(project, inverse);
    expect(project.inputRoutes[id]!.mixerTrack).toBe(1);
    expect(project.inputRoutes[id]!.armed).toBe(true);
  });

  it('tocar una ruta que no existe falla por su nombre', () => {
    const project = createEmptyProject();
    expect(() =>
      applyCommand(project, { type: 'patchInputRoute', routeId: 'fantasma', patch: {} }),
    ).toThrow(/entrada fantasma/);
  });

  it('no caben más de las que el kernel sabe enrutar', () => {
    const project = createEmptyProject();
    for (let i = 0; i < MAX_INPUT_ROUTES; i++) {
      applyCommand(project, { type: 'addInputRoute', route: createInputRoute(i) });
    }
    // Fallar aquí, con su nombre, es mejor que crearla en el proyecto y que no
    // suene nunca porque el motor no tiene sitio para ella.
    const extra: Command = { type: 'addInputRoute', route: createInputRoute(9) };
    expect(() => applyCommand(project, extra)).toThrow(/máximo/);
  });
});

describe('lo guardado en disco', () => {
  it('un .orbit de antes del enrutado abre y usa el par de siempre', () => {
    const saved = JSON.parse(serializeProject(createEmptyProject())) as Record<string, unknown>;
    delete saved['inputRoutes'];
    delete saved['inputRouteOrder'];
    const project = parseProject(JSON.stringify(saved));
    expect(project.inputRoutes).toEqual({});
    const routes = resolveInputRoutes(project, { channelCount: 8 });
    expect(routes).toHaveLength(1);
    expect(routes[0]!.srcL).toBe(0);
    expect(routes[0]!.srcR).toBe(1);
  });

  it('ida y vuelta por el archivo deja las rutas como estaban', () => {
    const project = withRoutes(4, [6, 7]);
    const back = parseProject(serializeProject(project));
    expect(back.inputRouteOrder).toEqual(project.inputRouteOrder);
    expect(projectInputRoutes(back).map((r) => r.channel)).toEqual([4, 6]);
  });

  it('los números que llegan del disco se acotan antes de tocar el motor', () => {
    // Cada uno de estos acaba en un índice de tabla del kernel o en una
    // ganancia: un NaN aquí es un bloque de audio con basura.
    const project = createEmptyProject() as Project & { inputRoutes: Record<string, unknown> };
    project.inputRoutes['sucia'] = {
      id: 'sucia',
      name: '',
      channel: -3,
      channelRight: 999,
      mixerTrack: Number.NaN,
      armed: true,
      monitor: true,
      gain: 50,
    };
    project.inputRouteOrder = ['sucia'];
    normalizeProjectInputRoutes(project);
    const route = project.inputRoutes['sucia']!;
    expect(route.channel).toBe(0);
    expect(route.channelRight).toBeLessThan(32);
    expect(route.mixerTrack).toBe(1);
    expect(route.gain).toBe(2);
    expect(route.name).toBe(inputRouteLabel(route.channel, route.channelRight));
  });

  it('una ruta en el pool pero fuera del orden se reengancha (no es peso muerto)', () => {
    const project = withRoutes(0, 1);
    project.inputRouteOrder = [project.inputRouteOrder[0]!];
    normalizeProjectInputRoutes(project);
    expect(project.inputRouteOrder).toHaveLength(2);
  });

  it('una pista de playlist que ya no existe se suelta', () => {
    const project = createEmptyProject();
    const track = createPlaylistTrack(project.activeArrangementId, 99);
    const route = createInputRoute(0);
    route.playlistTrackId = track.id; // pista que nunca se añadió
    applyCommand(project, { type: 'addInputRoute', route });
    normalizeProjectInputRoutes(project);
    expect(project.inputRoutes[route.id]!.playlistTrackId).toBeUndefined();
  });
});
