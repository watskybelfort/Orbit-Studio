/**
 * Definición de las tools MCP de Orbit Studio (v0.1).
 *
 * Este archivo es DATOS puros (nombre + descripción + JSON Schema): lo consume
 * el servidor MCP stdio (node/mcp-stdio.ts) para anunciar las tools, y sirve
 * de contrato para el ToolExecutor del renderer. Sin dependencias de Node ni
 * del SDK — browser-safe.
 *
 * Convenciones que las descripciones enseñan al modelo:
 * - Tiempos en beats (negra = 1). Un patrón de 4 beats = 1 compás de 4/4.
 * - Notas como número MIDI (`key`, convención FL: C5 = 60) o nombre (`note`,
 *   "F2", "A#4"...). Velocity 0..1, pan -1..1.
 * - Ganancias: `volume` lineal 0..2 (1 = 0 dB) o `volumeDb` en dB.
 * - Los ids de patrón/canal se obtienen con get_project; las tools también
 *   aceptan el nombre exacto ("Patrón 1", "Orbit Sub").
 */

import { EFFECT_PARAMS, INSTRUMENT_PARAMS, SCALES } from '@orbit/core';
import {
  COMPOSER_GENRES,
  COMPOSER_ROLES,
  MAX_PACK_SOUNDS,
  MAX_STRUCTURED_BEATS,
  PACK_FAMILIES,
  PACK_STYLES,
} from '@orbit/sound-library';
import { MAX_LEARN_SAMPLES as MAX_LEARN } from './composer-tools';

