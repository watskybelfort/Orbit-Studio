/**
 * Enrutado de entrada: qué canal FÍSICO de la interfaz entra en qué pista.
 *
 * Hasta aquí la entrada de Orbit era un par estéreo fijo. Con una interfaz de
 * ocho entradas eso significa que suena el par que el sistema ponga primero:
 * si el micro está en la 5 y la 6 no hay nada que hacer desde la app, y grabar
 * dos micros a la vez —voz y guitarra, dos cantantes— era imposible aunque el
 * aparato los tuviera enchufados.
 *
 * Una **ruta de entrada** es la pieza que faltaba: un canal físico (o un par)
 * con nombre, su pista de mixer por la que entra en vivo, su pista de playlist
 * donde cae la toma, y si está armada y monitorizándose. Es un concepto del
 * PROYECTO y no un ajuste suelto de la app, y esa es la diferencia entera: se
 * guarda en el `.orbit`, viaja a la sala de colaboración, tiene undo y pasa por
 * el bus de comandos como todo lo demás.
 *
 * ── La ruta implícita ──
 *
 * Un proyecto que no declara ninguna ruta NO se queda sin entrada: se resuelve
 * a una sola ruta estéreo sobre los canales 1 y 2 con lo que digan los ajustes
 * de la app (pista, ganancia, monitor). Es exactamente el comportamiento de
 * siempre, y es lo que hace que un `.orbit` guardado antes de que esto
 * existiera abra y grabe igual que ayer.
 *
 * ── Por qué las rutas que el aparato no tiene NO se descartan ──
 *
 * Un proyecto con rutas en los canales 5-6 abierto con el micro del portátil
 * (dos canales) podría "limpiarse" tirando esas rutas. No se hace: el índice
 * de cada ruta es lo que enlaza la UI, el motor y las tomas capturadas, y
 * moverlo al abrir el proyecto dejaría la captura de una ruta cayendo en la
 * pista de otra. Se marcan como NO disponibles, el motor no encuentra su canal
 * y no suenan, y la UI lo dice. Enchufar la interfaz las devuelve a la vida
 * sin haber perdido nada.
 */

import { newId } from '../ids';
import type { Id, Project } from './types';

/**
 * Máximo de canales físicos que el motor enruta. No es un límite del hardware:
 * es el tamaño de la tabla preasignada del kernel (ver `kernel-core.ts`), que
 * no puede crecer dentro de `process()`.
 */
export const MAX_INPUT_CHANNELS = 32;

/** Máximo de rutas simultáneas (mismo motivo: tablas preasignadas). */
export const MAX_INPUT_ROUTES = 8;

export interface InputRoute {
  id: Id;
  /** Nombre humano ("Voz", "Guitarra DI"). */
  name: string;
  /** Canal físico del aparato (0-based) que alimenta el lado izquierdo. */
  channel: number;
  /**
   * Canal físico del lado derecho. Ausente = la ruta es MONO y su canal llega
   * a los dos lados, que es lo que quiere un micro: un solo canal pegado a la
   * izquierda no es una entrada, es una avería.
   */
  channelRight?: number;
  /** Pista de mixer por la que entra en vivo (índice en `project.mixer`). */
  mixerTrack: number;
  /**
   * Pista de playlist donde cae su toma. Ausente = la elige el grabador como
   * siempre (la de la toma anterior, una libre, o una nueva).
   */
  playlistTrackId?: Id;
  /** Armada: graba cuando se pulse Rec. */
  armed: boolean;
  /** Se oye por su pista de mixer, con la cadena de la pista puesta. */
  monitor: boolean;
  /** Ganancia de entrada, lineal 0..2. */
  gain: number;
}

/**
 * Una ruta ya resuelta contra el aparato abierto: lo que necesitan el motor
 * (los cuatro primeros campos) y el grabador (los de abajo).
 */
export interface ResolvedInputRoute {
  /** Ruta del proyecto de la que sale; null = la implícita. */
  routeId: Id | null;
  name: string;
  /** Canal físico del lado izquierdo. */
  srcL: number;
  /** Canal físico del lado derecho; **-1 = mono** (el izquierdo a los dos lados). */
  srcR: number;
  mixerTrack: number;
  gain: number;
  monitor: boolean;
  armed: boolean;
  playlistTrackId: Id | null;
  /**
   * ¿El aparato abierto tiene esos canales? Solo para avisar en la UI: una
   * ruta no disponible viaja igual al motor (para no mover los índices) y
   * simplemente no encuentra su canal.
   */
  available: boolean;
}

