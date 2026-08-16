/**
 * Browser de la librería de sonidos (sidebar izquierda).
 *
 * Carga el manifest del pack de fábrica por el puente de Electron
 * (window.orbit.library) y lo pinta como árbol: categoría (colapsable) →
 * subcategoría → entradas. Buscador en cabecera (nombre, tags, subcategoría,
 * sin distinción de mayúsculas ni acentos).
 *
 * - Clic en una entrada: preview por el kernel (loadSample cachea por id).
 * - Doble clic: añade un canal sampler (lógica en sound-actions.ts).
 * - Arrastre: al Channel Rack crea canal sampler; a la Playlist, clip de audio.
 *
 * Fuera de Electron (sin window.orbit) muestra un estado vacío elegante.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CATEGORY_LABELS,
  loadManifest,
  SOUND_CATEGORIES,
  type SoundCategory,
  type SoundEntry,
  type SoundManifest,
} from '@orbit/sound-library';
import { engine, ensureAudioReady } from '../state/app';
import { addSamplerChannel, loadIntoEngine, setDragEntry } from './sound-actions';
import './browser.css';

// ── Estado de la librería ────────────────────────────────────────────────────

type LibState =
  | { status: 'cargando' }
  | { status: 'sin-electron' }
  | { status: 'sin-pack' }
  | { status: 'error'; message: string }
  | { status: 'ok'; manifest: SoundManifest };

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minúsculas y sin acentos, para buscar sin distinción. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** "0.8 s" para cortos, "12 s" para largos. */
function formatDuration(sec: number): string {
  return sec >= 10 ? `${Math.round(sec)} s` : `${sec.toFixed(1)} s`;
}

/** "trap" → "Trap" (etiqueta de subcategoría). */
function subLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface SubGroup {
  /** '' = entradas sueltas de la categoría (van primero). */
  name: string;
  entries: SoundEntry[];
}

interface CatGroup {
  category: SoundCategory;
  total: number;
  groups: SubGroup[];
}

/** Agrupa las entradas filtradas: categoría (orden fijo) → subcategoría. */
function buildTree(manifest: SoundManifest, query: string): CatGroup[] {
  const q = normalize(query.trim());
  const matches = (e: SoundEntry): boolean => {
    if (q === '') return true;
    if (normalize(e.name).includes(q)) return true;
    if (e.subcategory !== undefined && normalize(e.subcategory).includes(q)) return true;
    return e.tags.some((t) => normalize(t).includes(q));
  };

  const out: CatGroup[] = [];
  for (const category of SOUND_CATEGORIES) {
    const entries = manifest.entries.filter((e) => e.category === category && matches(e));
    if (entries.length === 0) continue;
    const bySub = new Map<string, SoundEntry[]>();
    for (const e of entries) {
      const key = e.subcategory ?? '';
      const list = bySub.get(key);
      if (list) list.push(e);
      else bySub.set(key, [e]);
    }
    const groups: SubGroup[] = [...bySub.entries()]
      .map(([name, list]) => ({ name, entries: list }))
      .sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : a.name.localeCompare(b.name)));
    out.push({ category, total: entries.length, groups });
  }
  return out;
}

// ── Componente ───────────────────────────────────────────────────────────────

