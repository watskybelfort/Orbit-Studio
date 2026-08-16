import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startBridgeHost, type BridgeHost } from '@orbit/claude-bridge/node/ws-host';

type ThemeId = 'dark' | 'light' | 'acrylic';
type Settings = Record<string, unknown>;

// QA/depuración: ORBIT_DEBUG_PORT=9223 abre el protocolo CDP en localhost
// (solo si se pide explícitamente; nunca por defecto).
if (process.env['ORBIT_DEBUG_PORT']) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['ORBIT_DEBUG_PORT']);
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

  win.on('maximize', () => win.webContents.send('window:maximized-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized-changed', false));

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
  const roots = ['downloads', 'music', 'documents', 'desktop', 'userData', 'temp'] as const;
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
  if (process.env['ORBIT_DEBUG_PORT']) {
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

  ipcMain.handle('settings:get', () => readSettings());

  ipcMain.handle('settings:set', (_event, patch: unknown) => {
    const base = readSettings();
    const merged: Settings =
      typeof patch === 'object' && patch !== null ? { ...base, ...(patch as Settings) } : base;
    writeSettings(merged);
    return merged;
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
    const json = await readFile(path, 'utf8');
    return { path: resolvePath(path), json };
  });

  // path null = "guardar como" (diálogo); si no, sobrescribe la ruta dada.
  ipcMain.handle(
    'project:save',
    async (event, path: unknown, json: unknown, suggestedName: unknown) => {
      if (typeof json !== 'string' || json.length === 0) {
        throw new Error('project:save requiere el JSON del proyecto');
      }
      let target = typeof path === 'string' && path.length > 0 ? resolvePath(path) : null;
      if (!target) {
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
