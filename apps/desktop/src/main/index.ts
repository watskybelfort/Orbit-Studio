import { app, BrowserWindow, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';

type ThemeId = 'dark' | 'light' | 'acrylic';
type Settings = Record<string, unknown>;

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

function createWindow(): BrowserWindow {
  const settings = readSettings();
  const savedTheme = settings['theme'];
  const theme: ThemeId = isThemeId(savedTheme) ? savedTheme : 'dark';

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
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
  return win;
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
}

// ─── Ciclo de vida ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
