/**
 * Lo que el render offline necesita del renderer: samples decodificados y
 * fuentes de los plugins JS.
 *
 * El kernel en vivo recibe los samples por transferencia cuando se cargan; el
 * render offline crea su propio kernel y hay que dárselos otra vez, así que se
 * decodifican aquí (con caché por id+hash para no repetir el trabajo en cada
 * export o consolidación).
 *
 * ## El caché no se vaciaba nunca
 *
 * Es la misma clase de fuga que tenía `this.samples` en `kernel-core.ts`
 * (v3.5): se escribe y no se borra. La diferencia es que ESTE caché vive en el
 * hilo de la UI, no en el de audio — menos grave, no inofensivo: cada export,
 * bounce o freeze deja aquí el audio decodificado del proyecto, y en una
 * sesión larga (o al cambiar de proyecto) eso solo crece.
 *
 * La solución del worklet (`sampleKeepSet` / `countSampleRefs` en
 * `packages/engine/src/compile.ts`, contando sobre el proyecto EDITABLE) no
 * traslada tal cual: ese conteo cubre canales, slicers, zonas de keymap y
 * clips — pero esas cuatro fuentes solo importan para decidir si un sample
 * puede sonar SIN estar registrado (`sampleIsUsed(..., keepRegistered=false)`
 * lo usa para decidir si desregistrarlo). Este caché nunca contiene una
 * entrada así: la clave (`id:hash`, ver `cacheKey`) sale de `ref.hash` en
 * `project.samples[id]`, y solo se guarda tras un `ref` válido — si el sample
 * no está registrado, se marca `missing` y nunca llega a `sampleCache.set`.
 * Por eso el keep-set correcto aquí es más simple que `sampleKeepSet`: TODO
 * `project.samples` con `keepRegistered` implícito en true (igual filosofía
 * que el valor por defecto del worklet: perder el registro cuesta una
 * relectura de disco en el próximo undo/export, así que no se abandona antes
 * de tiempo). Ver `gcRenderSampleCache`.
 */

import type { Project } from '@orbit/core';
import type { CompiledProject, SampleData } from '@orbit/engine';
import { readSampleBytes } from '../browser/sound-actions';
import { usePluginsStore } from '../state/plugins';

const sampleCache = new Map<string, SampleData>();

/** Clave de caché: identidad de CONTENIDO, no solo de id (un id re-grabado con
 * hash nuevo no debe servir el audio viejo desde caché). */
function cacheKey(id: string, hash: string): string {
  return `${id}:${hash}`;
}

/** Bytes que retiene un sample decodificado (Float32 = 4 bytes, dos canales). */
function sampleDataBytes(data: SampleData): number {
  return (data.left.length + data.right.length) * 4;
}

/** Tamaño real del caché ahora mismo — para medir, no para estimar. */
export function renderSampleCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const data of sampleCache.values()) bytes += sampleDataBytes(data);
  return { entries: sampleCache.size, bytes };
}

/**
 * Suelta del caché de render todo lo que `project` ya no registra con ese
 * hash exacto: un sample borrado del proyecto, o vuelto a grabar bajo el
 * mismo id con contenido nuevo, deja huérfana su entrada vieja.
 *
 * Por qué es seguro con un render EN MARCHA: esto solo hace `Map.delete` sobre
 * el caché, nunca toca los `SampleData` que ya se entregaron. `collectSamples`
 * devuelve su PROPIO `Map` con esas referencias, y ese Map las sigue
 * sosteniendo pase lo que pase con `sampleCache` — soltar la entrada del
 * caché no libera el buffer bajo los pies de nadie, solo hace que la PRÓXIMA
 * vez que alguien pida ese id haya que releerlo del disco. Y nunca se suelta
 * algo que la llamada en curso necesita: toda clave nace de
 * `project.samples[id].hash` del propio `project` que se le pasa, así que lo
 * que ese proyecto sigue nombrando sobrevive siempre a su propio barrido —
 * ver `collectSamples`, que llama esto DESPUÉS de resolver sus samples, nunca
 * antes.
 *
 * Sin tope numérico aparte: la cota es "lo que el proyecto abierto tiene
 * registrado ahora" (equivalente a `keepRegistered: true` del worklet).
 * Vaciar más —lo registrado que ya no usa ningún canal ni clip— ganaría
 * memoria y perdería la reutilización entre exports sucesivos del mismo
 * proyecto sin haber cambiado nada; eso es justo lo que este caché existe
 * para evitar.
 */
export function gcRenderSampleCache(project: Project): {
  before: { entries: number; bytes: number };
  after: { entries: number; bytes: number };
} {
  const before = renderSampleCacheStats();
  const live = new Set<string>();
  for (const ref of Object.values(project.samples)) {
    if (ref) live.add(cacheKey(ref.id, ref.hash));
  }
  for (const key of sampleCache.keys()) {
    if (!live.has(key)) sampleCache.delete(key);
  }
  return { before, after: renderSampleCacheStats() };
}

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
    const key = ref ? cacheKey(id, ref.hash) : id;
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
  // Después de resolver, nunca antes: barre lo que `project` ya no registra
  // con ese hash. `samples` (arriba) ya sostiene sus propias referencias, así
  // que este export/bounce en curso no pierde nada aunque el barrido se lleve
  // la entrada del caché por debajo — ver `gcRenderSampleCache`.
  gcRenderSampleCache(project);
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
