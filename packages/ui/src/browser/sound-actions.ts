/**
 * Acciones compartidas sobre sonidos de la librería: cargar al kernel, crear
 * canal sampler, colocar clip de audio en la playlist y rehidratar los samples
 * de un proyecto recién cargado. Las usan el Browser (clic/doble clic y
 * arrastre) y los destinos de drop (Channel Rack y Playlist).
 */

import {
  autoMapKeymap,
  createChannel,
  newId,
  normalizeKeymap,
  spreadKeymapRanges,
  MAX_KEYMAP_ZONES,
  type AutoMapOptions,
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

/**
 * El mismo arrastre, con TODAS las entradas.
 *
 * Son dos MIME y no uno por una razón concreta: en `dragover` el navegador
 * deja leer los TIPOS pero no el contenido, así que todos los destinos
 * comprueban `types.includes(SOUND_MIME)` para decidir si aceptan el drop.
 * Poner siempre el de siempre —con la primera entrada dentro— es lo que hace
 * que un arrastre de treinta muestras siga siendo un arrastre válido para
 * cualquier destino, sepa o no de grupos.
 */
export const SOUNDS_MIME = 'application/x-orbit-sounds';

/** Arrastre de un grupo de sonidos (uno también es un grupo). */
export function setDragEntries(dt: DataTransfer, entries: readonly SoundEntry[]): void {
  if (entries.length === 0) return;
  dt.setData(SOUND_MIME, JSON.stringify(entries[0]));
  if (entries.length > 1) dt.setData(SOUNDS_MIME, JSON.stringify(entries));
  dt.effectAllowed = 'copy';
}

export function setDragEntry(dt: DataTransfer, entry: SoundEntry): void {
  setDragEntries(dt, [entry]);
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

/**
 * Todo lo que trae el arrastre, en orden. Un destino que no sepa de grupos
 * puede seguir llamando a `getDragEntry` y le llegará la primera.
 */
export function getDragEntries(dt: DataTransfer): SoundEntry[] {
  const raw = dt.getData(SOUNDS_MIME);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // Un payload roto no puede tirar el drop entero: se cae a la entrada
      // suelta, que es lo que había antes de que esto existiera.
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as SoundEntry[];
    } catch {
      // sigue abajo
    }
  }
  const one = getDragEntry(dt);
  return one ? [one] : [];
}

/**
 * Lecturas de disco a la vez. Cargar un piano de treinta muestras hacía treinta
 * viajes al proceso principal en fila india; de cuatro en cuatro tarda lo que
 * tarda el disco y no lo que tarda el ida y vuelta multiplicado por treinta.
 * Cuatro y no treinta porque cada una decodifica un WAV entero en memoria.
 */
const LOAD_LIMIT = 4;

/** Recorre en paralelo pero de `limit` en `limit`, conservando el orden. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return out;
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

/** Lee los bytes de un sonido (pack de fábrica, pack generado o carpeta del
 *  usuario) y los sube al kernel bajo el id de la entrada. */
export async function loadIntoEngine(entry: SoundEntry): Promise<ArrayBuffer> {
  const api = window.orbit;
  if (!api) throw new Error('Librería no disponible fuera de Electron');
  const bytes = entry.id.startsWith('user:')
    ? await api.folder.read(entry.file)
    : entry.id.startsWith('pack:')
      ? await api.pack.read(entry.file)
      : await api.library.read(entry.file);
  await engine.loadSample(entry.id, bytes);
  return bytes;
}

/**
 * Duración real del sonido, en segundos.
 *
 * `entry.durationSec` es 0 en todo lo de "Tus carpetas" hasta que la cola de
 * análisis —perezosa y de uno en uno— le llega. Arrastrar a la playlist uno que
 * aún no había tocado dejaba un clip de 0,25 beats: de un loop de cuatro
 * segundos sonaban 125 ms. El motor acaba de decodificarlo aquí al lado, así
 * que la duración de verdad la tiene él.
 */
async function realDuration(entry: SoundEntry, bytes: ArrayBuffer): Promise<number> {
  if (entry.durationSec > 0) return entry.durationSec;
  try {
    const { duration } = await engine.loadSample(entry.id, bytes);
    return duration;
  } catch {
    return entry.durationSec;
  }
}

/** Un sonido ya leído de disco, listo para registrar. */
interface LoadedSound {
  entry: SoundEntry;
  bytes: ArrayBuffer;
}

/** Sube al kernel un grupo de sonidos, de cuatro en cuatro y en orden. */
async function loadAll(entries: readonly SoundEntry[]): Promise<LoadedSound[]> {
  return mapLimited(entries, LOAD_LIMIT, async (entry) => ({
    entry,
    bytes: await loadIntoEngine(entry),
  }));
}

/**
 * Los `registerSample` que hacen falta para un grupo, sin repetir.
 *
 * El `seen` no sobra: dentro de un lote el proyecto todavía no ha cambiado
 * —los comandos no se han despachado—, así que dos entradas del mismo sonido
 * pasarían las dos la comprobación y el batch llevaría el sample dos veces.
 */
