/**
 * Aviso de versión nueva: consulta la API de releases de GitHub del propio
 * repo (watskybelfort/Orbit-Studio). Esto NO es un autoUpdater — no descarga
 * nada ni reinicia nada, solo mira si hay algo más nuevo publicado y, si lo
 * hay, el renderer enseña un cartel con el enlace.
 *
 * La consulta va en el main porque el renderer no tiene red: la CSP se lo
 * prohíbe a propósito (ver index.ts, "Content-Security-Policy") porque ahí
 * corre código que no es nuestro — los plugins JS del usuario. El resultado
 * baja al renderer por el canal IPC 'update:check'.
 *
 * A diferencia de `gallery:fetch` (URL que pone el usuario, con guarda
 * anti-SSRF completa en path-guard.ts), el host de aquí es fijo y propio
 * (api.github.com) — no hay una URL ajena que validar. Lo que sí se respeta
 * igual: timeout, tope de tamaño, y fallo EN SILENCIO. Un cartel de error por
 * no poder comprobar la versión no le sirve a nadie.
 *
 * Lo puro de aquí (parsear la respuesta) vive aparte para poder probarlo sin
 * Electron delante — igual que path-guard.ts.
 *
 * Este archivo NO lleva throttle propio (`ipcMain.handle('update:check', …)`
 * en index.ts llama a `fetchLatestRelease()` sin condición): cuándo tocaba
 * volver a mirar ya lo decidió el renderer antes de invocar el canal
 * (`dueToRecheck` en `packages/ui/src/state/update-check.ts`, contra
 * `updateLastCheckedAt` en settings.json). Hubo una segunda copia de esa
 * misma cuenta aquí (`shouldRecheck`) que nadie llamaba en producción —cinco
 * tests propios sobre una función muerta— y se quitó: un throttle que vive en
 * dos sitios y solo se usa en uno es peor que uno solo, porque el que no se
 * usa se puede desincronizar del real sin que ningún test lo note.
 */

export const UPDATE_REPO = 'watskybelfort/Orbit-Studio';
const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 8_000;
/** De sobra para el JSON de una release; una respuesta más grande es rara. */
const MAX_BYTES = 256 * 1024;

/** Lo mínimo que le interesa al renderer de la última release publicada. */
export interface LatestRelease {
  /** Tag sin la "v" inicial (GitHub publica "v3.4.0"; nosotros comparamos "3.4.0"). */
  version: string;
  /** Página de la release en GitHub, para el enlace del cartel. */
  url: string;
}

/**
 * Parsea el JSON de GET /repos/{repo}/releases/latest.
 *
 * El endpoint `/latest` de GitHub ya excluye drafts y prereleases por su
 * cuenta, pero se revalida aquí por si acaso: un prerelease no es "la versión
 * nueva" que le interesa a alguien en medio de una sesión de mezcla. Devuelve
 * null ante cualquier forma inesperada — mejor no avisar que avisar mal.
 */
export function parseLatestRelease(body: unknown): LatestRelease | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r['draft'] === true || r['prerelease'] === true) return null;
  const tag = r['tag_name'];
  const url = r['html_url'];
  if (typeof tag !== 'string' || typeof url !== 'string') return null;
  const version = tag.trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}/.test(version)) return null; // no tiene pinta de versión
  if (!/^https:\/\/github\.com\//i.test(url)) return null; // solo el propio GitHub
  return { version, url };
}

/**
 * Trae la última release de GitHub. Falla EN SILENCIO ante cualquier cosa:
 * sin red, host caído, 403 por rate-limit, JSON raro — todo cae a `null`.
 */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch(RELEASES_URL, {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        // La API de GitHub responde 403 sin un User-Agent identificable.
        'User-Agent': 'orbit-studio-update-check',
      },
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_BYTES) return null;
    return parseLatestRelease(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}
