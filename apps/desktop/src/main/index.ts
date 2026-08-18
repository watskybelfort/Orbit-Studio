import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron';
import type { WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { networkInterfaces, release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startBridgeHost, type BridgeHost } from '@orbit/claude-bridge/node/ws-host';
import { generateBridgeToken } from '@orbit/claude-bridge/node/bridge-auth';
import { childWindowId, usableBounds, type Area } from './window-bounds';
import {
  HOST_ALL,
  HOST_LOCAL,
  describeAddress,
  hostWasHonored,
  isOpenToNetwork,
  resolveHost,
  sortAddresses,
  startServer,
  type HostAddress,
  type ServerHandle,
} from '@orbit/server';

type ThemeId = 'dark' | 'light' | 'acrylic';
type Settings = Record<string, unknown>;

// QA/depuración: ORBIT_DEBUG_PORT=9223 abre el protocolo CDP en localhost (solo
// si se pide explícitamente y NUNCA en la app empaquetada: en producción, el CDP
// abierto daría control total del renderer a cualquier proceso local).
const debugPort = !app.isPackaged ? process.env['ORBIT_DEBUG_PORT'] : undefined;
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

const OPAQUE_BG = { dark: '#141518', light: '#f4f5f7' } as const;
const TRANSPARENT_BG = '#00000000';

function isThemeId(v: unknown): v is ThemeId {
  return v === 'dark' || v === 'light' || v === 'acrylic';
}

// ─── Ajustes persistidos en userData/settings.json ───────────────────────────

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function readSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Settings) : {};
  } catch {
    return {}; // primer arranque o JSON corrupto: partimos de cero
  }
}

function writeSettings(settings: Settings): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

// ─── Tema de ventana (arquitectura A del skill acrylic-theming) ──────────────
// El blur del escritorio lo compone DWM sobre la ventana entera; el CSS del
// renderer solo tiñe con alfa. `backgroundMaterial` requiere Windows 11
// (build 22000+); fuera de ahí caemos a fondo opaco.

function acrylicSupported(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(release().split('.')[2] ?? '0');
  return build >= 22000;
}

/**
 * Conmuta el tema de la ventana EN CALIENTE.
 * Devuelve `true` si el acrílico quedó realmente activo (para que el renderer
 * sepa si el vidrio existe o debe asumir fondo opaco).
 */
function applyWindowTheme(win: BrowserWindow, theme: ThemeId): boolean {
  if (theme === 'acrylic' && acrylicSupported()) {
    try {
      win.setBackgroundMaterial('acrylic');
      win.setBackgroundColor(TRANSPARENT_BG);
      return true;
    } catch {
      // el material no está disponible pese al build: cae al teardown opaco
    }
  }
  // Apagar es un teardown real (regla del skill): quitar el material del
  // compositor Y volver a pintar opaco — nada de dejar el cristal a medias.
  try {
    win.setBackgroundMaterial('none');
  } catch {
    // fuera de Windows el material no existe; el fondo opaco basta
  }
  win.setBackgroundColor(theme === 'light' ? OPAQUE_BG.light : OPAQUE_BG.dark);
  return false;
}

