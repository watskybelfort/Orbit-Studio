/**
 * Galería de plugins: suscribirse a índices y traerse plugins de ahí.
 *
 * El SDK de plugins JS está desde v0.7, pero compartirlos era mandarse el .js
 * a mano. Una galería es un JSON publicado donde sea (ver
 * `docs/plugin-gallery.json` en el repo) con la lista de lo que hay y de dónde
 * bajarlo; aquí se guardan las fuentes que uno añade, se leen y se instala.
 *
 * La cadena de confianza no cambia respecto a dejar un .js en la carpeta a
 * mano, que es lo que se hacía antes: lo que baja NO se ejecuta para saber qué
 * es — se lee con el parseo ESTÁTICO de `plugin-parse.ts` (nada de `new
 * Function`), y si de ahí no sale un plugin, no se guarda. Lo que se instala
 * corre después con el mismo bypass anti-crash del kernel que cualquier otro.
 */

import { create } from 'zustand';
import { parsePluginSource } from './plugin-parse';
import { initPlugins, rescanPlugins } from './plugins';
import { isGalleryUrl, parseGalleryIndex, type GalleryIndex, type GalleryPlugin } from './gallery-index';

/** Clave en settings.json con las fuentes que uno ha añadido. */
const SETTINGS_KEY = 'pluginGallerySources';

export interface GallerySource {
  url: string;
  index: GalleryIndex | null;
  error: string | null;
  loading: boolean;
}

interface GalleryState {
  sources: GallerySource[];
  /** Ids instalados en esta sesión (para marcarlos en la lista). */
  installed: string[];
  busy: string | null;
  notice: string | null;
}

export const useGallery = create<GalleryState>(() => ({
  sources: [],
  installed: [],
  busy: null,
  notice: null,
}));

function setSource(url: string, patch: Partial<GallerySource>): void {
  useGallery.setState((s) => ({
    sources: s.sources.map((source) => (source.url === url ? { ...source, ...patch } : source)),
  }));
}

async function persist(): Promise<void> {
  const urls = useGallery.getState().sources.map((s) => s.url);
  await window.orbit?.settings.set({ [SETTINGS_KEY]: urls }).catch(() => undefined);
}

/** Trae (o re-trae) el índice de una fuente. */
export async function loadSource(url: string): Promise<void> {
  const api = window.orbit?.gallery;
  if (!api) return;
  setSource(url, { loading: true, error: null });
  try {
    const index = parseGalleryIndex(await api.fetch(url));
    if (!index) {
      setSource(url, { loading: false, error: 'Ahí no hay una galería válida', index: null });
      return;
    }
    setSource(url, { loading: false, error: null, index });
  } catch (err) {
    setSource(url, {
      loading: false,
      index: null,
      error: err instanceof Error ? err.message : 'No se pudo leer la galería',
    });
  }
}

/** Carga las fuentes guardadas (una vez, al abrir el panel). */
export async function initGallery(): Promise<void> {
  if (useGallery.getState().sources.length > 0) return;
  const settings = await window.orbit?.settings.get().catch(() => undefined);
  const raw = settings?.[SETTINGS_KEY];
  const urls = (Array.isArray(raw) ? raw : []).filter(isGalleryUrl);
  useGallery.setState({
    sources: urls.map((url) => ({ url, index: null, error: null, loading: false })),
  });
  await Promise.all(urls.map((url) => loadSource(url)));
}

export async function addSource(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!isGalleryUrl(trimmed)) {
    useGallery.setState({ notice: 'La dirección tiene que empezar por http:// o https://' });
    return;
  }
  if (useGallery.getState().sources.some((s) => s.url === trimmed)) {
    useGallery.setState({ notice: 'Esa galería ya está' });
    return;
  }
  useGallery.setState((s) => ({
    sources: [...s.sources, { url: trimmed, index: null, error: null, loading: true }],
    notice: null,
  }));
  await persist();
  await loadSource(trimmed);
}

export async function removeSource(url: string): Promise<void> {
  useGallery.setState((s) => ({ sources: s.sources.filter((source) => source.url !== url) }));
  await persist();
}

/**
 * Baja el plugin, comprueba que lo sea (parseo estático) y lo deja en la
 * carpeta de plugins. Devuelve el nombre visible si entró.
 */
export async function installPlugin(plugin: GalleryPlugin): Promise<void> {
  const api = window.orbit;
  if (!api?.gallery || !api.plugins) return;
  useGallery.setState({ busy: plugin.id, notice: null });
  try {
    const source = await api.gallery.fetch(plugin.url);
    const parsed = parsePluginSource(source);
    if (!parsed) {
      throw new Error('Eso no declara ni createEffect ni createInstrument: no es un plugin');
    }
    await api.plugins.write(`${plugin.id}.js`, source);
    // Que aparezca ya en el rack y en el mixer, sin reiniciar.
    await rescanPlugins();
    useGallery.setState((s) => ({
      installed: s.installed.includes(plugin.id) ? s.installed : [...s.installed, plugin.id],
      notice: `Instalado: ${parsed.name || plugin.name}`,
    }));
  } catch (err) {
    useGallery.setState({
      notice: err instanceof Error ? err.message : `No se pudo instalar ${plugin.name}`,
    });
  } finally {
    useGallery.setState({ busy: null });
  }
}

export async function uninstallPlugin(id: string): Promise<void> {
  const api = window.orbit?.plugins;
  if (!api) return;
  await api.remove(`${id}.js`).catch(() => undefined);
  await rescanPlugins();
  useGallery.setState((s) => ({
    installed: s.installed.filter((x) => x !== id),
    notice: `Quitado: ${id}`,
  }));
}

/** Para el arranque de la app (no bloquea nada si no hay fuentes). */
export function warmGallery(): void {
  void initGallery();
  void initPlugins();
}
