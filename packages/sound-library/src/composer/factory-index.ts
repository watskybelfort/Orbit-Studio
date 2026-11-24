/**
 * Índice de la librería de fábrica para el compositor: de un id
 * (`drums/trap/kick-01`) a su archivo, nombre y duración.
 *
 * Se lee del MISMO manifest que sirve el browser —el que genera
 * `generate/generate.ts`—, así que un sonido que el compositor pide existe en
 * la app por construcción, y un test comprueba que todos los ids de los
 * presets de género están aquí. Sin fs: el JSON va dentro del bundle.
 */

import manifest from '../../factory/manifest.json';

export interface FactorySound {
  id: string;
  name: string;
  /** Ruta relativa al pack de fábrica (la de `factory:<file>`). */
  file: string;
  durationSec: number;
}

const INDEX = new Map<string, FactorySound>(
  (manifest.entries as { id: string; name: string; file: string; durationSec: number }[]).map((e) => [
    e.id,
    { id: e.id, name: e.name, file: e.file, durationSec: e.durationSec },
  ]),
);

export function factorySound(id: string): FactorySound | undefined {
  return INDEX.get(id);
}
