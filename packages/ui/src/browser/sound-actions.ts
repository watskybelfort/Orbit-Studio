/**
 * Acciones compartidas sobre sonidos de la librería: cargar al kernel, crear
 * canal sampler, colocar clip de audio en la playlist y rehidratar los samples
 * de un proyecto recién cargado. Las usan el Browser (clic/doble clic y
 * arrastre) y los destinos de drop (Channel Rack y Playlist).
 */

import {
  autoMapKeymap,
  createChannel,
  createKeymapZone,
  midiToNote,
  newId,
  normalizeKeymap,
  spreadKeymapRanges,
  MAX_KEYMAP_ZONES,
  type AutoMapOptions,
  type Clip,
  type Command,
  type Id,
  type KeymapZone,
  type SampleRef,
} from '@orbit/core';

import {
  dynamicLabel,
  entrySamples,
  sampleIdFor,
  type SoundEntry,
  type SoundSample,
} from '@orbit/sound-library';
import { engine, store } from '../state/app';
import { collectWorkletSamples } from '../state/sample-gc';
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

/**
 * Lee de disco un archivo de una entrada. El esquema lo decide el id de la
 * entrada (pack de fábrica, pack generado o carpeta del usuario); el archivo
 * se pasa aparte porque un instrumento multisample tiene varios.
 */
async function readEntryFile(entry: SoundEntry, file: string): Promise<ArrayBuffer> {
  const api = window.orbit;
  if (!api) throw new Error('Librería no disponible fuera de Electron');
  if (entry.id.startsWith('user:')) return api.folder.read(file);
  if (entry.id.startsWith('pack:')) return api.pack.read(file);
  // Lo importado del Explorador vive en la carpeta de la app, con las tomas y
  // los bounces: ya es un sample nuestro y se lee por donde se leen esos.
  if (entry.id.startsWith('recording:')) return api.recording.read(file);
  return api.library.read(file);
}

/** La ruta con esquema que se guarda en el proyecto (y con la que rehidrata). */
function pathOf(entry: SoundEntry, file: string): string {
  if (entry.id.startsWith('user:')) return `user:${file}`;
  if (entry.id.startsWith('pack:')) return `pack:${file}`;
  if (entry.id.startsWith('recording:')) return `recording:${file}`;
  return `factory:${file}`;
}

/**
 * El nombre del que el auto-mapa saca la nota.
 *
 * Normalmente el del ARCHIVO: el de la entrada puede venir ya bonito y sin la
 * nota (`Piano Suave` contra `Piano_C3.wav`). Con lo importado del Explorador
 * es al revés — el archivo se guarda con un nombre de contenido
 * (`importado-<hash>.wav`) para que dos `kick.wav` distintos no se pisen, y ese
 * nombre no solo no dice la nota: engaña, porque un hash en hexadecimal está
 * lleno de letras que son notas y de números que parecen octavas. El nombre que
 * traía el archivo viaja en `name`.
 */
export function autoMapNameOf(entry: SoundEntry): string {
  if (entry.id.startsWith('recording:')) return entry.name;
  return entry.file || entry.name;
}

