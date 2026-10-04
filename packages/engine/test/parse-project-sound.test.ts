/**
 * BUG 017, la prueba que faltaba: parsear un `.orbit` no basta, hay que COMPILARLO
 * y RENDERIZARLO para ver que lo que sale esaudio y no NaN.
 *
 * La revisión encontró los cuatro con un síntoma de motor, no de validado:
 * `swing: 'wrong'` acababa en `compiled.events[0].start = NaN`, `channel.volume:
 * 'loud'` en un `render.left` con NaN, `timeSig.num: 'wrong'` en
 * `compiled.timeSigNum = NaN`, y `mixer[0].slots[0].mix: 'wrong'` pasaba porque
 * las pistas no pasaban por las mismas tablas internas que un canal. Aquí se
 * comprueba la otra mitad del contrato: lo que SÍ se abre tiene que sonar.
 *
 * Vive en el motor porque necesita `compileProject` y `renderProject`; los tipos
 * van en la dirección engine → core, nunca al revés.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  parseProject,
  serializeProject,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';

/** JSON plano del proyecto vacío, para mutarlo como si estuviera tocado a mano. */
function base(): Record<string, unknown> {
  return JSON.parse(serializeProject(createEmptyProject())) as Record<string, unknown>;
}

/** Todos los números de una estructura, para afirmar que ninguno es NaN. */
function numeros(valor: unknown, salida: number[] = []): number[] {
  if (typeof valor === 'number') salida.push(valor);
  else if (Array.isArray(valor)) for (const v of valor) numeros(v, salida);
  else if (valor !== null && typeof valor === 'object') {
    for (const v of Object.values(valor as Record<string, unknown>)) numeros(v, salida);
  }
  return salida;
}

function sinNaN(valor: unknown, que: string): void {
  const malos = numeros(valor).filter((n) => !Number.isFinite(n));
  expect(`${que}: ${malos.length} NaN/Inf`).toBe(`${que}: 0 NaN/Inf`);
}

/** Un proyecto con música de verdad: canal, patrón con notas y clip en la pista. */
function conMusica(): Project {
  const p = createEmptyProject();
  const channel = createChannel('sub808', 0);
  applyCommand(p, { type: 'addChannel', channel });
  const patternId = p.patternOrder[0]!;
  const pattern = p.patterns[patternId]!;
  pattern.notes[channel.id] = [
    { id: 'n1', start: 0, duration: 0.5, key: 36, velocity: 1, pan: 0, slide: false },
    { id: 'n2', start: 0.5, duration: 0.5, key: 36, velocity: 0.9, pan: 0, slide: false },
  ];
  const trackId = Object.keys(p.playlistTracks)[0]!;
  applyCommand(p, {
    type: 'addClips',
    clips: [{ id: 'clip1', kind: 'pattern', playlistTrackId: trackId, start: 0, length: 4, muted: false, patternId }],
  });
  return p;
}

describe('017 · lo que se abre tiene que sonar', () => {
  it('un proyecto recién creado compila y renderiza sin un solo NaN', () => {
    const compiled = compileProject(conMusica(), { mode: 'song' });
    sinNaN(compiled, 'compiled recien creado');
    const audio = renderProject(compiled, { sampleRate: 22050, tailSeconds: 0.2 });
    sinNaN(audio, 'render recien creado');
    expect(Math.max(...audio.left.map(Math.abs))).toBeGreaterThan(0);
  });

  it('el .orbit de un proyecto con música: ida y vuelta, compila y suena', () => {
    const original = conMusica();
    const vuelta = parseProject(serializeProject(original));
    const compiled = compileProject(vuelta, { mode: 'song' });
    sinNaN(compiled, 'compiled tras ida y vuelta');
    sinNaN(compiled.timeSigNum, 'timeSigNum');
    const audio = renderProject(compiled, { sampleRate: 22050, tailSeconds: 0.2 });
    sinNaN(audio, 'render tras ida y vuelta');
    expect(Math.max(...audio.left.map(Math.abs))).toBeGreaterThan(0);
  });

  it('un .orbit de legado (sin fx, sin eq, sin sends, sin aditivos) también', () => {
    // Lo que un archivo de antes de v1.1 no traía. Se rellena con defaults
    // explícitos, y el resultado tiene que sonar igual de finito.
    const data = JSON.parse(serializeProject(conMusica())) as Record<string, unknown>;
    for (const canal of Object.values(data.channels as Record<string, Record<string, unknown>>)) {
      delete canal.fx;
    }
    for (const pista of data.mixer as Record<string, unknown>[]) {
      delete pista.eqLow;
      delete pista.eqMid;
      delete pista.eqHigh;
      delete pista.routeTo;
      delete pista.sends;
    }
    for (const aditivo of ['samples', 'lfos', 'sections', 'channelGroups', 'inputRoutes', 'swing']) {
      delete data[aditivo];
    }
    const parsed = parseProject(JSON.stringify(data));
    expect(parsed.mixer[0]?.routeTo).toBeNull();
    expect(parsed.mixer[0]?.sends).toEqual([]);
    const compiled = compileProject(parsed, { mode: 'song' });
    sinNaN(compiled, 'compiled legado');
    const audio = renderProject(compiled, { sampleRate: 22050, tailSeconds: 0.2 });
    sinNaN(audio, 'render legado');
    // Y suena de verdad: un legacy que se abre en silencio no contaría.
    expect(Math.max(...audio.left.map(Math.abs))).toBeGreaterThan(0);
  });

  it('y los cuatro casos de la sonda NO llegan a compilar: se paran al parsear', () => {
    // La contraparte: lo inválido no se abre, así que no hay NaN que renderizar.
    const casos: [string, (d: Record<string, unknown>) => void][] = [
      ['swing de string', (d) => (d.swing = 'wrong')],
      ['timeSig.num de string', (d) => ((d.timeSig as Record<string, unknown>).num = 'wrong')],
      ['mix de slot de mixer', (d) => {
        const pista = (d.mixer as Record<string, Record<string, unknown>>)[1]!;
        pista.slots = [{ id: 's1', mix: 'wrong', params: {} }];
      }],
      ['notes de patrón ausentes', (d) => {
        const patron = Object.values(d.patterns as Record<string, Record<string, unknown>>)[0]!;
        delete patron.notes;
      }],
    ];
    for (const [nombre, romper] of casos) {
      const data = base();
      romper(data);
      expect(() => parseProject(JSON.stringify(data)), nombre).toThrow(/inválido/);
    }
  });
});