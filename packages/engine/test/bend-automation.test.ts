/**
 * La rueda de tono, ya como parámetro: guardada en el canal y movida por una
 * curva de automatización.
 *
 * Se mide la ALTURA de la salida, igual que el test del gesto en vivo. Es lo
 * único que prueba lo que esto promete: no que exista un campo `bend` ni que
 * el compilador saque un destino con la clave correcta —eso puede estar
 * perfecto y no sonar—, sino que la nota salga movida.
 *
 * Los dos casos van por separado porque fallan por separado: el valor que
 * viene GUARDADO en el canal (abrir un .orbit y que suene doblado) y el que
 * escribe la CURVA bloque a bloque mientras la nota ya está sonando.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  newId,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';
import { detectPitchTrack } from '../src/render/pitch';

const SR = 44100;
/** Una nota sostenida y limpia: lo que hace falta para medirle la altura. */
const PARAMS = { sustain: 1, decay: 4, cutoff: 9000, envAmount: 0, release: 0.05 };
const NOTA = 60;
const COMPASES = 4;

interface Montaje {
  project: Project;
  channelId: string;
}

/** Proyecto de un canal, una nota larga, y la rueda donde se pida. */
function montar(bend?: number): Montaje {
  const project = createEmptyProject();
  const channel = createChannel('synth', 0, 'Lead');
  applyCommand(project, { type: 'addChannel', channel });
  for (const [key, value] of Object.entries(PARAMS)) {
    applyCommand(project, { type: 'setChannelParam', channelId: channel.id, key, value });
  }
  if (bend !== undefined) {
    applyCommand(project, { type: 'patchChannel', channelId: channel.id, patch: { bend } });
  }
  const patternId = project.patternOrder[0]!;
  applyCommand(project, {
    type: 'addNotes',
    patternId,
    channelId: channel.id,
    notes: [
      { id: newId(), start: 0, duration: COMPASES, key: NOTA, velocity: 0.9, pan: 0, slide: false },
    ],
  });
  const pistas = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === project.activeArrangementId)
    .sort((a, b) => a.order - b.order);
  applyCommand(project, {
    type: 'addClips',
    clips: [
      {
        id: newId(),
        kind: 'pattern',
        playlistTrackId: pistas[0]!.id,
        start: 0,
        length: COMPASES,
        muted: false,
        patternId,
      },
    ],
  });
  return { project, channelId: channel.id };
}

/** Cuelga una curva de rueda del canal, con los puntos en 0..1. */
function conCurva(m: Montaje, puntos: { time: number; value: number }[]): Montaje {
  const otra = Object.values(m.project.playlistTracks)
    .filter((t) => t.arrangementId === m.project.activeArrangementId)
    .sort((a, b) => a.order - b.order)[1]!;
  applyCommand(m.project, {
    type: 'addClips',
    clips: [
      {
        id: newId(),
        kind: 'automation',
        playlistTrackId: otra.id,
        start: 0,
        length: COMPASES,
        muted: false,
        target: { kind: 'channelMix', channelId: m.channelId, param: 'bend' },
        points: puntos.map((p) => ({ id: newId(), time: p.time, value: p.value, tension: 0 })),
      },
    ],
  });
  return m;
}

function renderizar(m: Montaje): Float32Array {
  const res = renderProject(compileProject(m.project, { mode: 'song' }), {
    tailSeconds: 0,
    sampleRate: SR,
  });
  return res.left;
}

/** Altura mediana de un tramo (0 si ahí no hay tono que leer). */
function f0(xs: Float32Array, desde = 0, hasta = xs.length): number {
  const track = detectPitchTrack(xs.slice(desde, hasta), SR);
  const values = Array.from(track.f0)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  return values.length > 0 ? values[values.length >> 1]! : 0;
}

/** Semitonos entre dos alturas. */
const semitonos = (a: number, b: number): number => 12 * Math.log2(a / b);

describe('la rueda guardada en el canal', () => {
  it('la nota NACE doblada al abrir el proyecto', () => {
    // El caso de verdad: se guarda un .orbit con la rueda puesta, se abre otro
    // día y tiene que sonar como sonaba. Nadie va a mover nada.
    const recta = f0(renderizar(montar()));
    const doblada = f0(renderizar(montar(12)));
    expect(recta).toBeGreaterThan(0);
    expect(doblada).toBeGreaterThan(0);
    expect(semitonos(doblada, recta), 'el canal guardado no salió doblado').toBeCloseTo(12, 0);
  });

  it('dobla hacia abajo igual que hacia arriba', () => {
    const recta = f0(renderizar(montar()));
    const grave = f0(renderizar(montar(-7)));
    expect(semitonos(grave, recta)).toBeCloseTo(-7, 0);
  });
});

describe('la rueda movida por una curva', () => {
  it('una curva plana dobla el canal entero', () => {
    // 0.5 es el centro del parámetro y 0.75 son +12 semitonos: la curva y el
    // valor guardado tienen que dar exactamente lo mismo.
    const centrada = f0(renderizar(conCurva(montar(), [
      { time: 0, value: 0.5 },
      { time: COMPASES, value: 0.5 },
    ])));
    const arriba = f0(renderizar(conCurva(montar(), [
      { time: 0, value: 0.75 },
      { time: COMPASES, value: 0.75 },
    ])));
    expect(semitonos(arriba, centrada), 'la curva plana no dobló').toBeCloseTo(12, 0);
  });

  it('una rampa sube la altura MIENTRAS la nota suena', () => {
    // Aquí está lo que el gesto en vivo no sabía hacer: la nota ya está
    // sonando y la altura se mueve sola. Si la curva solo llegara a las notas
    // NUEVAS, estas dos medidas saldrían iguales.
    const xs = renderizar(conCurva(montar(), [
      { time: 0, value: 0.5 },
      { time: COMPASES, value: 0.75 },
    ]));
    const cuarto = Math.floor(xs.length / 4);
    const alPrincipio = f0(xs, 0, cuarto);
    const alFinal = f0(xs, xs.length - cuarto, xs.length);
    expect(alPrincipio).toBeGreaterThan(0);
    expect(alFinal).toBeGreaterThan(0);
    // No se pide el valor exacto del final: la mediana de un tramo de una
    // rampa exponencial no es el borde. Se pide que haya subido de verdad.
    expect(semitonos(alFinal, alPrincipio), 'la rampa no movió la nota viva').toBeGreaterThan(5);
  });

  it('el destino se compila con la clave de la rueda y en semitonos', () => {
    const m = conCurva(montar(), [
      { time: 0, value: 0.5 },
      { time: COMPASES, value: 1 },
    ]);
    const c = compileProject(m.project, { mode: 'song' });
    expect(c.automation).toHaveLength(1);
    expect(c.automation[0]!.target).toEqual({ scope: 'channelMix', channelIndex: 0, key: 'bend' });
    // Ya desnormalizado: lo que viaja al kernel son semitonos, no un 0..1.
    const values = c.automation[0]!.values;
    expect(values[0]).toBeCloseTo(0, 6);
    expect(values[values.length - 1]).toBeCloseTo(24, 6);
  });
});