export function Browser() {
  const [lib, setLib] = useState<LibState>({ status: 'cargando' });
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<SoundCategory>>(new Set());
  /** Id de la entrada sonando (indicador visual del preview). */
  const [playingId, setPlayingId] = useState<string | null>(null);
  /** Texto de estado discreto en el pie ("Cargando…" / error). */
  const [status, setStatus] = useState<string | null>(null);
  const previewTimer = useRef<number | null>(null);

  // Carga del manifest al montar.
  useEffect(() => {
    let cancelled = false;
    const api = window.orbit;
    if (!api) {
      setLib({ status: 'sin-electron' });
      return;
    }
    api.library
      .manifest()
      .then((json) => {
        if (cancelled) return;
        if (json === null) setLib({ status: 'sin-pack' });
        else setLib({ status: 'ok', manifest: loadManifest(json) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLib({
          status: 'error',
          message: err instanceof Error ? err.message : 'Error leyendo el manifest',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Limpia el timer del indicador de preview al desmontar.
  useEffect(
    () => () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    },
    [],
  );

  const tree = useMemo(
    () => (lib.status === 'ok' ? buildTree(lib.manifest, query) : []),
    [lib, query],
  );

  const searching = query.trim() !== '';

  const toggleCategory = (category: SoundCategory) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  // Clic: preview del sample por el kernel.
  const preview = async (entry: SoundEntry) => {
    ensureAudioReady();
    setStatus(null);
    try {
      await loadIntoEngine(entry);
      engine.previewSample(entry.id, entry.gainSuggestion ?? 0.9);
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      setPlayingId(entry.id);
      previewTimer.current = window.setTimeout(
        () => setPlayingId(null),
        Math.max(200, Math.ceil(entry.durationSec * 1000)),
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : `No se pudo leer "${entry.name}"`);
    }
  };

  // Doble clic: canal sampler nuevo (lógica compartida con el drop del rack).
  const addToProject = async (entry: SoundEntry) => {
    ensureAudioReady();
    setStatus(null);
    try {
      await addSamplerChannel(entry);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : `No se pudo añadir "${entry.name}"`);
    }
  };

  // ── Estados vacíos ─────────────────────────────────────────────────────────

  let body: ReactNode;
  if (lib.status === 'cargando') {
    body = <div className="browser-empty">Cargando librería…</div>;
  } else if (lib.status === 'sin-electron') {
    body = (
      <div className="browser-empty">
        <div className="browser-empty-title">Librería no disponible</div>
        <div>Abre Orbit Studio en Electron para explorar los sonidos de fábrica.</div>
      </div>
    );
  } else if (lib.status === 'sin-pack') {
    body = (
      <div className="browser-empty">
        <div className="browser-empty-title">Pack de fábrica no generado</div>
        <div>Genera el pack Orbit Essentials para llenar el browser.</div>
      </div>
    );
  } else if (lib.status === 'error') {
    body = <div className="browser-empty">{lib.message}</div>;
  } else if (tree.length === 0) {
    body = <div className="browser-empty">Sin resultados para «{query.trim()}»</div>;
  } else {
    body = tree.map(({ category, total, groups }) => {
      const isClosed = !searching && closed.has(category);
      return (
        <section key={category} className="browser-cat">
          <button
            type="button"
            className="browser-cat-head"
            onClick={() => toggleCategory(category)}
            aria-expanded={!isClosed}
          >
            <span className="browser-caret">{isClosed ? '▸' : '▾'}</span>
            <span className="browser-cat-name">{CATEGORY_LABELS[category]}</span>
            <span className="browser-cat-count">{total}</span>
          </button>
          {!isClosed &&
            groups.map((group) => (
              <div key={group.name || '·'} className="browser-sub">
                {group.name !== '' && (
                  <div className="browser-sub-name">{subLabel(group.name)}</div>
                )}
                {group.entries.map((entry) => {
                  const playing = playingId === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={playing ? 'browser-entry playing' : 'browser-entry'}
                      draggable
                      onDragStart={(e) => setDragEntry(e.dataTransfer, entry)}
                      onClick={() => void preview(entry)}
                      onDoubleClick={() => void addToProject(entry)}
                      title={`${entry.name} — clic: escuchar · doble clic: añadir · arrastra al rack o a la playlist`}
                    >
                      <span className="browser-entry-dot" aria-hidden="true" />
                      <span className="browser-entry-name">{entry.name}</span>
                      {entry.keyRoot !== undefined && (
                        <span className="browser-badge">{entry.keyRoot}</span>
                      )}
                      {entry.bpm !== undefined && (
                        <span className="browser-badge">{entry.bpm} BPM</span>
                      )}
                      <span className="browser-entry-dur">
                        {formatDuration(entry.durationSec)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
        </section>
      );
    });
  }

  return (
    <div className="browser">
      <div className="browser-head">
        <div className="browser-title">
          Librería
          {lib.status === 'ok' && (
            <span className="browser-pack">
              {lib.manifest.pack} · {lib.manifest.entries.length}
            </span>
          )}
        </div>
        <input
          type="search"
          className="browser-search"
          placeholder="Buscar (nombre, tag, grupo)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="browser-body">{body}</div>
      {status !== null && <div className="browser-status">{status}</div>}
    </div>
  );
}
