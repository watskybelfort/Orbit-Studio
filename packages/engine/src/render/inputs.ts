import type { CompiledProject } from '../protocol';

/** Identidades que necesita cualquier kernel offline: sampler, zonas y playlist. */
export function neededSampleIds(compiled: CompiledProject): Set<string> {
  const needed = new Set<string>();
  for (const channel of compiled.channels) {
    if (channel.sampleId) needed.add(channel.sampleId);
    for (const zone of channel.keymap ?? []) needed.add(zone.sampleId);
  }
  for (const clip of compiled.audioClips) needed.add(clip.sampleId);
  return needed;
}

/** Fuentes JS que el kernel instancia, incluidos instrumentos e inserts de canal. */
export function neededPluginIds(compiled: CompiledProject): Set<string> {
  const needed = new Set<string>();
  for (const channel of compiled.channels) {
    if (channel.instrumentPluginId) needed.add(channel.instrumentPluginId);
    for (const slot of channel.fx ?? []) {
      if (slot?.kind === 'plugin' && slot.pluginId) needed.add(slot.pluginId);
    }
  }
  for (const track of compiled.mixer) {
    for (const slot of track.slots) {
      if (slot?.kind === 'plugin' && slot.pluginId) needed.add(slot.pluginId);
    }
  }
  return needed;
}