export interface ResolveInputOptions {
  /**
   * Canales que trae el aparato abierto. Ausente = todavía no se sabe (el
   * micro no está abierto): no se marca nada como no disponible.
   */
  channelCount?: number;
  /**
   * Lo que valía antes de que existieran las rutas, para la implícita: la
   * pista, la ganancia y el monitor de los ajustes de entrada de la app.
   */
  fallback?: { mixerTrack?: number; gain?: number; monitor?: boolean };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Nombre por defecto de una ruta según sus canales (1-based, como el aparato). */
export function inputRouteLabel(channel: number, channelRight?: number): string {
  return channelRight === undefined || channelRight === channel
    ? `Entrada ${channel + 1}`
    : `Entrada ${channel + 1}-${channelRight + 1}`;
}

/**
 * Ruta nueva sobre un canal (o un par). Nace ARMADA y sin monitor: armada
 * porque quien la crea la crea para grabar por ella, sin monitor porque
 * encender un micro que sale por los altavoces sin avisar es un acople.
 */
export function createInputRoute(
  channel: number,
  channelRight?: number,
  name?: string,
): InputRoute {
  const l = clampInt(channel, 0, MAX_INPUT_CHANNELS - 1, 0);
  const r =
    channelRight === undefined
      ? undefined
      : clampInt(channelRight, 0, MAX_INPUT_CHANNELS - 1, l);
  return {
    id: newId(),
    name: name ?? inputRouteLabel(l, r),
    channel: l,
    ...(r === undefined ? null : { channelRight: r }),
    mixerTrack: 1,
    armed: true,
    monitor: false,
    gain: 1,
  };
}

/**
 * Sanea una ruta que llega del disco o de la sala. Todo lo que hay dentro va
 * DIRECTO a un índice de tabla del kernel o a una ganancia: un NaN o un -3 no
 * es una ruta rara, es un bloque de audio con basura o un acceso fuera de la
 * tabla.
 */
export function normalizeInputRoute(raw: unknown): InputRoute | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<InputRoute>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  const channel = clampInt(r.channel, 0, MAX_INPUT_CHANNELS - 1, 0);
  const right =
    r.channelRight === undefined || r.channelRight === null
      ? undefined
      : clampInt(r.channelRight, 0, MAX_INPUT_CHANNELS - 1, channel);
  const route: InputRoute = {
    id: r.id,
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : inputRouteLabel(channel, right),
    channel,
    ...(right === undefined ? null : { channelRight: right }),
    mixerTrack: clampInt(r.mixerTrack, 0, 4096, 1),
    armed: r.armed !== false,
    monitor: r.monitor === true,
    gain:
      typeof r.gain === 'number' && Number.isFinite(r.gain)
        ? Math.min(2, Math.max(0, r.gain))
        : 1,
    ...(typeof r.playlistTrackId === 'string' && r.playlistTrackId.length > 0
      ? { playlistTrackId: r.playlistTrackId }
      : null),
  };
  return route;
}

/**
 * Deja el pool de rutas del proyecto en un estado usable tras leer un
 * `.orbit`: saneadas, sin huérfanas en el orden, sin duplicados y cortadas al
 * máximo que el kernel sabe enrutar. Muta el proyecto (se llama desde
 * `parseProject`, que es quien lo está construyendo).
 */
