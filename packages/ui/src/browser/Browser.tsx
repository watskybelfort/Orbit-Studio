/**
 * Browser de la librería de sonidos (sidebar izquierda).
 *
 * Carga el manifest del pack de fábrica por el puente de Electron
 * (window.orbit.library) y lo pinta como árbol: categoría (colapsable) →
 * subcategoría → entradas. Encima, filtros combinables (texto, categoría,
 * género/tag, tonalidad y rango de BPM) con el conteo de resultados y un botón
 * de limpiar; vistas de Favoritos y de colecciones; y una perilla de volumen
 * para el preview.
 *
 * - Clic en una entrada: preview por el kernel (loadSample cachea por id).
 * - Doble clic: añade un canal sampler (lógica en sound-actions.ts).
 * - Arrastre: al Channel Rack crea canal sampler; a la Playlist, clip de audio.
 * - Estrella: favorito · "+": añadir a una colección.
 *
 * Los archivos de las carpetas del usuario se indexan solos (BPM y tonalidad
 * estimados, ver analysis-queue.ts) sin bloquear la vista y sin recalcular.
 *
 * Fuera de Electron (sin window.orbit) muestra un estado vacío elegante.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CATEGORY_LABELS,
  loadManifest,
  PACK_FAMILIES,
  PACK_STYLES,
  SOUND_CATEGORIES,
  type PackFamily,
  type PackStyle,
  type SoundCategory,
  type SoundEntry,
  type SoundManifest,
} from '@orbit/sound-library';
import { engine, ensureAudioReady } from '../state/app';
import { Knob } from '../widgets/Knob';
import { addSamplerChannel, loadIntoEngine, setDragEntry } from './sound-actions';
import { pendingAnalysis, queueAnalysis } from './analysis-queue';
import { generatePack, packEntries } from './pack-generator';
import {
  BPM_MAX,
  BPM_MIN,
  buildFacets,
  countActiveFilters,
  EMPTY_FILTERS,
  filterEntries,
  hasActiveFilters,
  type BrowserFilters,
  type MatchContext,
} from './filters';
import {
  createCollection,
  deleteCollection,
  forgetAnalysis,
  loadPrefs,
  setPreviewGain,
  toggleFavorite,
  toggleInCollection,
  usePrefs,
} from './library-prefs';
import './browser.css';

// ── Estado de la librería ────────────────────────────────────────────────────

type LibState =
  | { status: 'cargando' }
  | { status: 'sin-electron' }
  | { status: 'sin-pack' }
  | { status: 'error'; message: string }
  | { status: 'ok'; manifest: SoundManifest };

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "0.8 s" para cortos, "12 s" para largos. */
function formatDuration(sec: number): string {
  return sec >= 10 ? `${Math.round(sec)} s` : `${sec.toFixed(1)} s`;
}

/** "trap" → "Trap" (etiqueta de subcategoría). */
function subLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Campo de BPM del filtro: vacío o basura → el valor por defecto del extremo. */
function clampBpm(raw: string, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(n)));
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

/** Agrupa las entradas ya filtradas: categoría (orden fijo) → subcategoría. */
function buildTree(entries: readonly SoundEntry[]): CatGroup[] {
  const out: CatGroup[] = [];
  for (const category of SOUND_CATEGORIES) {
    const list = entries.filter((e) => e.category === category);
    if (list.length === 0) continue;
    const bySub = new Map<string, SoundEntry[]>();
    for (const e of list) {
      const key = e.subcategory ?? '';
      const group = bySub.get(key);
      if (group) group.push(e);
      else bySub.set(key, [e]);
    }
    const groups: SubGroup[] = [...bySub.entries()]
      .map(([name, items]) => ({ name, entries: items }))
      .sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : a.name.localeCompare(b.name)));
    out.push({ category, total: list.length, groups });
  }
  return out;
}


/** Nombres visibles del generador de packs. */
const PACK_FAMILY_LABELS: Record<PackFamily, string> = {
  kicks: 'Kicks',
  snares: 'Snares',
  claps: 'Claps',
  hats: 'Hats',
  openhats: 'Open hats',
  percs: 'Percusión',
  '808s': '808s',
  impacts: 'Impactos',
  risers: 'Risers',
  downlifters: 'Downlifters',
};

