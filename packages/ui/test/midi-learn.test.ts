/**
 * MIDI learn: la tabla de mapeos y sus rótulos.
 *
 * Lo que se prueba es la lectura de lo guardado: `settings.json` lo puede
 * haber tocado cualquiera (o venir de una versión anterior), y un mapeo roto
 * no puede impedir que carguen los demás ni colarse hasta el bus de comandos
 * con un destino que no existe.
 */

import { describe, expect, it } from 'vitest';
import {
  ccSource,
  isLearning,
  midiMappingFor,
  midiSourceLabel,
  parseMidiMappings,
  SOURCE_BEND,
  type MidiMapping,
} from '../src/state/midi-learn';
import type { ParamRef } from '@orbit/core';

const MIXER_VOL: ParamRef = { kind: 'mixer', trackIndex: 3, param: 'volume' };
const MIXER_PAN: ParamRef = { kind: 'mixer', trackIndex: 3, param: 'pan' };

describe('claves y rótulos de origen', () => {
  it('el CC se nombra por su número, y los famosos por su nombre', () => {
    expect(ccSource(74)).toBe('cc:74');
    expect(midiSourceLabel('cc:74')).toBe('CC 74');
    expect(midiSourceLabel('cc:1')).toBe('Rueda de modulación');
    expect(midiSourceLabel('cc:11')).toBe('Pedal de expresión');
    expect(midiSourceLabel(SOURCE_BEND)).toBe('Rueda de tono');
  });
});

describe('parseMidiMappings', () => {
  it('lee lo que está bien', () => {
    const list = parseMidiMappings([
      { source: 'cc:74', ref: MIXER_VOL },
      { source: SOURCE_BEND, ref: { kind: 'transport', param: 'tempo' } },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]!.source).toBe('cc:74');
  });

  it('tira lo que no es un origen válido', () => {
    expect(parseMidiMappings([{ source: 'cc:128', ref: MIXER_VOL }])).toEqual([]);
    expect(parseMidiMappings([{ source: 'cc:-1', ref: MIXER_VOL }])).toEqual([]);
    expect(parseMidiMappings([{ source: 'cc:abc', ref: MIXER_VOL }])).toEqual([]);
    expect(parseMidiMappings([{ source: '', ref: MIXER_VOL }])).toEqual([]);
    expect(parseMidiMappings([{ ref: MIXER_VOL }])).toEqual([]);
    // El 127 sí entra: es el último CC que existe.
    expect(parseMidiMappings([{ source: 'cc:127', ref: MIXER_VOL }])).toHaveLength(1);
  });

  it('tira lo que no es un destino válido', () => {
    expect(parseMidiMappings([{ source: 'cc:1', ref: { kind: 'inventado' } }])).toEqual([]);
    expect(parseMidiMappings([{ source: 'cc:1', ref: { kind: 'mixer' } }])).toEqual([]);
    expect(parseMidiMappings([{ source: 'cc:1', ref: { kind: 'transport', param: 'x' } }])).toEqual(
      [],
    );
    expect(parseMidiMappings([{ source: 'cc:1', ref: null }])).toEqual([]);
    expect(parseMidiMappings([{ source: 'cc:1' }])).toEqual([]);
  });

  it('un mapeo roto no se lleva por delante a los buenos', () => {
    const list = parseMidiMappings([
      { source: 'cc:1', ref: MIXER_VOL },
      'basura',
      { source: 'cc:999', ref: MIXER_VOL },
      { source: 'cc:2', ref: MIXER_PAN },
    ]);
    expect(list.map((m) => m.source)).toEqual(['cc:1', 'cc:2']);
  });

  it('un origen no puede quedarse con dos destinos: manda el último', () => {
    const list = parseMidiMappings([
      { source: 'cc:1', ref: MIXER_VOL },
      { source: 'cc:1', ref: MIXER_PAN },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]!.ref).toEqual(MIXER_PAN);
  });

  it('lo que no es una lista sale vacío', () => {
    expect(parseMidiMappings(undefined)).toEqual([]);
    expect(parseMidiMappings(null)).toEqual([]);
    expect(parseMidiMappings({ 'cc:1': MIXER_VOL })).toEqual([]);
    expect(parseMidiMappings('cc:1')).toEqual([]);
  });
});

describe('buscar el mando de un destino', () => {
  const mappings: Record<string, MidiMapping> = {
    'cc:74': { source: 'cc:74', ref: MIXER_VOL },
  };

  it('encuentra el mapeo por la identidad del destino, no por la referencia', () => {
    // Otro objeto con los mismos campos tiene que encontrarlo igual: los
    // ParamRef se reconstruyen en cada render.
    const same: ParamRef = { kind: 'mixer', trackIndex: 3, param: 'volume' };
    expect(midiMappingFor(same, mappings)?.source).toBe('cc:74');
    expect(midiMappingFor(MIXER_PAN, mappings)).toBeNull();
  });

  it('sabe qué destino está esperando a que muevas un mando', () => {
    expect(isLearning(MIXER_VOL, { kind: 'mixer', trackIndex: 3, param: 'volume' })).toBe(true);
    expect(isLearning(MIXER_PAN, MIXER_VOL)).toBe(false);
    expect(isLearning(MIXER_VOL, null)).toBe(false);
  });
});
