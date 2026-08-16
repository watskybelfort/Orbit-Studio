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

import { EFFECT_PARAMS, INSTRUMENT_PARAMS } from '@orbit/core';

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

const EFFECT_KINDS = Object.keys(EFFECT_PARAMS);
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
      '{"kind":"effect","trackIndex":N,"slotIndex":M,"param":clave} · {"kind":"transport","param":"tempo"|"swing"}. ' +
      'points: time en beats relativos al clip, value normalizado 0..1 (se desnormaliza al rango real ' +
      'del parámetro), tension -1..1 (curvatura hacia el siguiente punto; 0 = lineal).',
    inputSchema: {
      type: 'object',
      properties: {
        trackIndex: { type: 'integer', minimum: 0, description: 'Índice de pista de playlist.' },
        targetJson: {
          anyOf: [{ type: 'string' }, { type: 'object' }],
          description: 'ParamRef destino, como objeto o string JSON.',
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
