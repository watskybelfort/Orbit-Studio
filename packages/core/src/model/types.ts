/**
 * Modelo de proyecto de Orbit Studio.
 *
 * Reglas de diseño:
 * - Toda entidad tiene `id` estable (nanoid) → merge CRDT y undo inequívocos.
 * - Pools planos (Record<Id, T>) + arrays de orden / claves foráneas; nada de
 *   árboles profundos, para mapear 1:1 a Y.Map/Y.Array.
 * - Tiempos musicales en beats (float, negra = 1). El motor convierte a samples.
 * - Ganancias de usuario en lineal [0..2]; la UI las muestra en dB.
 */

// Solo el TIPO: la cuenta y las reglas del keymap viven en `model/keymap.ts`,
// que a su vez necesita `Id` de aquí. Al ser un import de tipos, TypeScript lo
// borra al compilar y el ciclo no existe en tiempo de ejecución.
import type { KeymapZone } from './keymap';
// Igual que arriba: solo el TIPO. Las reglas del enrutado de entrada viven en
// `model/input-routing.ts`, que necesita `Id` y `Project` de aquí.
import type { InputRoute } from './input-routing';

export type Id = string;


// ── Notas ────────────────────────────────────────────────────────────────────

export interface Note {
  id: Id;
  /** Inicio en beats, relativo al patrón. */
  start: number;
  /** Duración en beats. */
  duration: number;
  /** Altura MIDI 0..127 (60 = C5 en convención FL). */
  key: number;
  /** 0..1 */
  velocity: number;
  /** -1..1 */
  pan: number;
  /** Nota slide: la voz activa hace glide hasta esta altura (808). */
  slide: boolean;
}

// ── Canales (instrumentos) ───────────────────────────────────────────────────

export type InstrumentKind =
  | 'sub808'
  | 'synth'
  | 'supersaw'
  | 'fm'
  | 'drums'
  | 'sampler'
  | 'nova'
  | 'prisma'
  | 'vox'
  | 'slicer';

/**
 * Inserts propios de un canal (v1.1). Son la cadena que suena ANTES de que el
 * canal entre en su pista de mixer, y existen para poder tratar UN sonido a
 * solas —bajarle el reverb, ensuciarlo, filtrarlo— sin gastar un insert
 * entero del mixer ni arrastrar a los demás canales que compartan pista.
 */
export const CHANNEL_SLOTS = 4;

/**
 * Carpeta del Channel Rack: agrupa canales para no perderse en un proyecto de
 * cuarenta. NO es un bus de audio (para eso está la pista de mixer): plegar,
 * silenciar o soltar la carpeta es hacérselo a sus canales, uno por uno, en un
 * solo paso de undo.
 */
export interface ChannelGroup {
  id: Id;
  name: string;
  color: string;
  /** Plegada: sus canales no se pintan en el rack (siguen sonando igual). */
  collapsed: boolean;
}

export interface Channel {
  id: Id;
  name: string;
  color: string;
  /**
   * Carpeta a la que pertenece (v1.5). Ausente o cadena VACÍA = suelto, al
   * final del rack. Se usa la cadena vacía al sacarlo de una carpeta: un
   * `undefined` se pierde al serializar el comando y por la sala no llegaría a
   * sacar a nadie de ningún sitio.
   */
  groupId?: Id;
  kind: InstrumentKind;
  /** Parámetros del instrumento; claves según PARAM_SPECS[kind]. */
  params: Record<string, number>;
  /** Sample cargado (solo sampler). */
  sampleId?: Id;
  /**
   * Multisample (solo sampler): varias muestras repartidas por el teclado y
   * por velocidad (ver `model/keymap.ts`). Cuando está y tiene zonas, MANDA
   * sobre `sampleId` — que se conserva igual, para que quitar el keymap
   * devuelva el canal exactamente a como estaba.
   */
  keymap?: KeymapZone[];

