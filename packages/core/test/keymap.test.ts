/**
 * Keymaps: qué zona dispara cada nota y cómo se reparten solas.
 *
 * Lo que se prueba aquí es lo que decide si un piano muestreado suena o no
 * suena: los bordes (una nota justo en el límite entre dos zonas), los huecos
 * (una nota que no cubre nadie es silencio, no un fallo) y el solape, que NO
 * es un error sino la manera de hacer capas.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createKeymapZone,
  MAX_KEYMAP_ZONES,
  parseProject,
  serializeProject,
  type SampleRef,
  normalizeKeymap,
  normalizeKeymapZone,
  sortKeymap,
  spreadKeymapRanges,
  spreadKeymapVelocities,
  zonesForNote,
  zoneTranspose,
  type KeymapZone,
} from '../src/index';

function zone(patch: Partial<KeymapZone>): KeymapZone {
  return createKeymapZone(patch.sampleId ?? 'sample-1', patch);
}

describe('zona nueva', () => {
  it('cubre el teclado entero y la velocidad entera', () => {
    const z = createKeymapZone('s1');
    expect(z.keyLow).toBe(0);
    expect(z.keyHigh).toBe(127);
    expect(z.velLow).toBe(0);
    expect(z.velHigh).toBe(1);
    expect(z.keyRoot).toBe(60);
    expect(z.gain).toBe(1);
    expect(z.id).not.toBe('');
  });
});

describe('normalizar una zona', () => {
  it('da la vuelta a un rango invertido en vez de dejarlo mudo', () => {
    // Sale de arrastrar el borde izquierdo más allá del derecho, que es un
    // gesto normal; dejarlo invertido haría una zona que no suena nunca.
    const z = normalizeKeymapZone(zone({ keyLow: 80, keyHigh: 40 }));
    expect(z.keyLow).toBe(40);
    expect(z.keyHigh).toBe(80);
    const v = normalizeKeymapZone(zone({ velLow: 0.9, velHigh: 0.2 }));
    expect(v.velLow).toBeCloseTo(0.2, 6);
    expect(v.velHigh).toBeCloseTo(0.9, 6);
  });

  it('acota teclas, velocidades, afinación y ganancia', () => {
    const z = normalizeKeymapZone(
      zone({ keyLow: -20, keyHigh: 999, keyRoot: 500, velLow: -3, velHigh: 9, tune: 50, gain: 99 }),
    );
    expect(z.keyLow).toBe(0);
    expect(z.keyHigh).toBe(127);
    expect(z.keyRoot).toBe(127);
    expect(z.velLow).toBe(0);
    expect(z.velHigh).toBe(1);
    expect(z.tune).toBe(6);
    expect(z.gain).toBe(4);
  });

  it('redondea las teclas: media tecla no existe', () => {
    const z = normalizeKeymapZone(zone({ keyLow: 40.6, keyHigh: 60.2, keyRoot: 48.5 }));
    expect(z.keyLow).toBe(41);
    expect(z.keyHigh).toBe(60);
    expect(Number.isInteger(z.keyRoot)).toBe(true);
  });
});

describe('normalizar el mapa entero', () => {
  it('sin zonas no hay mapa', () => {
    expect(normalizeKeymap([])).toBeUndefined();
    expect(normalizeKeymap(undefined)).toBeUndefined();
    expect(normalizeKeymap(null)).toBeUndefined();
  });

  it('tira las zonas que no apuntan a ningún sample', () => {
    const good = zone({ sampleId: 's1' });
    const orphan = { ...zone({}), sampleId: '' };
    expect(normalizeKeymap([good, orphan])).toHaveLength(1);
    // Y si SOLO había huérfanas, tampoco hay mapa.
    expect(normalizeKeymap([orphan])).toBeUndefined();
  });

  it('recorta al tope de zonas', () => {
    const many = Array.from({ length: MAX_KEYMAP_ZONES + 20 }, (_, i) =>
      zone({ sampleId: 's' + i, keyLow: i % 128, keyHigh: 127 }),
    );
    expect(normalizeKeymap(many)).toHaveLength(MAX_KEYMAP_ZONES);
  });

  it('deja el mapa ordenado por dónde empieza cada zona', () => {
    const list = normalizeKeymap([
      zone({ keyLow: 60, keyHigh: 70 }),
      zone({ keyLow: 0, keyHigh: 30 }),
      zone({ keyLow: 40, keyHigh: 50 }),
    ])!;
    expect(list.map((z) => z.keyLow)).toEqual([0, 40, 60]);
  });

  it('con la misma tecla, ordena por velocidad', () => {
    const list = sortKeymap([
      zone({ keyLow: 60, keyHigh: 60, velLow: 0.7, velHigh: 1 }),
      zone({ keyLow: 60, keyHigh: 60, velLow: 0, velHigh: 0.3 }),
    ]);
    expect(list[0]!.velLow).toBe(0);
  });
});

describe('qué zona dispara una nota', () => {
  const bajo = zone({ sampleId: 'bajo', keyLow: 0, keyHigh: 59, keyRoot: 48 });
  const alto = zone({ sampleId: 'alto', keyLow: 60, keyHigh: 127, keyRoot: 72 });
  const mapa = [bajo, alto];

  it('los bordes son inclusivos por los dos lados', () => {
    expect(zonesForNote(mapa, 59, 0.8).map((z) => z.sampleId)).toEqual(['bajo']);
    expect(zonesForNote(mapa, 60, 0.8).map((z) => z.sampleId)).toEqual(['alto']);
    expect(zonesForNote(mapa, 0, 0.8).map((z) => z.sampleId)).toEqual(['bajo']);
    expect(zonesForNote(mapa, 127, 0.8).map((z) => z.sampleId)).toEqual(['alto']);
  });

  it('un hueco del mapa es silencio, no un fallo', () => {
    const conHueco = [zone({ keyLow: 0, keyHigh: 30 }), zone({ keyLow: 60, keyHigh: 127 })];
    expect(zonesForNote(conHueco, 45, 0.8)).toEqual([]);
  });

  it('la velocidad filtra igual que la tecla', () => {
    const suave = zone({ sampleId: 'suave', keyLow: 60, keyHigh: 60, velLow: 0, velHigh: 0.5 });
    const fuerte = zone({ sampleId: 'fuerte', keyLow: 60, keyHigh: 60, velLow: 0.5, velHigh: 1 });
    expect(zonesForNote([suave, fuerte], 60, 0.2).map((z) => z.sampleId)).toEqual(['suave']);
    expect(zonesForNote([suave, fuerte], 60, 0.9).map((z) => z.sampleId)).toEqual(['fuerte']);
    // En la frontera exacta caen las dos: eso es un solape, y es legal.
    expect(zonesForNote([suave, fuerte], 60, 0.5)).toHaveLength(2);
  });

  it('el solape devuelve TODAS: así se hacen las capas', () => {
    const micro1 = zone({ sampleId: 'cerca', keyLow: 50, keyHigh: 70 });
    const micro2 = zone({ sampleId: 'lejos', keyLow: 50, keyHigh: 70 });
    expect(zonesForNote([micro1, micro2], 60, 0.8).map((z) => z.sampleId)).toEqual([
      'cerca',
      'lejos',
    ]);
  });
});

describe('transposición de una zona', () => {
  it('la raíz suena sin tocar', () => {
    expect(zoneTranspose(zone({ keyRoot: 60 }), 60)).toBe(0);
  });

  it('cuenta semitonos desde la raíz, con la afinación fina encima', () => {
    expect(zoneTranspose(zone({ keyRoot: 60 }), 72)).toBe(12);
    expect(zoneTranspose(zone({ keyRoot: 60 }), 48)).toBe(-12);
    expect(zoneTranspose(zone({ keyRoot: 60, tune: 0.5 }), 61)).toBeCloseTo(1.5, 6);
  });
});

describe('repartir los rangos solos', () => {
  it('cubre el teclado entero sin huecos ni solapes', () => {
    const zones = spreadKeymapRanges([
      zone({ sampleId: 'a', keyRoot: 36 }),
      zone({ sampleId: 'b', keyRoot: 60 }),
      zone({ sampleId: 'c', keyRoot: 84 }),
    ]);
    expect(zones[0]!.keyLow).toBe(0);
    expect(zones[zones.length - 1]!.keyHigh).toBe(127);
    // Cada tecla del teclado la cubre exactamente una zona.
    for (let key = 0; key <= 127; key++) {
      expect(zonesForNote(zones, key, 0.8)).toHaveLength(1);
    }
  });

  it('cada zona se queda con su propia raíz', () => {
    const zones = spreadKeymapRanges([
      zone({ sampleId: 'a', keyRoot: 40 }),
      zone({ sampleId: 'b', keyRoot: 64 }),
    ]);
    for (const z of zones) {
      expect(z.keyRoot).toBeGreaterThanOrEqual(z.keyLow);
      expect(z.keyRoot).toBeLessThanOrEqual(z.keyHigh);
    }
  });

  it('con una sola muestra, esa manda en todo el teclado', () => {
    const zones = spreadKeymapRanges([zone({ keyRoot: 60 })]);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.keyLow).toBe(0);
    expect(zones[0]!.keyHigh).toBe(127);
  });

  it('las raíces vienen desordenadas y se ordenan solas', () => {
    const zones = spreadKeymapRanges([
      zone({ sampleId: 'c', keyRoot: 84 }),
      zone({ sampleId: 'a', keyRoot: 36 }),
      zone({ sampleId: 'b', keyRoot: 60 }),
    ]);
    expect(zones.map((z) => z.sampleId)).toEqual(['a', 'b', 'c']);
  });
});

describe('repartir las capas de velocidad', () => {
  it('tres tomas de la misma nota salen en tres capas contiguas', () => {
    const zones = spreadKeymapVelocities([
      zone({ sampleId: 'p', keyRoot: 60 }),
      zone({ sampleId: 'mf', keyRoot: 60 }),
      zone({ sampleId: 'f', keyRoot: 60 }),
    ]);
    expect(zones).toHaveLength(3);
    expect(zones[0]!.velLow).toBe(0);
    expect(zones[2]!.velHigh).toBe(1);
    // Cualquier velocidad dispara UNA capa: si disparara dos sonaría el doble.
    for (const v of [0, 0.1, 0.33, 0.34, 0.5, 0.66, 0.67, 0.9, 1]) {
      expect(zonesForNote(zones, 60, v)).toHaveLength(1);
    }
  });

  it('una muestra sola se queda con la velocidad entera', () => {
    const zones = spreadKeymapVelocities([zone({ keyRoot: 60 })]);
    expect(zones[0]!.velLow).toBe(0);
    expect(zones[0]!.velHigh).toBe(1);
  });

  it('no mezcla notas distintas: cada raíz reparte lo suyo', () => {
    const zones = spreadKeymapVelocities([
      zone({ sampleId: 'do-p', keyRoot: 60 }),
      zone({ sampleId: 'do-f', keyRoot: 60 }),
      zone({ sampleId: 'mi', keyRoot: 64 }),
    ]);
    const mi = zones.find((z) => z.sampleId === 'mi')!;
    expect(mi.velLow).toBe(0);
    expect(mi.velHigh).toBe(1);
  });
});

describe('el keymap sobrevive al disco', () => {
  it('va y vuelve entero en un .orbit', () => {
    const project = createEmptyProject();
    const channel = createChannel('sampler', 0, 'Piano');
    applyCommand(project, { type: 'addChannel', channel });
    const sample: SampleRef = {
      id: 'smp-do',
      name: 'Piano C3',
      path: 'pack:piano-c3.wav',
      hash: 'abc',
      duration: 2,
    };
    applyCommand(project, { type: 'registerSample', sample });
    const keymap = [createKeymapZone('smp-do', { keyLow: 48, keyHigh: 72, keyRoot: 60, gain: 0.8 })];
    applyCommand(project, { type: 'patchChannel', channelId: channel.id, patch: { keymap } });

    const back = parseProject(serializeProject(project));
    expect(back.channels[channel.id]!.keymap).toEqual(keymap);
  });

  it('una zona que apunta a un sample que ya no está se cae al abrir', () => {
    // El motor usa el keymap tal cual: una zona huérfana sería una nota muda
    // sin explicación, y peor, un `samples.get(undefined)` en el kernel.
    const project = createEmptyProject();
    const channel = createChannel('sampler', 0, 'Piano');
    applyCommand(project, { type: 'addChannel', channel });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: channel.id,
      patch: { keymap: [createKeymapZone('sample-que-no-existe')] },
    });
    const back = parseProject(serializeProject(project));
    expect(back.channels[channel.id]!.keymap).toBeUndefined();
  });

  it('un archivo tocado a mano con una zona del revés se endereza al abrir', () => {
    const project = createEmptyProject();
    const channel = createChannel('sampler', 0, 'Piano');
    applyCommand(project, { type: 'addChannel', channel });
    applyCommand(project, {
      type: 'registerSample',
      sample: { id: 's1', name: 's1', path: 'pack:s1.wav', hash: 'h', duration: 1 },
    });
    const raw = JSON.parse(serializeProject(project)) as {
      channels: Record<string, { keymap?: unknown }>;
    };
    raw.channels[channel.id]!.keymap = [
      { id: 'z1', sampleId: 's1', keyLow: 90, keyHigh: 30, keyRoot: 60, velLow: 1, velHigh: 0, tune: 0, gain: 1 },
    ];
    const back = parseProject(JSON.stringify(raw));
    const z = back.channels[channel.id]!.keymap![0]!;
    expect(z.keyLow).toBe(30);
    expect(z.keyHigh).toBe(90);
    expect(z.velLow).toBe(0);
    expect(z.velHigh).toBe(1);
  });

  it('un .orbit anterior (sin keymap) abre igual que siempre', () => {
    const project = createEmptyProject();
    const channel = createChannel('sampler', 0, 'Piano');
    applyCommand(project, { type: 'addChannel', channel });
    const back = parseProject(serializeProject(project));
    expect(back.channels[channel.id]!.keymap).toBeUndefined();
  });
});

describe('repartir rangos con capas en la misma nota', () => {
  it('las capas de una misma nota comparten trozo de teclado', () => {
    // Repartiendo por ZONA y no por raíz, dos capas de la misma nota se
    // pisaban el punto medio la una a la otra y salían con el rango del revés
    // (una zona de una sola tecla, o directamente muda).
    const zones = spreadKeymapRanges([
      zone({ sampleId: 'do-p', keyRoot: 60 }),
      zone({ sampleId: 'do-f', keyRoot: 60 }),
      zone({ sampleId: 'mi', keyRoot: 64 }),
    ]);
    const doP = zones.find((z) => z.sampleId === 'do-p')!;
    const doF = zones.find((z) => z.sampleId === 'do-f')!;
    expect(doP.keyLow).toBe(doF.keyLow);
    expect(doP.keyHigh).toBe(doF.keyHigh);
    expect(doP.keyLow).toBeLessThanOrEqual(60);
    expect(doP.keyHigh).toBeGreaterThanOrEqual(60);
    for (const z of zones) expect(z.keyLow).toBeLessThanOrEqual(z.keyHigh);
  });

  it('el teclado sigue cubierto entero con capas de por medio', () => {
    const zones = spreadKeymapVelocities(
      spreadKeymapRanges([
        zone({ sampleId: 'a1', keyRoot: 48 }),
        zone({ sampleId: 'a2', keyRoot: 48 }),
        zone({ sampleId: 'b1', keyRoot: 72 }),
        zone({ sampleId: 'b2', keyRoot: 72 }),
      ]),
    );
    for (let key = 0; key <= 127; key++) {
      expect(zonesForNote(zones, key, 0.9).length).toBeGreaterThan(0);
    }
  });
});
