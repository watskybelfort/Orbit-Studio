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
import { fingerprint, sha256Base64, verifyIndex } from './gallery-signature';

/** Clave en settings.json con las fuentes que uno ha añadido. */
const SETTINGS_KEY = 'pluginGallerySources';
/** Clave pública fijada de cada fuente: url → clave en base64. */
const SETTINGS_KEY_KEYS = 'pluginGalleryKeys';

/**
 * En qué estado de confianza está una fuente.
 *
 * - `unsigned`: no trae firma. Vale igual —es lo que había— pero se dice.
 * - `trusted`: firmada y con la MISMA clave que se fijó la primera vez.
 * - `pinned`: firmada, y esta es la primera vez: su clave queda fijada.
 * - `keyChanged`: firmada, pero con OTRA clave. Esto se para en seco.
 * - `badSignature`: trae firma y no cuadra con su propio contenido.
 */
export type GalleryTrust = 'unsigned' | 'trusted' | 'pinned' | 'keyChanged' | 'badSignature';

export interface GallerySource {
  url: string;
  index: GalleryIndex | null;
  error: string | null;
  loading: boolean;
  /** Cómo salió la comprobación de la firma en la última lectura. */
  trust: GalleryTrust;
  /** Huella legible de la clave que firma (o de la fijada, si cambió). */
  fingerprint?: string;
  /** Huella de la clave NUEVA cuando no coincide con la fijada. */
  newFingerprint?: string;
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

/** Claves fijadas, tal y como están guardadas. */
async function pinnedKeys(): Promise<Record<string, string>> {
  const settings = await window.orbit?.settings.get().catch(() => undefined);
  const raw = settings?.[SETTINGS_KEY_KEYS];
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [url, key] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && key.length <= 512) out[url] = key;
  }
  return out;
}

async function setPinnedKey(url: string, key: string | null): Promise<void> {
  const keys = await pinnedKeys();
  if (key === null) delete keys[url];
  else keys[url] = key;
  await window.orbit?.settings.set({ [SETTINGS_KEY_KEYS]: keys }).catch(() => undefined);
}

/**
 * Decide en qué estado queda una fuente tras leer su índice.
 *
 * El modelo es el de SSH: **se confía en la primera clave que se ve** y a
 * partir de ahí se exige que no cambie. No hay autoridad que valide a nadie —
 * cualquiera puede generar una clave y firmar lo suyo—, así que lo que aporta
 * la firma no es "esto es bueno" sino "esto lo publicó EL MISMO de siempre".
 * Por eso un cambio de clave no es un aviso: es un alto.
 */
async function checkTrust(url: string, index: GalleryIndex): Promise<Partial<GallerySource>> {
  const signature = index.signature;
  const pinned = (await pinnedKeys())[url];

  if (!signature) {
    // Una fuente que ESTABA firmada y deja de estarlo es tan sospechosa como un
    // cambio de clave: alguien ha quitado la firma por el camino.
    if (pinned !== undefined) {
      return {
        trust: 'keyChanged',
        fingerprint: await fingerprint(pinned),
        error: 'Esta galería estaba firmada y ahora llega sin firma. No se usa hasta que lo revises.',
      };
    }
    return { trust: 'unsigned' };
  }

  const result = await verifyIndex(index, signature);
  if (!result.ok) return { trust: 'badSignature', error: result.reason };

  if (pinned === undefined) {
    await setPinnedKey(url, signature.key);
    return { trust: 'pinned', fingerprint: result.fingerprint };
  }
  if (pinned !== signature.key) {
    return {
      trust: 'keyChanged',
      fingerprint: await fingerprint(pinned),
      newFingerprint: result.fingerprint,
      error: 'La firma es de otra clave distinta de la que aceptaste. No se usa hasta que lo revises.',
    };
  }
  return { trust: 'trusted', fingerprint: result.fingerprint };
}

/**
 * Acepta la clave nueva de una fuente cuya firma cambió.
 *
 * Existe porque una clave puede cambiar por motivos legítimos (se rotó, se
 * perdió), pero eso lo decide una persona mirando la huella — no la app sola.
 */
export async function trustNewKey(url: string): Promise<void> {
  const source = useGallery.getState().sources.find((s) => s.url === url);
  const key = source?.index?.signature?.key;
  if (!key) return;
  await setPinnedKey(url, key);
  useGallery.setState({ notice: 'Clave aceptada. Se vuelve a leer la galería.' });
  await loadSource(url);
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
    const trust = await checkTrust(url, index);
    // Con la clave cambiada el índice se GUARDA pero no se ofrece: la lista de
    // plugins se esconde hasta que alguien mire la huella y decida. Guardarlo
    // es lo que permite enseñar la huella nueva.
    setSource(url, { loading: false, error: null, index, ...trust });
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
    sources: urls.map((url) => ({
      url,
      index: null,
      error: null,
      loading: false,
      trust: 'unsigned' as const,
    })),
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
    sources: [
      ...s.sources,
      { url: trimmed, index: null, error: null, loading: true, trust: 'unsigned' as const },
    ],
    notice: null,
  }));
  await persist();
  await loadSource(trimmed);
}

export async function removeSource(url: string): Promise<void> {
  useGallery.setState((s) => ({ sources: s.sources.filter((source) => source.url !== url) }));
  await persist();
  // La clave fijada se va con la fuente: si mañana se vuelve a añadir, es una
  // decisión nueva y hay que volver a mirar la huella.
  await setPinnedKey(url, null);
}

/**
 * Baja el plugin, comprueba que lo sea (parseo estático) y lo deja en la
 * carpeta de plugins. Devuelve el nombre visible si entró.
 */
export async function installPlugin(plugin: GalleryPlugin, sourceUrl?: string): Promise<void> {
  const api = window.orbit;
  if (!api?.gallery || !api.plugins) return;

  /*
   * De una galería en la que no se confía no se instala nada.
   *
   * `keyChanged` y `badSignature` no son avisos que se puedan ignorar dándole a
   * un botón: en los dos casos, lo que tenemos delante no es lo que el autor
   * publicó (o no sabemos si lo es), y ese es justo el momento en el que un
   * plugin no debería acabar en el disco.
   */
  const from = sourceUrl
    ? useGallery.getState().sources.find((s) => s.url === sourceUrl)
    : undefined;
  if (from && (from.trust === 'keyChanged' || from.trust === 'badSignature')) {
    useGallery.setState({
      notice: 'De esta galería no se instala nada hasta que se resuelva lo de su firma.',
    });
    return;
  }

  useGallery.setState({ busy: plugin.id, notice: null });
  try {
    const source = await api.gallery.fetch(plugin.url);

    /*
     * El hash es lo que hace que la firma llegue hasta el código.
     *
     * La firma cubre el índice, y el índice trae el hash de cada archivo: si lo
     * que baja de la URL no da ese hash, el archivo ha cambiado desde que se
     * firmó — da igual que la URL sea la buena y que el servidor conteste 200.
     * Aquí se para.
     */
    if (plugin.sha256) {
      const got = await sha256Base64(source);
      if (got !== plugin.sha256) {
        throw new Error(
          'El archivo no coincide con lo que firmó la galería: ha cambiado desde que se publicó.',
        );
      }
    }

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