  /**
   * Cortes propios del Slicer, normalizados 0..1 y ordenados (ver
   * `model/slices.ts`): cada uno es el INICIO de un trozo. Los pone el detector
   * de transientes o la mano. Ausente = trozos iguales según el parámetro
   * `slices`, que es como funcionó siempre.
   */
  slicePoints?: number[];
  /** Preset cargado (solo kind='nova'); ver model/nova.ts. */
  novaPreset?: string;
  /** Preset cargado (solo kind='prisma'); ver model/prisma.ts. */
  prismaPreset?: string;
  /**
   * Efectos propios del canal, longitud fija CHANNEL_SLOTS y huecos = null.
   * Ausente (los .orbit anteriores a v1.1) = cadena vacía: el canal entra seco
   * en su pista de mixer, exactamente como antes.
   */
  fx?: (EffectSlot | null)[];
  /**
   * Plugin JS de instrumento que toca este canal (id del archivo). Cuando
   * está, sustituye al motor interno del `kind`; si el plugin falta o
   * revienta, el canal cae a su motor de siempre.
   */
  instrumentPluginId?: string;
  /** Ganancia lineal 0..2. */
  volume: number;
  /** -1..1 */
  pan: number;
  /**
   * Rueda de tono del canal, en semitonos (v3.4). Ausente = 0, que es donde
   * estuvo siempre: un `.orbit` de antes de esto suena exactamente igual.
   *
   * Es un parámetro del PROYECTO y no un mensaje suelto al motor, y esa es la
   * diferencia entera: como parámetro tiene curva de automatización, se graba
   * al mover la rueda tocando, viaja a la sala y tiene undo. Antes la rueda
   * doblaba la voz viva y lo que dobló no quedaba en ninguna parte.
   */
  bend?: number;
  mute: boolean;
  solo: boolean;
  /** Índice de pista de mixer (0 = Master, 1..N = inserts). */
  mixerTrack: number;
}

// ── Patrones ─────────────────────────────────────────────────────────────────

export interface Pattern {
  id: Id;
  name: string;
  color: string;
  /** Longitud en beats (el step sequencer pinta length*4 pasos de 1/16). */
  length: number;
  /** Notas por canal. */
  notes: Record<Id, Note[]>;
}

// ── Playlist / arrangements ──────────────────────────────────────────────────

export interface Arrangement {
  id: Id;
  name: string;
}

/** Iconos disponibles para una pista de playlist (la UI dibuja cada uno). */
export type TrackIcon =
  | 'drums'
  | 'bass'
  | 'keys'
  | 'guitar'
  | 'synth'
  | 'vocal'
  | 'audio'
  | 'fx';

export const TRACK_ICONS: TrackIcon[] = [
  'drums',
  'bass',
  'keys',
  'guitar',
  'synth',
  'vocal',
  'audio',
  'fx',
];

/** Estado de una ventana guardado en un layout del proyecto. */
export interface LayoutWindow {
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlaylistTrack {
  id: Id;
  arrangementId: Id;
  name: string;
  color: string;
  /** Altura en px de la fila (UI); se arrastra desde el borde de la cabecera. */
  height: number;
  /** Icono de la pista (clave de TRACK_ICONS); ausente = sin icono. */
  icon?: TrackIcon;
  muted: boolean;
  /** Posición vertical (0 arriba). */
  order: number;
  /**
   * Pista de mixer a la que van los clips de AUDIO de este carril (índice en
   * `project.mixer`; 0 = master). Ausente = master. Da a las tomas de voz y a
   * las pistas congeladas su propio canal de mixer (EQ, compresor, sends). Los
   * clips de PATRÓN no lo usan: sus canales ya declaran su pista de mixer.
   */
  mixerTrack?: number;
}

export type ClipKind = 'pattern' | 'audio' | 'automation';

export interface AutomationPoint {
  id: Id;
  /** Beats relativos al inicio del clip. */
  time: number;
  /** Valor normalizado 0..1 (se desnormaliza con el spec del parámetro). */
  value: number;
  /** -1..1: curvatura hacia el siguiente punto (0 = lineal). */
  tension: number;
}

/** Referencia a un parámetro automatizable de cualquier parte del proyecto. */
export type ParamRef =
  | { kind: 'channel'; channelId: Id; param: string }
  | { kind: 'channelMix'; channelId: Id; param: 'volume' | 'pan' | 'bend' }
  | {
      kind: 'mixer';
      trackIndex: number;
      param: 'volume' | 'pan' | 'stereoWidth' | 'eqLow' | 'eqMid' | 'eqHigh';
    }
  | { kind: 'effect'; trackIndex: number; slotIndex: number; param: string }
  /** Parámetro de un insert PROPIO del canal (Channel.fx). */
  | { kind: 'channelFx'; channelId: Id; slotIndex: number; param: string }
  | { kind: 'transport'; param: 'tempo' | 'swing' };

// ── LFOs (modulación continua de un parámetro) ───────────────────────────────

/** Forma de onda del LFO; el orden es el del selector de la UI y del kernel. */
export type LfoShape = 'sine' | 'triangle' | 'saw' | 'square' | 'random';

export const LFO_SHAPES: LfoShape[] = ['sine', 'triangle', 'saw', 'square', 'random'];

/**
 * Modulador libre sobre un parámetro. A diferencia de un clip de
 * automatización (que dibuja el valor), el LFO **suma** una oscilación
 * alrededor del valor actual del parámetro: si además hay automatización en
 * el mismo destino, el LFO ondula sobre la curva.
 *
 * La fase se deriva de la posición de la canción (`beats / rateBeats`), no de
 * un reloj libre: así el render offline suena EXACTAMENTE igual que en vivo.
 */
export interface Lfo {
  id: Id;
  target: ParamRef;
  shape: LfoShape;
  /** Duración de un ciclo en beats (4 = un compás de 4/4). */
  rateBeats: number;
  /** Profundidad bipolar -1..1 en unidades normalizadas del parámetro. */
  amount: number;
  /** Desfase inicial 0..1 (1 = un ciclo entero). */
  phase: number;
  enabled: boolean;
}

export interface Clip {
  id: Id;
  kind: ClipKind;
  playlistTrackId: Id;
  /** Inicio en beats absolutos de la canción. */
  start: number;
  /** Longitud en beats. */
  length: number;
  muted: boolean;
  color?: string;

