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

interface ManifestTake {
  file: string;
  rootMidi: number;
  durationSec: number;
  velLow?: number;
  velHigh?: number;
}
interface ManifestEntry {
  id: string;
  name: string;
  file: string;
  durationSec: number;
  samples?: ManifestTake[];
}

/** Una toma de un instrumento multisampleado: su id, su nota y su franja de fuerza. */
export interface FactoryTake extends FactorySound {
  rootMidi: number;
  velLow: number;
  velHigh: number;
}

const ENTRIES = manifest.entries as ManifestEntry[];

/**
 * El id de cada toma sigue la convención del browser (`sampleIdFor`): la
 * principal es el id de la entrada; las demás, su ruta sin extensión. Así un
 * beat del compositor y un instrumento soltado desde el browser comparten
 * samples en el proyecto en vez de duplicarlos.
 */
function takeId(entry: ManifestEntry, file: string): string {
  return file === entry.file ? entry.id : file.replace(/\.[a-z0-9]+$/i, '');
}

const INDEX = new Map<string, FactorySound>();
const INSTRUMENTS = new Map<string, FactoryTake[]>();
for (const e of ENTRIES) {
  INDEX.set(e.id, { id: e.id, name: e.name, file: e.file, durationSec: e.durationSec });
  if (!e.samples || e.samples.length < 2) continue;
  const takes = e.samples.map((t): FactoryTake => {
    const id = takeId(e, t.file);
    return {
      id,
      name: id === e.id ? e.name : `${e.name} ${t.rootMidi}${t.velHigh !== undefined && t.velHigh < 1 ? ` (${t.velHigh < 0.5 ? 'pp' : 'p'})` : ''}`,
      file: t.file,
      durationSec: t.durationSec,
      rootMidi: t.rootMidi,
      velLow: t.velLow ?? 0,
      velHigh: t.velHigh ?? 1,
    };
  });
  INSTRUMENTS.set(e.id, takes);
  for (const t of takes) if (!INDEX.has(t.id)) INDEX.set(t.id, t);
}

/** Un sonido (o una toma de instrumento) de la librería de fábrica. */
export function factorySound(id: string): FactorySound | undefined {
  return INDEX.get(id);
}

/** Las tomas de un instrumento multisampleado (`instrumentos/piano-suave`), o undefined. */
export function factoryInstrument(id: string): readonly FactoryTake[] | undefined {
  return INSTRUMENTS.get(id);
}