async function registerCommands(loaded: readonly LoadedSound[]): Promise<Command[]> {
  const seen = new Set<string>();
  const out: Command[] = [];
  for (const { entry, bytes } of loaded) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(...(await registerIfNew(entry, bytes)));
  }
  return out;
}

/** registerSample si el proyecto aún no conoce este sonido. */
async function registerIfNew(entry: SoundEntry, bytes: ArrayBuffer): Promise<Command[]> {
  if (store.project.samples[entry.id] !== undefined) return [];
  const sample: SampleRef = {
    id: entry.id,
    name: entry.name,
    path: entry.id.startsWith('user:')
      ? `user:${entry.file}`
      : entry.id.startsWith('pack:')
        ? `pack:${entry.file}`
        : `factory:${entry.file}`,
    hash: (await sha1Hex(bytes)) ?? entry.id,
    // La de verdad, no la que traiga la entrada: lo de "Tus carpetas" llega con
    // 0 hasta que la cola de análisis pasa por ahí.
    duration: await realDuration(entry, bytes),
  };
  return [{ type: 'registerSample', sample }];
}

/** Doble clic o drop en el rack: canal sampler nuevo por el bus de comandos. */
export async function addSamplerChannel(entry: SoundEntry): Promise<void> {
  return addSamplerChannels([entry]);
}

/**
 * Varios sonidos al rack de una vez: un canal por sonido, en UN solo deshacer.
 *
 * Que sea un solo deshacer no es cosmética: soltar ocho piezas de batería y
 * tener que darle ocho veces a Ctrl+Z para volver atrás es lo que hace que la
 * gente no use el arrastre múltiple.
 */
export async function addSamplerChannels(entries: readonly SoundEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const loaded = await loadAll(entries);
  const commands: Command[] = await registerCommands(loaded);

  let index = store.project.channelOrder.length;
  let lastId: Id | null = null;
  for (const { entry } of loaded) {
    const channel = createChannel('sampler', index++, entry.name);
    // El kernel resuelve el sample de la voz por Channel.sampleId → debe ser
    // el mismo id con el que engine.loadSample lo subió (el del manifest).
    channel.sampleId = entry.id;
    if (entry.gainSuggestion !== undefined) {
      channel.volume = Math.min(2, entry.gainSuggestion);
    }
    commands.push({ type: 'addChannel', channel });
    lastId = channel.id;
  }

  const label =
    entries.length === 1
      ? `Añadir sampler "${entries[0]!.name}"`
      : `Añadir ${entries.length} samplers`;
  store.dispatch(
    commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
    { label },
  );
  // Igual que el rack: el último canal añadido queda seleccionado.
  if (lastId !== null) useUiStore.setState({ pianoRollChannelId: lastId });
}

/**
 * Drop de uno o varios sonidos sobre el keymap de un canal: sube los samples,
 * los registra y añade sus zonas, con las notas leídas de los nombres.
 *
 * Las zonas nuevas se reparten ENTRE ELLAS y con las que ya había: soltar seis
 * muestras más sobre un piano de doce tiene que dejar un piano de dieciocho
 * bien repartido, no seis zonas encima tapando lo anterior.
 */
export async function addKeymapZones(
  channelId: Id,
  entries: readonly SoundEntry[],
  options: AutoMapOptions = {},
): Promise<KeymapDropResult> {
  const channel = store.project.channels[channelId];
  if (!channel || entries.length === 0) return { added: 0, unreadable: [], dropped: 0 };

  const loaded = await loadAll(entries);
  const commands: Command[] = await registerCommands(loaded);

  // El auto-mapa necesita el NOMBRE DEL ARCHIVO, que es donde va la nota; el
  // de la entrada puede venir ya bonito y sin ella. De una ruta, el auto-mapa
  // solo mira el último tramo — la nota no está en el nombre de la carpeta.
  const { zones, unreadable } = autoMapKeymap(
    entries.map((e) => ({ id: e.id, name: e.file || e.name })),
    options,
  );
  if (zones.length === 0) return { added: 0, unreadable, dropped: 0 };

  // El tope se aplica ANTES de repartir, no después. Repartir y luego recortar
  // dejaba el teclado con agujeros: los rangos se habían calculado contando
  // con zonas que después desaparecían. Y se recorta por el final, así que lo
  // que ya estaba en el canal se conserva — quien acaba de soltar sabe que ha
  // soltado de más, pero no espera perder lo de antes.
  const all = [...(channel.keymap ?? []), ...zones];
  const dropped = Math.max(0, all.length - MAX_KEYMAP_ZONES);
  // Las que ya estaban conservan su raíz y su ganancia; lo que se recalcula
  // son los rangos, que es lo que cambia al entrar gente nueva.
  const merged = spreadKeymapRanges(all.slice(0, MAX_KEYMAP_ZONES));
  commands.push({
    type: 'patchChannel',
    channelId,
    patch: { keymap: normalizeKeymap(merged) ?? [] },
  });

  const added = zones.length - dropped;
  const label = `${channel.name}: ${added} muestra(s) al keymap`;
  store.dispatch(
    commands.length === 1 ? commands[0]! : { type: 'batch', label, commands },
    { label },
  );
  return { added, unreadable, dropped };
}