// ─── Content-Security-Policy ─────────────────────────────────────────────────
// Red de seguridad contra inyección: aunque el renderer es código propio, una
// CSP corta la exfiltración por fetch/XHR a hosts externos si algo llegara a
// ejecutarse (p. ej. el código de un plugin en el export). Se aplica SOLO al
// renderer empaquetado (loadFile): en desarrollo, vite inyecta un preámbulo
// inline y usa HMR, y una CSP lo rompería.
//
// Notas de por qué cada relajación: 'unsafe-eval' porque el kernel compila los
// plugins JS y el encoder MP3 con new Function; 'unsafe-inline' en style por los
// estilos en línea de React; blob: para el AudioWorklet; y connect-src ws/wss
// porque el servidor de colaboración es una URL configurable (no puede ser solo
// 'self'). El grueso —bloquear fetch/XHR/img a http(s) externos— sigue en pie.
function installCsp(): void {
  if (process.env['ELECTRON_RENDERER_URL']) return; // dev: sin CSP (vite/HMR)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

// ─── Ventanas desacopladas ───────────────────────────────────────────────────
// El renderer saca un editor a una ventana nativa con `window.open('',
// 'orbit-<id>')` y porta ahí su contenido (mismo contexto JS). Desde aquí se
// le da lo que tiene una ventana de verdad y un popup no: su sitio recordado
// entre sesiones —para que el mixer VIVA en el segundo monitor y no haya que
// arrastrarlo cada arranque— y la opción de dejarla siempre encima.

const DETACHED_BOUNDS = 'detachedBounds';
const DETACHED_ON_TOP = 'detachedAlwaysOnTop';
/** El arrastre llega en ráfaga: se apunta el sitio cuando para. */
const BOUNDS_SAVE_DELAY_MS = 400;

/** Ventana nativa de cada editor fuera, por id ('mixer', 'pianoRoll'…). */
const detachedWindows = new Map<string, BrowserWindow>();

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Áreas útiles de los monitores de AHORA (sin barra de tareas). */
function workAreas(): Area[] {
  return screen.getAllDisplays().map((d) => d.workArea);
}

/** Sitio guardado de ese editor, ya comprobado contra las pantallas actuales. */
function savedDetachedBounds(id: string, settings: Settings): ReturnType<typeof usableBounds> {
  return usableBounds(recordOf(settings[DETACHED_BOUNDS])[id], workAreas());
}

function detachedOnTop(id: string, settings: Settings): boolean {
  return recordOf(settings[DETACHED_ON_TOP])[id] === true;
}

/** Apunta dónde ha quedado la ventana (merge sobre lo que ya hubiera). */
function rememberDetachedBounds(id: string, win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized()) return;
  const settings = readSettings();
  const { x, y, width, height } = win.getBounds();
  writeSettings({
    ...settings,
    [DETACHED_BOUNDS]: { ...recordOf(settings[DETACHED_BOUNDS]), [id]: { x, y, width, height } },
  });
}

/**
 * Adopta la ventana hija recién creada. El sitio ya se le pasó al construirla
 * (en overrideBrowserWindowOptions, para que no aparezca en un lado y salte
 * al otro); aquí quedan el registro, el siempre-encima y el seguimiento.
 */
function adoptDetachedWindow(child: BrowserWindow, frameName: string): void {
  const id = childWindowId(frameName);
  if (!id) return;
  detachedWindows.set(id, child);
  if (detachedOnTop(id, readSettings())) child.setAlwaysOnTop(true);

  let timer: NodeJS.Timeout | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      rememberDetachedBounds(id, child);
    }, BOUNDS_SAVE_DELAY_MS);
  };
  child.on('move', soon);
  child.on('resize', soon);
  child.on('close', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    rememberDetachedBounds(id, child);
  });
  child.on('closed', () => {
    if (detachedWindows.get(id) === child) detachedWindows.delete(id);
  });
}

/** Cerrar la app se lleva las hijas por delante: hay que apuntarlas antes. */
function rememberAllDetachedBounds(): void {
  for (const [id, child] of detachedWindows) {
    if (!child.isDestroyed()) rememberDetachedBounds(id, child);
  }
}

// ─── Ventana principal ───────────────────────────────────────────────────────