const PACK_STYLE_LABELS: Record<PackStyle, string> = {
  trap: 'Trap',
  drill: 'Drill',
  boombap: 'Boom bap',
  latin: 'Latino',
  house: 'House',
  techno: 'Techno',
  lofi: 'Lo-fi',
};

// ── Componente ───────────────────────────────────────────────────────────────

export function Browser() {
  const [lib, setLib] = useState<LibState>({ status: 'cargando' });
  const [filters, setFilters] = useState<BrowserFilters>(EMPTY_FILTERS);
  const [panelOpen, setPanelOpen] = useState(false);
  const [closed, setClosed] = useState<ReadonlySet<SoundCategory>>(new Set());
  /** Id de la entrada sonando (indicador visual del preview). */
  const [playingId, setPlayingId] = useState<string | null>(null);
  /** Texto de estado discreto en el pie ("Cargando…" / error). */
  const [status, setStatus] = useState<string | null>(null);
  /** Entrada cuyo menú de colecciones está abierto. */
  const [collectionMenu, setCollectionMenu] = useState<SoundEntry | null>(null);
  /** Archivos de usuario aún en la cola de análisis (redibuja el aviso). */
  const [analizando, setAnalizando] = useState(0);
  /** Packs generados en la app (userData/packs), con su manifest. */
  const [packs, setPacks] = useState<{ slug: string; manifest: SoundManifest }[]>([]);
  /** Encargo del generador y su progreso ("3 / 12 · Hat drill 03"). */
  const [packForm, setPackForm] = useState<{ family: PackFamily; style: PackStyle; count: number }>({
    family: 'hats',
    style: 'trap',
    count: 8,
  });
  const [packBusy, setPackBusy] = useState<string | null>(null);
  const previewTimer = useRef<number | null>(null);

  const { favorites, collections, previewGain, analysis } = usePrefs();

  // Carga del manifest y de las preferencias al montar.
  useEffect(() => {
    void loadPrefs();
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

  // ── Carpetas del usuario (packs propios, persistidas en settings) ──────────

  const [folders, setFolders] = useState<string[]>([]);
  const [folderFiles, setFolderFiles] = useState<Record<string, { file: string; name: string }[]>>(
    {},
  );

  useEffect(() => {
    const api = window.orbit;
    if (!api) return;
    void api.settings.get().then((s) => {
      const raw = s['userFolders'];
      const list = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
      setFolders(list);
      for (const dir of list) {
        void api.folder
          .scan(dir)
          .then((files) => setFolderFiles((p) => ({ ...p, [dir]: files })))
          .catch(() => setStatus(`No se pudo leer ${dir}`));
      }
    });
  }, []);

  const addFolder = async () => {
    const api = window.orbit;
    if (!api) return;
    const dir = await api.folder.pick();
    if (!dir || folders.includes(dir)) return;
    const next = [...folders, dir];
    setFolders(next);
    // Persistir ANTES de escanear: el main valida contra settings.
    await api.settings.set({ userFolders: next });
    try {
      const files = await api.folder.scan(dir);
      setFolderFiles((p) => ({ ...p, [dir]: files }));
    } catch {
      setStatus(`No se pudo escanear ${dir}`);
    }
  };

  // ── Packs generados (userData/packs) ──────────────────────────────────────
  // Mismo formato que el pack de fábrica, así que el árbol no cambia: solo
  // hay que traerlos y prefijar sus ids/rutas con el pack al que pertenecen.

  const refreshPacks = async (): Promise<{ slug: string; manifest: SoundManifest }[]> => {
    const api = window.orbit;
    if (!api) return [];
    try {
      const raw = await api.pack.list();
      const parsed = raw.flatMap((p) => {
        try {
          return [{ slug: p.slug, manifest: loadManifest(p.manifest) }];
        } catch {
          return []; // manifest a medias: mejor no enseñarlo que romper el browser
        }
      });
      setPacks(parsed);
      return parsed;
    } catch {
      return [];
    }
  };

  useEffect(() => {
    void refreshPacks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Genera un pack con el motor y lo deja listo en el browser. */
  const runGenerate = async () => {
    if (packBusy !== null) return;
    setStatus(null);
    setPackBusy('Preparando…');
    try {
      const pack = await generatePack(packForm, {
        taken: packs.map((p) => p.slug),
        onProgress: (done, total, name) => setPackBusy(`${done} / ${total} · ${name}`),
      });
      await refreshPacks();
      setStatus(`Pack "${pack.name}": ${pack.count} sonidos`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'No se pudo generar el pack');
    } finally {
      setPackBusy(null);
    }
  };

  const removePack = async (slug: string, name: string) => {
    try {
      await window.orbit?.pack.remove(slug);
      await refreshPacks();
      setStatus(`Pack "${name}" borrado`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'No se pudo borrar el pack');
    }
  };

  const removeFolder = (dir: string) => {
    const next = folders.filter((f) => f !== dir);
    setFolders(next);
    void window.orbit?.settings.set({ userFolders: next });
    forgetAnalysis(dir);
  };

  /**
   * Entrada de un archivo del usuario, con el BPM y la tonalidad que haya
   * estimado el indexador (el manifest de fábrica siempre manda sobre esto,
   * pero aquí no hay manifest: son archivos sueltos).
   */
  const userEntry = useMemo(
    () =>
      (f: { file: string; name: string }): SoundEntry => {
        const entry: SoundEntry = {
          id: `user:${f.file}`,
          name: f.name,
          category: 'fx',
          file: f.file,
          tags: [],
          durationSec: 0,
        };
        const a = analysis[f.file];
        if (a?.bpm !== undefined) entry.bpm = a.bpm;
        if (a?.keyRoot !== undefined) entry.keyRoot = a.keyRoot;
        // Con la duración real, soltar el archivo en la playlist crea un clip
        // de la longitud correcta (el escaneo de carpeta no la trae).
        if (a?.durationSec !== undefined) entry.durationSec = a.durationSec;
        return entry;
      },
    [analysis],
  );

  const userEntriesByDir = useMemo(() => {
    const out: Record<string, SoundEntry[]> = {};
    for (const dir of folders) out[dir] = (folderFiles[dir] ?? []).map(userEntry);
    return out;
  }, [folders, folderFiles, userEntry]);

  // ── Filtros ───────────────────────────────────────────────────────────────

  const factoryEntries = useMemo(
    () => (lib.status === 'ok' ? lib.manifest.entries : []),
    [lib],
  );

  /**
   * Entradas de los packs generados. El manifest de cada pack trae rutas
   * relativas a SU carpeta: aquí se les antepone el pack (y el esquema
   * `pack:` al id) para que loadIntoEngine sepa por dónde leerlas.
   */
  const packEntriesBySlug = useMemo(() => {
    const out: Record<string, SoundEntry[]> = {};
    for (const pack of packs) out[pack.slug] = packEntries(pack.slug, pack.manifest);
    return out;
  }, [packs]);

  const facets = useMemo(
    () =>
      buildFacets([
        ...factoryEntries,
        ...Object.values(packEntriesBySlug).flat(),
        ...Object.values(userEntriesByDir).flat(),
      ]),
    [factoryEntries, packEntriesBySlug, userEntriesByDir],
  );

  const ctx: MatchContext = useMemo(() => {
    const ids = filters.collection !== null ? collections[filters.collection] : undefined;
    return { favorites, collectionIds: ids ? new Set(ids) : null };
  }, [favorites, collections, filters.collection]);

  const filteredFactory = useMemo(
    () => filterEntries(factoryEntries, filters, ctx),
    [factoryEntries, filters, ctx],
  );

  const filteredUser = useMemo(() => {
    const out: Record<string, SoundEntry[]> = {};
    for (const [dir, list] of Object.entries(userEntriesByDir)) {
      out[dir] = filterEntries(list, filters, ctx);
    }
    return out;
  }, [userEntriesByDir, filters, ctx]);

  const filteredPacks = useMemo(() => {
    const out: Record<string, SoundEntry[]> = {};
    for (const [slug, list] of Object.entries(packEntriesBySlug)) {
      out[slug] = filterEntries(list, filters, ctx);
    }
    return out;
  }, [packEntriesBySlug, filters, ctx]);

  const packVisible = useMemo(() => Object.values(filteredPacks).flat(), [filteredPacks]);
  const userVisible = useMemo(() => Object.values(filteredUser).flat(), [filteredUser]);
  const resultCount = filteredFactory.length + packVisible.length + userVisible.length;
  const activeCount = countActiveFilters(filters);
  const filtering = hasActiveFilters(filters);
  /** Vista plana: en favoritos y colecciones el árbol por categorías estorba. */
  const flatView = filters.onlyFavorites || filters.collection !== null;

  const tree = useMemo(() => buildTree(filteredFactory), [filteredFactory]);

  // Indexado perezoso de lo que se ve (solo archivos sin metadatos aún).
  useEffect(() => {
    const files = userVisible.slice(0, 200).map((e) => e.file);
    if (files.length === 0) return;
    const pendientes = queueAnalysis(files);
    setAnalizando(pendientes);
    if (pendientes === 0) return;
    const id = window.setInterval(() => {
      const left = pendingAnalysis();
      setAnalizando(left);
      if (left === 0) window.clearInterval(id);
    }, 600);
    return () => window.clearInterval(id);
  }, [userVisible]);

  const patchFilters = (patch: Partial<BrowserFilters>) =>
    setFilters((prev) => ({ ...prev, ...patch }));

  /** Marca/desmarca un valor dentro de un filtro de conjunto (tags, tonos…). */
  const toggleIn = <T extends string>(set: ReadonlySet<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPanelOpen(false);
  };

  const toggleCategory = (category: SoundCategory) => {
    setClosed((prev) => toggleIn(prev, category));
  };

  // ── Acciones sobre un sonido ──────────────────────────────────────────────

  // Clic: preview del sample por el kernel, al volumen de la perilla.
  const preview = async (entry: SoundEntry) => {
    ensureAudioReady();
    setStatus(null);
    try {
      await loadIntoEngine(entry);
      engine.previewSample(entry.id, (entry.gainSuggestion ?? 0.9) * previewGain);
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      setPlayingId(entry.id);
      previewTimer.current = window.setTimeout(
        () => setPlayingId(null),
        Math.max(200, Math.ceil((entry.durationSec || 2) * 1000)),
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

  /** Fila de un sonido: preview, arrastre, favorito y menú de colecciones. */
  const renderEntry = (entry: SoundEntry, opts: { showDuration?: boolean } = {}) => {
    const playing = playingId === entry.id;
    const fav = favorites.has(entry.id);
    return (
      <div
        key={entry.id}
        className={playing ? 'browser-entry playing' : 'browser-entry'}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => setDragEntry(e.dataTransfer, entry)}
        onClick={() => void preview(entry)}
        onDoubleClick={() => void addToProject(entry)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void addToProject(entry);
          else if (e.key === ' ') {
            e.preventDefault();
            void preview(entry);
          }
        }}
        title={`${entry.name} — clic: escuchar · doble clic: añadir · arrastra al rack o a la playlist`}
      >
        <span className="browser-entry-dot" aria-hidden="true" />
        <span className="browser-entry-name">{entry.name}</span>
        {entry.keyRoot !== undefined && (
          <span className="browser-badge" title={`Tonalidad ${entry.keyRoot}`}>
            {entry.keyRoot}
          </span>
        )}
        {entry.bpm !== undefined && (
          <span className="browser-badge" title={`${entry.bpm} BPM`}>
            {entry.bpm}
          </span>
        )}
        {/* La duración cede el sitio al BPM: en un loop manda el tempo. */}
        {opts.showDuration !== false && entry.bpm === undefined && entry.durationSec > 0 && (
          <span className="browser-entry-dur">{formatDuration(entry.durationSec)}</span>
        )}
        <button
          type="button"
          className={fav ? 'browser-star on' : 'browser-star'}
          title={fav ? 'Quitar de favoritos' : 'Marcar como favorito'}
          aria-pressed={fav}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(entry.id);
          }}
        >
          {fav ? '★' : '☆'}
        </button>
        <button
          type="button"
          className="browser-collect"
          title="Añadir a una colección"
          onClick={(e) => {
            e.stopPropagation();
            setCollectionMenu(entry);
          }}
        >
          ＋
        </button>
      </div>
    );
  };

  // ── Estados vacíos y cuerpo ───────────────────────────────────────────────

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
  } else if (resultCount === 0) {
    body = (
      <div className="browser-empty">
        <div className="browser-empty-title">Sin resultados</div>
        <div>
          {filters.onlyFavorites
            ? 'Aún no has marcado ningún favorito: pulsa la estrella de un sonido.'
            : filters.collection !== null
              ? `La colección «${filters.collection}» está vacía.`
              : 'Ningún sonido cumple los filtros activos.'}
        </div>
      </div>
    );
  } else if (flatView) {
    body = <div className="browser-sub">{filteredFactory.map((e) => renderEntry(e))}</div>;
  } else {
    body = tree.map(({ category, total, groups }) => {
      const isClosed = !filtering && closed.has(category);
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
                {group.name !== '' && <div className="browser-sub-name">{subLabel(group.name)}</div>}
                {group.entries.map((entry) => renderEntry(entry))}
              </div>
            ))}
        </section>
      );
    });
  }

  // ── Sección de packs generados ────────────────────────────────────────────

  const packSection = lib.status !== 'sin-electron' && !flatView && (
    <section className="browser-cat">
      <div className="browser-cat-head user-head">
        <span className="browser-cat-name">Packs generados</span>
        <span className="browser-cat-count">{packVisible.length}</span>
      </div>

      <div className="pack-gen">
        <select
          className="pack-gen-sel"
          value={packForm.family}
          onChange={(e) => setPackForm((f) => ({ ...f, family: e.target.value as PackFamily }))}
          title="Qué familia de sonidos"
        >
          {PACK_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {PACK_FAMILY_LABELS[family]}
            </option>
          ))}
        </select>
        <select
          className="pack-gen-sel"
          value={packForm.style}
          onChange={(e) => setPackForm((f) => ({ ...f, style: e.target.value as PackStyle }))}
          title="Con qué carácter"
        >
          {PACK_STYLES.map((style) => (
            <option key={style} value={style}>
              {PACK_STYLE_LABELS[style]}
            </option>
          ))}
        </select>
        <input
          type="number"
          className="pack-gen-count"
          min={1}
          max={32}
          value={packForm.count}
          onChange={(e) =>
            setPackForm((f) => ({
              ...f,
              count: Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 1))),
            }))
          }
          title="Cuántos sonidos"
        />
        <button
          className="pack-gen-go"
          disabled={packBusy !== null}
          onClick={() => void runGenerate()}
          title="Renderiza el pack con el motor de la app (Claude puede pedirlo también por su tool)"
        >
          {packBusy === null ? 'Generar' : '…'}
        </button>
      </div>
      {packBusy !== null && <div className="browser-sub-name">{packBusy}</div>}
      {packs.length === 0 && packBusy === null && (
        <div className="browser-sub-name">
          Aún no hay ninguno. Elige familia y estilo, o pídeselo a Claude.
        </div>
      )}

      {packs.map((pack) => {
        const files = filteredPacks[pack.slug] ?? [];
        return (
          <div key={pack.slug} className="browser-sub">
            <div className="browser-sub-name user-folder">
              <span className="user-folder-name" title={pack.manifest.generatedWith}>
                {pack.manifest.pack}
              </span>
              <span className="user-folder-count">{files.length}</span>
              <button
                className="user-folder-del"
                title="Abrir su carpeta"
                onClick={() => void window.orbit?.pack.reveal(pack.slug)}
              >
                ⁝
              </button>
              <button
                className="user-folder-del"
                title="Borrar este pack del disco"
                onClick={() => void removePack(pack.slug, pack.manifest.pack)}
              >
                ✕
              </button>
            </div>
            {files.map((entry) => renderEntry(entry))}
          </div>
        );
      })}
    </section>
  );

  /** En vista plana los sonidos generados van con el resto. */
  const packFlat = flatView && packVisible.length > 0 && (
    <div className="browser-sub">{packVisible.map((e) => renderEntry(e))}</div>
  );

  // ── Sección de carpetas del usuario ───────────────────────────────────────

  const userSection = lib.status !== 'sin-electron' && !flatView && (
    <section className="browser-cat">
      <div className="browser-cat-head user-head">
        <span className="browser-cat-name">Tus carpetas</span>
        <span className="browser-cat-count">{userVisible.length}</span>
        <button
          className="user-folder-add"
          title="Añadir una carpeta con tus sonidos"
          onClick={() => void addFolder()}
        >
          +
        </button>
      </div>
      {folders.length === 0 && (
        <div className="browser-sub-name">Añade carpetas con tus packs (se indexan igual).</div>
      )}
      {folders.map((dir) => {
        const files = filteredUser[dir] ?? [];
        return (
          <div key={dir} className="browser-sub">
            <div className="browser-sub-name user-folder">
              <span className="user-folder-name" title={dir}>
                {dir.split(/[\\/]/).pop()}
              </span>
              <span className="user-folder-count">{files.length}</span>
              <button
                className="user-folder-del"
                title="Quitar esta carpeta del browser"
                onClick={() => removeFolder(dir)}
              >
                ✕
              </button>
            </div>
            {files.slice(0, 200).map((entry) => renderEntry(entry, { showDuration: false }))}
          </div>
        );
      })}
    </section>
  );

  /** En vista plana los archivos del usuario van con el resto, sin carpetas. */
  const userFlat = flatView && userVisible.length > 0 && (
    <div className="browser-sub">{userVisible.map((e) => renderEntry(e, { showDuration: false }))}</div>
  );

  // ── Cabecera ──────────────────────────────────────────────────────────────

  const viewValue = filters.onlyFavorites
    ? '@fav'
    : filters.collection !== null
      ? `#${filters.collection}`
      : '';

  const onViewChange = (value: string) => {
    if (value === '@fav') patchFilters({ onlyFavorites: true, collection: null });
    else if (value.startsWith('#')) patchFilters({ onlyFavorites: false, collection: value.slice(1) });
    else patchFilters({ onlyFavorites: false, collection: null });
  };

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

        <div className="browser-search-row">
          <input
            type="search"
            className="browser-search"
            placeholder="Buscar (nombre, tag, grupo)…"
            value={filters.query}
            onChange={(e) => patchFilters({ query: e.target.value })}
            spellCheck={false}
          />
          <Knob
            value={previewGain}
            min={0}
            max={1.5}
            defaultValue={1}
            size={26}
            onChange={setPreviewGain}
            format={(v) => `Preview ${Math.round(v * 100)} %`}
          />
        </div>

        <div className="browser-filter-row">
          <button
            type="button"
            className={panelOpen ? 'browser-fbtn open' : 'browser-fbtn'}
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            title="Filtros por categoría, género, tonalidad y BPM"
          >
            Filtros
            {activeCount > 0 && <span className="browser-fbadge">{activeCount}</span>}
          </button>

          <select
            className="browser-view"
            value={viewValue}
            onChange={(e) => onViewChange(e.target.value)}
            title="Vista: toda la librería, favoritos o una colección"
          >
            <option value="">Todo</option>
            <option value="@fav">★ Favoritos ({favorites.size})</option>
            {Object.keys(collections)
              .sort((a, b) => a.localeCompare(b))
              .map((name) => (
                <option key={name} value={`#${name}`}>
                  {name} ({collections[name]?.length ?? 0})
                </option>
              ))}
          </select>

          <span className="browser-count">{resultCount}</span>

          {filtering && (
            <button type="button" className="browser-clear" onClick={clearFilters} title="Quitar todos los filtros">
              Limpiar
            </button>
          )}
        </div>

        {panelOpen && (
          <div className="browser-filters">
            <FilterChips
              label="Categoría"
              values={facets.categories}
              selected={filters.categories}
              labelOf={(c) => CATEGORY_LABELS[c]}
              onToggle={(c) => patchFilters({ categories: toggleIn(filters.categories, c) })}
            />
            <FilterChips
              label="Género / tag"
              values={facets.tags.slice(0, 40)}
              selected={filters.tags}
              onToggle={(t) => patchFilters({ tags: toggleIn(filters.tags, t) })}
            />
            {facets.keys.length > 0 && (
              <FilterChips
                label="Tonalidad"
                values={facets.keys}
                selected={filters.keys}
                onToggle={(k) => patchFilters({ keys: toggleIn(filters.keys, k) })}
              />
            )}
            <div className="browser-frow">
              <label className="browser-flabel">
                <input
                  type="checkbox"
                  checked={filters.bpm !== null}
                  onChange={(e) =>
                    patchFilters({
                      bpm: e.target.checked
                        ? (facets.bpmRange ?? { min: BPM_MIN, max: BPM_MAX })
                        : null,
                    })
                  }
                />
                BPM
              </label>
              <input
                type="number"
                className="browser-bpm"
                min={BPM_MIN}
                max={BPM_MAX}
                disabled={filters.bpm === null}
                value={filters.bpm?.min ?? BPM_MIN}
                onChange={(e) =>
                  patchFilters({
                    bpm: {
                      min: clampBpm(e.target.value, BPM_MIN),
                      max: filters.bpm?.max ?? BPM_MAX,
                    },
                  })
                }
              />
              <span className="browser-fdash">–</span>
              <input
                type="number"
                className="browser-bpm"
                min={BPM_MIN}
                max={BPM_MAX}
                disabled={filters.bpm === null}
                value={filters.bpm?.max ?? BPM_MAX}
                onChange={(e) =>
                  patchFilters({
                    bpm: {
                      min: filters.bpm?.min ?? BPM_MIN,
                      max: clampBpm(e.target.value, BPM_MAX),
                    },
                  })
                }
              />
            </div>
          </div>
        )}
      </div>

      <div className="browser-body">
        {body}
        {packSection}
        {packFlat}
        {userSection}
        {userFlat}
      </div>

      {filters.collection !== null && (
        <div className="browser-status browser-collection-bar">
          <span>Colección «{filters.collection}»</span>
          <button
            type="button"
            className="user-folder-del"
            title="Borrar esta colección"
            onClick={() => {
              deleteCollection(filters.collection!);
              patchFilters({ collection: null });
            }}
          >
            ✕
          </button>
        </div>
      )}

      {analizando > 0 && (
        <div className="browser-status">Analizando {analizando} archivo(s): BPM y tonalidad…</div>
      )}
      {status !== null && <div className="browser-status">{status}</div>}

      {collectionMenu && (
        <CollectionMenu entry={collectionMenu} onClose={() => setCollectionMenu(null)} />
      )}
    </div>
  );
}

