/**
 * Acciones compartidas sobre sonidos de la librería: cargar al kernel, crear
 * canal sampler, colocar clip de audio en la playlist y rehidratar los samples
 * de un proyecto recién cargado. Las usan el Browser (clic/doble clic y
 * arrastre) y los destinos de drop (Channel Rack y Playlist).
 */

import {
  createChannel,
  newId,
  type Clip,
  type Command,
  type Id,
  type SampleRef,
} from '@orbit/core';
import type { SoundEntry } from '@orbit/sound-library';
import { engine, store } from '../state/app';
import { useUiStore } from '../state/ui';

/** MIME propio para arrastrar sonidos del browser dentro de la app. */
export const SOUND_MIME = 'application/x-orbit-sound';

export function setDragEntry(dt: DataTransfer, entry: SoundEntry): void {
  dt.setData(SOUND_MIME, JSON.stringify(entry));
  dt.effectAllowed = 'copy';
}

export function getDragEntry(dt: DataTransfer): SoundEntry | null {
  const raw = dt.getData(SOUND_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SoundEntry;
  } catch {
    return null;
  }
}

/** sha1 en hex del archivo (identidad del SampleRef); null si no hay WebCrypto. */
export async function sha1Hex(data: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-1', data);
    let out = '';
    for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

/** Lee los bytes de un sonido (pack de fábrica o carpeta del usuario) y los
 *  sube al kernel bajo el id de la entrada. */
export async function loadIntoEngine(entry: SoundEntry): Promise<ArrayBuffer> {
  const api = window.orbit;
  if (!api) throw new Error('Librería no disponible fuera de Electron');
  const bytes = entry.id.startsWith('user:')
    ? await api.folder.read(entry.file)
    : await api.library.read(entry.file);
  await engine.loadSample(entry.id, bytes);
  return bytes;
}

/** registerSample si el proyecto aún no conoce este sonido. */
async function registerIfNew(entry: SoundEntry, bytes: ArrayBuffer): Promise<Command[]> {
  if (store.project.samples[entry.id] !== undefined) return [];
  const sample: SampleRef = {
    id: entry.id,
    name: entry.name,
    path: entry.id.startsWith('user:') ? `user:${entry.file}` : `factory:${entry.file}`,
    hash: (await sha1Hex(bytes)) ?? entry.id,
    duration: entry.durationSec,
  };
  return [{ type: 'registerSample', sample }];
}

/** Doble clic o drop en el rack: canal sampler nuevo por el bus de comandos. */
export async function addSamplerChannel(entry: SoundEntry): Promise<void> {
  const bytes = await loadIntoEngine(entry);

  const channel = createChannel('sampler', store.project.channelOrder.length, entry.name);
  // El kernel resuelve el sample de la voz por Channel.sampleId → debe ser
  // el mismo id con el que engine.loadSample lo subió (el del manifest).
  channel.sampleId = entry.id;
  if (entry.gainSuggestion !== undefined) {
    channel.volume = Math.min(2, entry.gainSuggestion);
  }

  const commands: Command[] = [...(await registerIfNew(entry, bytes))];
  commands.push({ type: 'addChannel', channel });

  const label = `Añadir sampler "${entry.name}"`;
  store.dispatch(
    commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
    { label },
  );
  // Igual que el rack: el canal recién añadido queda seleccionado.
  useUiStore.setState({ pianoRollChannelId: channel.id });
}

/** Drop en la playlist: clip de audio con la longitud real del sonido. */
export async function addAudioClip(entry: SoundEntry, trackId: Id, startBeat: number): Promise<void> {
  const bytes = await loadIntoEngine(entry);

  const lengthBeats = Math.max(0.25, (entry.durationSec * store.project.tempo) / 60);
  const clip: Clip = {
    id: newId(),
    kind: 'audio',
    playlistTrackId: trackId,
    start: startBeat,
    length: lengthBeats,
    muted: false,
    sampleId: entry.id,
    audioOffset: 0,
    audioGain: Math.min(2, entry.gainSuggestion ?? 1),
  };

  const label = `Colocar audio "${entry.name}"`;
  const commands: Command[] = [...(await registerIfNew(entry, bytes)), { type: 'addClips', clips: [clip] }];
  store.dispatch(
    commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
    { label },
  );
}

/** Bytes de un SampleRef según su esquema, o null si no es resoluble aquí. */
export async function readSampleBytes(path: string): Promise<ArrayBuffer | null> {
  const api = window.orbit;
  if (!api) return null;
  if (path.startsWith('factory:')) return api.library.read(path.slice('factory:'.length));
  if (path.startsWith('recording:')) return api.recording.read(path.slice('recording:'.length));
  if (path.startsWith('user:')) return api.folder.read(path.slice('user:'.length));
  return null;
}

/**
 * Sube al kernel todos los samples que el proyecto referencia (tras abrir un
 * .orbit o recuperar un autosave, el kernel arranca vacío y los samplers y
 * clips de audio no sonarían): pack de fábrica y grabaciones. Mejor esfuerzo:
 * lo que falle se ignora — el export ya avisa de samples ausentes por su lado.
 */
export async function rehydrateSamples(): Promise<void> {
  for (const ref of Object.values(store.project.samples)) {
    try {
      const bytes = await readSampleBytes(ref.path);
      if (bytes) await engine.loadSample(ref.id, bytes);
    } catch {
      // sample no disponible en esta máquina: se omite
    }
  }
}
