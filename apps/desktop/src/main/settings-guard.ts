/**
 * La lista de ajustes que el renderer NO puede escribir por el canal genérico
 * (`settings:set`), y la decisión de si hospedar el servidor necesita
 * confirmación explícita.
 *
 * Vive aparte de `index.ts` (que importa Electron) para poder probarlo tal
 * cual, como `path-guard` o `window-bounds`.
 */

/**
 * Claves que NO se escriben por `settings:set`.
 *
 * `userFolders` es la única lista blanca que protege `folder:scan` y
 * `folder:read` — la regla de "solo las carpetas que el usuario eligió con el
 * diálogo". Si se puede reescribir por el canal genérico de ajustes, la regla
 * la acaba poniendo quien la tenía que cumplir: un
 * `settings.set({ userFolders: ['C:\\'] })` y la guarda deja de guardar nada.
 * Las carpetas se registran por su canal propio, que solo acepta lo que salió
 * del diálogo.
 *
 * `recentProjects` va por lo mismo: es la lista blanca de `project:open-recent`
 * y solo la escribe el main cuando un diálogo confirma que el usuario eligió
 * ese archivo. Si el renderer pudiera meter rutas, "abrir un reciente" sería
 * "leer cualquier archivo del disco".
 *
 * `friends` también: es la lista blanca de a quién se puede invitar por la red
 * local (`net:invite`), y no la escribe quien tiene que cumplirla.
 *
 * `collabServerHost`/`collabServerOpen` entran desde v3.11: deciden en qué
 * interfaz escucha el servidor de colaboración que arranca la app. Escribirlas
 * desde el renderer convertía `server:start` en "expón la sala a toda la red"
 * con un solo mensaje, sin diálogo y sin que nadie lo pidiera; el servidor no
 * tiene más cerradura que el código de sala. Arrancar en una dirección abierta
 * exige ahora confirmación en el main (ver `requiresNetworkConfirmation`).
 */
export const SETTINGS_LOCKED: ReadonlySet<string> = new Set([
  'userFolders',
  'recentProjects',
  'friends',
  'collabServerHost',
  'collabServerOpen',
]);

/**
 * ¿Arrancar el servidor en este host exige confirmación del usuario? Todo lo
 * que no sea esta máquina (loopback) expone la sala a la red, y eso se pregunta
 * SIEMPRE, aunque `settings.json` ya traiga la dirección escrita a mano.
 *
 * Espejo exacto de `isOpenToNetwork` de apps/server (`src/host.ts`): se repite
 * aquí porque ese paquete no tiene entry para Vitest y la regla es una línea;
 * su test (`apps/desktop/test/settings-guard.test.ts`) fija que no se muevan
 * por separado.
 */
export function requiresNetworkConfirmation(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

/**
 * ¿Es un destino de escucha legítimo para el canal dedicado?
 *
 * El panel de colaboración SÍ necesita persistir dónde escuchar, y por eso no
 * puede quedarse con el canal genérico bloqueado: tiene el suyo
 * (`settings:set-server-host`), que valida contra esta lista antes de escribir.
 * Acepta solo loopback, "todas las redes" y una interfaz REAL de esta máquina:
 * un renderer comprometido no puede inventarse una dirección ni colar un valor
 * arbitrario en settings.json.
 */
export function isAllowedServerHost(host: string, interfaces: readonly string[]): boolean {
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0') {
    return true;
  }
  return interfaces.includes(host);
}
