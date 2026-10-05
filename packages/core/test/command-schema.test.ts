/**
 * BUG 018 — el servidor aceptaba comandos desconocidos y payloads inválidos.
 *
 * El guardia solo exigía que `type` fuera una cadena y casteaba a `Command`. De
 * ahí: un tipo inexistente pasaba (`applyCommand` devolvía `undefined` y quien
 * espera un inverso se come un `undefined` sin saber de dónde) y un `batch` con
 * `commands: null` reventaba al reproducir con un TypeError que no nombraba el
 * campo. Todo eso entrando por el socket.
 *
 * Aquí se comprueba la FORMA en los dos sitios donde decide: el bus de core (que
 * también lo llama el renderer y el MCP) y el guardia del servidor.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  commandProblem,
  COMMAND_TYPES,
  createEmptyProject,
  isCommand,
  newId,
  type Command,
} from '../src/index';

/** Cuenta nodos como los cuenta el presupuesto, para poder comparar de verdad. */
function nodos(valor: unknown): number {
  let total = 0;
  const pila: unknown[] = [valor];
  while (pila.length > 0) {
    const actual = pila.pop();
    if (actual === null || typeof actual !== 'object') continue;
    total++;
    for (const item of Array.isArray(actual) ? actual : Object.values(actual)) pila.push(item);
  }
  return total;
}

describe('018 · un tipo de comando que no existe no es un comando', () => {
  it('tipo inexistente: se dice cuál, sin excepción', () => {
    expect(commandProblem({ type: 'doesNotExist' })).toMatch(/desconocido: "doesNotExist"/);
    expect(isCommand({ type: 'doesNotExist' })).toBe(false);
  });

  it('el enum de runtime tiene los 61 comandos y ninguno más', () => {
    // El número viene de la unión `Command`: si mañana se añade un tipo sin fila
    // en la tabla, el COMPILADOR falla, y esta cuenta avisa de que la tabla y la
    // unión siguen de acuerdo.
    expect(COMMAND_TYPES.size).toBe(61);
    expect(COMMAND_TYPES.has('batch')).toBe(true);
    expect(COMMAND_TYPES.has('doesNotExist')).toBe(false);
  });

  it('el bus lanza con el motivo en vez de devolver undefined', () => {
    const p = createEmptyProject();
    // Antes: `applyCommand` caía en el switch, no había caso y devolvía
    // `undefined` sin decir nada.
    expect(() => applyCommand(p, { type: 'doesNotExist' } as never)).toThrow(
      /Comando inválido: tipo de comando desconocido/,
    );
  });
});

