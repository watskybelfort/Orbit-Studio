/**
 * Registro de plugins JS de usuario (SDK de efectos).
 *
 * Al arrancar, scan de userData/plugins vía el puente (window.orbit.plugins):
 * cada .js válido se parsea (name/params del propio archivo, saneados) y se
 * registra en el kernel en vivo; el código fuente queda guardado para que el
 * export offline pueda pasárselo a renderProject/renderStems.
 */

import { create } from 'zustand';
import type { ParamSpec } from '@orbit/core';
import { engine } from './app';
import { parsePluginSource } from './plugin-parse';

export interface PluginInfo {
  /** Nombre de archivo sin extensión: slug estable que viaja en el proyecto. */
  id: string;
  /** Nombre visible: `const name` del archivo, o el id si no lo declara. */
  name: string;
  /** Perillas declaradas por el plugin (ya saneadas). */
  params: ParamSpec[];
  /** Se puede insertar como efecto en un slot del mixer. */
  effect: boolean;
  /** Se puede cargar como instrumento en un canal del rack. */
  instrument: boolean;
}

interface PluginsState {
  plugins: PluginInfo[];
  /** Código fuente por id (lo necesita el render offline del export). */
  sources: Map<string, string>;
}

export const usePluginsStore = create<PluginsState>(() => ({
  plugins: [],
  sources: new Map(),
}));

let started = false;

/**
 * Escanea la carpeta de plugins y los registra en el motor. Idempotente
 * (se llama una vez desde App); fuera de Electron no hace nada.
 */
export async function initPlugins(): Promise<void> {
  if (started) return;
  const api = window.orbit;
  if (!api?.plugins) return;
  started = true;

  let files: { id: string; name: string; source: string }[];
  try {
    files = await api.plugins.scan();
  } catch (e) {
    console.warn('[plugins] no se pudo escanear la carpeta de plugins:', e);
    return;
  }

  const plugins: PluginInfo[] = [];
  const sources = new Map<string, string>();
  for (const f of files) {
    const parsed = parsePluginSource(f.source);
    if (!parsed) {
      // Plugin roto (no compila, o sin createEffect ni createInstrument).
      console.warn(`[plugins] plugin ignorado (sin fábrica válida o con errores): ${f.name}`);
      continue;
    }
    plugins.push({
      id: f.id,
      name: parsed.name ?? f.id,
      params: parsed.params,
      effect: parsed.effect,
      instrument: parsed.instrument,
    });
    sources.set(f.id, f.source);
    // El motor encola los mensajes hasta que el AudioContext despierte,
    // así que registrar antes del primer gesto del usuario es seguro.
    if (parsed.effect) engine.registerPlugin(f.id, f.source);
    if (parsed.instrument) engine.registerInstrument(f.id, f.source);
  }
  usePluginsStore.setState({ plugins, sources });
}
