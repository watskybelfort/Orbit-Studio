/**
 * Vista Live — performance por escenas: cada PATRÓN es una escena lanzable
 * (en Orbit un patrón ya agrupa todos los canales, como una fila de session).
 *
 * Lanzamiento:
 *   - Transporte parado (o sonando la canción): el pad arranca su patrón en
 *     el acto, desde el principio.
 *   - Sonando en modo patrón: el pad entra EN COLA (engine.queueSnapshot) y
 *     el kernel hace el cambio EXACTO al cerrar el loop actual (precisión de
 *     sample). El swap se detecta aquí por el salto hacia atrás de
 *     positionBeats; entonces se realinea activePatternId con lo que el
 *     kernel ya está tocando — el syncProject que dispara ese realineo es
 *     idéntico al snapshot recién aplicado, así que no corta el audio.
 *   - Pad en cola: clic para cancelar (re-encola el patrón que suena).
 *   - Pad ya sonando: no hace nada (más seguro que relanzar desde 0).
 *
 * Clic DERECHO en un pad: menú de la escena (renombrar, color, clonar y
 * borrar). El borrado comparte implementación con la paleta y el menú Patrón.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { type Id, type Pattern } from '@orbit/core';
import { reportActivity } from '../../collab/presence';
import {
  addPattern,
  clonePattern,
  patternClipsHint,
  removePattern,
  renamePattern,
  setPatternColor,
} from '../../palette/default-commands';
import { engine, play, setActivePattern, setPlayMode, stopPlayback, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { IconStop } from '../../icons';
import { MenuPortal } from '../../widgets/MenuPortal';
import './live.css';

export function LiveView() {
  const project = useProject();
  const activePatternId = useUiStore((s) => s.activePatternId);
  const playing = useUiStore((s) => s.playing);
  const playMode = useUiStore((s) => s.playMode);

  /** Menú contextual de un pad: qué escena y dónde se abrió. */
  const [padMenu, setPadMenu] = useState<{ id: Id; x: number; y: number } | null>(null);
  /** Raíz de la vista: le dice al portal en qué documento pintar el menú. */
  const rootRef = useRef<HTMLDivElement>(null);

  /** Patrón lanzado que espera el cierre del loop (null = sin cola). */
  const [queuedId, setQueuedId] = useState<Id | null>(null);
  // Espejo en ref para leerlo desde la suscripción sin re-suscribir.
  const queuedRef = useRef<Id | null>(null);
  const setQueued = (id: Id | null) => {
    queuedRef.current = id;
    setQueuedId(id);
  };

  // Patrón activo (fallback al primero, igual que el Channel Rack).
  const firstPatternId = project.patternOrder[0];
  const patternId =
    activePatternId && project.patterns[activePatternId] ? activePatternId : firstPatternId;
  const playingPattern = playing && playMode === 'pattern';

  // Detección del swap: en modo patrón la posición SALTA hacia atrás justo al
  // cerrar el loop, que es el instante exacto en que el kernel aplica la cola.
  // Con cola pendiente, ese salto ⇒ el patrón lanzado YA está sonando.
  useEffect(() => {
    const unsub = useUiStore.subscribe((s, prev) => {
      const queued = queuedRef.current;
      if (queued === null) return;
      if (!s.playing) {
        // El usuario paró el transporte con cola pendiente: cola huérfana.
        setQueued(null);
        return;
      }
      if (prev.positionBeats > s.positionBeats + 0.5) {
        // Realinea engine.playMode y el resto de la UI con lo que ya suena
        // (si el patrón fue borrado mientras esperaba, se descarta la cola).
        if (store.project.patterns[queued]) setActivePattern(queued);
        setQueued(null);
      }
    });
    return unsub;
  }, []);

  /** Clic en un pad: arranque inmediato o lanzamiento cuantizado según estado. */
  const launch = (id: Id) => {
    if (playingPattern) {
      if (queuedRef.current !== null && (id === queuedRef.current || id === patternId)) {
        // Cancelar la cola: re-encolamos el patrón ACTIVO (machaca la cola
        // pendiente del kernel con lo que ya está sonando).
        if (patternId) engine.queueSnapshot(store.project, { mode: 'pattern', patternId });
        setQueued(null);
        return;
      }
      if (id === patternId) return; // ya suena: nada
      // Lanzamiento CUANTIZADO: el actual sigue hasta cerrar su loop y el
      // kernel hace el swap solo, con precisión de sample.
      engine.queueSnapshot(store.project, { mode: 'pattern', patternId: id });
      setQueued(id);
      return;
    }
    // Parado o sonando la canción: arranque inmediato desde el principio.
    stopPlayback(); // caret a 0 (y corta la canción si sonaba)
    setQueued(null);
    setActivePattern(id);
    setPlayMode('pattern');
    void play();
  };

  /**
   * Borra la escena: si era la que esperaba en cola hay que cancelarla antes,
   * porque el kernel ya tiene su snapshot y la haría sonar igual al cerrar el
   * loop. El resto (clips, undo, patrón activo) lo cubre removePattern.
   */
  const removeScene = (id: Id) => {
    if (queuedRef.current === id) {
      if (patternId && patternId !== id) {
        engine.queueSnapshot(store.project, { mode: 'pattern', patternId });
      }
      setQueued(null);
    }
    removePattern(id);
  };

  const stop = () => {
    setQueued(null);
    stopPlayback();
  };

  const queuedPattern = queuedId !== null ? project.patterns[queuedId] : undefined;
  const menuPattern = padMenu ? project.patterns[padMenu.id] : undefined;
  // Con una sola escena el borrado no se ofrece: core lanza en vez de dejar el
  // proyecto sin patrones.
  const canRemove = project.patternOrder.length > 1;

  return (
    <div className="live" ref={rootRef} onPointerDown={() => reportActivity('Vista Live')}>
      <div className="live-grid">
        {project.patternOrder.map((id) => {
          const pattern = project.patterns[id];
          if (!pattern) return null;
          return (
            <ScenePad
              key={id}
              pattern={pattern}
              beatsPerBar={project.timeSig.num}
              sounding={playingPattern && id === patternId}
              queued={id === queuedId}
              onLaunch={() => launch(id)}
              onMenu={(x, y) => setPadMenu({ id, x, y })}
            />
          );
        })}
        <button className="live-pad add" title="Nuevo patrón (escena vacía)" onClick={() => addPattern()}>
          +
        </button>
      </div>

      <div className="live-bar">
        <button className="live-stop" title="Detener" onClick={stop}>
          <IconStop size={13} />
          <span>STOP</span>
        </button>
        {queuedPattern && (
          <span className="live-queued-info" title="Entra al cerrar el loop actual">
            En cola: {queuedPattern.name}
          </span>
        )}
        <span className="live-hint">
          Clic: lanzar escena · sonando entra al cierre del loop · clic derecho: menú de la escena
        </span>
      </div>

      {padMenu && menuPattern && (
        <MenuPortal
          anchor={rootRef.current}
          x={padMenu.x}
          y={padMenu.y}
          className="live-ctx"
          onClose={() => setPadMenu(null)}
        >
          <div className="live-ctx-title" style={{ borderLeftColor: menuPattern.color }}>
            {menuPattern.name}
          </div>
          <button
            className="menu-item"
            onClick={() => {
              setPadMenu(null);
              renamePattern(padMenu.id);
            }}
          >
            Renombrar…
          </button>
          <label className="menu-item live-ctx-color">
            Cambiar color
            <input
              type="color"
              value={menuPattern.color}
              onChange={(e) => setPatternColor(padMenu.id, e.target.value)}
            />
          </label>
          <button
            className="menu-item"
            onClick={() => {
              setPadMenu(null);
              clonePattern(padMenu.id);
            }}
          >
            Clonar escena
          </button>
          <div className="menu-sep" />
          <button
            className="menu-item"
            disabled={!canRemove}
            title={
              canRemove
                ? 'Se lleva sus notas y sus clips de la playlist; Ctrl+Z lo devuelve entero'
                : 'El proyecto siempre tiene un patrón'
            }
            onClick={() => {
              setPadMenu(null);
              removeScene(padMenu.id);
            }}
          >
            Borrar escena{patternClipsHint(padMenu.id)}
          </button>
        </MenuPortal>
      )}
    </div>
  );
}

