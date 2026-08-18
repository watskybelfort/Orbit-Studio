/** Formato .orbit: JSON versionado. Los samples van referenciados por hash. */

import type { Project } from './model/types';
import { FORMAT_VERSION } from './model/types';
import { normalizeSlicePoints } from './model/slices';

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
  for (const key of [
    'id', 'meta', 'tempo', 'channels', 'patterns', 'mixer', 'clips',
  ] as const) {
    if (p[key] === undefined) {
      throw new Error(`.orbit inválido: falta "${key}"`);
    }
  }
  // Campos añadidos después (aditivos, sin subir formatVersion): los archivos
  // anteriores simplemente no los traen y arrancan vacíos/planos.
  p.lfos ??= {};
  // Cortes del Slicer: llegan del disco sin garantías (archivo tocado a mano,
  // versión futura) y el motor los usa tal cual, así que se sanean una vez aquí.
  for (const channel of Object.values(p.channels ?? {})) {
    const clean = normalizeSlicePoints(channel.slicePoints);
    if (clean) channel.slicePoints = clean;
    else delete channel.slicePoints;
  }
  for (const track of p.mixer ?? []) {
    track.eqLow ??= 0;
    track.eqMid ??= 0;
    track.eqHigh ??= 0;
  }
  return p as Project;
}
