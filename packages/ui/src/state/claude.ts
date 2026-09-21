/**
 * Puente Claude en el renderer: recibe tool calls del main (window.orbit.claude),
 * las ejecuta con el ToolExecutor contra el ProjectStore vivo (origin 'claude',
 * un paso de undo por tool) y publica la actividad para el panel lateral.
 */

import { create } from 'zustand';
import {
  ToolExecutor,
  type GeneratePackFn,
  type LibraryFn,
  type LibrarySound,
  type SaveFileFn,
} from '@orbit/claude-bridge';
import { loadManifest, type SoundEntry } from '@orbit/sound-library';
import { addSamplerChannels } from '../browser/sound-actions';
import { generatePack, packEntries, readPackEntries } from '../browser/pack-generator';
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
  /**
   * Petición escrita en el panel: viaja adjunta a la SIGUIENTE get_project
   * que haga Claude (MCP no permite empujarle mensajes) y se consume ahí.
   */
  pendingRequest: string | null;
}

export const useClaudeStore = create<ClaudeState>(() => ({
  connected: false,
  available: typeof window !== 'undefined' && !!window.orbit?.claude,
  entries: [],
  pendingRequest: null,
}));

/** Deja una petición para Claude (o la limpia con null). */
export function setClaudeRequest(request: string | null): void {
  useClaudeStore.setState({ pendingRequest: request && request.trim() !== '' ? request.trim() : null });
}

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

  /**
   * Packs de sonidos que pida Claude (tool generate_pack): las recetas y el
   * render viven en la UI, el executor solo pide el trabajo. Con addChannels
   * cada sonido entra además en un canal sampler por el MISMO camino que el
   * doble clic del browser — registra el sample y despacha por el bus.
   */
  const makePack: GeneratePackFn = async (request, opts) => {
    const pack = await generatePack(request);
    let added = 0;
    if (opts.addChannels) {
      // Un solo dispatch para todo el pack: la tool promete UN paso de undo y
      // con un canal por vuelta se comía un Ctrl+Z por sonido.
      const entries = await readPackEntries(pack.slug);
      await addSamplerChannels(entries, {
        ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts.label !== undefined ? { label: opts.label } : {}),
      });
      added = entries.length;
    }
    return { ...pack, added };
  };

  /**
   * Librería para las tools `list_library` / `load_sample`: el pack de fábrica
   * más los generados, con las MISMAS entradas que ve el browser — los ids y
   * las rutas de un pack van prefijados por `packEntries`, que es de donde sabe
   * `loadIntoEngine` por dónde leer el WAV.
   */
  const library: LibraryFn = {
    async list(): Promise<LibrarySound[]> {
      const entries: { entry: SoundEntry; pack: string }[] = [];

      const factoryJson = await api.library.manifest().catch(() => null);
      if (factoryJson !== null) {
        try {
          const manifest = loadManifest(factoryJson);
          for (const entry of manifest.entries) entries.push({ entry, pack: manifest.pack });
        } catch {
          // manifest a medias: igual que el browser, mejor no enseñarlo que romper
        }
      }

      for (const raw of await api.pack.list().catch(() => [])) {
        try {
          const manifest = loadManifest(raw.manifest);
          for (const entry of packEntries(raw.slug, manifest)) {
            entries.push({ entry, pack: manifest.pack });
          }
        } catch {
          // ídem
        }
      }

      return entries.map(({ entry, pack }) => ({
        id: entry.id,
        name: entry.name,
        pack,
        category: entry.category,
        ...(entry.subcategory !== undefined ? { subcategory: entry.subcategory } : {}),
        tags: entry.tags,
        durationSec: entry.durationSec,
        ...(entry.bpm !== undefined ? { bpm: entry.bpm } : {}),
        ...(entry.keyRoot !== undefined ? { keyRoot: entry.keyRoot } : {}),
      }));
    },

    async load(ids, opts): Promise<{ id: string; name: string }[]> {
      const wanted = new Set(ids);
      const found: SoundEntry[] = [];

      const factoryJson = await api.library.manifest().catch(() => null);
      if (factoryJson !== null) {
        try {
          for (const entry of loadManifest(factoryJson).entries) {
            if (wanted.has(entry.id)) found.push(entry);
          }
        } catch {
          // ídem
        }
      }
      for (const raw of await api.pack.list().catch(() => [])) {
        try {
          for (const entry of packEntries(raw.slug, loadManifest(raw.manifest))) {
            if (wanted.has(entry.id)) found.push(entry);
          }
        } catch {
          // ídem
        }
      }

      // Se respeta el ORDEN que pidió quien llama, no el del manifest: quien
      // carga bombo, bajo y hat espera esos tres canales en ese orden.
      const byId = new Map(found.map((entry) => [entry.id, entry]));
      const ordered = ids.flatMap((id) => {
        const entry = byId.get(id);
        return entry ? [entry] : [];
      });

      const before = new Set(store.project.channelOrder);
      // Las opciones del bridge (origin 'claude', etiqueta y mixerTrack) van
      // tal cual: son las que hacen que la tool sea un solo paso de undo.
      await addSamplerChannels(ordered, opts);
      return store.project.channelOrder
        .filter((id) => !before.has(id))
        .map((id) => ({ id, name: store.project.channels[id]?.name ?? id }));
    },
  };

  const executor = new ToolExecutor(
    store,
    saveFile,
    () => {
      const request = useClaudeStore.getState().pendingRequest;
      if (request) useClaudeStore.setState({ pendingRequest: null });
      return request;
    },
    makePack,
    library,
  );

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