/** Ventana viva más reciente: destino de las tool calls del puente Claude. */
let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const settings = readSettings();
  const savedTheme = settings['theme'];
  const theme: ThemeId = isThemeId(savedTheme) ? savedTheme : 'dark';

  const win = new BrowserWindow({
    title: 'Orbit Studio',
    icon: join(__dirname, '../../resources/icon.ico'),
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // Sin `frame: false`: con frame quitado del todo, DWM no compone el
    // backgroundMaterial (bug de Electron) y el acrílico sale sin blur.
    // titleBarStyle 'hidden' ya da la ventana sin barra nativa.
    titleBarStyle: 'hidden',
    backgroundColor: OPAQUE_BG.dark,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });

  // El tema persistido se aplica antes de mostrar para evitar el flash del
  // color por defecto (y para que el acrílico ya esté compuesto al aparecer).
  applyWindowTheme(win, theme);

  // Ventanas desacopladas: el renderer hace window.open('') y porta el editor
  // ahí (mismo contexto JS). Frame nativo normal — mover/cerrar es del OS.
  // SOLO se permite about:blank/'' : las ventanas hijas heredan el preload con
  // la API orbit y sandbox:false, así que abrir una URL externa aquí sería darle
  // a esa página acceso a file.write, settings, etc. Los enlaces http(s) van al
  // navegador del sistema; el resto se deniega.
  win.webContents.setWindowOpenHandler((details) => {
    const url = details.url;
    if (url !== '' && url !== 'about:blank') {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    }
    // Sitio de la última vez, si ese monitor sigue estando: va en las OPCIONES
    // de construcción (y no con un setBounds después) para que la ventana no
    // aparezca en mitad de la pantalla principal y salte al segundo monitor.
    const id = childWindowId(details.frameName);
    const saved = id ? savedDetachedBounds(id, readSettings()) : null;
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        title: 'Orbit Studio',
        icon: join(__dirname, '../../resources/icon.ico'),
        minWidth: 320,
        minHeight: 220,
        autoHideMenuBar: true,
        backgroundColor: theme === 'light' ? OPAQUE_BG.light : OPAQUE_BG.dark,
        ...(saved ?? {}),
      },
    };
  });

  win.webContents.on('did-create-window', (child, details) =>
    adoptDetachedWindow(child, details.frameName),
  );

  // La app es una SPA: nunca navega el documento de nivel superior. Cualquier
  // will-navigate a una URL distinta (un enlace, un location.href inyectado) se
  // bloquea; los http(s) se abren fuera. HMR recarga la MISMA URL, así que en
  // desarrollo no molesta.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));
  // Al cerrar la principal, las hijas se van con ella sin dar tiempo a su
  // propio 'close': su sitio se apunta desde aquí.
  win.on('close', () => rememberAllDetachedBounds());

  win.once('ready-to-show', () => win.show());

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

// ─── Puente Claude (MCP) ─────────────────────────────────────────────────────
// El host WS (packages/claude-bridge) escucha en localhost:7855; cada tool
// call se reenvía al renderer por IPC, donde el ToolExecutor la ejecuta contra
// el ProjectStore vivo, y la respuesta vuelve por la pasarela genérica
// 'claude:tool-result'.

const CLAUDE_TOOL_TIMEOUT_MS = 60_000;

let bridgeHost: BridgeHost | null = null;

// ─── Servidor de colaboración en proceso ─────────────────────────────────────
// El panel de colaboración puede arrancar el servidor (apps/server) DENTRO del
// proceso main, para no tener que abrir una terminal aparte. Escucha en
// localhost por defecto (sin auth, ver el hardening del server). Las salas se
// guardan en userData/collab-rooms (./rooms sería de solo lectura empaquetado).

let collabServer: ServerHandle | null = null;
/** Dirección que se pidió en el panel al arrancar (para saber si se cumplió). */
let collabServerWanted: string | undefined;

/**
 * IPv4 de esta máquina con las que otro puede entrar a la sala, etiquetadas y
 * ordenadas para el desplegable del panel: la del VPN primero (es la que se
 * comparte para tocar con alguien de fuera), lo virtual y el 169.254 al final.
 */
function localAddresses(): { address: string; label: string }[] {
  const found: HostAddress[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) found.push({ name, address: net.address });
    }
  }
  return sortAddresses(found).map((entry) => ({
    address: entry.address,
    label: describeAddress(entry),
  }));
}

