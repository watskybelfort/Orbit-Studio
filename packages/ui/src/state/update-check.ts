/**
 * Aviso de versión nueva: mira si hay una release más reciente publicada en
 * GitHub y, si la hay, se lo dice a la app en forma de un cartel discreto con
 * el enlace. NO es un autoUpdater: no descarga nada, no reinicia nada.
 *
 * La consulta a la red la hace el main —el renderer no tiene red, por la CSP
 * (ver apps/desktop/src/main/index.ts)— por el canal IPC `update.check()`.
 * Aquí solo se decide CUÁNDO volver a preguntarle y, con lo que contesta, si
 * toca enseñar el cartel: eso último es comparar la versión local contra la
 * remota, y para eso se reusa `isNewerVersion` de `./version-compare` en vez
 * de reescribir la comparación.
 *
 * Apagable desde Ajustes (`updateCheckEnabled`, encendido por defecto): un
 * DAW que interrumpe a mitad de una toma es peor que uno viejo. Y con
 * throttle: no se consulta en cada arranque, se guarda cuándo se miró por
 * última vez (`updateLastCheckedAt` en settings.json) y solo se vuelve a
 * preguntar pasado el intervalo.
 */

import { create } from 'zustand';
import { isNewerVersion } from './version-compare';

/** Clave de settings.json para apagar el aviso (por defecto, encendido). */
export const UPDATE_CHECK_ENABLED_KEY = 'updateCheckEnabled';
const LAST_CHECKED_KEY = 'updateLastCheckedAt';
const LATEST_KNOWN_KEY = 'updateLatestKnown';
const DISMISSED_KEY = 'updateDismissedVersion';

/**
 * Una vez al día es de sobra para un aviso: Orbit no saca quince releases en
 * una tarde, y así la app no llama a la API de GitHub en cada arranque.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface KnownRelease {
  version: string;
  url: string;
}

interface UpdateCheckState {
  /** true si hay que enseñar el cartel ahora mismo. */
  available: boolean;
  release: KnownRelease | null;
}

export const useUpdateCheck = create<UpdateCheckState>(() => ({
  available: false,
  release: null,
}));

function parseKnownRelease(raw: unknown): KnownRelease | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r['version'] === 'string' && typeof r['url'] === 'string'
    ? { version: r['version'], url: r['url'] }
    : null;
}

/**
 * La lógica de decisión: local vs remota. Pura, sin IPC ni settings, para
 * poder probarla sola. Tres motivos para NO enseñar nada: no hay ninguna
 * release conocida, la conocida no es más nueva que la instalada, o esta
 * versión concreta ya se descartó (el usuario cerró el cartel para ella).
 */
export function decideBanner(
  localVersion: string,
  latest: KnownRelease | null,
  dismissedVersion: string | null,
): KnownRelease | null {
  if (!latest) return null;
  if (!isNewerVersion(latest.version, localVersion)) return null;
  if (latest.version === dismissedVersion) return null;
  return latest;
}

/**
 * ¿Toca volver a preguntarle al main? EL throttle: el main no lleva el suyo
 * (`ipcMain.handle('update:check', …)` en index.ts llama a
 * `fetchLatestRelease()` sin condición, confiando en que el renderer no
 * invoque el canal más de la cuenta) — hubo una segunda copia de esta misma
 * cuenta en el main (`shouldRecheck`) que nadie llamaba en producción, y se
 * quitó por muerta. Esta es la única que de verdad decide cuándo se vuelve a
 * mirar, así que grabar `LAST_CHECKED_KEY` en todos los caminos de
 * `initUpdateCheck` (éxito Y fallo) es lo que hace que este throttle cumpla
 * lo que promete.
 */
export function dueToRecheck(
  lastCheckedAt: number | undefined,
  now: number,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (typeof lastCheckedAt !== 'number' || !Number.isFinite(lastCheckedAt)) return true;
  return now - lastCheckedAt >= intervalMs;
}

/**
 * Arranca el aviso. Primero enseña de entrada lo último que ya se sabía (si
 * sigue siendo más nuevo y no se descartó) — así el cartel no depende de que
 * la red esté disponible en ESTE arranque. Después, si toca por el throttle,
 * vuelve a preguntarle al main y actualiza lo que haga falta.
 *
 * Se llama una vez al montar la app; sin `window.orbit` (UI corriendo fuera
 * de Electron) o con el aviso apagado en Ajustes, no hace nada.
 */
export async function initUpdateCheck(): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  const settings = await api.settings.get().catch(() => undefined);
  if (!settings || settings[UPDATE_CHECK_ENABLED_KEY] === false) return;

  const info = await api.app.info().catch(() => undefined);
  if (!info) return;
  const localVersion = info.version;

  const dismissed =
    typeof settings[DISMISSED_KEY] === 'string' ? (settings[DISMISSED_KEY] as string) : null;
  const cached = parseKnownRelease(settings[LATEST_KNOWN_KEY]);
  const shown = decideBanner(localVersion, cached, dismissed);
  if (shown) useUpdateCheck.setState({ available: true, release: shown });

  const lastCheckedAt =
    typeof settings[LAST_CHECKED_KEY] === 'number' ? (settings[LAST_CHECKED_KEY] as number) : undefined;
  const now = Date.now();
  if (!dueToRecheck(lastCheckedAt, now, UPDATE_CHECK_INTERVAL_MS)) return;

  // Falla en silencio: sin red, `update.check()` devuelve null y aquí no se
  // enseña ni cartel de error ni nada — pero el throttle SÍ se graba igual
  // (justo abajo): sin eso, `lastCheckedAt` se quedaba en la última vez que
  // hubo red, `dueToRecheck` seguía diciendo que tocaba mirar en cada
  // arranque siguiente, y la app volvía a golpear la API de GitHub cada vez
  // en vez de una vez cada 24h — justo lo que este comentario dice que no
  // pasa. Con red inestable, o varias instancias detrás de la misma IP, eso
  // choca contra el límite de 60 peticiones/hora anónimas de GitHub.
  const latest = await api.update.check().catch(() => null);

  const settingsPatch: Record<string, unknown> = { [LAST_CHECKED_KEY]: now };
  if (latest) settingsPatch[LATEST_KNOWN_KEY] = latest;
  await api.settings.set(settingsPatch).catch(() => undefined);
  if (!latest) return;

  const next = decideBanner(localVersion, latest, dismissed);
  useUpdateCheck.setState({ available: next !== null, release: next });
}

/** El usuario cerró el cartel: no se vuelve a enseñar para ESTA versión. */
export function dismissUpdate(): void {
  const release = useUpdateCheck.getState().release;
  useUpdateCheck.setState({ available: false });
  if (release) {
    void window.orbit?.settings.set({ [DISMISSED_KEY]: release.version }).catch(() => undefined);
  }
}

/** Ajustes → interruptor. Al apagar, el cartel se va en el acto (si estaba). */
export async function setUpdateCheckEnabled(on: boolean): Promise<void> {
  await window.orbit?.settings.set({ [UPDATE_CHECK_ENABLED_KEY]: on }).catch(() => undefined);
  if (!on) useUpdateCheck.setState({ available: false, release: null });
}
