/**
 * Índices de la galería de plugins.
 *
 * El SDK de plugins JS existe desde v0.7, pero compartirlos era "mándame el
 * .js por ahí". Una galería es, simplemente, un JSON publicado en cualquier
 * sitio (un repo, un gist, tu propio servidor) que dice qué plugins hay y de
 * dónde bajarlos. La app se suscribe a las fuentes que uno quiera.
 *
 * Este módulo es el contrato, y es DESCONFIADO a propósito: el JSON lo escribe
 * un tercero, así que aquí se valida entrada por entrada y se descarta lo que
 * no encaje en vez de dejarlo pasar a medias. Las URLs solo pueden ser http(s)
 * —nada de `file:` ni de esquemas raros— y el id, que acaba siendo un nombre
 * de archivo en la carpeta de plugins, se recorta a lo que vale en un disco.
 */

/** Id de plugin: lo que puede llamarse un archivo en userData/plugins. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_ENTRIES = 200;

export interface GalleryPlugin {
  /** Id estable dentro de la galería; será `<id>.js` en el disco. */
  id: string;
  name: string;
  /** De dónde se baja el código (http/https). */
  url: string;
  author?: string;
  description?: string;
  tags: string[];
  /** Lo que dice ser: efecto, instrumento o ambos (informativo). */
  kind?: 'effect' | 'instrument';
}

export interface GalleryIndex {
  /** Nombre visible de la galería. */
  name: string;
  description?: string;
  plugins: GalleryPlugin[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** URL de descarga válida: solo http(s), y absoluta. */
export function isPluginUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parsePlugin(raw: unknown): GalleryPlugin | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o['id'])?.toLowerCase();
  if (!id || !ID_RE.test(id)) return null;
  const url = o['url'];
  if (!isPluginUrl(url)) return null;
  const name = str(o['name']) ?? id;
  const plugin: GalleryPlugin = { id, name, url, tags: [] };
  const author = str(o['author']);
  if (author) plugin.author = author;
  const description = str(o['description']);
  if (description) plugin.description = description;
  const kind = o['kind'];
  if (kind === 'effect' || kind === 'instrument') plugin.kind = kind;
  const tags = o['tags'];
  if (Array.isArray(tags)) {
    plugin.tags = tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 8);
  }
  return plugin;
}

/**
 * JSON de una galería → índice válido. Devuelve null si no hay nada
 * aprovechable; lo que sí se puede leer se queda aunque alguna entrada esté
 * rota (una galería con un plugin mal escrito sigue sirviendo para los otros).
 */
export function parseGalleryIndex(json: string): GalleryIndex | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const list = o['plugins'];
  if (!Array.isArray(list)) return null;

  const plugins: GalleryPlugin[] = [];
  const seen = new Set<string>();
  for (const entry of list.slice(0, MAX_ENTRIES)) {
    const plugin = parsePlugin(entry);
    if (!plugin || seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    plugins.push(plugin);
  }
  if (plugins.length === 0) return null;
  const index: GalleryIndex = { name: str(o['name']) ?? 'Galería', plugins };
  const description = str(o['description']);
  if (description) index.description = description;
  return index;
}

/** URL de fuente que se puede guardar en los ajustes (misma regla). */
export function isGalleryUrl(value: unknown): value is string {
  return isPluginUrl(value);
}