function collabServerStatus(): {
  running: boolean;
  port?: number;
  host?: string;
  roomCapacity?: number;
  /** El servidor acepta conexiones de fuera de esta máquina. */
  openToNetwork?: boolean;
  /** Dirección que hay que dar a los demás (la elegida, o la mejor si escucha en todas). */
  shareAddress?: string;
  /** false si se pidió una IP que ya no existe y hubo que quedarse en local. */
  hostHonored?: boolean;
} {
  if (!collabServer) return { running: false };
  const host = collabServer.host;
  const openToNetwork = isOpenToNetwork(host);
  const share = host === HOST_ALL ? localAddresses()[0]?.address : host;
  return {
    running: true,
    port: collabServer.port,
    host,
    roomCapacity: collabServer.roomCapacity,
    openToNetwork,
    hostHonored: hostWasHonored(collabServerWanted, host),
    ...(openToNetwork && share !== undefined ? { shareAddress: share } : null),
  };
}

function dispatchClaudeTool(req: {
  tool: string;
  args: unknown;
}): Promise<{ text: string } | { error: string }> {
  const win =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ error: 'Orbit Studio no tiene ninguna ventana abierta' });
  }
  const id = randomUUID();
  const channel = `claude:tool-result:${id}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(channel);
      resolve({ error: `El editor no respondió a "${req.tool}" en ${CLAUDE_TOOL_TIMEOUT_MS / 1000} s` });
    }, CLAUDE_TOOL_TIMEOUT_MS);
    ipcMain.once(channel, (_event, result: unknown) => {
      clearTimeout(timer);
      resolve(normalizeToolResult(result));
    });
    win.webContents.send('claude:tool-call', { id, tool: req.tool, args: req.args });
  });
}

function normalizeToolResult(result: unknown): { text: string } | { error: string } {
  if (typeof result === 'object' && result !== null) {
    const r = result as { text?: unknown; error?: unknown };
    if (typeof r.error === 'string') return { error: r.error };
    if (typeof r.text === 'string') return { text: r.text };
  }
  return { error: 'Respuesta inválida del editor (se esperaba { text } o { error })' };
}

function startClaudeBridge(): void {
  bridgeHost = startBridgeHost({
    // Token por sesión: solo el relay MCP que lee ~/.orbit/bridge.json puede
    // hablar con el host. Corta que cualquier proceso local ejecute las tools.
    token: generateBridgeToken(),
    dispatch: dispatchClaudeTool,
    onStatus: (s) => {
      // Indicador de conexión para la UI (panel de Claude).
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('claude:bridge-status', s);
      }
    },
  });
}

// ─── Archivos (guardar WAV renderizado por Claude o por la UI) ───────────────
// Rutas permitidas para 'file:write': lo elegido en un diálogo de guardado más
// las carpetas de usuario habituales (descargas, música, documentos, escritorio,
// datos de la app y temporales). Nada de escrituras arbitrarias en disco.

const grantedWritePaths = new Set<string>();

function isWriteAllowed(target: string): boolean {
  if (grantedWritePaths.has(target)) return true;
  // 'userData' NO está: autosave, grabaciones y settings tienen sus propios
  // canales, y dejar file:write llegar ahí permitiría reescribir settings.json
  // o plantar plugins. Las carpetas de usuario son para exports.
  const roots = ['downloads', 'music', 'documents', 'desktop', 'temp'] as const;
  return roots.some((root) => {
    try {
      const base = resolvePath(app.getPath(root));
      return target === base || target.startsWith(base + '\\') || target.startsWith(base + '/');
    } catch {
      return false;
    }
  });
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function windowOf(sender: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(sender);
}

function registerIpc(): void {
  ipcMain.handle('window:minimize', (event) => {
    windowOf(event.sender)?.minimize();
  });

  ipcMain.handle('window:maximize', (event) => {
    const win = windowOf(event.sender);
    if (!win) return false;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  ipcMain.handle('window:close', (event) => {
    windowOf(event.sender)?.close();
  });

  ipcMain.handle('window:isMaximized', (event) => {
    return windowOf(event.sender)?.isMaximized() ?? false;
  });

  // Solo QA (con ORBIT_DEBUG_PORT): la ventana se pone siempre-encima a sí
  // misma para capturas de pantalla — sin SetForegroundWindow, que Windows
  // bloquea desde procesos en segundo plano y dejaría la captura sobre otra app.
  if (debugPort) {
    ipcMain.handle('debug:always-on-top', (event, on: unknown) => {
      const win = windowOf(event.sender);
      if (!win) return;
      win.setAlwaysOnTop(on === true);
      if (on === true) win.moveTop();
    });
  }

  ipcMain.handle('theme:apply', (event, theme: unknown) => {
    const win = windowOf(event.sender);
    const id: ThemeId = isThemeId(theme) ? theme : 'dark';
    const acrylicAvailable = win !== null && applyWindowTheme(win, id);
    return { acrylicAvailable };
  });

  // ── Ventanas desacopladas ─────────────────────────────────────────────────
  // El id viaja pelado ('mixer'); se valida con el mismo filtro que el
  // frameName porque acaba siendo una clave de settings.json.

  ipcMain.handle('detached:state', (_event, id: unknown) => {
    const key = typeof id === 'string' ? childWindowId(`orbit-${id}`) : null;
    return { alwaysOnTop: key !== null && detachedOnTop(key, readSettings()) };
  });

  ipcMain.handle('detached:always-on-top', (_event, id: unknown, on: unknown) => {
    const key = typeof id === 'string' ? childWindowId(`orbit-${id}`) : null;
    if (!key) return false;
    const flag = on === true;
    const win = detachedWindows.get(key);
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(flag);
    const settings = readSettings();
    writeSettings({
      ...settings,
      [DETACHED_ON_TOP]: { ...recordOf(settings[DETACHED_ON_TOP]), [key]: flag },
    });
    return flag;
  });

  ipcMain.handle('settings:get', () => readSettings());

  ipcMain.handle('settings:set', (_event, patch: unknown) => {
    const base = readSettings();
    const merged: Settings =
      typeof patch === 'object' && patch !== null ? { ...base, ...(patch as Settings) } : base;
    writeSettings(merged);
    return merged;
  });

  // ── Servidor de colaboración (arrancarlo desde el panel) ───────────────────
  ipcMain.handle('server:status', () => collabServerStatus());

  /** Direcciones de esta máquina para el desplegable de "dónde escuchar". */
  ipcMain.handle('server:interfaces', () => localAddresses());

  ipcMain.handle('server:start', async () => {
    if (collabServer) return collabServerStatus();
    const settings = readSettings();
    const capacity = settings['collabRoomCapacity'];
    // Dónde escucha lo elige el usuario en el panel (`collabServerHost`): solo
    // esta máquina, una IP concreta (la del VPN, la de la LAN…) o todas. Es una
    // decisión EXPLÍCITA porque el servidor no tiene más autenticación que el
    // código de sala; sin elección se queda en localhost. `collabServerOpen` es
    // la casilla de la 1.3.0: si estaba encendida, equivale a "todas".
    const wanted = settings['collabServerHost'];
    collabServerWanted =
      typeof wanted === 'string' && wanted.trim() !== ''
        ? wanted.trim()
        : settings['collabServerOpen'] === true
          ? HOST_ALL
          : HOST_LOCAL;
    try {
      collabServer = await startServer({
        host: resolveHost(collabServerWanted, localAddresses().map((a) => a.address)),
        roomsDir: join(app.getPath('userData'), 'collab-rooms'),
        // Cuánta gente cabe en cada sala: lo elige el usuario en el panel de
        // colaboración y se guarda en settings.json (el server lo recorta a su
        // rango, así que un valor raro no impide arrancar).
        ...(typeof capacity === 'number' ? { roomCapacity: capacity } : null),
      });
      return collabServerStatus();
    } catch (err) {
      return { running: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('server:stop', async () => {
    if (collabServer) {
      await collabServer.close();
      collabServer = null;
    }
    return collabServerStatus();
  });

  // Pasarela genérica del renderer para responder tool calls de Claude:
  // el preload manda (id, result) y aquí se re-emite al canal por-id que
  // espera dispatchClaudeTool con ipcMain.once.
  ipcMain.on('claude:tool-result', (event, id: unknown, result: unknown) => {
    if (typeof id !== 'string') return;
    ipcMain.emit(`claude:tool-result:${id}`, event, result);
  });

  // Diálogo de guardado (filtro WAV). Devuelve la ruta elegida o null.
  ipcMain.handle('file:save-dialog', async (event, defaultName: unknown) => {
    const win = windowOf(event.sender);
    const name =
      typeof defaultName === 'string' && defaultName.length > 0 ? defaultName : 'export.wav';
    const defaultPath = isAbsolute(name) ? name : join(app.getPath('music'), name);
    const options = {
      title: 'Guardar audio',
      defaultPath,
      filters: [
        { name: 'Audio WAV', extensions: ['wav'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    const chosen = resolvePath(result.filePath);
    grantedWritePaths.add(chosen); // el usuario la eligió: queda autorizada
    return chosen;
  });

  // Escritura de bytes en disco (Uint8Array o ArrayBuffer) en ruta permitida.
  ipcMain.handle('file:write', async (_event, path: unknown, data: unknown) => {
    if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
      throw new Error('file:write requiere una ruta absoluta');
    }
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else throw new Error('file:write requiere datos Uint8Array o ArrayBuffer');
    const target = resolvePath(path);
    if (!isWriteAllowed(target)) {
      throw new Error(
        `Ruta no permitida: ${target}. Usa file:save-dialog o una carpeta de usuario (descargas, música, documentos...)`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  });

  // ── Proyectos .orbit (diálogos + fs SOLO en el main) ───────────────────────

  ipcMain.handle('project:open', async (event) => {
    const win = windowOf(event.sender);
    const options = {
      title: 'Abrir proyecto',
      filters: [
        { name: 'Proyecto Orbit', extensions: ['orbit'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
      properties: ['openFile' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    const chosen = resolvePath(path);
    // El usuario abrió este .orbit por diálogo: puede guardarlo de vuelta sin
    // pedir ruta otra vez, aunque esté fuera de las carpetas de usuario.
    grantedWritePaths.add(chosen);
    const json = await readFile(path, 'utf8');
    return { path: chosen, json };
  });

  // path null = "guardar como" (diálogo); si no, sobrescribe la ruta dada.
  ipcMain.handle(
    'project:save',
    async (event, path: unknown, json: unknown, suggestedName: unknown) => {
      if (typeof json !== 'string' || json.length === 0) {
        throw new Error('project:save requiere el JSON del proyecto');
      }
      let target = typeof path === 'string' && path.length > 0 ? resolvePath(path) : null;
      if (target) {
        // Una ruta suministrada por el renderer debe estar autorizada: elegida
        // antes por diálogo (project:save/open) o en una carpeta de usuario. Si
        // no, se rechaza para que no se pueda escribir a rutas arbitrarias.
        if (!isWriteAllowed(target)) {
          throw new Error(`Ruta no permitida: ${target}. Usa "Guardar como".`);
        }
      } else {
        const win = windowOf(event.sender);
        const name =
          typeof suggestedName === 'string' && suggestedName.length > 0
            ? suggestedName
            : 'proyecto.orbit';
        const options = {
          title: 'Guardar proyecto',
          defaultPath: join(app.getPath('documents'), name),
          filters: [{ name: 'Proyecto Orbit', extensions: ['orbit'] }],
        };
        const result = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return null;
        target = resolvePath(result.filePath);
        grantedWritePaths.add(target); // el usuario la eligió: queda autorizada
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, json, 'utf8');
      return target;
    },
  );

  // ── Autosave: pending.orbit + anillo de backups en userData/autosave ───────
  // pending.orbit existe = hubo cambios sin guardar (la sesión murió o se cerró
  // sin guardar); el renderer lo ofrece como recuperación al arrancar y lo
  // limpia en cada guardado manual. El anillo conserva los últimos 5 estados.
  const AUTOSAVE_KEEP = 5;
  const autosaveDir = () => join(app.getPath('userData'), 'autosave');
  const pendingPath = () => join(autosaveDir(), 'pending.orbit');

  ipcMain.handle('autosave:write', async (_event, json: unknown) => {
    if (typeof json !== 'string' || json.length === 0) return;
    const dir = autosaveDir();
    await mkdir(dir, { recursive: true });
    for (let i = AUTOSAVE_KEEP - 1; i >= 1; i--) {
      try {
        await rename(join(dir, `backup-${i}.orbit`), join(dir, `backup-${i + 1}.orbit`));
      } catch {
        // ese hueco del anillo aún no existe
      }
    }
    try {
      await copyFile(pendingPath(), join(dir, 'backup-1.orbit'));
    } catch {
      // primer autosave de la sesión
    }
    await writeFile(pendingPath(), json, 'utf8');
  });

  ipcMain.handle('autosave:clear', async () => {
    try {
      await rm(pendingPath());
    } catch {
      // no había pendiente
    }
  });

  ipcMain.handle('autosave:check', async () => {
    try {
      const json = await readFile(pendingPath(), 'utf8');
      const info = await stat(pendingPath());
      return { json, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  });

  // ── Carpetas del usuario (packs propios en el browser) ─────────────────────
  // El renderer solo puede leer archivos DENTRO de carpetas que el usuario
  // eligió con el diálogo (persistidas en settings.json → userFolders).

  const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac']);

  function userFolders(): string[] {
    const raw = readSettings()['userFolders'];
    return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
  }

  ipcMain.handle('folder:pick', async (event) => {
    const win = windowOf(event.sender);
    const options = {
      title: 'Añadir carpeta de sonidos',
      properties: ['openDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const dir = result.filePaths[0];
    return result.canceled || !dir ? null : resolvePath(dir);
  });

  ipcMain.handle('folder:scan', async (_event, dir: unknown) => {
    if (typeof dir !== 'string') throw new Error('folder:scan requiere la ruta de la carpeta');
    const base = resolvePath(dir);
    if (!userFolders().some((f) => resolvePath(f) === base)) {
      throw new Error('Carpeta no registrada en userFolders');
    }
    const found: { file: string; name: string }[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > 4 || found.length >= 500) return;
      let items;
      try {
        items = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (found.length >= 500) return;
        const full = join(d, item.name);
        if (item.isDirectory()) await walk(full, depth + 1);
        else if (AUDIO_EXT.has(item.name.slice(item.name.lastIndexOf('.')).toLowerCase())) {
          found.push({ file: full, name: item.name.replace(/\.[^.]+$/, '') });
        }
      }
    };
    await walk(base, 0);
    return found;
  });

  ipcMain.handle('folder:read', async (_event, file: unknown) => {
    if (typeof file !== 'string') throw new Error('folder:read requiere la ruta del archivo');
    const target = resolvePath(file);
    const allowed = userFolders().some((f) => {
      const base = resolvePath(f);
      return target.startsWith(base + '\\') || target.startsWith(base + '/');
    });
    if (!allowed) throw new Error('folder:read solo sirve archivos de tus carpetas registradas');
    const buf = await readFile(target);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  // ── Import MIDI (diálogo + bytes) ──────────────────────────────────────────

  ipcMain.handle('midi:open', async (event) => {
    const win = windowOf(event.sender);
    const options = {
      title: 'Importar MIDI',
      filters: [
        { name: 'Archivos MIDI', extensions: ['mid', 'midi'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
      properties: ['openFile' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    const buf = await readFile(path);
    return {
      name: path.split(/[\\/]/).pop() ?? 'midi',
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  });

  // ── Grabaciones (tomas de micro) ───────────────────────────────────────────
  // Viven en userData/recordings; el renderer las referencia con el esquema
  // `recording:<archivo>` en SampleRef.path. recording:read solo sirve
  // archivos DENTRO de esa carpeta (mismo criterio que library:read).

  const recordingsDir = () => join(app.getPath('userData'), 'recordings');

  ipcMain.handle('recording:save', async (_event, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('recording:save requiere un nombre de archivo');
    }
    let bytes: Uint8Array;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else throw new Error('recording:save requiere datos Uint8Array o ArrayBuffer');
    const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'toma.wav';
    await mkdir(recordingsDir(), { recursive: true });
    await writeFile(join(recordingsDir(), safe), bytes);
    return safe;
  });

  ipcMain.handle('recording:read', async (_event, file: unknown) => {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('recording:read requiere el nombre del archivo');
    }
    const base = resolvePath(recordingsDir());
    const target = resolvePath(join(base, file));
    if (target !== base && !target.startsWith(base + '\\') && !target.startsWith(base + '/')) {
      throw new Error('recording:read solo sirve archivos de la carpeta de grabaciones');
    }
    const buf = await readFile(target);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  // ── Plugins JS de usuario (SDK de efectos) ─────────────────────────────────
  // Los .js viven en userData/plugins (no recursivo). El main solo lista y
  // sirve el código fuente; el renderer lo parsea (name/params del contrato)
  // y lo registra en el kernel, que lo corre con bypass automático si lanza.

  const pluginsDir = () => join(app.getPath('userData'), 'plugins');
  const PLUGINS_MAX = 100;

  ipcMain.handle('plugins:scan', async () => {
    const dir = pluginsDir();
    await mkdir(dir, { recursive: true });
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: { id: string; name: string; source: string }[] = [];
    for (const item of items) {
      if (found.length >= PLUGINS_MAX) break;
      if (!item.isFile() || !item.name.toLowerCase().endsWith('.js')) continue;
      try {
        const source = await readFile(join(dir, item.name), 'utf8');
        // id = nombre de archivo sin extensión (slug estable que viaja en el
        // proyecto); el nombre "bonito" lo saca el renderer del propio código.
        found.push({ id: item.name.replace(/\.js$/i, ''), name: item.name, source });
      } catch {
        // archivo ilegible: se salta sin romper el scan
      }
    }
    return found;
  });

  ipcMain.handle('plugins:open-folder', async () => {
    const dir = pluginsDir();
    await mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  // ── Librería de sonidos (pack de fábrica) ──────────────────────────────────
  // En desarrollo el pack vive en packages/sound-library/factory; empaquetado,
  // en resources/sound-library. library:read solo sirve archivos DENTRO del pack.

  const factoryDir = (): string =>
    app.isPackaged
      ? join(process.resourcesPath, 'sound-library')
      : join(app.getAppPath(), '..', '..', 'packages', 'sound-library', 'factory');

  ipcMain.handle('library:manifest', async () => {
    try {
      return await readFile(join(factoryDir(), 'manifest.json'), 'utf8');
    } catch {
      return null; // pack aún no generado
    }
  });

  ipcMain.handle('library:read', async (_event, file: unknown) => {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('library:read requiere la ruta relativa del manifest');
    }
    const base = resolvePath(factoryDir());
    const target = resolvePath(base, file);
    if (target !== base && !target.startsWith(base + '\\') && !target.startsWith(base + '/')) {
      throw new Error(`Ruta fuera del pack: ${file}`);
    }
    const bytes = await readFile(target);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
}

// ─── Ciclo de vida ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  installCsp();
  registerIpc();
  startClaudeBridge();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  bridgeHost?.close();
  bridgeHost = null;
  void collabServer?.close();
  collabServer = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
