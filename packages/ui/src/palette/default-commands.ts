/**
 * Comandos por defecto de la paleta (Ctrl+K): archivo, ventanas, transporte y
 * patrones. Se registran una vez desde App; el proveedor se evalúa al abrir la
 * paleta, así que los títulos condicionales salen frescos.
 *
 * Aquí viven también las ACCIONES DE PATRÓN (crear, clonar, renombrar, color y
 * borrar). Son exportadas porque las comparten cinco superficies —esta paleta,
 * el menú Patrón del MenuBar, el atajo global, el menú contextual de los pads
 * de la Vista Live y el botón del Piano Roll— y el borrado tiene reglas que no
 * pueden divergir: el guard del último patrón, el realineo del patrón activo y
 * el aviso de cuántos clips se lleva por delante.
 */

import { createPattern, describeParamRef, newId, type Id, type Note, type Pattern } from '@orbit/core';
import { repeatLastExport } from '../export';
import { engine, pausePlayback, setActivePattern, setPlayMode, stopPlayback, store, togglePlay } from '../state/app';
import { playDirect } from '../shell/Transport';
import { useBounceStore } from '../state/bounce';
import { toggleMidiArmed, useLiveInputStore } from '../state/live-input';
import { LAYOUT_PRESETS, applyLayout, applyPreset, listLayouts } from '../state/layouts';
import { addLfoFor, createAutomationClipFor, findLfoFor } from '../state/param-actions';
import { toggleParamRecordArmed, useParamRecord } from '../state/param-record';
import { useParamTouch } from '../state/param-touch';
import {
  importMidi,
  newProject,
  openProject,
  openRecentProject,
  saveProject,
  useRecentProjects,
} from '../state/project-file';
import { toggleRecording, useRecorderStore } from '../state/recorder';
import { useUiStore, type WindowId } from '../state/ui';
import { registerPaletteProvider, type PaletteCommand } from './registry';

const WINDOWS: { id: WindowId; title: string; shortcut?: string }[] = [
  { id: 'playlist', title: 'Playlist', shortcut: 'F5' },
  { id: 'channelRack', title: 'Channel Rack', shortcut: 'F6' },
  { id: 'pianoRoll', title: 'Piano Roll', shortcut: 'F7' },
  { id: 'liveView', title: 'Vista Live', shortcut: 'F8' },
  { id: 'mixer', title: 'Mixer', shortcut: 'F9' },
  { id: 'automation', title: 'Automatización' },
  { id: 'lfo', title: 'LFOs' },
  { id: 'nova', title: 'Orbit Nova' },
  { id: 'history', title: 'Historial' },
  { id: 'projectInfo', title: 'Info del proyecto' },
  { id: 'scope', title: 'Orbit Scope' },
  { id: 'graph', title: 'Enrutado (graph editor)' },
  { id: 'audioEditor', title: 'Editor de audio' },
  { id: 'collab', title: 'Colaboración' },
  { id: 'export', title: 'Exportar' },
  { id: 'settings', title: 'Ajustes', shortcut: 'F10' },
];

// ── Acciones de patrón ───────────────────────────────────────────────────────

/**
 * Aviso efímero por el canal de `bounce` (App lo pinta como `.app-notice`).
 * Timer propio porque el de `bounce.ts` es privado de ese módulo.
 */
let patternNoticeTimer: ReturnType<typeof setTimeout> | null = null;

function patternNotice(notice: string): void {
  if (patternNoticeTimer) clearTimeout(patternNoticeTimer);
  useBounceStore.setState({ notice });
  patternNoticeTimer = setTimeout(() => useBounceStore.setState({ notice: null }), 5000);
}

/**
 * Patrón activo DE VERDAD: `activePatternId` es estado de UI y nadie lo limpia
 * al borrar, así que puede apuntar a un patrón que ya no existe. Cae al primero
 * de la lista, igual que hacen el rack y la Vista Live.
 */
export function activePattern(): Pattern | undefined {
  const project = store.project;
  const id = useUiStore.getState().activePatternId;
  if (id !== null && project.patterns[id]) return project.patterns[id];
  const first = project.patternOrder[0];
  return first ? project.patterns[first] : undefined;
}

/** Clips de la playlist que se lleva por delante borrar ese patrón. */
export function patternClipCount(patternId: Id): number {
  return Object.values(store.project.clips).filter((c) => c.patternId === patternId).length;
}