  /** kind === 'pattern' */
  patternId?: Id;
  /** Offset en beats dentro del patrón (clips recortados). */
  patternOffset?: number;

  /** kind === 'audio' */
  sampleId?: Id;
  /** Offset en segundos dentro del sample. */
  audioOffset?: number;
  /** Ganancia lineal del clip. */
  audioGain?: number;
  /** Time-stretch: el audio se estira (pitch intacto) para llenar el clip. */
  audioStretch?: boolean;
  /** Transposición del clip en semitonos (pitch-shift, tiempo intacto). */
  audioPitch?: number;
  /**
   * Fundido de entrada en BEATS desde el principio del clip: la ganancia sube
   * de 0 a 1 en ese tramo. En beats y no en segundos porque el clip vive en el
   * timeline: cambiar el tempo mueve el clip y el fundido tiene que ir con él.
   * Ausente o 0 = entra a saco, como siempre.
   */
  fadeIn?: number;
  /** Fundido de salida en beats desde el final del clip (baja de 1 a 0). */
  fadeOut?: number;
  /**
   * Carril de toma dentro de la pista (comping): varias tomas apiladas en la
   * misma pista, solo suena la elegida. 0 = carril principal.
   */
  lane?: number;
  /**
   * Clip de audio nacido de CONGELAR una pista: guarda los clips que
   * sustituye (que siguen ahí, muteados y en el carril de abajo) para poder
   * descongelar sin haber perdido nada.
   */
  frozenFrom?: Id[];