export function normalizeProjectInputRoutes(project: Partial<Project>): void {
  const raw = (project.inputRoutes ?? {}) as Record<string, unknown>;
  const clean: Record<Id, InputRoute> = {};
  for (const [id, value] of Object.entries(raw)) {
    const route = normalizeInputRoute(value);
    // La clave del pool manda sobre el id de dentro: es por la que se busca.
    if (route) clean[id] = { ...route, id };
  }
  const seen = new Set<Id>();
  const order: Id[] = [];
  for (const id of project.inputRouteOrder ?? []) {
    if (typeof id !== 'string' || !clean[id] || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  // Una ruta en el pool pero fuera del orden es invisible: se reengancha al
  // final en vez de quedarse como peso muerto en el archivo.
  for (const id of Object.keys(clean)) if (!seen.has(id)) order.push(id);
  // Lo que pase del máximo del kernel se queda en el proyecto pero fuera del
  // orden no: se recorta el orden, que es lo que se resuelve.
  project.inputRoutes = clean;
  project.inputRouteOrder = order.slice(0, MAX_INPUT_ROUTES);
  // La pista de playlist de una ruta puede haber desaparecido: la toma cae
  // donde la ponga el grabador en vez de apuntar a una pista fantasma.
  for (const id of project.inputRouteOrder) {
    const route = clean[id]!;
    if (route.playlistTrackId && !project.playlistTracks?.[route.playlistTrackId]) {
      delete route.playlistTrackId;
    }
  }
}

/** Las rutas del proyecto en su orden, ya saneadas y cortadas al máximo. */
export function projectInputRoutes(project: Project): InputRoute[] {
  const out: InputRoute[] = [];
  for (const id of project.inputRouteOrder ?? []) {
    const route = project.inputRoutes?.[id];
    if (route) out.push(route);
    if (out.length >= MAX_INPUT_ROUTES) break;
  }
  return out;
}

/**
 * Las rutas efectivas para el aparato abierto. **Nunca devuelve vacío**: sin
 * rutas declaradas sale la implícita (el par 1-2 con los ajustes de la app),
 * que es el comportamiento de toda la vida.
 */
export function resolveInputRoutes(
  project: Project,
  opts: ResolveInputOptions = {},
): ResolvedInputRoute[] {
  const count = opts.channelCount;
  const has = (channel: number): boolean =>
    count === undefined || !Number.isFinite(count) ? true : channel < count;

  const declared = projectInputRoutes(project);
  if (declared.length === 0) {
    // La implícita. Con un aparato MONO el lado derecho no existe: -1 hace que
    // el motor mande el izquierdo a los dos lados, igual que hoy.
    const mono = count !== undefined && Number.isFinite(count) && count < 2;
    return [
      {
        routeId: null,
        name: mono ? inputRouteLabel(0) : inputRouteLabel(0, 1),
        srcL: 0,
        srcR: mono ? -1 : 1,
        mixerTrack: Math.max(0, Math.round(opts.fallback?.mixerTrack ?? 1)),
        gain: Math.max(0, opts.fallback?.gain ?? 1),
        monitor: opts.fallback?.monitor === true,
        armed: true,
        playlistTrackId: null,
        available: true,
      },
    ];
  }

  return declared.map((route) => {
    const srcR = route.channelRight === undefined ? -1 : route.channelRight;
    return {
      routeId: route.id,
      name: route.name,
      srcL: route.channel,
      srcR,
      mixerTrack: route.mixerTrack,
      gain: route.gain,
      monitor: route.monitor,
      armed: route.armed,
      playlistTrackId: route.playlistTrackId ?? null,
      available: has(route.channel) && (srcR < 0 || has(srcR)),
    };
  });
}

/**
 * Las rutas que van a grabar, con su ÍNDICE dentro de la lista resuelta — que
 * es el que usan el mensaje de captura del kernel y los paquetes que vuelven.
 * Se ignoran las que el aparato no tiene: armar un canal que no existe no
 * puede dejar la grabación esperando una toma que nunca llega.
 */
export function armedInputRoutes(
  routes: readonly ResolvedInputRoute[],
): { index: number; route: ResolvedInputRoute }[] {
  const out: { index: number; route: ResolvedInputRoute }[] = [];
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]!;
    if (route.armed && route.available) out.push({ index: i, route });
  }
  return out;
}

/**
 * Firma de lo que el MOTOR ve de las rutas. La UI la usa para no reenviar el
 * mismo enrutado en cada versión del proyecto: cambiar el nombre de una ruta
 * no es un mensaje al kernel.
 */
export function inputRoutesSignature(routes: readonly ResolvedInputRoute[]): string {
  let out = '';
  for (const r of routes) {
    out += `${r.srcL},${r.srcR},${r.mixerTrack},${r.gain},${r.monitor ? 1 : 0};`;
  }
  return out;
}