/**
 * Falso cuando solo queda un patrón: core LANZA en ese caso (sin patrones el
 * rack, el modo PAT y la grabación en vivo se quedan sin destino), así que
 * toda superficie que ofrezca el borrado tiene que preguntar antes.
 */
export function canRemovePattern(): boolean {
  return store.project.patternOrder.length > 1;
}

/** Coletilla de aviso: " (y 3 clips de la playlist)" o cadena vacía. */
export function patternClipsHint(patternId: Id): string {
  const clips = patternClipCount(patternId);
  if (clips === 0) return '';
  return ` (y ${clips} ${clips === 1 ? 'clip' : 'clips'} de la playlist)`;
}

/** Crea un patrón vacío al final y lo deja activo. */
export function addPattern(): void {
  const p = createPattern(store.project.patternOrder.length);
  store.dispatch({ type: 'addPattern', pattern: p }, { label: `Añadir "${p.name}"` });
  setActivePattern(p.id);
}

/** Clona un patrón (notas incluidas, con ids nuevos) justo detrás y lo activa. */
export function clonePattern(patternId?: Id): void {
  const pattern = patternId ? store.project.patterns[patternId] : activePattern();
  if (!pattern) return;
  const notes: Record<Id, Note[]> = {};
  for (const [channelId, list] of Object.entries(pattern.notes)) {
    notes[channelId] = list.map((n) => ({ ...n, id: newId() }));
  }
  const clon: Pattern = {
    id: newId(),
    name: `${pattern.name} (copia)`,
    color: pattern.color,
    length: pattern.length,
    notes,
  };
  const index = store.project.patternOrder.indexOf(pattern.id);
  store.dispatch(
    { type: 'addPattern', pattern: clon, index: index + 1 },
    { label: `Clonar "${pattern.name}"` },
  );
  setActivePattern(clon.id);
}

/** Renombra pidiendo el nombre (mismo prompt que el resto del shell). */
export function renamePattern(patternId?: Id): void {
  const pattern = patternId ? store.project.patterns[patternId] : activePattern();
  if (!pattern) return;
  const raw = window.prompt('Nombre del patrón', pattern.name);
  if (raw === null) return;
  const name = raw.trim();
  if (!name || name === pattern.name) return;
  store.dispatch(
    { type: 'patchPattern', patternId: pattern.id, patch: { name } },
    { label: `Renombrar patrón a "${name}"` },
  );
}

/** Color del patrón (el de sus pads en Live y el de sus clips en la playlist). */
export function setPatternColor(patternId: Id, color: string): void {
  const pattern = store.project.patterns[patternId];
  if (!pattern || pattern.color === color) return;
  store.dispatch(
    { type: 'patchPattern', patternId, patch: { color } },
    { label: `Color de "${pattern.name}"`, mergeKey: `pattern:${patternId}:color` },
  );
}

/**
 * Borra un patrón con todo lo que arrastra —sus notas y sus clips de la
 * playlist— en UN paso de undo, y deja el patrón activo en un sitio válido.
 *
 * Sin confirmación a propósito: el aviso dice qué se llevó y Ctrl+Z lo devuelve
 * entero (core guarda el patrón completo y sus clips en el comando inverso).
 */
export function removePattern(patternId: Id): void {
  const pattern = store.project.patterns[patternId];
  if (!pattern) return;
  if (!canRemovePattern()) {
    patternNotice('No se puede borrar el último patrón: el proyecto siempre tiene uno.');
    return;
  }
  const index = store.project.patternOrder.indexOf(patternId);
  const hint = patternClipsHint(patternId);
  store.dispatch({ type: 'removePattern', patternId }, { label: `Borrar "${pattern.name}"` });

  // El patrón activo es estado de UI y core no lo toca: si apuntaba al que se
  // acaba de borrar, salta al vecino de abajo (o al último si era el final).
  // Sin esto, addNotes y compañía tirarían por el `must` de core.
  const active = useUiStore.getState().activePatternId;
  if (active === null || !store.project.patterns[active]) {
    const order = store.project.patternOrder;
    const next = order[Math.min(index, order.length - 1)];
    if (next) setActivePattern(next);
  }
  patternNotice(`Borrado "${pattern.name}"${hint} · Ctrl+Z lo devuelve entero.`);
}

/** Borra el patrón activo (paleta, menú Patrón y Ctrl+Shift+Supr). */
export function removeActivePattern(): void {
  const pattern = activePattern();
  if (pattern) removePattern(pattern.id);
}

