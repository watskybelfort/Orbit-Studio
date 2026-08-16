/**
 * Puente Claude en el renderer: recibe tool calls del main (window.orbit.claude),
 * las ejecuta con el ToolExecutor contra el ProjectStore vivo (origin 'claude',
 * un paso de undo por tool) y publica la actividad para el panel lateral.
 */

import { create } from 'zustand';
import { ToolExecutor, type SaveFileFn } from '@orbit/claude-bridge';
import { store } from './app';

export interface ClaudeActivityEntry {
  id: number;
  tool: string;
  /** Primera línea del resultado, o el mensaje de error. */
  summary: string;
  ok: boolean;
  running: boolean;
  /** Momento de inicio (epoch ms). */
  at: number;
}

interface ClaudeState {
  /** Hay un cliente MCP (Claude Code) conectado al host WS. */
  connected: boolean;
  /** Puente disponible (estamos dentro de Electron). */
  available: boolean;
  entries: ClaudeActivityEntry[];
}

export const useClaudeStore = create<ClaudeState>(() => ({
  connected: false,
  available: typeof window !== 'undefined' && !!window.orbit?.claude,
  entries: [],
}));

const MAX_ENTRIES = 200;
let nextEntryId = 1;

function pushEntry(entry: ClaudeActivityEntry): void {
  useClaudeStore.setState((s) => ({
    entries: [...s.entries.slice(-(MAX_ENTRIES - 1)), entry],
  }));
}

function updateEntry(id: number, patch: Partial<ClaudeActivityEntry>): void {
  useClaudeStore.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  }));
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

let started = false;

/**
 * Arranca la escucha de tool calls. Idempotente; fuera de Electron no hace
 * nada. Se llama una vez desde App.
 */
export function initClaudeBridge(): void {
  if (started) return;
  const api = window.orbit;
  if (!api?.claude) return;
  started = true;

  // Guardado de WAVs que pida Claude (tool render): diálogo + escritura IPC.
  const saveFile: SaveFileFn = async (suggestedName, data) => {
    const path = await api.file.saveDialog(suggestedName);
    if (!path) throw new Error('El usuario canceló el diálogo de guardado');
    await api.file.write(path, data);
    return path;
  };

  const executor = new ToolExecutor(store, saveFile);

  api.claude.onBridgeStatus((s) => {
    useClaudeStore.setState({ connected: s.connected });
  });

  api.claude.onToolCall((req) => {
    const entryId = nextEntryId++;
    pushEntry({
      id: entryId,
      tool: req.tool,
      summary: '',
      ok: true,
      running: true,
      at: Date.now(),
    });
    void executor
      .execute(req.tool, req.args)
      .then((result) => {
        updateEntry(entryId, { running: false, ok: true, summary: firstLine(result.text) });
        api.claude.sendToolResult(req.id, result);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        updateEntry(entryId, { running: false, ok: false, summary: message });
        api.claude.sendToolResult(req.id, { error: message });
      });
  });
}
