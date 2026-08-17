/**
 * Filtros de canal del Channel Rack (los "filters" de FL): agrupan los canales
 * por familia de instrumento y se combinan con un buscador por nombre.
 *
 * Es estado de VISTA: nada de esto toca el proyecto ni el store global de UI,
 * solo decide qué filas se pintan.
 */

import { INSTRUMENT_LABELS, type Channel, type InstrumentKind } from '@orbit/core';

export interface RackFilter {
  id: string;
  label: string;
  /** Tipos que deja pasar; `null` = todos (el filtro "Todos"). */
  kinds: readonly InstrumentKind[] | null;
  title: string;
}

/**
 * Un tipo nuevo de instrumento que no esté listado aquí sigue apareciendo en
 * "Todos" y en el buscador: los filtros suman, nunca esconden sin querer.
 */
export const RACK_FILTERS: readonly RackFilter[] = [
  { id: 'all', label: 'Todos', kinds: null, title: 'Ver todos los canales' },
  { id: 'drums', label: 'Drums', kinds: ['drums'], title: 'Baterías y percusión' },
  { id: 'bass', label: '808/Bajos', kinds: ['sub808'], title: 'Subgraves y 808' },
  {
    id: 'melodic',
    label: 'Melódicos',
    kinds: ['synth', 'supersaw', 'fm', 'nova'],
    title: 'Sintes, pads y leads',
  },
  {
    id: 'sampler',
    label: 'Sampler',
    kinds: ['sampler', 'slicer'],
    title: 'Samples y slicer',
  },
  { id: 'vox', label: 'Voces', kinds: ['vox'], title: 'Canales de voz' },
];

export const DEFAULT_FILTER_ID = 'all';

/** Minúsculas y sin acentos: "melódico" encuentra "melodico" y al revés. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function findFilter(filterId: string): RackFilter | undefined {
  return RACK_FILTERS.find((f) => f.id === filterId);
}

/** ¿El canal pasa el filtro de familia elegido? */
export function matchesKind(channel: Channel, filterId: string): boolean {
  const filter = findFilter(filterId);
  if (!filter || filter.kinds === null) return true;
  return filter.kinds.includes(channel.kind);
}

/** ¿El canal pasa el buscador? Busca en su nombre y en el del instrumento. */
export function matchesQuery(channel: Channel, query: string): boolean {
  const q = normalizeText(query);
  if (!q) return true;
  return (
    normalizeText(channel.name).includes(q) ||
    normalizeText(INSTRUMENT_LABELS[channel.kind]).includes(q)
  );
}

/** Filtro completo: familia + buscador. */
export function matchesChannel(channel: Channel, filterId: string, query: string): boolean {
  return matchesKind(channel, filterId) && matchesQuery(channel, query);
}