describe('018 · un lote con la forma equivocada se rechaza entero', () => {
  it('commands null: el TypeError de "not iterable" ya no existe', () => {
    expect(commandProblem({ type: 'batch', commands: null })).toBe('"commands" no es null');
    expect(commandProblem({ type: 'batch', commands: null })).not.toMatch(/iterable/);
  });

  it('commands ausente, commands no-lista, y lista con un hijo inválido', () => {
    expect(commandProblem({ type: 'batch' })).toBe('"commands" está');
    expect(commandProblem({ type: 'batch', commands: 'setTempo' })).toMatch(/una lista/);
    expect(commandProblem({ type: 'batch', commands: [null] })).toMatch(/un objeto|una entidad/);
    expect(
      commandProblem({ type: 'batch', commands: [{ type: 'setTempo', tempo: 'pronto' }] }),
    ).toMatch(/tempo" un número/);
  });

  it('el problema del hijo dice DÓNDE está, para no buscar a ciegas', () => {
    expect(
      commandProblem({ type: 'batch', label: 'todo', commands: [{ type: 'nope' }] }),
    ).toBe('en "commands": tipo de comando desconocido: "nope"');
  });

  it('un lote dentro de un lote se valida en cascada', () => {
    const bien = { type: 'batch', commands: [{ type: 'setTempo', tempo: 100 }] };
    expect(commandProblem({ type: 'batch', commands: [bien] })).toBeNull();
    const malo = {
      type: 'batch',
      commands: [{ type: 'batch', commands: [{ type: 'removeChannel' }] }],
    };
    expect(commandProblem(malo)).toMatch(/channelId" está/);
  });

  it('un lote anidado más hondo de lo razonable SE RECHAZA (no se deja de mirar)', () => {
    let cmd: unknown = { type: 'setTempo', tempo: 100 };
    for (let i = 0; i < 40; i++) cmd = { type: 'batch', commands: [cmd] };
    expect(commandProblem(cmd)).toMatch(/anidado/);
  });
});

describe('018 · campos que faltan o vienen del tipo que no', () => {
  it('los obligatorios que faltan se nombran uno a uno', () => {
    expect(commandProblem({ type: 'setTempo' })).toBe('"tempo" está');
    expect(commandProblem({ type: 'patchChannel', channelId: 'c1' })).toBe('"patch" está');
    expect(commandProblem({ type: 'removeClips' })).toBe('"clipIds" está');
  });

  it('tipos primitivos equivocados, con NaN y Infinity como no-números', () => {
    expect(commandProblem({ type: 'setTempo', tempo: Number.NaN })).toMatch(/un número/);
    expect(commandProblem({ type: 'setTempo', tempo: Infinity })).toMatch(/un número/);
    expect(commandProblem({ type: 'setMeta', patch: 'nada' })).toMatch(/un objeto|una entidad/);
    expect(commandProblem({ type: 'removeClips', clipIds: [1, 2] })).toMatch(
      /una lista de ids/,
    );
  });

  it('las entidades tienen que ser objetos, y su id una cadena', () => {
    expect(commandProblem({ type: 'addChannel', channel: 'x' })).toMatch(/una entidad/);
    expect(commandProblem({ type: 'addChannel', channel: { id: 7 } })).toMatch(
      /"channel"\.id un id \(cadena\)/,
    );
    // Un canal sin volumen no entra: el motor lo leería como NaN.
    // Un canal a medias no es un comando: la tabla es la del modelo (017 y 018
    // comparten tablas), y sin volumen el motor compilaría un NaN.
    expect(commandProblem({ type: 'addChannel', channel: { id: 'c1' } })).toMatch(
      /"channel"\.\w+ está/,
    );
    expect(commandProblem({ type: 'addChannel', channel: canalCompleto() })).toBeNull();
  });

  it('los mapas de listas (notesByPattern) se miran de verdad', () => {
    expect(
      commandProblem({ type: 'restoreChannel', channel: canalCompleto(), index: 0, notesByPattern: { p: [] } }),
    ).toBeNull();
    expect(
      commandProblem({
        type: 'restoreChannel',
        channel: canalCompleto(),
        index: 0,
        notesByPattern: { p: 'notas' },
      }),
    ).toMatch(/una lista/);
  });

  it('null donde el tipo lo admite y donde no', () => {
    // Vaciar un insert y borrar un envío son null por diseño.
    expect(commandProblem({ type: 'setEffect', trackIndex: 1, slotIndex: 0, slot: null })).toBeNull();
    expect(commandProblem({ type: 'setSend', trackIndex: 1, target: 2, level: null })).toBeNull();
    expect(commandProblem({ type: 'setRoute', trackIndex: 1, routeTo: null })).toBeNull();
    expect(commandProblem({ type: 'setLayout', name: 'x', windows: null })).toBeNull();
    // En cualquier otro sitio, null es un tipo equivocado.
    expect(commandProblem({ type: 'setTempo', tempo: null })).toBe('"tempo" no es null');
    expect(commandProblem({ type: 'setEffect', trackIndex: null, slotIndex: 0, slot: {} })).toMatch(
      /"trackIndex" no es null/,
    );
  });

  it('lo opcional se puede omitir; lo obligatorio no', () => {
    // Un canal sin volumen no entra: el motor lo leería como NaN.
    expect(commandProblem({ type: 'addChannel', channel: { id: 'c1' } })).toMatch(
      /"channel"\.\w+ está/,
    );
    expect(commandProblem({ type: 'addChannel', channel: canalCompleto() })).toBeNull();
    expect(commandProblem({ type: 'addChannel', channel: canalCompleto(), index: 2 })).toBeNull();
    expect(commandProblem({ type: 'batch', commands: [] })).toBeNull();
    expect(commandProblem({ type: 'batch', label: 'x', commands: [] })).toBeNull();
    // El inverso de setChannelParam solo trae dropKey cuando lo necesita, pero el
    // resto del comando sí está.
    expect(commandProblem({ type: 'setChannelParam', channelId: 'c', key: 'k', value: 1 })).toBeNull();
  });

  it('campos de sobra no se Penalizan (el log puede traer metadatos)', () => {
    expect(commandProblem({ type: 'setTempo', tempo: 120, label: 'movimiento', seq: 7 })).toBeNull();
  });
});

describe('018 · el presupuesto de nodos aguanta un lote musical de verdad', () => {
  // No vale decir "tres órdenes de magnitud de margen" sin medirlo: aquí se
  // cuentan los nodos de los lotes más PESADOS que genera la app y se compara con
  // el presupuesto, para que el número del umbral no sea una forexplotación.
  const nota = (i: number) => ({
    id: `n${i}`,
    start: (i % 64) * 0.25,
    duration: 0.25,
    key: 36 + (i % 48),
    velocity: 0.8,
    pan: 0,
    slide: false,
  });

  it('pegar 8 compases a 1/16 en un canal (512 notas) entra de sobra', () => {
    const notes = Array.from({ length: 512 }, (_, i) => nota(i));
    const cmd = { type: 'addNotes', patternId: 'p', channelId: 'c', notes };
    const cuenta = nodos(cmd);
    expect(commandProblem(cmd)).toBeNull();
    // MEDIDO: 512 notas son 514 nodos (una por nota, más el comando y su lista).
    // La nota es un nodo, no varios, que es lo que hace el presupuesto holgado.
    expect(cuenta).toBe(514);
  });

  it('un arrastre enorme: 400 clips en un lote de un solo paso de undo', () => {
    const clips = Array.from({ length: 400 }, (_, i) => ({
      id: `c${i}`,
      kind: 'pattern',
      playlistTrackId: 't1',
      start: i * 4,
      length: 4,
      muted: false,
      patternId: 'p1',
    }));
    const cmd = { type: 'batch', label: 'arrastre', commands: [{ type: 'addClips', clips }] };
    expect(commandProblem(cmd)).toBeNull();
    // MEDIDO: 402 nodos (uno por clip, más el lote, su lista y su comando).
    expect(nodos(cmd)).toBe(404);
  });

  it('deshacer un arrangement entero (pistas, clips y secciones)', () => {
    const tracks = Array.from({ length: 64 }, (_, i) => ({
      id: `t${i}`, arrangementId: 'a1', name: 'P', color: 'rojo', height: 1, muted: false, order: i,
    }));
    const clips = Array.from({ length: 500 }, (_, i) => ({
      id: `c${i}`, kind: 'pattern', playlistTrackId: 't0', start: i, length: 4, muted: false,
    }));
    const sections = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, arrangementId: 'a1', name: 'S', start: 0, length: 4 }));
    const cmd = {
      type: 'restoreArrangement',
      arrangement: { id: 'a1', name: 'A' },
      index: 0,
      tracks,
      clips,
      sections,
      activeWas: 'a1',
    };
    expect(commandProblem(cmd)).toBeNull();
    // MEDIDO: 609 nodos para 604 entidades (64 pistas + 500 clips + 40 secciones).
    expect(nodos(cmd)).toBe(609);
  });

  it('y por debajo del presupuesto hay un margen real, no nominal', () => {
    // 10 veces el lote musical más pesado sigue validando; el umbral (20k) está
    // donde está porque está, no porque alguien lo copiara de otro sitio.
    const notes = Array.from({ length: 512 * 10 }, (_, i) => nota(i));
    expect(commandProblem({ type: 'addNotes', patternId: 'p', channelId: 'c', notes })).toBeNull();
  });
});