// ── Subcomponentes ───────────────────────────────────────────────────────────

interface FilterChipsProps<T extends string> {
  label: string;
  values: readonly T[];
  selected: ReadonlySet<T>;
  labelOf?: (v: T) => string;
  onToggle: (v: T) => void;
}

/** Fila de chips marcables (se combinan en O dentro del grupo). */
function FilterChips<T extends string>({
  label,
  values,
  selected,
  labelOf,
  onToggle,
}: FilterChipsProps<T>) {
  if (values.length === 0) return null;
  return (
    <div className="browser-frow stack">
      <span className="browser-flabel">{label}</span>
      <div className="browser-chips">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            className={selected.has(v) ? 'browser-chip on' : 'browser-chip'}
            aria-pressed={selected.has(v)}
            onClick={() => onToggle(v)}
          >
            {labelOf ? labelOf(v) : v}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Menú de colecciones de un sonido: marcar/desmarcar y crear una nueva. */
function CollectionMenu({ entry, onClose }: { entry: SoundEntry; onClose: () => void }) {
  const collections = usePrefs((s) => s.collections);
  const [nombre, setNombre] = useState('');
  const names = Object.keys(collections).sort((a, b) => a.localeCompare(b));

  const crear = () => {
    const clean = nombre.trim();
    if (clean === '') return;
    createCollection(clean);
    toggleInCollection(clean, entry.id);
    onClose();
  };

  return (
    <>
      <div className="browser-menu-veil" onClick={onClose} />
      <div className="browser-menu" role="menu">
        <div className="browser-menu-title">Colecciones de «{entry.name}»</div>
        {names.length === 0 && <div className="browser-menu-empty">Aún no tienes colecciones.</div>}
        {names.map((name) => {
          const dentro = (collections[name] ?? []).includes(entry.id);
          return (
            <button
              key={name}
              type="button"
              className={dentro ? 'browser-menu-item on' : 'browser-menu-item'}
              onClick={() => toggleInCollection(name, entry.id)}
            >
              <span className="browser-menu-check">{dentro ? '✓' : ''}</span>
              {name}
            </button>
          );
        })}
        <div className="browser-menu-new">
          <input
            className="browser-search"
            autoFocus
            placeholder="Nueva colección…"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') crear();
              if (e.key === 'Escape') onClose();
            }}
          />
          <button type="button" className="browser-fbtn" onClick={crear}>
            Crear
          </button>
        </div>
      </div>
    </>
  );
}
