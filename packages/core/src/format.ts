/** Formato .orbit: JSON versionado. Los samples van referenciados por hash. */

import type { Project } from './model/types';
import { FORMAT_VERSION } from './model/types';
import { normalizeKeymap } from './model/keymap';
import { BEND_MAX } from './model/paramref';
import { normalizeSlicePoints } from './model/slices';
import { normalizeProjectInputRoutes } from './model/input-routing';


export const ORBIT_EXTENSION = '.orbit';

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 1);
}

export function parseProject(json: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('El archivo no es un .orbit válido (JSON corrupto)');
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error('El archivo no es un .orbit válido');
  }
  const p = data as Partial<Project>;
  if (p.formatVersion !== FORMAT_VERSION) {
    throw new Error(
      `Versión de formato no soportada: ${String(p.formatVersion)} (esperada ${FORMAT_VERSION})`,
    );
  }
  // Estas cuatro faltaban en la lista y nadie las rellena por defecto: sin
  // ellas el archivo pasaba la puerta y reventaba más tarde, dentro del
  // compilador, con un TypeError que no dice nada ("Cannot convert undefined or
  // null to object"). Un .orbit incompleto tiene que fallar AQUÍ y por su
  // nombre.
  for (const key of [
    'id', 'meta', 'tempo', 'channels', 'patterns', 'mixer', 'clips',
    'channelOrder', 'playlistTracks', 'markers', 'timeSig',
  ] as const) {
    if (p[key] === undefined) {
      throw new Error(`.orbit inválido: falta "${key}"`);
    }
  }
  // `swing` faltaba en la lista y NO se rellenaba: sin él, `swungStart`
  // produce NaN y corrompe el timing EN SILENCIO (peor que un throw). Se
  // rellena a 0 (recto), que es como sonaba antes de que existiera el swing.
  p.swing ??= 0;
  // `samples` es aditivo (un proyecto sin audio no lo trae); sin él,
  // `registerSample` y el diff revientan al indexar undefined.
  p.samples ??= {};
  // `patternOrder` es de siempre, pero un archivo tocado a mano podría no
  // traerlo: se recupera del orden de las claves en vez de reventar más tarde
  // en removeChannel / diff / encodeMidi con un TypeError sin nombre.
  p.patternOrder ??= Object.keys(p.patterns ?? {});
  // Campos añadidos después (aditivos, sin subir formatVersion): los archivos
  // anteriores simplemente no los traen y arrancan vacíos/planos.
  p.lfos ??= {};
  // Secciones del arreglo (v2.4): aditivas. Un .orbit anterior abre sin forma
  // dibujada, que es exactamente como estaba antes de que existieran.
  p.sections ??= {};
  // Carpetas del rack (v1.5): aditivas, los archivos anteriores no las traen.
  p.channelGroups ??= {};
  p.channelGroupOrder ??= [];
  // Enrutado de entrada (v3.5): aditivo. Un .orbit anterior abre sin rutas y
  // se resuelve a la implícita —el par 1-2— que es como grabó siempre. Y las
  // que vengan se sanean aquí: cada número de una ruta acaba siendo un índice
  // de tabla del kernel o una ganancia, y eso no puede llegar del disco sin
  // mirar. Va DESPUÉS de `playlistTracks` porque comprueba que la pista de
  // cada ruta siga existiendo.
  p.inputRoutes ??= {};
  p.inputRouteOrder ??= [];
  normalizeProjectInputRoutes(p);
  // Cortes del Slicer: llegan del disco sin garantías (archivo tocado a mano,
  // versión futura) y el motor los usa tal cual, así que se sanean una vez aquí.
  for (const channel of Object.values(p.channels ?? {})) {
    const clean = normalizeSlicePoints(channel.slicePoints);
    if (clean) channel.slicePoints = clean;
    else delete channel.slicePoints;
    // Keymap del multisample: mismo trato que los cortes. Llega del disco sin
    // garantías y el motor lo usa tal cual, así que se sanea una vez aquí —
    // una zona con el rango del revés o apuntando a un sample que no existe no
    // puede llegar viva al kernel. Aditivo: los .orbit anteriores no lo traen.
    const zones = normalizeKeymap(channel.keymap);
    const known = zones?.filter((z) => p.samples?.[z.sampleId] !== undefined);
    if (known && known.length > 0) channel.keymap = known;
    else delete channel.keymap;

    // Rueda de tono (v3.4): un número que llega del disco y va DIRECTO a la
    // altura de cada nota del canal. Un NaN o un 400 aquí no es un canal raro,
    // es un canal mudo —la voz nace a una frecuencia imposible— así que se
    // acota, y el 0 se borra en vez de guardarse: sin doblar es la ausencia
    // del campo, igual que en los .orbit de antes de que existiera.
    if (channel.bend === undefined || !Number.isFinite(channel.bend) || channel.bend === 0) {
      delete channel.bend;
    } else {
      channel.bend = Math.min(BEND_MAX, Math.max(-BEND_MAX, channel.bend));
    }

    // Carpeta que ya no existe: el canal se queda suelto en vez de
    // desaparecer del rack (se pinta por carpeta, y esa no se pinta).
    if (channel.groupId !== undefined && !p.channelGroups?.[channel.groupId]) {
      delete channel.groupId;
    }
  }
  for (const track of p.mixer ?? []) {
    track.eqLow ??= 0;
    track.eqMid ??= 0;
    track.eqHigh ??= 0;
  }
  return p as Project;
}