// ── Pad de escena ────────────────────────────────────────────────────────────

interface ScenePadProps {
  pattern: Pattern;
  /** Pulsos por compás (timeSig.num) para mostrar la longitud en compases. */
  beatsPerBar: number;
  /** Es el patrón activo y está sonando en modo patrón. */
  sounding: boolean;
  /** Lanzado y a la espera del cierre del loop. */
  queued: boolean;
  onLaunch: () => void;
  /** Clic derecho: abre el menú de la escena en esas coordenadas de viewport. */
  onMenu: (x: number, y: number) => void;
}

function ScenePad({ pattern, beatsPerBar, sounding, queued, onLaunch, onMenu }: ScenePadProps) {
  const bars = Math.round((pattern.length / Math.max(1, beatsPerBar)) * 10) / 10;
  const noteCount = Object.values(pattern.notes).reduce((total, list) => total + list.length, 0);
  const cls = `live-pad${sounding ? ' sounding' : ''}${queued ? ' queued' : ''}`;
  const title = queued
    ? `${pattern.name} — en cola, clic para cancelar`
    : sounding
      ? `${pattern.name} — sonando`
      : `Lanzar ${pattern.name} · clic derecho para renombrar, colorear, clonar o borrar`;
  return (
    <button
      className={cls}
      style={{ '--pad-color': pattern.color } as CSSProperties}
      title={title}
      onClick={onLaunch}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className="live-pad-name">{pattern.name}</span>
      <span className="live-pad-meta">
        {bars} {bars === 1 ? 'compás' : 'compases'} · {noteCount} {noteCount === 1 ? 'nota' : 'notas'}
      </span>
      <span className="live-pad-state">{sounding ? '▶' : queued ? '…' : ''}</span>
    </button>
  );
}