// ── Registro de la paleta ────────────────────────────────────────────────────

let registered = false;

export function registerDefaultCommands(): void {
  if (registered) return;
  registered = true;
  registerPaletteProvider((): PaletteCommand[] => {
    const ui = useUiStore.getState();
    const rec = useRecorderStore.getState();
    const live = useLiveInputStore.getState();
    const touched = useParamTouch.getState().last;
    const paramRec = useParamRecord.getState();
    const pattern = activePattern();
    return [
      // Archivo
      { id: 'archivo.nuevo', title: 'Nuevo proyecto', group: 'Archivo', run: () => newProject() },
      { id: 'archivo.abrir', title: 'Abrir proyecto…', group: 'Archivo', shortcut: 'Ctrl+O', run: () => void openProject() },
      // Recientes: uno por archivo, con su nombre en el título para que se
      // encuentren escribiendo el nombre del beat y no "reciente".
      ...useRecentProjects
        .getState()
        .list.filter((r) => r.exists)
        .map((r) => ({
          id: `archivo.reciente.${r.path}`,
          title: `Abrir reciente: ${r.name}`,
          group: 'Archivo',
          keywords: `${r.path} proyecto orbit`,
          run: () => void openRecentProject(r.path),
        })),
      { id: 'archivo.guardar', title: 'Guardar proyecto', group: 'Archivo', shortcut: 'Ctrl+S', run: () => void saveProject() },
      { id: 'archivo.guardar-como', title: 'Guardar proyecto como…', group: 'Archivo', run: () => void saveProject(true) },
      { id: 'archivo.importar-midi', title: 'Importar MIDI…', group: 'Archivo', keywords: 'mid smf', run: () => void importMidi() },
      { id: 'archivo.exportar', title: 'Exportar…', group: 'Archivo', keywords: 'wav mp3 stems render', run: () => ui.openWindow('export') },
      {
        id: 'ayuda.atajos',
        title: 'Atajos de teclado…',
        group: 'Ayuda',
        shortcut: 'F1',
        keywords: 'teclas chuleta shortcuts ayuda',
        run: () => useUiStore.setState({ shortcutsOpen: true }),
      },
      {
        id: 'archivo.repetir-export',
        title: 'Repetir el último export',
        group: 'Archivo',
        shortcut: 'Ctrl+E',
        keywords: 'render wav rapido otra vez',
        run: () => void repeatLastExport(),
      },
      // Patrón (sobre el activo; los títulos llevan su nombre para que no
      // haya duda de a cuál le vas a dar).
      ...(pattern
        ? [
            {
              id: 'patron.nuevo',
              title: 'Nuevo patrón',
              group: 'Patrón',
              keywords: 'pattern escena crear anadir vacio',
              run: () => addPattern(),
            },
            {
              id: 'patron.clonar',
              title: `Clonar "${pattern.name}"`,
              group: 'Patrón',
              keywords: 'pattern duplicar copia',
              run: () => clonePattern(),
            },
            {
              id: 'patron.renombrar',
              title: `Renombrar "${pattern.name}"…`,
              group: 'Patrón',
              keywords: 'pattern nombre',
              run: () => renamePattern(),
            },
            // Con un solo patrón el comando NO aparece: core lanza si se
            // intenta y la paleta no sabe pintar comandos deshabilitados.
            ...(canRemovePattern()
              ? [
                  {
                    id: 'patron.borrar',
                    title: `Borrar "${pattern.name}"${patternClipsHint(pattern.id)}`,
                    group: 'Patrón',
                    shortcut: 'Ctrl+Shift+Supr',
                    keywords: 'pattern eliminar quitar suprimir',
                    run: () => removeActivePattern(),
                  },
                ]
              : []),
          ]
        : []),
      // Ventanas
      ...WINDOWS.map((w) => ({
        id: `ver.${w.id}`,
        title: `Abrir ${w.title}`,
        group: 'Ver',
        ...(w.shortcut ? { shortcut: w.shortcut } : null),
        run: () => useUiStore.getState().openWindow(w.id),
      })),
      {
        id: 'ver.browser',
        title: ui.browserOpen ? 'Ocultar el Browser' : 'Mostrar el Browser',
        group: 'Ver',
        keywords: 'libreria sonidos',
        run: () => useUiStore.setState((s) => ({ browserOpen: !s.browserOpen })),
      },
      {
        id: 'ver.claude',
        title: ui.claudePanelOpen ? 'Ocultar el panel de Claude' : 'Mostrar el panel de Claude',
        group: 'Ver',
        run: () => useUiStore.setState((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
      },
      {
        id: 'ver.compacto',
        title: ui.compact ? 'Salir del modo compacto' : 'Modo compacto (Zen)',
        group: 'Ver',
        keywords: 'zen clean limpio ocultar paneles libreria',
        run: () => useUiStore.setState((s) => ({ compact: !s.compact })),
      },
      {
        id: 'ver.acerca-de',
        title: 'Acerca de Orbit Studio',
        group: 'Ver',
        keywords: 'version build about electron chrome node info',
        run: () => useUiStore.setState({ aboutOpen: true }),
      },
      // Transporte
      {
        id: 'transporte.play',
        title: ui.playing ? 'Detener (Stop)' : 'Reproducir (Play)',
        group: 'Transporte',
        shortcut: 'Espacio',
        run: () => void togglePlay(),
      },
      {
        id: 'transporte.play-pat',
        title: 'Reproducir patrón (Channel Rack)',
        group: 'Transporte',
        keywords: 'pat channel rack beat',
        run: () => playDirect('pattern'),
      },
      {
        id: 'transporte.play-song',
        title: 'Reproducir canción (Playlist)',
        group: 'Transporte',
        keywords: 'song playlist arreglo',
        run: () => playDirect('song'),
      },
      { id: 'transporte.pausa', title: 'Pausa (conserva la posición)', group: 'Transporte', run: () => pausePlayback() },
      { id: 'transporte.stop', title: 'Detener y volver al inicio', group: 'Transporte', run: () => stopPlayback() },
      {
        id: 'transporte.modo',
        title: ui.playMode === 'song' ? 'Cambiar a modo Patrón' : 'Cambiar a modo Canción',
        group: 'Transporte',
        shortcut: 'L',
        run: () => setPlayMode(ui.playMode === 'song' ? 'pattern' : 'song'),
      },
      {
        id: 'transporte.metronomo',
        title: ui.metronome ? 'Apagar el metrónomo' : 'Encender el metrónomo',
        group: 'Transporte',
        run: () => {
          const next = !useUiStore.getState().metronome;
          useUiStore.setState({ metronome: next });
          engine.setMetronome(next);
        },
      },
      {
        id: 'transporte.grabar',
        title: rec.phase === 'recording' ? 'Parar la grabación de micro' : 'Grabar el micro a la playlist',
        group: 'Transporte',
        keywords: 'voz toma record',
        run: () => void toggleRecording(),
      },
      {
        id: 'transporte.midi',
        title: live.armed ? 'Desarmar la grabación MIDI' : 'Armar la grabación MIDI',
        group: 'Transporte',
        keywords: 'teclado tocar en vivo',
        run: () => toggleMidiArmed(),
      },
      {
        id: 'transporte.grabar-perillas',
        title: paramRec.armed
          ? 'Desarmar la grabación de perillas'
          : 'Armar la grabación de perillas',
        group: 'Transporte',
        keywords: 'automatizacion movimientos mandos knob',
        run: () => toggleParamRecordArmed(),
      },
      // Layouts de ventanas: predefinidos y los guardados en el proyecto.
      ...LAYOUT_PRESETS.map((preset) => ({
        id: `layout.${preset.id}`,
        title: `Layout: ${preset.name}`,
        group: 'Ver',
        keywords: `ventanas disposicion ${preset.hint}`,
        run: () => applyPreset(preset.id),
      })),
      ...listLayouts().map((name) => ({
        id: `layout.guardado.${name}`,
        title: `Layout guardado: ${name}`,
        group: 'Ver',
        keywords: 'ventanas disposicion proyecto',
        run: () => applyLayout(name),
      })),
      // Automatización del último parámetro tocado (el atajo de FL).
      ...(touched
        ? [
            {
              id: 'auto.clip-ultimo',
              title: `Automatizar ${describeParamRef(touched, store.project)}`,
              group: 'Automatización',
              keywords: 'ultimo parametro tocado perilla clip curva',
              run: () => createAutomationClipFor(touched),
            },
            {
              id: 'auto.lfo-ultimo',
              title: `${findLfoFor(touched, store.project) ? 'Ajustar' : 'Añadir'} LFO en ${describeParamRef(touched, store.project)}`,
              group: 'Automatización',
              keywords: 'ultimo parametro tocado modulacion',
              run: () => addLfoFor(touched),
            },
          ]
        : []),
    ];
  });
}