/** JSON Schema (draft-07 compatible) del input de una tool. */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [extra: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

// ── Fragmentos de descripción generados del registro de parámetros de core ──
// (una sola fuente de verdad: si un efecto/instrumento gana parámetros, la
// descripción de la tool se actualiza sola).

const instrumentParamsHelp = Object.entries(INSTRUMENT_PARAMS)
  .map(([kind, specs]) => `${kind}: ${specs.map((s) => s.key).join(',')}`)
  .join(' · ');

const effectParamsHelp = Object.entries(EFFECT_PARAMS)
  .map(([kind, specs]) => `${kind}: ${specs.map((s) => s.key).join(',') || '(sin parámetros)'}`)
  .join(' · ');

const EFFECT_KINDS = Object.keys(EFFECT_PARAMS).filter((k) => k !== 'plugin');
const INSTRUMENT_KINDS = Object.keys(INSTRUMENT_PARAMS);

// ── Sub-esquemas reutilizados ────────────────────────────────────────────────

const noteInputSchema = {
  type: 'object',
  properties: {
    start: { type: 'number', minimum: 0, description: 'Inicio en beats, relativo al patrón.' },
    duration: { type: 'number', exclusiveMinimum: 0, description: 'Duración en beats.' },
    key: {
      type: 'integer',
      minimum: 0,
      maximum: 127,
      description: 'Altura MIDI (convención FL: C5 = 60). Alternativa a `note`.',
    },
    note: {
      type: 'string',
      description: 'Nombre de nota estilo FL: "F2", "A#4", "Bb3". Alternativa a `key`.',
    },
    velocity: { type: 'number', minimum: 0, maximum: 1, description: 'Velocity 0..1 (por defecto 0.9).' },
    pan: { type: 'number', minimum: -1, maximum: 1, description: 'Pan -1..1 (por defecto 0).' },
    slide: {
      type: 'boolean',
      description: 'Nota slide: la voz activa hace glide hasta esta altura (típico en 808).',
    },
  },
  required: ['start', 'duration'],
} as const;

const paramsObjectSchema = (help: string) =>
  ({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: `Parámetros por clave (valores reales, se ajustan al rango válido). ${help}`,
  }) as const;

// ── Tools v0.1 ───────────────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: 'get_project',
    description:
      'Devuelve el estado del proyecto de Orbit Studio. Con detail="summary" (por defecto) da un ' +
      'resumen legible: tempo, compás, swing, canales (instrumento, pista de mixer, ids), patrones ' +
      '(nº de notas por canal, ids), pistas de playlist con sus clips, y mixer con efectos. Con ' +
      'detail="full" devuelve el JSON completo del proyecto. Llama a esta tool primero para conocer ' +
      'los ids con los que trabajar.',
    inputSchema: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'Nivel de detalle (por defecto "summary").',
        },
      },
    },
  },
  {
    name: 'get_notes',
    description:
      'Lee las notas de un canal dentro de un patrón (piano roll). Devuelve cada nota con nombre ' +
      '("F2"), inicio y duración en beats, velocity, pan y si es slide. patternId y channelId ' +
      'aceptan id o nombre exacto.',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string', description: 'Id o nombre del patrón.' },
        channelId: { type: 'string', description: 'Id o nombre del canal.' },
      },
      required: ['patternId', 'channelId'],
    },
  },
  {
    name: 'set_notes',
    description:
      'Escribe notas en el piano roll de un canal dentro de un patrón. Cada nota lleva start y ' +
      'duration en beats y la altura como `key` (MIDI, C5=60) o `note` ("F2"). Con replace=true ' +
      'sustituye TODAS las notas previas de ese canal en el patrón; si no, añade. Para 808 con ' +
      'glide usa slide=true en la nota destino. Todo queda como UN solo paso de undo.',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string', description: 'Id o nombre del patrón.' },
        channelId: { type: 'string', description: 'Id o nombre del canal.' },
        notes: {
          type: 'array',
          items: noteInputSchema,
          description: 'Notas a escribir.',
        },
        replace: {
          type: 'boolean',
          description: 'true = reemplaza las notas existentes del canal en ese patrón (por defecto false).',
        },
      },
      required: ['patternId', 'channelId', 'notes'],
    },
  },
  {
    name: 'add_channel',
    description:
      'Crea un canal (instrumento) en el channel rack. kinds: sub808 (bajo 808 con glide y drive), ' +
      'synth (sustractivo), supersaw (pads/leads anchos), fm (bells/keys FM), drums (kit por drum map: ' +
      'kick=36 rim=37 snare=38 clap=39 hat=42 openhat=46 tom=45 conga=48 crash=49 shaker=70), sampler. ' +
      `Parámetros opcionales por kind — ${instrumentParamsHelp}. Devuelve el id del canal creado.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: INSTRUMENT_KINDS, description: 'Tipo de instrumento.' },
        name: { type: 'string', description: 'Nombre visible (por defecto el del instrumento).' },
        mixerTrack: {
          type: 'integer',
          minimum: 0,
          description: 'Pista de mixer destino (0 = Master, 1..N = inserts). Por defecto 0.',
        },
        params: paramsObjectSchema(''),
      },
      required: ['kind'],
    },
  },
  {
    name: 'set_channel',
    description:
      'Ajusta un canal existente: nombre, volumen (lineal 0..2 con `volume` o en dB con `volumeDb`), ' +
      'pan, mute, solo, pista de mixer y parámetros del instrumento (merge, no reemplaza los demás). ' +
      'Un solo paso de undo.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Id o nombre del canal.' },
        patch: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            volume: { type: 'number', minimum: 0, maximum: 2, description: 'Ganancia lineal 0..2 (1 = 0 dB).' },
            volumeDb: { type: 'number', description: 'Ganancia en dB (alternativa a volume).' },
            pan: { type: 'number', minimum: -1, maximum: 1 },
            mute: { type: 'boolean' },
            solo: { type: 'boolean' },
            mixerTrack: { type: 'integer', minimum: 0 },
            params: paramsObjectSchema(instrumentParamsHelp),
          },
        },
      },
      required: ['channelId', 'patch'],
    },
  },
  {
    name: 'set_keymap',
    description:
      'Multisample: reparte varias muestras YA REGISTRADAS en el proyecto por el teclado de un ' +
      'canal de sampler, cada una sonando a su nota real en vez de estirar una sola. Las muestras ' +
      'se dan por id o por nombre (`samples`), y la nota de cada una se lee de su nombre de ' +
      'archivo (`Piano_C3.wav`); con `roots` se dan a mano, en el mismo orden. Los rangos de tecla ' +
      'se reparten solos entre las raíces. Con `velocityLayers` las muestras que caigan en la ' +
      'misma nota se reparten la velocidad (capas suave/fuerte) en vez de sonar a la vez. ' +
      '`samples` vacío quita el keymap y el canal vuelve a su único sample. Un paso de undo.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Id o nombre del canal (tiene que ser sampler).' },
        samples: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids o nombres de samples del proyecto. Vacío = quitar el keymap.',
        },
        roots: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 127 },
          description:
            'Nota raíz de cada muestra (MIDI, C5=60), en el mismo orden que `samples`. Sin esto se ' +
            'lee del nombre del archivo.',
        },
        octaveOffset: {
          type: 'integer',
          minimum: -4,
          maximum: 4,
          description: 'Octavas que se le suman a lo leído del nombre (otra convención de octava).',
        },
        velocityLayers: {
          type: 'boolean',
          description: 'Repartir la velocidad entre las muestras que compartan nota. Por defecto sí.',
        },
      },
      required: ['channelId', 'samples'],
    },
  },
  {
    name: 'set_steps',

    description:
      'Programa el step sequencer de un canal en un patrón: un string donde cada carácter es un paso ' +
      'de 1/16 (0.25 beats). "x" o "X" = golpe (velocity 0.9), dígito 1-9 = golpe con velocity n/9, ' +
      '"-" o "." = silencio. Ej: "x---x---x---x---" = 4 golpes a negra. `key` elige la pieza/altura ' +
      '(por defecto 36 = kick del drum map). Reemplaza los pasos previos de ESA altura en ese canal.',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string', description: 'Id o nombre del patrón.' },
        channelId: { type: 'string', description: 'Id o nombre del canal.' },
        steps: {
          type: 'string',
          description: 'Patrón de pasos, típicamente 16 chars (= 4 beats).',
        },
        key: {
          type: 'integer',
          minimum: 0,
          maximum: 127,
          description: 'Altura MIDI de los golpes (por defecto 36 = kick).',
        },
      },
      required: ['patternId', 'channelId', 'steps'],
    },
  },
  {
    name: 'add_pattern',
    description:
      'Crea un patrón nuevo. length en beats (por defecto 4 = 1 compás de 4/4). Devuelve su id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre (por defecto "Patrón N").' },
        length: { type: 'number', exclusiveMinimum: 0, description: 'Longitud en beats (por defecto 4).' },
      },
    },
  },
  {
    name: 'arrange_clip',
    description:
      'Gestiona clips de patrón en la playlist (modo song). action="add": coloca un patrón en una ' +
      'pista (trackIndex 0..N-1 del arrangement activo) en startBeat, con lengthBeats opcional (por ' +
      'defecto la longitud del patrón). action="move": cambia startBeat/trackIndex/lengthBeats de un ' +
      'clip existente (clipId). action="remove": borra el clip (clipId). Devuelve el id del clip.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'move', 'remove'] },
        clipId: { type: 'string', description: 'Id del clip (para move/remove).' },
        patternId: { type: 'string', description: 'Id o nombre del patrón (para add).' },
        trackIndex: { type: 'integer', minimum: 0, description: 'Índice de pista de playlist (0 arriba).' },
        startBeat: { type: 'number', minimum: 0, description: 'Inicio en beats absolutos de la canción.' },
        lengthBeats: { type: 'number', exclusiveMinimum: 0, description: 'Longitud en beats.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_tempo',
    description: 'Cambia el tempo del proyecto en BPM (20..999).',
    inputSchema: {
      type: 'object',
      properties: {
        bpm: { type: 'number', minimum: 20, maximum: 999, description: 'Tempo en BPM.' },
      },
      required: ['bpm'],
    },
  },
  {
    name: 'set_swing',
    description:
      'Ajusta el swing global 0..1 (desplaza los 1/16 impares, estilo FL). 0 = recto, ~0.5 = swing marcado.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', minimum: 0, maximum: 1, description: 'Cantidad de swing 0..1.' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'set_mixer',
    description:
      'Ajusta una pista del mixer (0 = Master, 1..N = inserts): volumen (lineal `volume` 0..2 o ' +
      '`volumeDb` en dB), pan, mute, solo, nombre y `routeTo` (índice de la pista destino, null = ' +
      'desconectar; el master no se re-rutea).',
    inputSchema: {
      type: 'object',
      properties: {
        trackIndex: { type: 'integer', minimum: 0, description: 'Índice de pista de mixer.' },
        patch: {
          type: 'object',
          properties: {
            volume: { type: 'number', minimum: 0, maximum: 2, description: 'Ganancia lineal 0..2 (1 = 0 dB).' },
            volumeDb: { type: 'number', description: 'Ganancia en dB (alternativa a volume).' },
            pan: { type: 'number', minimum: -1, maximum: 1 },
            mute: { type: 'boolean' },
            solo: { type: 'boolean' },
            name: { type: 'string' },
            routeTo: {
              type: ['integer', 'null'],
              description: 'Pista destino del routing (null = ninguna).',
            },
          },
        },
      },
      required: ['trackIndex', 'patch'],
    },
  },
  {
    name: 'add_effect',
    description:
      'Inserta un efecto en un slot del mixer (slotIndex 0..9). kinds: ' +
      `${EFFECT_KINDS.join(', ')}. Parámetros por kind — ${effectParamsHelp}. ` +
      'mix = dry/wet 0..1. sidechainSource (solo compressor) = índice de la pista que alimenta el detector.',
    inputSchema: {
      type: 'object',
      properties: {
        trackIndex: { type: 'integer', minimum: 0, description: 'Pista de mixer.' },
        slotIndex: { type: 'integer', minimum: 0, maximum: 9, description: 'Slot 0..9.' },
        kind: { type: 'string', enum: EFFECT_KINDS, description: 'Tipo de efecto.' },
        params: paramsObjectSchema(''),
        mix: { type: 'number', minimum: 0, maximum: 1, description: 'Dry/wet del slot (por defecto 1).' },
        sidechainSource: {
          type: 'integer',
          minimum: 0,
          description: 'Pista de mixer que alimenta el detector (compresor sidechain).',
        },
      },
      required: ['trackIndex', 'slotIndex', 'kind'],
    },
  },
  {
    name: 'set_effect',
    description:
      'Ajusta un efecto ya insertado: parámetros (merge), enabled y mix. Un solo paso de undo. ' +
      `Parámetros por kind — ${effectParamsHelp}.`,
    inputSchema: {
      type: 'object',
      properties: {
        trackIndex: { type: 'integer', minimum: 0 },
        slotIndex: { type: 'integer', minimum: 0, maximum: 9 },
        params: paramsObjectSchema(''),
        enabled: { type: 'boolean' },
        mix: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['trackIndex', 'slotIndex'],
    },
  },
  {
    name: 'remove_effect',
    description: 'Quita el efecto de un slot del mixer.',
    inputSchema: {
      type: 'object',
      properties: {
        trackIndex: { type: 'integer', minimum: 0 },
        slotIndex: { type: 'integer', minimum: 0, maximum: 9 },
      },
      required: ['trackIndex', 'slotIndex'],
    },
  },
  {
    name: 'set_automation',
    description:
      'Crea un clip de automatización en una pista de la playlist. `targetJson` es un ParamRef de ' +
      'core (objeto o string JSON): {"kind":"mixer","trackIndex":N,"param":"volume"|"pan"|"stereoWidth"} · ' +
      '{"kind":"channel","channelId":id,"param":clave} · {"kind":"channelMix","channelId":id,"param":"volume"|"pan"} · ' +
      '{"kind":"effect","trackIndex":N,"slotIndex":M,"param":clave} · {"kind":"transport","param":"tempo"}. ' +
      'Para ajustar el swing global usa set_swing; no admite curvas de automatización. ' +
      'points: time en beats relativos al clip, value normalizado 0..1 (se desnormaliza al rango real ' +
      'del parámetro), tension -1..1 (curvatura hacia el siguiente punto; 0 = lineal).',
    inputSchema: {
      type: 'object',
      properties: {
        trackIndex: { type: 'integer', minimum: 0, description: 'Índice de pista de playlist.' },
        targetJson: {
          anyOf: [{ type: 'string' }, { type: 'object' }],
          description: 'ParamRef destino, como objeto o string JSON. Transporte: solo tempo; para swing global usa set_swing.',
        },
        startBeat: { type: 'number', minimum: 0, description: 'Inicio del clip en beats absolutos.' },
        lengthBeats: { type: 'number', exclusiveMinimum: 0, description: 'Longitud del clip en beats.' },
        points: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              time: { type: 'number', minimum: 0, description: 'Beats relativos al inicio del clip.' },
              value: { type: 'number', minimum: 0, maximum: 1, description: 'Valor normalizado 0..1.' },
              tension: { type: 'number', minimum: -1, maximum: 1, description: 'Curvatura (0 = lineal).' },
            },
            required: ['time', 'value'],
          },
        },
      },
      required: ['trackIndex', 'targetJson', 'startBeat', 'lengthBeats', 'points'],
    },
  },
  {
    name: 'render',
    description:
      'Renderiza el proyecto offline (motor real, determinista) y guarda un WAV 16-bit 44.1 kHz. ' +
      'mode="song" (por defecto, usa la playlist) o mode="pattern" (un patrón suelto, patternId ' +
      'opcional: por defecto el primero). `path` opcional: nombre o ruta sugerida del archivo. ' +
      'Devuelve la ruta final, duración, peak y LUFS integrado.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['song', 'pattern'], description: 'Qué renderizar (por defecto "song").' },
        patternId: { type: 'string', description: 'Id o nombre del patrón (solo mode="pattern").' },
        path: { type: 'string', description: 'Nombre o ruta sugerida para el WAV.' },
      },
    },
  },
  {
    name: 'analyze_mix',
    description:
      'Renderiza el proyecto en memoria y devuelve medidas reales de la mezcla: LUFS integrado ' +
      '(objetivo streaming: -14), peak dBFS, balance espectral por bandas (low <120 Hz, low-mid ' +
      '120-900, high-mid 900-6k, high >6k; en dB relativos al total) y correlación estéreo (-1..1; ' +
      '≈1 mono, <0 problemas de fase). Si la playlist está vacía analiza el primer patrón con notas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'advise_mix',
    description:
      'Analiza la mezcla (mismo render y medidas que analyze_mix) y devuelve un DIAGNÓSTICO ' +
      'ACCIONABLE más una cadena de efectos concreta con valores reales. Dice qué banda sobra o ' +
      'falta (por la diferencia entre bandas, no por su valor absoluto), si hay problema de fase, y ' +
      'si el master pega o se queda corto para los -14 LUFS de streaming. Criterio de género: trap, ' +
      'boombap, reggaeton o generico (por defecto se deduce del tempo). Detecta sola la pista de voz, ' +
      'la del 808/sub y la del beat por su nombre; se pueden forzar con voiceTrack/lowTrack/beatTrack. ' +
      'Con apply=true aplica la cadena por el bus de comandos en UN solo paso de undo (inserta los ' +
      'efectos en slots libres, reajusta los que ya estén y mueve los faders propuestos); sin apply ' +
      'solo aconseja. La voz se trata para que mande por encima del beat y el grave se deja mono ' +
      'por debajo de 110 Hz.',
    inputSchema: {
      type: 'object',
      properties: {
        apply: {
          type: 'boolean',
          description: 'true = aplica la cadena propuesta (un paso de undo). Por defecto false.',
        },
        genre: {
          type: 'string',
          enum: ['trap', 'boombap', 'reggaeton', 'generico', 'auto'],
          description: 'Criterio de balance. "auto" (por defecto) lo deduce del tempo.',
        },
        targetLufs: {
          type: 'number',
          minimum: -30,
          maximum: -6,
          description: 'LUFS objetivo (por defecto -14, streaming).',
        },
        voiceTrack: {
          type: 'integer',
          minimum: 1,
          description: 'Pista de mixer de la voz (si no, se busca por nombre).',
        },
        beatTrack: {
          type: 'integer',
          minimum: 1,
          description: 'Pista del beat/instrumental (para el sidechain de la voz).',
        },
        lowTrack: {
          type: 'integer',
          minimum: 1,
          description: 'Pista del 808/sub (si no, se busca por nombre).',
        },
      },
    },
  },
  {
    name: 'list_library',
    description:
      'Lista los sonidos de la librería del browser: el pack de fábrica y los packs generados ' +
      '(sección "Packs generados"). Sin filtros los devuelve todos agrupados por pack. `busca` ' +
      'filtra por nombre, tags, categoría o pack (subcadena, sin acentos ni mayúsculas); `pack` ' +
      'se queda con uno solo; `categoria` con una categoría. Devuelve nombre, categoría, ' +
      'duración y, cuando aplica, BPM y nota raíz — que es lo que hace falta para decidir si un ' +
      'loop encaja con el tempo del proyecto. Los nombres que devuelve son los que acepta ' +
      '`load_sample`.',
    inputSchema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Texto en nombre, tags, categoría o pack.' },
        pack: { type: 'string', description: 'Nombre o slug de un pack concreto.' },
        categoria: { type: 'string', description: 'Categoría del browser (drums, 808s, fx, melodic-loops…).' },
        limite: { type: 'integer', minimum: 1, description: 'Cuántos como mucho (por defecto 120).' },
      },
    },
  },
  {
    name: 'load_sample',
    description:
      'Mete sonidos de la librería en el proyecto como canales sampler, igual que arrastrarlos al ' +
      'channel rack: un canal por sonido, en UN solo paso de undo, con su multisample montado si ' +
      'lo trae. `sonidos` son nombres (exactos, o el único que coincida) o ids de `list_library`. ' +
      'Con `mixerTrack` los canales salen ya enrutados a esa pista. Devuelve el nombre y el id de ' +
      'cada canal creado, listos para `set_notes` y `set_steps`.',
    inputSchema: {
      type: 'object',
      properties: {
        sonidos: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'Nombres o ids de sonidos de la librería.',
        },
        mixerTrack: {
          type: 'integer',
          minimum: 0,
          description: 'Pista de mixer a la que van todos los canales creados.',
        },
      },
      required: ['sonidos'],
    },
  },
  {
    name: 'generate_pack',
    description:
      'Genera un pack de sonidos NUEVO por síntesis ("12 hats de drill") con el MISMO motor que ' +
      'suena en vivo y lo deja en la librería de la app (sección "Packs generados"), listo para ' +
      'arrastrar al rack o a la playlist. `family` manda (kicks, snares, claps, hats, openhats, ' +
      'percs, 808s, impacts, risers, downlifters), hay loops (melodic-loops, drum-loops, ' +
      'bass-loops) y está `beats`, que son TEMAS ENTEROS con estructura (intro, subida, drop, ' +
      'vuelta y cierre encadenados, con batería, 808 y melodía sonando a la vez). `style` le da el ' +
      'carácter (trap, drill, boombap, latin, house, techno, lofi; por defecto trap). `count` 1..' +
      String(MAX_PACK_SOUNDS) +
      ' (por defecto 8): las variaciones recorren TODO el rango de la familia, de lo más oscuro a ' +
      'lo más brillante. OJO: `beats` tiene su propio tope de ' + String(MAX_STRUCTURED_BEATS) +
      ' (por defecto 2), porque cada uno dura entre medio minuto y minuto y medio. `key` es la ' +
      'nota raíz de los 808s ("C", "F", "A#"). `seed` cambia las variaciones sin cambiar nada más ' +
      '(mismo encargo + misma semilla = mismo pack, siempre). Con `addChannels` true, además mete ' +
      'cada sonido en un canal sampler del proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        family: {
          type: 'string',
          enum: [...PACK_FAMILIES],
          description: 'Qué familia de sonidos.',
        },
        style: {
          type: 'string',
          enum: [...PACK_STYLES],
          description: 'Carácter del pack (por defecto "trap").',
        },
        count: {
          type: 'number',
          minimum: 1,
          maximum: MAX_PACK_SOUNDS,
          description: 'Cuántos sonidos (por defecto 8).',
        },
        name: { type: 'string', description: 'Nombre del pack (por defecto, familia + estilo).' },
        key: { type: 'string', description: 'Nota raíz de los 808s ("C", "D#", "F"...).' },
        seed: { type: 'number', description: 'Semilla de las variaciones.' },
        addChannels: {
          type: 'boolean',
          description: 'Además de generarlo, mete cada sonido en un canal sampler.',
        },
      },
      required: ['family'],
    },
  },
  // ── Compositor de beats ─────────────────────────────────────────────────────
  {
    name: 'list_genres',
    description:
      'Lista los géneros del compositor (tempos, escalas, carácter), las partes que sabe generar, ' +
      'las escalas válidas, las formas de tema y los perfiles de estilo guardados. Llámala antes ' +
      'de compose_beat si no sabes qué pedir.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'compose_beat',
    description:
      'Compone un beat ENTERO con el compositor local de Orbit y lo monta en el proyecto con CADA ' +
      'PARTE POR SEPARADO: bombo, caja, hats, percusión, bajo/808, acordes, melodía y FX, cada uno ' +
      'en su canal (con su sonido e insertos), su pista de mixer, sus patrones (uno por tipo de ' +
      'sección) y su pista de playlist; más las secciones del arreglo y la cadena del master. Todo ' +
      'en UN paso de undo, detrás de lo que ya haya en la playlist. Es determinista: misma semilla ' +
      '+ mismos argumentos = mismo beat. Todo lo que no pases lo decide el género (o el perfil). ' +
      'Úsala para encargos concretos: "neo perreo en F# frigio a 98 con solo batería y bajo" es ' +
      'genre=neoperreo, key="F#", scale="Frigio", bpm=98, parts=["kick","snare","hats","perc","bass"]. ' +
      'Con dryRun describe el plan sin tocar el proyecto. Después, recompose_part cambia una parte.',
    inputSchema: {
      type: 'object',
      properties: {
        genre: { type: 'string', enum: [...COMPOSER_GENRES], description: 'Género (ver list_genres).' },
        variant: {
          type: 'string',
          maxLength: 40,
          description: 'Variante del género (ver list_genres): p. ej. trap "duro" o "crudo", reggaeton "moderno", neoperreo "oscuro". Sin ella, la de siempre.',
        },
        seed: { type: 'number', minimum: 0, description: 'Semilla (por defecto, al azar; se devuelve para repetir).' },
        bpm: { type: 'number', minimum: 40, maximum: 250, description: 'Tempo fijo.' },
        key: { type: 'string', description: 'Tónica: "C", "F#", "Bb"…' },
        scale: { type: 'string', description: `Escala: ${Object.keys(SCALES).join(', ')} (o "major"/"minor").` },
        shape: {
          description: '"song" (forma completa del género, por defecto), "loop" (un bucle) o 0..5: 0-2 de club (intro/subida/drop), 3-5 de canción de rap (versos de 16, hooks de 8; la 5 es larga, con breakdown).',
          oneOf: [{ type: 'string', enum: ['song', 'loop'] }, { type: 'integer', minimum: 0, maximum: 5 }],
        },
        loopBars: { type: 'integer', minimum: 1, maximum: 32, description: 'Compases del bucle (shape="loop"; por defecto 8).' },
        parts: {
          type: 'array',
          items: { type: 'string', enum: [...COMPOSER_ROLES] },
          description: 'Qué partes generar (por defecto todas).',
        },
        progression: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          maxItems: 16,
          description: 'Grados de la escala por compás (0 = tónica). P. ej. [0,5,3,4].',
        },
        profile: { type: 'string', description: 'Perfil de estilo (id o nombre) que empuja tempo, tonalidad, groove y sonido.' },
        influence: { type: 'number', minimum: 0, maximum: 1, description: 'Cuánto manda el perfil sobre el género (0.5).' },
        complexity: { type: 'number', minimum: 0, maximum: 1, description: 'Densidad de notas (0.5).' },
        soundVariation: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Cuánto se alejan los sonidos de sus presets: 0 = el preset tal cual, 1 = sonido nuevo (0.35).',
        },
        startBar: { type: 'number', minimum: 0, description: 'Compás de arranque (por defecto, al final de lo existente).' },
        setTempo: { type: 'boolean', description: 'Cambiar tempo y swing del proyecto a los del beat (por defecto true).' },
        dryRun: { type: 'boolean', description: 'Solo describir el plan, sin aplicarlo.' },
      },
      required: ['genre'],
    },
  },
  {
    name: 'recompose_part',
    description:
      'Vuelve a componer UNA parte del último beat de compose_beat (misma tonalidad, tempo, ' +
      'progresión y forma), sustituyendo sus notas en su sitio. Con newSound también le da otro ' +
      'sonido. Un paso de undo. Ejemplo: "otra melodía" = part="melody".',
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'string', enum: [...COMPOSER_ROLES], description: 'Parte a recomponer.' },
        seed: { type: 'number', minimum: 0, description: 'Semilla nueva (por defecto, al azar).' },
        complexity: { type: 'number', minimum: 0, maximum: 1 },
        soundVariation: { type: 'number', minimum: 0, maximum: 1 },
        newSound: { type: 'boolean', description: 'Cambiar también el sonido (por defecto false).' },
      },
      required: ['part'],
    },
  },
  {
    name: 'list_style_profiles',
    description:
      'Perfiles de estilo guardados (lo que el compositor aprendió de los beats del usuario): por ' +
      'pista, tempo, tonalidad, swing, brillo, suciedad y a qué género suena.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'learn_style',
    description:
      'Entrena un perfil de estilo midiendo audios (samples del proyecto o sonidos de la librería, ' +
      'por id o nombre): tempo, tonalidad, groove por semicorchea en grave/medio/agudo, swing, ' +
      `brillo y suciedad. No guarda audio ni notas. De 1 a ${MAX_LEARN} audios; con \`profile\` ` +
      'amplía uno existente. Después: compose_beat profile="<nombre>".',
    inputSchema: {
      type: 'object',
      properties: {
        samples: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_LEARN },
        name: { type: 'string', description: 'Nombre del perfil nuevo (por defecto "Mi estilo").' },
        profile: { type: 'string', description: 'Perfil existente a ampliar (id o nombre).' },
      },
      required: ['samples'],
    },
  },
  {
    name: 'analyze_reference',
    description:
      'Mide una pista de referencia (sample del proyecto o de la librería) y cuenta su tempo, ' +
      'tonalidad, groove, swing, brillo y a qué género suena. No cambia nada.',
    inputSchema: {
      type: 'object',
      properties: { sample: { type: 'string', description: 'Id o nombre del sample.' } },
      required: ['sample'],
    },
  },
  {
    name: 'compose_from_reference',
    description:
      'Saca un beat NUEVO con la temática de una pista de referencia: la mide, elige el género que ' +
      'mejor le va (o el que pases) y compone con su tempo, tonalidad, groove y carácter de sonido ' +
      '(influencia 0.7 por defecto), sin copiar sus notas. Acepta los mismos ajustes que ' +
      'compose_beat. Monta el beat igual: partes separadas, un paso de undo.',
    inputSchema: {
      type: 'object',
      properties: {
        sample: { type: 'string', description: 'Id o nombre del sample de referencia.' },
        genre: { type: 'string', enum: [...COMPOSER_GENRES] },
        variant: { type: 'string', maxLength: 40, description: 'Variante del género (ver list_genres).' },
        seed: { type: 'number', minimum: 0 },
        bpm: { type: 'number', minimum: 40, maximum: 250 },
        key: { type: 'string' },
        scale: { type: 'string' },
        shape: { oneOf: [{ type: 'string', enum: ['song', 'loop'] }, { type: 'integer', minimum: 0, maximum: 5 }] },
        loopBars: { type: 'integer', minimum: 1, maximum: 32 },
        parts: { type: 'array', items: { type: 'string', enum: [...COMPOSER_ROLES] } },
        influence: { type: 'number', minimum: 0, maximum: 1 },
        complexity: { type: 'number', minimum: 0, maximum: 1 },
        soundVariation: { type: 'number', minimum: 0, maximum: 1 },
        startBar: { type: 'number', minimum: 0 },
        dryRun: { type: 'boolean' },
      },
      required: ['sample'],
    },
  },
  // ── Edición de notas, borrado y arreglo ─────────────────────────────────────
  {
    name: 'riff',
    description:
      'Genera un riff/melodía en la escala dentro de un patrón y canal (la "riff machine" del piano ' +
      'roll, Alt+G), determinista por semilla. Por defecto sustituye lo que había en ese canal.',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string' },
        channelId: { type: 'string' },
        key: { type: 'string', description: 'Tónica ("A", "F#"…; por defecto C).' },
        scale: { type: 'string', description: 'Escala (por defecto "Menor natural").' },
        bars: { type: 'integer', minimum: 1, maximum: 64 },
        density: { type: 'number', minimum: 1, maximum: 32, description: 'Notas por compás (4).' },
        octave: { type: 'integer', minimum: 0, maximum: 9, description: 'Octava baja estilo FL (C5 = 60; por defecto 5).' },
        octaves: { type: 'integer', minimum: 1, maximum: 3 },
        character: { type: 'string', enum: ['sostenido', 'sincopado', 'puntillo'] },
        seed: { type: 'number', minimum: 0 },
        replace: { type: 'boolean', description: 'Sustituir las notas existentes (por defecto true).' },
      },
      required: ['patternId', 'channelId'],
    },
  },
  {
    name: 'transform_notes',
    description:
      'Transforma las notas de un canal en un patrón, en un paso de undo. op: humanize (amount = ' +
      'timing en beats, velocity), strum (amount = beats, direction up/down), arpeggiate (grid, mode, ' +
      'octaves), chop (grid), chordify (intervals en semitonos, o scale+key para acordes en escala), ' +
      'transpose (amount = semitonos), quantize (grid, amount = fuerza 0..1), velocity (amount = factor).',
    inputSchema: {
      type: 'object',
      properties: {
        patternId: { type: 'string' },
        channelId: { type: 'string' },
        op: { type: 'string', enum: ['humanize', 'strum', 'arpeggiate', 'chop', 'chordify', 'transpose', 'quantize', 'velocity'] },
        amount: { type: 'number' },
        velocity: { type: 'number', minimum: 0, maximum: 1 },
        grid: { type: 'number', minimum: 0.03125, maximum: 4, description: 'En beats (0.25 = semicorchea).' },
        mode: { type: 'string', enum: ['up', 'down', 'updown', 'downup', 'alternate', 'random', 'chord'] },
        octaves: { type: 'integer', minimum: 1, maximum: 4 },
        direction: { type: 'string', enum: ['up', 'down'] },
        intervals: { type: 'array', items: { type: 'integer', minimum: -24, maximum: 24 }, maxItems: 8 },
        scale: { type: 'string' },
        key: { type: 'string' },
        seed: { type: 'number', minimum: 0 },
      },
      required: ['patternId', 'channelId', 'op'],
    },
  },
  {
    name: 'delete_channel',
    description: 'Borra un canal del rack con todas sus notas (undo lo devuelve entero).',
    inputSchema: { type: 'object', properties: { channelId: { type: 'string' } }, required: ['channelId'] },
  },
  {
    name: 'delete_pattern',
    description: 'Borra un patrón y sus clips de la playlist (undo lo devuelve). No borra el último.',
    inputSchema: { type: 'object', properties: { patternId: { type: 'string' } }, required: ['patternId'] },
  },
  {
    name: 'sections',
    description:
      'Secciones del arreglo (intro, drop…) del arrangement activo: action=list las enumera, add ' +
      'añade una (name, startBar, bars, kind), remove quita una (sectionId o nombre; los clips se quedan).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'] },
        name: { type: 'string' },
        startBar: { type: 'number', minimum: 0 },
        bars: { type: 'number', exclusiveMinimum: 0 },
        kind: { type: 'string', enum: ['intro', 'build', 'drop', 'break', 'outro'] },
        sectionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'undo',
    description: 'Deshace el último cambio hecho por Claude (no toca los cambios del usuario).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'redo',
    description: 'Rehace el último cambio de Claude deshecho.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Búsqueda rápida por nombre. */
export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