/** Lee los bytes de la grabación PRINCIPAL de un sonido y la sube al kernel. */
export async function loadIntoEngine(entry: SoundEntry): Promise<ArrayBuffer> {
  const bytes = await readEntryFile(entry, entry.file);
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
async function realDuration(
  declared: number,
  sampleId: string,
  bytes: ArrayBuffer,
): Promise<number> {
  if (declared > 0) return declared;
  try {
    const { duration } = await engine.loadSample(sampleId, bytes);
    return duration;
  } catch {
    return declared;
  }
}

/** Una grabación concreta, ya leída y subida al kernel. */
export interface LoadedPart {
  /** La grabación tal como la declara el manifest. */
  sample: SoundSample;
  /** Id con el que vive en el kernel y en el proyecto. */
  id: string;
  bytes: ArrayBuffer;
}

/** Un sonido ya leído de disco, con TODAS sus grabaciones. */
export interface LoadedSound {
  entry: SoundEntry;
  parts: LoadedPart[];
}

/**
 * La grabación principal: la que se escucha, la que se coloca en la playlist y
 * la que se queda en `sampleId` cuando el canal es multisample (quitar el
 * keymap devuelve el canal a un sonido, no a nada).
 */
function mainPart(loaded: LoadedSound): LoadedPart {
  return loaded.parts.find((p) => p.sample.file === loaded.entry.file) ?? loaded.parts[0]!;
}

/**
 * Sube al kernel un grupo de sonidos con todas sus grabaciones, de cuatro en
 * cuatro y en orden.
 *
 * Se aplana antes de repartir el trabajo para que el límite cuente lecturas de
 * VERDAD: un instrumento de tres grabaciones son tres viajes al disco, no uno,
 * y contarlo como uno dejaba doce lecturas en vuelo cuando el límite decía
 * cuatro.
 */
async function loadAll(entries: readonly SoundEntry[]): Promise<LoadedSound[]> {
  const jobs: { at: number; sample: SoundSample }[] = [];
  entries.forEach((entry, at) => {
    for (const sample of entrySamples(entry)) jobs.push({ at, sample });
  });
  const out: LoadedSound[] = entries.map((entry) => ({ entry, parts: [] }));
  const done = await mapLimited(jobs, LOAD_LIMIT, async ({ at, sample }) => {
    const entry = entries[at]!;
    const id = sampleIdFor(entry, sample.file);
    const bytes = await readEntryFile(entry, sample.file);
    await engine.loadSample(id, bytes);
    return { at, part: { sample, id, bytes } };
  });
  // `mapLimited` conserva el orden, así que las grabaciones de cada
  // instrumento vuelven en el orden en que las declara el manifest.
  for (const { at, part } of done) out[at]!.parts.push(part);
  return out;
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
  for (const sound of loaded) {
    for (const part of sound.parts) {
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      out.push(...(await registerPart(sound.entry, part)));
    }
  }
  return out;
}

/** registerSample si el proyecto aún no conoce esta grabación. */
async function registerPart(entry: SoundEntry, part: LoadedPart): Promise<Command[]> {
  if (store.project.samples[part.id] !== undefined) return [];
  const sample: SampleRef = {
    id: part.id,
    name: nombreDeToma(entry, part),
    path: pathOf(entry, part.sample.file),
    hash: (await sha1Hex(part.bytes)) ?? part.id,
    // La de verdad, no la que traiga la entrada: lo de "Tus carpetas" llega con
    // 0 hasta que la cola de análisis pasa por ahí.
    duration: await realDuration(part.sample.durationSec, part.id, part.bytes),
  };
  return [{ type: 'registerSample', sample }];
}

/**
 * Cómo se llama una grabación en la lista de zonas del editor.
 *
 * La principal conserva el nombre del sonido a secas. Las demás llevan su nota
 * y, si el instrumento trae capas de fuerza, su marca de dinámica: seis filas
 * que pusieran "Piano Suave" no dicen nada, y seis que pusieran "Piano Suave
 * C4" dicen la mitad, porque hay dos por nota.
 */
function nombreDeToma(entry: SoundEntry, part: LoadedPart): string {
  if (part.id === entry.id) return entry.name;
  const nota = midiToNote(part.sample.rootMidi);
  const capa = dynamicLabel(part.sample);
  return capa === undefined ? `${entry.name} ${nota}` : `${entry.name} ${nota} ${capa}`;
}

/**
 * Las zonas de una grabación del pack: su tecla y su franja de fuerza.
 *
 * Las dos salen del manifest y ninguna se adivina. El pack SABE a qué nota y
 * con qué pulsación se grabó cada toma; leer la nota del nombre del archivo
 * sería tirar un dato cierto por uno probable, y repartir las franjas a partes
 * iguales por el ORDEN en que llegan daría lo mismo hoy y dependería de ese
 * orden mañana.
 *
 * Sin franja declarada —los packs del usuario, y cualquier pack anterior a las
 * capas— la zona coge la fuerza entera y el instrumento se reparte solo por
 * teclas, exactamente como antes.
 */
function zonaDeToma(part: LoadedPart): KeymapZone {
  return createKeymapZone(part.id, {
    keyRoot: part.sample.rootMidi,
    velLow: part.sample.velLow ?? 0,
    velHigh: part.sample.velHigh ?? 1,
  });
}

/**
 * El keymap de un instrumento con varias grabaciones, o `undefined` si trae
 * una sola (y entonces el canal es el sampler de un sample de siempre).
 *
 * Se exporta porque es puro y porque es LA decisión de esta ruta: cómo cae en
 * el teclado el instrumento que sueltas. Todo lo que lo rodea habla con el
 * kernel y con el store, así que esto es lo único que se puede mirar de cerca.
 */
export function keymapOf(sound: LoadedSound): KeymapZone[] | undefined {
  if (sound.parts.length < 2) return undefined;
  // `spreadKeymapRanges` reparte por RAÍCES distintas, no por zonas: las dos
  // capas de una nota comparten su trozo de teclado y se separan por fuerza.
  return normalizeKeymap(spreadKeymapRanges(sound.parts.map(zonaDeToma)));
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
  for (const sound of loaded) {
    const { entry } = sound;
    const channel = createChannel('sampler', index++, entry.name);
    // El kernel resuelve el sample de la voz por Channel.sampleId → debe ser
    // el mismo id con el que engine.loadSample lo subió (el del manifest).
    channel.sampleId = mainPart(sound).id;
    // Un instrumento con varias grabaciones entra YA montado como multisample:
    // es la diferencia entre un piano y una muestra de piano estirada por todo
    // el teclado. Con una sola, el canal es el sampler de siempre.
    const keymap = keymapOf(sound);
    if (keymap) channel.keymap = keymap;
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

  // Lo que el pack YA SABE no se adivina. Un instrumento del manifest trae la
  // nota de cada grabación escrita; leerla del nombre del archivo sería
  // cambiar un dato cierto por uno probable, y el desplazamiento de octavas
  // —que existe para arreglar librerías con otra convención— lo movería de su
  // sitio. Lo que no la trae sí pasa por el auto-mapa.
  const sabidas: KeymapZone[] = [];
  const adivinar: { id: Id; name: string }[] = [];
  for (const sound of loaded) {
    if (sound.entry.samples && sound.entry.samples.length > 0) {
      for (const part of sound.parts) sabidas.push(zonaDeToma(part));
    } else {
      // El auto-mapa necesita el NOMBRE DEL ARCHIVO, que es donde va la nota;
      // el de la entrada puede venir ya bonito y sin ella. De una ruta solo
      // mira el último tramo — la nota no está en el nombre de la carpeta.
      adivinar.push({ id: mainPart(sound).id, name: autoMapNameOf(sound.entry) });
    }
  }
  const { zones: adivinadas, unreadable } =
    adivinar.length > 0
      ? autoMapKeymap(adivinar, options)
      : { zones: [] as KeymapZone[], unreadable: [] as string[] };
  const zones = [...sabidas, ...adivinadas];
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
  for (const sound of loaded) {
    // En la playlist va la grabación PRINCIPAL: un clip de audio es un trozo
    // de sonido, no un instrumento. El keymap es cosa del canal.
    const part = mainPart(sound);
    const durationSec = await realDuration(part.sample.durationSec, part.id, part.bytes);
    const lengthBeats = Math.max(0.25, (durationSec * store.project.tempo) / 60);
    clips.push({
      id: newId(),
      kind: 'audio',
      playlistTrackId: trackId,
      start: at,
      length: lengthBeats,
      muted: false,
      sampleId: part.id,
      audioOffset: 0,
      audioGain: Math.min(2, sound.entry.gainSuggestion ?? 1),
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
 * lo que falle no tumba el resto — pero SÍ se devuelve, porque quien abrió
 * "desde una plantilla" necesita saber qué faltó en vez de heredar un canal
 * mudo sin explicación (los llamadores que abren un .orbit de siempre pueden
 * seguir descartando el resultado con `void`).
 *
 * Esto resuelve SOLO por ruta local, así que no vale para colaboración: en la
 * máquina del otro las rutas `user:`/`recording:` no existen. Ese caso lo lleva
 * collab/sample-sync.ts, que además busca el contenido publicado en la sala por
 * hash y sube lo nuestro. Si añades una vía nueva de registro de samples, la
 * cubre sola: reconcilia el proyecto entero, no comandos sueltos.
 */
export async function rehydrateSamples(): Promise<SampleRef[]> {
  const missing: SampleRef[] = [];
  for (const ref of Object.values(store.project.samples)) {
    try {
      const bytes = await readSampleBytes(ref.path);
      if (bytes) await engine.loadSample(ref.id, bytes);
      else missing.push(ref);
    } catch {
      // sample no disponible en esta máquina
      missing.push(ref);
    }
  }
  // Y lo del proyecto ANTERIOR, que ya no lo usa nadie, que lo suelte el
  // worklet. Este es el sitio porque por aquí pasan las cuatro puertas que
  // cambian el proyecto entero —abrir un `.orbit`, recuperar el autosave,
  // restaurar una versión y arrancar desde plantilla—, que es justo el caso en
  // que se queda colgado el audio del proyecto de antes.
  //
  // Va DESPUÉS del bucle a propósito: primero se sube lo que hace falta ahora y
  // solo entonces se suelta el resto. Al revés, un sample compartido entre los
  // dos proyectos se soltaría para volver a leerse del disco a continuación.
  collectWorkletSamples(engine, store.project);
  return missing;
}
