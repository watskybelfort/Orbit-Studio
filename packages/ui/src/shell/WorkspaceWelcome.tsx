import { useRef, useState } from 'react';
import { LAYOUT_PRESETS, applyPreset } from '../state/layouts';
import { useDetachedStore } from '../state/detached';
import { useUiStore, type WindowId } from '../state/ui';
import { StudioGuide } from './StudioGuide';
import './studio-guide.css';

/** Cerrar todos los editores deja un punto de partida, no un escritorio muerto. */
export function WorkspaceWelcome() {
  const visible = useUiStore((s) => (Object.keys(s.windows) as WindowId[]).filter((id) => s.windows[id].open).join(','));
  const detached = useDetachedStore((s) => s.detached);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideTrigger = useRef<HTMLButtonElement>(null);
  const hasInternalWindow = visible.split(',').some((id) => id && !detached[id as WindowId]);
  if (hasInternalWindow) return null;
  return (
    <section className="workspace-welcome" aria-label="Inicio del espacio de trabajo">
      <span className="studio-guide__eyebrow">Orbit Studio</span>
      <h1>Tu espacio para crear</h1>
      <p>Abre una herramienta desde la barra o elige una distribución para el siguiente paso de tu proyecto.</p>
      <div className="workspace-welcome__layouts">
        {LAYOUT_PRESETS.map((preset) => (
          <button key={preset.id} onClick={() => applyPreset(preset.id)}><strong>{preset.name}</strong><span>{preset.hint}</span></button>
        ))}
      </div>
      <button ref={guideTrigger} className="tbtn" onClick={() => setGuideOpen(true)}>Ver la guía del estudio</button>
      <p className="workspace-welcome__hint">Ctrl+K busca cualquier acción · F1 abre los atajos</p>
      {guideOpen && <StudioGuide onClose={() => setGuideOpen(false)} returnFocusTo={guideTrigger.current} />}
    </section>
  );
}