/** Qué pasó al soltar un grupo de muestras sobre un keymap. */
export interface KeymapDropResult {
  /** Zonas que entraron de verdad. */
  added: number;
  /** Nombres de los que no se supo leer la nota (se quedan fuera). */
  unreadable: string[];
  /** Zonas que no cupieron bajo el tope del keymap. */
  dropped: number;
}

/** Nombres que se listan enteros antes de resumir el resto. */
const MAX_LISTED = 4;

/**
 * Lo que se le dice a quien acaba de soltar un montón de muestras.
 *
 * Las tres cosas que pueden pasar se cuentan las tres, y a la vez: en un drop
 * de treinta muestras es perfectamente normal que entren veinte, que ocho no
 * traigan nota legible y que dos no quepan. Decir solo la primera —"20
 * muestras al keymap"— deja diez desaparecidas sin explicación, y eso se
 * descubre tocando el instrumento y encontrando huecos.
 */
export function describeKeymapDrop(result: KeymapDropResult): string {
  const parts: string[] = [];
  if (result.added > 0) {
    parts.push(`${result.added} muestra${result.added === 1 ? '' : 's'} al keymap.`);
  }
  if (result.unreadable.length > 0) {
    const shown = result.unreadable.slice(0, MAX_LISTED).join(', ');
    const rest = result.unreadable.length - MAX_LISTED;
    parts.push(
      `No he sabido leer la nota de ${result.unreadable.length}: ${shown}` +
        `${rest > 0 ? ` y ${rest} más` : ''}. Ponlas a mano abajo.`,
    );
  }
  if (result.dropped > 0) {
    parts.push(`${result.dropped} no cabían: el keymap admite ${MAX_KEYMAP_ZONES} zonas.`);
  }
  return parts.length > 0 ? parts.join(' ') : 'No ha entrado ninguna muestra.';
}

/** Drop en la playlist: clip de audio con la longitud real del sonido. */
export async function addAudioClip(entry: SoundEntry, trackId: Id, startBeat: number): Promise<void> {
  return addAudioClips([entry], trackId, startBeat);
}

/**
 * Varios sonidos a la playlist: uno detrás de otro en la misma pista, desde
 * donde se soltaron, en un solo deshacer.
 *
 * Uno detrás de otro y no apilados en el mismo punto: soltar cuatro trozos de
 * una voz picada, o cuatro compases de un loop, es montar una secuencia. Cada
 * uno arranca donde acaba el anterior con su longitud REAL, así que no se
 * cuadran a la rejilla — si las piezas son de compás exacto ya caen en su
 * sitio, y si no lo son, moverlas a una rejilla las descolocaría.
 */
export async function addAudioClips(
  entries: readonly SoundEntry[],
  trackId: Id,
  startBeat: number,
): Promise<void> {
  if (entries.length === 0) return;
  const loaded = await loadAll(entries);
  const commands: Command[] = await registerCommands(loaded);

  const clips: Clip[] = [];
  let at = startBeat;
  for (const { entry, bytes } of loaded) {
    const durationSec = await realDuration(entry, bytes);
    const lengthBeats = Math.max(0.25, (durationSec * store.project.tempo) / 60);
    clips.push({
      id: newId(),
      kind: 'audio',
      playlistTrackId: trackId,
      start: at,
      length: lengthBeats,
      muted: false,
      sampleId: entry.id,
      audioOffset: 0,
      audioGain: Math.min(2, entry.gainSuggestion ?? 1),
    });
    at += lengthBeats;
  }

  const label =
    entries.length === 1
      ? `Colocar audio "${entries[0]!.name}"`
      : `Colocar ${entries.length} audios`;
  commands.push({ type: 'addClips', clips });
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
  if (path.startsWith('pack:')) return api.pack.read(path.slice('pack:'.length));
  if (path.startsWith('recording:')) return api.recording.read(path.slice('recording:'.length));
  if (path.startsWith('user:')) return api.folder.read(path.slice('user:'.length));
  return null;
}

/**
 * Sube al kernel todos los samples que el proyecto referencia (tras abrir un
 * .orbit o recuperar un autosave, el kernel arranca vacío y los samplers y
 * clips de audio no sonarían): pack de fábrica y grabaciones. Mejor esfuerzo:
 * lo que falle se ignora — el export ya avisa de samples ausentes por su lado.
 *
 * Esto resuelve SOLO por ruta local, así que no vale para colaboración: en la
 * máquina del otro las rutas `user:`/`recording:` no existen. Ese caso lo lleva
 * collab/sample-sync.ts, que además busca el contenido publicado en la sala por
 * hash y sube lo nuestro. Si añades una vía nueva de registro de samples, la
 * cubre sola: reconcilia el proyecto entero, no comandos sueltos.
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
