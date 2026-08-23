/**
 * Lo que el render offline necesita del renderer: samples decodificados y
 * fuentes de los plugins JS.
 *
 * El kernel en vivo recibe los samples por transferencia cuando se cargan; el
 * render offline crea su propio kernel y hay que dárselos otra vez, así que se
 * decodifican aquí (con caché por id+hash para no repetir el trabajo en cada
 * export o consolidación).
 */

import type { Project } from '@orbit/core';
import type { CompiledProject, SampleData } from '@orbit/engine';
import { readSampleBytes } from '../browser/sound-actions';
import { usePluginsStore } from '../state/plugins';

const sampleCache = new Map<string, SampleData>();

export interface CollectedSamples {
  samples: Map<string, SampleData>;
  /** Nombres de los que no se pudieron leer (van como silencio en el render). */
  missing: string[];
}

/**
 * Todos los samples que el render va a necesitar.
 *
 * Aparte y puro porque olvidarse de una fuente aquí no da error: da SILENCIO
 * en el export, y el silencio de un instrumento concreto dentro de una mezcla
 * es de lo último que se mira. Ya pasó con el multisample — el keymap tiene
 * sus propias muestras y no están en `ch.sampleId`.
 */
export function neededSampleIds(compiled: CompiledProject): Set<string> {
  const needed = new Set<string>();
  for (const ch of compiled.channels) {
    if (ch.sampleId) needed.add(ch.sampleId);
    for (const zone of ch.keymap ?? []) needed.add(zone.sampleId);
  }
  for (const clip of compiled.audioClips) needed.add(clip.sampleId);
  return needed;
}

export async function collectSamples(
  project: Project,
  compiled: CompiledProject,
): Promise<CollectedSamples> {
  const needed = neededSampleIds(compiled);


  const samples = new Map<string, SampleData>();
  const missing: string[] = [];
  for (const id of needed) {
    const ref = project.samples[id];
    const key = ref ? `${id}:${ref.hash}` : id;
    const cached = sampleCache.get(key);
    if (cached) {
      samples.set(id, cached);
      continue;
    }
    if (!ref || !window.orbit) {
      missing.push(ref?.name ?? id);
      continue;
    }
    try {
      const bytes = await readSampleBytes(ref.path);
      if (!bytes) {
        // Esquema de ruta que el renderer no sabe resolver (rutas locales sueltas).
        missing.push(ref.name);
        continue;
      }
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      const left = decoded.getChannelData(0).slice();
      const right = (
        decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0)
      ).slice();
      const data: SampleData = { left, right, rate: decoded.sampleRate };
      sampleCache.set(key, data);
      samples.set(id, data);
    } catch {
      missing.push(ref.name);
    }
  }
  return { samples, missing };
}

/** Fuentes de los plugins JS que usa el mixer (los que falten van en bypass). */
export function collectPluginSources(project: Project): {
  plugins: Map<string, string>;
  missing: string[];
} {
  const sources = usePluginsStore.getState().sources;
  const plugins = new Map<string, string>();
  const missing: string[] = [];
  for (const track of project.mixer) {
    for (const slot of track.slots) {
      if (slot?.kind !== 'plugin' || !slot.pluginId || plugins.has(slot.pluginId)) continue;
      const code = sources.get(slot.pluginId);
      if (code) plugins.set(slot.pluginId, code);
      else if (!missing.includes(slot.pluginId)) missing.push(slot.pluginId);
    }
  }
  return { plugins, missing };
}