  /** kind === 'automation' */
  target?: ParamRef;
  points?: AutomationPoint[];
}

/**
 * Un tramo con nombre del arreglo: la intro, el drop, la vuelta.
 *
 * No suena: es la FORMA del tema, y lo que la hace una herramienta y no una
 * etiqueta es que las operaciones se la llevan entera — duplicar un drop copia
 * sus clips y empuja lo que venía detrás, borrar una vuelta cierra el hueco.
 * Vive por arrangement, como las pistas de playlist.
 */
export interface ArrangementSection {
  id: Id;
  arrangementId: Id;
  name: string;
  /** Inicio en beats absolutos de la canción. */
  start: number;
  /** Longitud en beats. */
  length: number;
  color?: string;
  /**
   * Papel dentro del tema, cuando viene de una forma conocida. Es solo para
   * pintarlo y para que el generador y la playlist hablen el mismo idioma;
   * nada del motor lo mira.
   */
  kind?: 'intro' | 'build' | 'drop' | 'break' | 'outro';
}

export interface Marker {
  id: Id;
  /** Beats absolutos. */
  time: number;
  name: string;
  color: string;
  /** Cambio de tempo a partir de este marcador (opcional). */
  tempo?: number;
  /** Cambio de compás (pulsos por compás) a partir de aquí (opcional). */
  timeSigNum?: number;
}

// ── Mixer ────────────────────────────────────────────────────────────────────

export type EffectKind =
  | 'eq'
  | 'compressor'
  | 'limiter'
  | 'reverb'
  | 'convolver'
  | 'vinyl'
  | 'delay'
  | 'chorus'
  | 'flanger'
  | 'phaser'
  | 'distortion'
  | 'bitcrush'
  | 'autofilter'
  | 'gate'
  | 'stereo'
  | 'analyzer'
  | 'plugin';

export interface EffectSlot {
  id: Id;
  kind: EffectKind;
  enabled: boolean;
  /** Dry/wet del slot, 0..1. */
  mix: number;
  params: Record<string, number>;
  /** Pista de mixer que alimenta el detector (compresor sidechain). */
  sidechainSource?: number;
  /** kind === 'plugin': id del plugin JS de usuario que ocupa el slot. */
  pluginId?: string;
}

export const MIXER_SLOTS = 10;

/**
 * Dónde se toma la señal que viaja por un envío.
 *
 * `post` (por defecto) es después del fader: bajar la pista baja también lo que
 * mandas. `pre` es antes, que es lo que hace posible una reverb que se queda
 * cuando cierras el fader, o una mezcla de auriculares con sus propias
 * proporciones.
 */
export type SendTap = 'post' | 'pre';

/**
 * Qué parte de la señal viaja.
 *
 * Esto es lo que convierte un envío en un proceso y no en un cable: mandar solo
 * los LADOS de una pista a un bus con su compresor es una decisión de mezcla que
 * antes había que montar duplicando la pista.
 */
export type SendPart = 'stereo' | 'mid' | 'side' | 'left' | 'right';

export interface Send {
  /** Índice de pista destino. */
  target: number;
  /** Ganancia lineal 0..2. */
  level: number;
  /** Antes o después del fader. Ausente = 'post', como siempre. */
  tap?: SendTap;
  /** Qué parte de la señal se manda. Ausente = 'stereo'. */
  part?: SendPart;
  /**
   * Polaridad invertida. Con esto el envío RESTA en vez de sumar: es la
   * herramienta de los trucos de paralelo y de comprobar cancelaciones.
   */
  invert?: boolean;
  /** Pan propio del envío (-1..1). Ausente = centrado. */
  pan?: number;
  /** Silenciado sin perder sus ajustes. */
  mute?: boolean;
}

export interface MixerTrack {
  id: Id;
  name: string;
  color: string;
  /** Ganancia lineal 0..2 (≈ +6 dB máx). */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** 0 = mono, 1 = normal, 2 = extra ancho. */
  stereoWidth: number;
  /**
   * EQ rápido del strip (dB, -18..18), como el de FL: shelf grave en 120 Hz,
   * campana media en 1 kHz y shelf agudo en 6 kHz. Va DESPUÉS de los slots de
   * efectos y antes de width/pan/fader. Los .orbit anteriores a v0.9 no lo
   * traen y arrancan planos.
   */
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  /** Slots de efectos; longitud fija MIXER_SLOTS, huecos = null. */
  slots: (EffectSlot | null)[];
  /** Pista a la que desemboca (null solo en el master). */
  routeTo: number | null;
  sends: Send[];
}

// ── Samples ──────────────────────────────────────────────────────────────────

export interface SampleRef {
  id: Id;
  name: string;
  /** Ruta absoluta local o `factory:<relpath>` para contenido de fábrica. */
  path: string;
  /** sha1 del archivo — identidad para colaboración/caché. */
  hash: string;
  /** Duración en segundos (informativa). */
  duration: number;
}

// ── Proyecto ─────────────────────────────────────────────────────────────────

export interface TimeSig {
  num: number;
  den: number;
}

export interface ProjectMeta {
  title: string;
  author: string;
  comments: string;
}

export const FORMAT_VERSION = 1;
export const PPQ = 96;

export interface Project {
  formatVersion: typeof FORMAT_VERSION;
  id: Id;
  meta: ProjectMeta;

  tempo: number;
  timeSig: TimeSig;
  /** Swing global 0..1 (desplaza los 1/16 pares). */
  swing: number;

  channels: Record<Id, Channel>;
  channelOrder: Id[];
  /**
   * Carpetas del Channel Rack (v1.5): pura organización, no tocan el audio —
   * un canal suena igual dentro que fuera. Los .orbit anteriores no las traen
   * y arrancan vacías.
   */
  channelGroups: Record<Id, ChannelGroup>;
  channelGroupOrder: Id[];

  patterns: Record<Id, Pattern>;
  patternOrder: Id[];

  arrangements: Record<Id, Arrangement>;
  arrangementOrder: Id[];
  activeArrangementId: Id;

  playlistTracks: Record<Id, PlaylistTrack>;
  clips: Record<Id, Clip>;
  markers: Record<Id, Marker>;
  /** Secciones del arreglo (v2.4; los .orbit anteriores no las traen). */
  sections: Record<Id, ArrangementSection>;
  /** Moduladores continuos por parámetro (v0.8; los .orbit viejos no lo traen). */
  lfos: Record<Id, Lfo>;
  /**
   * Enrutado de entrada (v3.5): qué canal físico de la interfaz entra en qué
   * pista. Aditivo — un `.orbit` anterior no lo trae y se resuelve a la ruta
   * implícita (el par 1-2), que es como grabó siempre. Ver
   * `model/input-routing.ts`.
   */
  inputRoutes: Record<Id, InputRoute>;
  inputRouteOrder: Id[];
  /**
   * Layouts de ventanas guardados con el proyecto (v1.0): nombre → ventana →
   * posición. La UI decide qué claves usa; el modelo solo los transporta.
   */
  layouts?: Record<string, Record<string, LayoutWindow>>;

  mixer: MixerTrack[];

  samples: Record<Id, SampleRef>;
}
