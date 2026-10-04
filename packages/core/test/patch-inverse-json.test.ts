/**
 * BUG 002 — el inverso de un patch que quita un campo opcional perdía la clave al
 * viajar por JSON, así que el undo compartido divergía.
 *
 * `JSON.stringify` borra toda clave que vale `undefined`. El caso es el de la
 * tarjeta: se PONE un campo opcional (`groupId`), y su inverso —que es "borra esta
 * clave"— se armaba con `pickOld`, que escribía `undefined`. Al otro lado del
 * socket llegaba `{ patch: {} }`: el que deshacía quitaba el campo y el resto de
 * clientes se lo quedaban. Con `groupId` eso es organización; con `sampleId` de un
 * canal o `sampleOffset` de un clip, es audio.
 *
 * Se recorre TODAS las familias de patch con campo opcional de `model/types.ts`
 * (no una muestra): poner el campo, deshacer en local y deshacer con el inverso
 * que ha pasado por JSON tienen que acabar igual, y el estado tiene que ser el de
 * antes de ponerlo, no "casi". La convergencia entre dos clientes de verdad está en
 * el test de socket del servidor.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createPlaylistTrack,
  serializeProject,
  UNSET,
  type Command,
  type Project,
} from '../src/index';

/** Ida y vuelta por el cable: lo que hace la sala con cada comando. */
function porJSON(cmd: Command): Command {
  return JSON.parse(JSON.stringify(cmd)) as Command;
}

/**
 * Proyecto con un canal: el vacío no trae ninguno, y casi todas las familias de
 * patch apuntan a un canal. El canal se añade por el BUS, no a mano, para que el
 * test no dependa de la forma exacta de createEmptyProject.
 */
function proyecto(): Project {
  const p = createEmptyProject();
  applyCommand(p, { type: 'addChannel', channel: createChannel('synth', 0) });
  return p;
}

function firstCanal(p: Project): string {
  return p.channelOrder[0] ?? Object.keys(p.channels)[0]!;
}

/**
 * Cada familia: `preparar` deja la entidad con el campo opcional AUSENTE, y
 * `poner` es el comando que lo pone. Lo que viaja por la sala es su inverso, y
 * como el campo no estaba, ese inverso tiene que llevar la marca de borrado.
 */
interface Caso {
  nombre: string;
  preparar(p: Project): void;
  poner(p: Project): Command;
}