describe('018 · cada tipo de comando con su comando mínimo', () => {
  it('ninguno revienta al aplicarse por leer un campo que no trae', () => {
    // El campo obligatorio de cada fila se rellena con lo mínimo plausible y se
    // aplica contra un proyecto vacío. Lo que se comprueba es que el bus no
    // reviente por LEER: si la tabla dijera mal un campo, aquí se vería.
    const p = createEmptyProject();
    const rotos: string[] = [];
    for (const [tipo, campos] of minimos()) {
      const cmd = { type: tipo, ...campos } as Command;
      try {
        applyCommand(p, cmd);
      } catch (error) {
        const motivo = (error as Error).message;
        // Que no exista la entidad sobre la que se opera es lo NORMAL en un
        // proyecto vacío; lo que no vale es leer un campo inexistente.
        if (!/No existe|fuera de rango|no es un volumen|ya existe|debe ser|inválido/.test(motivo)) {
          rotos.push(`${tipo}: ${motivo}`);
        }
      }
    }
    expect(rotos).toEqual([]);
  });
});

/** Comando mínimo por tipo: cada campo obligatorio con su valor más pequeño. */
function minimos(): [string, Record<string, unknown>][] {
  const id = () => newId();
  const ent = () => ({ id: id() });
  return [
    ['setTempo', { tempo: 120 }],
    ['setSwing', { swing: 0 }],
    ['setTimeSig', { timeSig: { num: 4, den: 4 } }],
    ['setMeta', { patch: { title: 't' } }],
    ['addChannel', { channel: canalCompleto(), index: 0 }],
    ['removeChannel', { channelId: id() }],
    ['restoreChannel', { channel: canalCompleto(), index: 0, notesByPattern: {} }],
    ['patchChannel', { channelId: id(), patch: {} }],
    ['setChannelParam', { channelId: id(), key: 'k', value: 0 }],
    ['moveChannel', { channelId: id(), toIndex: 0 }],
    ['addChannelGroup', { group: { id: 'g1', name: 'G', color: 'rojo', collapsed: false }, index: 0, members: [] }],
    ['removeChannelGroup', { groupId: id() }],
    ['patchChannelGroup', { groupId: id(), patch: {} }],
    ['setChannelEffect', { channelId: id(), slotIndex: 0, slot: slotCompleto() }],
    ['patchChannelEffect', { channelId: id(), slotIndex: 0, patch: {} }],
    ['setChannelEffectParam', { channelId: id(), slotIndex: 0, key: 'k', value: 0 }],
    ['addPattern', { pattern: patronCompleto(), index: 0 }],
    ['removePattern', { patternId: id() }],
    ['restorePattern', { pattern: patronCompleto(), index: 0, clips: [] }],
    ['patchPattern', { patternId: id(), patch: {} }],
    ['addNotes', { patternId: id(), channelId: id(), notes: [] }],
    ['removeNotes', { patternId: id(), channelId: id(), noteIds: [] }],
    ['patchNotes', { patternId: id(), channelId: id(), patches: [] }],
    ['addPlaylistTrack', { track: pistaCompleta() }],
    ['removePlaylistTrack', { trackId: id() }],
    ['restorePlaylistTrack', { track: pistaCompleta(), clips: [] }],
    ['patchPlaylistTrack', { trackId: id(), patch: {} }],
    ['addClips', { clips: [] }],
    ['removeClips', { clipIds: [] }],
    ['restoreClips', { clips: [] }],
    ['patchClips', { patches: [] }],
    ['addArrangement', { arrangement: { id: 'a1', name: 'A' } }],
    ['removeArrangement', { arrangementId: id() }],
    [
      'restoreArrangement',
      { arrangement: { id: 'a1', name: 'A' }, index: 0, tracks: [], clips: [], sections: [], activeWas: id() },
    ],
    ['patchArrangement', { arrangementId: id(), patch: {} }],
    ['setActiveArrangement', { arrangementId: id() }],
    ['setLayout', { name: 'l', windows: null }],
    ['addLfos', { lfos: [] }],
    ['removeLfos', { lfoIds: [] }],
    ['restoreLfos', { lfos: [] }],
    ['patchLfo', { lfoId: id(), patch: {} }],
    ['addSections', { sections: [] }],
    ['removeSections', { sectionIds: [] }],
    ['restoreSections', { sections: [] }],
    ['patchSections', { patches: [] }],
    ['addMarker', { marker: { id: 'm1', time: 0, name: 'M', color: 'rojo' } }],
    ['removeMarker', { markerId: id() }],
    ['patchMarker', { markerId: id(), patch: {} }],
    ['patchMixerTrack', { trackIndex: 1, patch: {} }],
    ['setEffect', { trackIndex: 1, slotIndex: 0, slot: null }],
    ['patchEffect', { trackIndex: 1, slotIndex: 0, patch: {} }],
    ['setEffectParam', { trackIndex: 1, slotIndex: 0, key: 'k', value: 0 }],
    ['setSend', { trackIndex: 1, target: 2, level: 0 }],
    ['patchSend', { trackIndex: 1, target: 2, patch: {} }],
    ['setRoute', { trackIndex: 1, routeTo: 0 }],
    ['addInputRoute', { route: rutaCompleta(), index: 0 }],
    ['removeInputRoute', { routeId: id() }],
    ['patchInputRoute', { routeId: id(), patch: {} }],
    ['registerSample', { sample: { id: 's1', name: 'a.wav', path: 'a', hash: 'h', duration: 1 } }],
    ['unregisterSample', { sampleId: id() }],
    ['batch', { commands: [] }],
  ];
}
/**
 * Un canal que cumple la tabla de `model/types.ts`: las tablas de entidades son
 * las mismas que usa `parseProject` (017), así que un comando con un canal a medio
 *填写 se rechaza igual que un `.orbit` a medio.
 */
function canalCompleto(): Record<string, unknown> {
  return {
    id: 'c1',
    name: 'Canal',
    color: 'rojo',
    kind: 'synth',
    params: {},
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    mixerTrack: 1,
  };
}

/** Patrón completo: `notes` es obligatorio y es un mapa de listas. */
function patronCompleto(): Record<string, unknown> {
  return { id: newId(), name: 'P', color: 'azul', length: 4, notes: {} };
}

/** Pista de playlist completa. */
function pistaCompleta(): Record<string, unknown> {
  return {
    id: newId(),
    arrangementId: 'a1',
    name: 'Pista',
    color: 'rojo',
    height: 1,
    muted: false,
    order: 0,
  };
}

/** Slot de efecto completo: `mix` y `params` son obligatorios. */
function slotCompleto(): Record<string, unknown> {
  return { id: 'fx1', kind: 'reverb', enabled: true, mix: 1, params: {} };
}

/** Ruta de entrada completa. */
function rutaCompleta(): Record<string, unknown> {
  return {
    id: 'r1',
    name: 'Micro',
    channel: 1,
    mixerTrack: 1,
    armed: false,
    monitor: false,
    gain: 1,
  };
}
