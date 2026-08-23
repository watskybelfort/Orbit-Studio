import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  encodeMidi,
  newId,
  parseProject,
  serializeProject,
  type Command,
  type Project,
  type Send,
} from '../src/index';

const snap = (p: Project): string => JSON.stringify(p);

/** apply + inverso = identidad byte a byte. */
function expectInvertible(p: Project, cmd: Command): void {
  const before = snap(p);
  const inv = applyCommand(p, cmd);
  applyCommand(p, inv);
  expect(snap(p)).toBe(before);
}

describe('setSend: el inverso conserva la FORMA del envío', () => {
  it('deshacer el borrado de un envío moldeado lo devuelve entero', () => {
    const p = createEmptyProject();
    const shaped: Send = { target: 2, level: 0.8, tap: 'pre', part: 'side', invert: true, pan: -0.5, mute: true };
    p.mixer[1]!.sends.push({ ...shaped });
    const before = snap(p);
    // Borrar el envío…
    const inv = applyCommand(p, { type: 'setSend', trackIndex: 1, target: 2, level: null });
    expect(p.mixer[1]!.sends.find((s) => s.target === 2)).toBeUndefined();
    // …y deshacer: vuelve con tap/part/invert/pan/mute, no solo {target, level}.
    applyCommand(p, inv);
    expect(snap(p)).toBe(before);
    const restored = p.mixer[1]!.sends.find((s) => s.target === 2);
    expect(restored).toEqual(shaped);
  });

  it('cambiar solo el nivel de un envío moldeado sigue siendo invertible', () => {
    const p = createEmptyProject();
    p.mixer[1]!.sends.push({ target: 3, level: 0.5, tap: 'pre', invert: true });
    expectInvertible(p, { type: 'setSend', trackIndex: 1, target: 3, level: 0.9 });
  });
});

describe('batch: es todo-o-nada (rollback si un sub lanza)', () => {
  it('un sub que lanza no deja el proyecto mutado a medias', () => {
    const p = createEmptyProject();
    const ch = createChannel('sub808', 0);
    applyCommand(p, { type: 'addChannel', channel: ch });
    const before = snap(p);
    // El primer sub borra el canal (válido); el segundo referencia uno que no
    // existe (lanza). Sin rollback, el canal quedaría borrado a medias.
    expect(() =>
      applyCommand(p, {
        type: 'batch',
        commands: [
          { type: 'removeChannel', channelId: ch.id },
          { type: 'removeChannel', channelId: 'no-existe' },
        ],
      }),
    ).toThrow();
    expect(snap(p)).toBe(before);
  });
});

describe('removeArrangement: no deja secciones huérfanas y restaura el activo', () => {
  it('deshacer devuelve secciones y activeArrangementId', () => {
    const p = createEmptyProject();
    const b = { id: newId(), name: 'B' };
    applyCommand(p, { type: 'addArrangement', arrangement: b });
    applyCommand(p, { type: 'setActiveArrangement', arrangementId: b.id });
    // Una sección que pertenece a B.
    const section = { id: newId(), arrangementId: b.id, name: 'Drop', start: 0, length: 8, color: '#f00' };
    applyCommand(p, { type: 'addSections', sections: [section] });
    const before = snap(p);
    const inv = applyCommand(p, { type: 'removeArrangement', arrangementId: b.id });
    // La sección se fue con el arreglo (no quedó huérfana).
    expect(p.sections[section.id]).toBeUndefined();
    expect(p.activeArrangementId).not.toBe(b.id);
    // Deshacer lo devuelve TODO, incluido el activo.
    applyCommand(p, inv);
    expect(snap(p)).toBe(before);
    expect(p.activeArrangementId).toBe(b.id);
    expect(p.sections[section.id]).toBeDefined();
  });
});

describe('parseProject: rellena claves que causaban NaN o crashes', () => {
  it('un .orbit sin swing/samples/patternOrder abre con defaults sanos', () => {
    const p = createEmptyProject();
    const raw = JSON.parse(serializeProject(p));
    delete raw.swing;
    delete raw.samples;
    delete raw.patternOrder;
    const parsed = parseProject(JSON.stringify(raw));
    expect(parsed.swing).toBe(0);
    expect(parsed.samples).toEqual({});
    expect(parsed.patternOrder.length).toBeGreaterThan(0);
  });
});

describe('slotIndex de efectos: se valida rango y entero', () => {
  it('un slot fuera de rango o fraccionario lanza (no rompe la invariante)', () => {
    const p = createEmptyProject();
    const slot = { id: newId(), kind: 'eq' as const, enabled: true, mix: 1, params: {} };
    expect(() => applyCommand(p, { type: 'setEffect', trackIndex: 0, slotIndex: 25, slot })).toThrow();
    expect(() => applyCommand(p, { type: 'setEffect', trackIndex: 0, slotIndex: 2.5, slot })).toThrow();
    expect(() => applyCommand(p, { type: 'setEffect', trackIndex: 0, slotIndex: -1, slot })).toThrow();
  });
});

describe('encodeMidi: el conductor lleva los cambios de tempo de los marcadores', () => {
  it('un marcador de tempo emite un segundo meta 0x51 en song', () => {
    const p = createEmptyProject();
    p.tempo = 120;
    applyCommand(p, {
      type: 'addMarker',
      marker: { id: newId(), time: 8, name: 'x', color: '#fff', tempo: 174 },
    });
    const bytes = encodeMidi(p, { mode: 'song' });
    // Cuenta cuántas veces aparece la firma de un meta de tempo (FF 51 03).
    let count = 0;
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0x51 && bytes[i + 2] === 0x03) count++;
    }
    expect(count).toBe(2); // el inicial + el del marcador
  });
});
