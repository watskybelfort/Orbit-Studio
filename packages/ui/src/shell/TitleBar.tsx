import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import './TitleBar.css';

// Barra de título custom (la ventana es frameless: los botones los dibuja la UI).
// Dos modos: botones Windows a la derecha (defecto) o semáforo macOS a la
// izquierda (trafficLights). El main solo ejecuta minimize/maximize/close.

export interface TitleBarProps {
  /** Semáforo macOS a la izquierda en lugar de los botones Windows. */
  trafficLights?: boolean;
  /** Texto del logo/título (por ahora, texto plano). */
  title?: string;
}

function orbit(): OrbitApi | undefined {
  return typeof window !== 'undefined' ? window.orbit : undefined;
}

// ── Glifos SVG inline (trazo fino, currentColor para heredar el tema) ────────

function GlyphMinimize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.5" y1="5" x2="9.5" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function GlyphMaximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function GlyphRestore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M 3 2.5 V 1.5 A 1 1 0 0 1 4 0.5 H 8.5 A 1 1 0 0 1 9.5 1.5 V 6 A 1 1 0 0 1 8.5 7 H 7.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="0.5" y="3" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function GlyphClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

// Glifos del semáforo (aparecen al hacer hover sobre el grupo, como macOS)

function TrafficGlyphClose() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function TrafficGlyphMinimize() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <line x1="1" y1="4" x2="7" y2="4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function TrafficGlyphMaximize() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M 1.5 6.5 V 3 L 5 6.5 Z" fill="currentColor" />
      <path d="M 6.5 1.5 V 5 L 3 1.5 Z" fill="currentColor" />
    </svg>
  );
}

// ── Componente ───────────────────────────────────────────────────────────────

export function TitleBar({ trafficLights = false, title = 'Orbit Studio' }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = orbit();
    if (!api) return;
    let alive = true;
    void api.window.isMaximized().then((value) => {
      if (alive) setIsMaximized(value);
    });
    const unsubscribe = api.window.onMaximizedChanged(setIsMaximized);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const minimize = () => void orbit()?.window.minimize();
  const toggleMaximize = () => void orbit()?.window.maximize(); // el estado llega por onMaximizedChanged
  const close = () => void orbit()?.window.close();

  // Doble clic en la zona de arrastre = maximizar/restaurar (no sobre botones).
  const onDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    toggleMaximize();
  };

  return (
    <header className="titlebar" onDoubleClick={onDoubleClick}>
      {trafficLights ? (
        <>
          <div className="traffic">
            <button type="button" aria-label="Cerrar" className="traffic__dot traffic__dot--close" onClick={close}>
              <TrafficGlyphClose />
            </button>
            <button type="button" aria-label="Minimizar" className="traffic__dot traffic__dot--min" onClick={minimize}>
              <TrafficGlyphMinimize />
            </button>
            <button
              type="button"
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              className="traffic__dot traffic__dot--max"
              onClick={toggleMaximize}
            >
              <TrafficGlyphMaximize />
            </button>
          </div>
          <span className="titlebar__title-center">{title}</span>
        </>
      ) : (
        <>
          <span className="titlebar__logo">{title}</span>
          <div className="titlebar__spacer" />
          <div className="titlebar__controls">
            <button type="button" aria-label="Minimizar" className="titlebar__btn" onClick={minimize}>
              <GlyphMinimize />
            </button>
            <button
              type="button"
              aria-label={isMaximized ? 'Restaurar' : 'Maximizar'}
              className="titlebar__btn"
              onClick={toggleMaximize}
            >
              {isMaximized ? <GlyphRestore /> : <GlyphMaximize />}
            </button>
            <button type="button" aria-label="Cerrar" className="titlebar__btn titlebar__btn--close" onClick={close}>
              <GlyphClose />
            </button>
          </div>
        </>
      )}
    </header>
  );
}