const casos: Caso[] = [
  {
    nombre: 'patchChannel pone groupId',
    preparar: (p) => {
      applyCommand(p, {
        type: 'addChannelGroup',
        group: { id: 'g1', name: 'G', color: 'rojo', collapsed: false },
      });
    },
    poner: (p) => ({ type: 'patchChannel', channelId: firstCanal(p), patch: { groupId: 'g1' } }),
  },
  {
    nombre: 'patchChannel pone sampleId',
    preparar: (p) => {
      p.samples = { s1: { id: 's1', name: 'a.wav', path: 'a', hash: 'h', duration: 1 } };
      p.channels[firstCanal(p)]!.kind = 'sampler';
    },
    poner: (p) => ({ type: 'patchChannel', channelId: firstCanal(p), patch: { sampleId: 's1' } }),
  },
  {
    nombre: 'patchChannel pone bend',
    preparar: () => undefined,
    poner: (p) => ({ type: 'patchChannel', channelId: firstCanal(p), patch: { bend: 3 } }),
  },
  {
    nombre: 'patchChannelGroup pone busTrack',
    preparar: (p) => {
      applyCommand(p, {
        type: 'addChannelGroup',
        group: { id: 'g1', name: 'G', color: 'rojo', collapsed: false },
      });
    },
    poner: () => ({ type: 'patchChannelGroup', groupId: 'g1', patch: { busTrack: 3 } }),
  },
  {
    nombre: 'patchChannelGroup pone mute',
    preparar: (p) => {
      applyCommand(p, {
        type: 'addChannelGroup',
        group: { id: 'g1', name: 'G', color: 'rojo', collapsed: false },
      });
    },
    poner: () => ({ type: 'patchChannelGroup', groupId: 'g1', patch: { mute: true } }),
  },
  {
    nombre: 'patchChannelEffect pone sidechainSource',
    preparar: (p) => {
      p.channels[firstCanal(p)]!.fx = [
        { id: 'fx1', kind: 'compressor', enabled: true, mix: 1, params: {} },
      ];
    },
    poner: (p) => ({
      type: 'patchChannelEffect',
      channelId: firstCanal(p),
      slotIndex: 0,
      patch: { sidechainSource: 2 },
    }),
  },
  {
    nombre: 'patchEffect pone sidechainSource en un slot de mixer',
    preparar: (p) => {
      p.mixer[1]!.slots[0] = { id: 'fx1', kind: 'compressor', enabled: true, mix: 1, params: {} };
    },
    poner: () => ({
      type: 'patchEffect',
      trackIndex: 1,
      slotIndex: 0,
      patch: { sidechainSource: 2 },
    }),
  },
  {
    nombre: 'patchPlaylistTrack pone icon',
    preparar: () => undefined,
    poner: (p) => ({
      type: 'patchPlaylistTrack',
      trackId: Object.keys(p.playlistTracks)[0]!,
      patch: { icon: 'drums' },
    }),
  },
  {
    nombre: 'patchPlaylistTrack pone mixerTrack',
    preparar: () => undefined,
    poner: (p) => ({
      type: 'patchPlaylistTrack',
      trackId: Object.keys(p.playlistTracks)[0]!,
      patch: { mixerTrack: 4 },
    }),
  },
  {
    nombre: 'patchSend pone pan',
    preparar: (p) => {
      p.mixer[1]!.sends = [{ target: 2, level: 0.5 }];
    },
    poner: () => ({ type: 'patchSend', trackIndex: 1, target: 2, patch: { pan: -0.3 } }),
  },
  {
    nombre: 'patchInputRoute pone channelRight',
    preparar: (p) => {
      applyCommand(p, {
        type: 'addInputRoute',
        route: {
          id: 'r1', name: 'Micro', channel: 1, mixerTrack: 1,
          armed: false, monitor: false, gain: 1,
        },
      });
    },
    poner: () => ({ type: 'patchInputRoute', routeId: 'r1', patch: { channelRight: 2 } }),
  },
  {
    nombre: 'patchInputRoute pone playlistTrackId',
    preparar: (p) => {
      applyCommand(p, {
        type: 'addInputRoute',
        route: {
          id: 'r1', name: 'Micro', channel: 1, mixerTrack: 1,
          armed: false, monitor: false, gain: 1,
        },
      });
    },
    poner: (p) => ({
      type: 'patchInputRoute',
      routeId: 'r1',
      patch: { playlistTrackId: Object.keys(p.playlistTracks)[0]! },
    }),
  },
];

