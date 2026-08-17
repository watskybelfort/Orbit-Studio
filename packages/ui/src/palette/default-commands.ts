/**
 * Comandos por defecto de la paleta (Ctrl+K): archivo, ventanas y
 * transporte. Se registran una vez desde App; el proveedor se evalúa al
 * abrir la paleta, así que los títulos condicionales salen frescos.
 */

import { describeParamRef } from '@orbit/core';
import { engine, pausePlayback, setPlayMode, stopPlayback, store, togglePlay } from '../state/app';
import { playDirect } from '../shell/Transport';
import { toggleMidiArmed, useLiveInputStore } from '../state/live-input';
import { addLfoFor, createAutomationClipFor, findLfoFor } from '../state/param-actions';
import { toggleParamRecordArmed, useParamRecord } from '../state/param-record';
import { useParamTouch } from '../state/param-touch';
import { importMidi, newProject, openProject, saveProject } from '../state/project-file';
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
  { id: 'scope', title: 'Orbit Scope' },
  { id: 'audioEditor', title: 'Editor de audio' },
  { id: 'collab', title: 'Colaboración' },
  { id: 'export', title: 'Exportar' },
  { id: 'settings', title: 'Ajustes', shortcut: 'F10' },
];

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
    return [
      // Archivo
      { id: 'archivo.nuevo', title: 'Nuevo proyecto', group: 'Archivo', run: () => newProject() },
      { id: 'archivo.abrir', title: 'Abrir proyecto…', group: 'Archivo', shortcut: 'Ctrl+O', run: () => void openProject() },
      { id: 'archivo.guardar', title: 'Guardar proyecto', group: 'Archivo', shortcut: 'Ctrl+S', run: () => void saveProject() },
      { id: 'archivo.guardar-como', title: 'Guardar proyecto como…', group: 'Archivo', run: () => void saveProject(true) },
      { id: 'archivo.importar-midi', title: 'Importar MIDI…', group: 'Archivo', keywords: 'mid smf', run: () => void importMidi() },
      { id: 'archivo.exportar', title: 'Exportar…', group: 'Archivo', keywords: 'wav mp3 stems render', run: () => ui.openWindow('export') },
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
