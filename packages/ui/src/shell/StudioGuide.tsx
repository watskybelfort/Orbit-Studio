import { useEffect, useId, useRef } from 'react';
import { useUiStore, type WindowId } from '../state/ui';
import './studio-guide.css';

const STEPS = [
  { id: 'channelRack', name: 'Crea el ritmo', text: 'Elige sonidos y dibuja pasos en el Channel Rack.', label: 'Ritmos' },
  { id: 'pianoRoll', name: 'Escribe la melodía', text: 'Dibuja notas, acordes y slides de 808 en el Piano Roll.', label: 'Notas' },
  { id: 'playlist', name: 'Construye la canción', text: 'Ordena tus patrones y grabaciones en la Playlist.', label: 'Arreglo' },
  { id: 'mixer', name: 'Dale espacio a cada sonido', text: 'Equilibra niveles y efectos con la voz por encima del beat.', label: 'Mezcla' },
  { id: 'export', name: 'Saca tu música del estudio', text: 'Exporta audio o MIDI para compartir o continuar en FL.', label: 'Exportar' },
] satisfies { id: WindowId; name: string; text: string; label: string }[];

export function StudioGuide({ onClose, returnFocusTo }: { onClose: () => void; returnFocusTo: HTMLButtonElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const transferringFocus = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = returnFocusTo ?? dialog?.ownerDocument.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (!transferringFocus.current && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  return (
    <dialog
      ref={ref}
      className="studio-guide popup"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="studio-guide__header">
        <div><span className="studio-guide__eyebrow">Guía del estudio</span><h2 id={titleId}>Del ritmo a la canción</h2></div>
        <button className="studio-guide__close" onClick={onClose} aria-label="Cerrar guía">×</button>
      </header>
      <p className="studio-guide__intro">Empieza donde estés. Cada paso abre su herramienta sin cambiar tu música.</p>
      <ol className="studio-guide__steps">
        {STEPS.map((step, index) => (
          <li key={step.id}>
            <button onClick={() => { useUiStore.getState().openWindow(step.id); onClose(); }}>
              <span className="studio-guide__number">0{index + 1}</span>
              <span className="studio-guide__copy"><strong>{step.name}</strong><span>{step.text}</span></span>
              <span className="studio-guide__destination">{step.label} →</span>
            </button>
          </li>
        ))}
      </ol>
      <footer className="studio-guide__footer">
        <p><strong>Patrón</strong> escucha la idea actual. <strong>Canción</strong> reproduce el arreglo. <kbd>Espacio</kbd> arranca o para el modo elegido.</p>
        <p>El botón <strong>?</strong> de cada editor explica sus primeros pasos. <strong>Organizar</strong> distribuye las ventanas según lo que estés haciendo.</p>
        <button className="tbtn" onClick={() => {
          // Retira la modalidad ANTES de montar el siguiente diálogo: su
          // autofocus no puede ejecutarse mientras siga siendo fondo inerte.
          transferringFocus.current = true;
          ref.current?.close();
          onClose();
          useUiStore.setState({ shortcutsOpen: true });
        }}>Consultar todos los atajos · F1</button>
      </footer>
    </dialog>
  );
}