describe('002 · el inverso de un patch opcional viaja y deshace', () => {
  it.each(casos)('$nombre: undo directo y undo por JSON acaban igual', (caso) => {
    const p = proyecto();
    caso.preparar(p);
    const antes = serializeProject(p);

    // 1. Poner el campo opcional y deshacer en local: el inverso es el comando que
    //    dice "borra esta clave".
    const inverseDirecto = applyCommand(p, caso.poner(p));
    applyCommand(p, inverseDirecto);
    expect(serializeProject(p)).toBe(antes);

    // 2. Poner otra vez y deshacer con el inverso que ha pasado por el cable. El
    //    inverso es el MISMO comando en los dos casos: lo que se perdía al
    //    serializar es justo lo que se comprueba aquí.
    const inversePorCable = porJSON(applyCommand(p, caso.poner(p)));
    // El sobre de borrado viaja entero: es lo que se perdía al serializar.
    expect(JSON.stringify(inversePorCable)).toContain('"$orbitUnset":true');
    applyCommand(p, inversePorCable);
    expect(serializeProject(p)).toBe(antes);
  });

  it('la marca es explícita y aparece en el comando, no un undefined', () => {
    const p = proyecto();
    const inverse = applyCommand(p, {
      type: 'patchChannel',
      channelId: firstCanal(p),
      patch: { groupId: 'g1' },
    });
    // El comando lleva la clave CON valor: es lo que sobrevive al JSON.
    expect((inverse as { patch: Record<string, unknown> }).patch.groupId).toBe(UNSET);
    expect(JSON.stringify(inverse)).toContain('"$orbitUnset":true');
    // Y aplicarlo borra la clave de verdad, no la deja en undefined.
    applyCommand(p, inverse);
    expect('groupId' in p.channels[firstCanal(p)]!).toBe(false);
    expect(serializeProject(p)).not.toContain('groupId');
  });

  it('quitar un bus a una carpeta vuelve a NO tener bus (no a bus 0)', () => {
    // Antes el inverso reponía 0, que no era el estado real: lo que había antes de
    // darle un bus es que no había bus. La marca restaura exactamente eso.
    const p = proyecto();
    applyCommand(p, {
      type: 'addChannelGroup',
      group: { id: 'g1', name: 'G', color: 'rojo', collapsed: false },
    });
    const inverse = applyCommand(p, {
      type: 'patchChannelGroup',
      groupId: 'g1',
      patch: { busTrack: 3 },
    });
    expect('busTrack' in p.channelGroups.g1!).toBe(true);
    applyCommand(p, porJSON(inverse));
    expect('busTrack' in p.channelGroups.g1!).toBe(false);
  });

  it('notas y clips: el inverso repone el valor, sin marca de borrado', () => {
    // Note y Clip no tienen ningún campo opcional en `model/types.ts` (por eso la
    // sonda de `patchNotes.bend` queda como payload tolerado y no como feature):
    // aquí se comprueba la otra mitad del contrato — cuando el campo YA tenía
    // valor, el inverso lo repone y NO lleva la marca, porque borrar algo que
    // existía sería perder datos.
    const p = proyectoConNotaYClip();
    const antes = serializeProject(p);

    const inverseNota = applyCommand(p, {
      type: 'patchNotes',
      patternId: p.patternOrder[0]!,
      channelId: firstCanal(p),
      patches: [{ id: 'n1', pan: 0 }],
    });
    expect(JSON.stringify(inverseNota)).not.toContain('unset');
    applyCommand(p, porJSON(inverseNota));
    expect(serializeProject(p)).toBe(antes);

    const inverseClip = applyCommand(p, {
      type: 'patchClips',
      patches: [{ id: 'c1', color: 'azul' }],
    });
    applyCommand(p, porJSON(inverseClip));
    expect(serializeProject(p)).toBe(antes);
  });
it('el control en negativo: sin la marca, el undo por JSON no deshace', () => {
    // Qué rompería esto: si el inverso volviera a llevar `undefined`, el viaje por
    // el cable lo borraría y el campo seguiría puesto. Se comprueba a mano, sin
    // tocar el bus, que un comando con `undefined` no sobrevive al JSON.
    const inversoRoto = {
      type: 'patchChannel',
      channelId: 'c1',
      patch: { groupId: undefined },
    } as unknown as Command;
    expect(JSON.stringify(porJSON(inversoRoto))).not.toContain('groupId');
    // Y el mismo comando con la marca sí llega entero.
    const inversoBueno = {
      type: 'patchChannel',
      channelId: 'c1',
      patch: { groupId: UNSET },
    } as unknown as Command;
    expect(JSON.stringify(porJSON(inversoBueno))).toContain('groupId');
  });
});

/** Proyecto con una nota y un clip, con los campos obligatorios del modelo. */
function proyectoConNotaYClip(): Project {
  const p = createEmptyProject();
  const canal = createChannel('synth', 0);
  applyCommand(p, { type: 'addChannel', channel: canal });
  const patternId = p.patternOrder[0]!;
  p.patterns[patternId]!.notes[canal.id] = [
    { id: 'n1', start: 0, duration: 1, key: 60, velocity: 1, pan: 0.4, slide: false },
  ];
  const track = createPlaylistTrack(p.activeArrangementId, 0);
  applyCommand(p, { type: 'addPlaylistTrack', track });
  applyCommand(p, {
    type: 'addClips',
    clips: [
      {
        id: 'c1', kind: 'pattern', playlistTrackId: track.id, start: 0, length: 4,
        muted: false, patternId, color: 'rojo',
      },
    ],
  });
  return p;
}