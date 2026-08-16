/**
 * Ventana desacoplada: abre una ventana NATIVA del OS (window.open, que en
 * Electron crea un BrowserWindow hijo con frame normal) y porta el contenido
 * del editor ahí con createPortal. Mismo contexto JS → los stores, el motor
 * de audio y los atajos siguen siendo los de la app; solo cambia dónde se
 * pinta. Cerrar la ventana nativa (X) re-acopla el editor al workspace.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './detached.css';

export interface DetachedWindowProps {
  /** Nombre estable de la ventana nativa (una por editor). */
  name: string;
  title: string;
  width: number;
  height: number;
  /** Se llama cuando la ventana nativa se cierra (re-acoplar). */
  onClose: () => void;
  children: ReactNode;
}

/** Copia los estilos de la app (style de Vite y link de producción). */
function cloneStyles(from: Document, into: Document): void {
  for (const node of from.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    into.head.appendChild(node.cloneNode(true));
  }
}

/** Replica los atributos del <html> (data-theme, clases del tema). */
function syncRootAttributes(into: Document): void {
  for (const { name, value } of [...document.documentElement.attributes]) {
    into.documentElement.setAttribute(name, value);
  }
}

export function DetachedWindow({ name, title, width, height, onClose, children }: DetachedWindowProps) {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const childRef = useRef<Window | null>(null);
  // onClose vive en un ref: el efecto de apertura corre UNA vez por ventana.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const child = window.open('', `orbit-${name}`, `width=${width},height=${height}`);
    if (!child) {
      onCloseRef.current(); // popup bloqueado: re-acopla y no rompas nada
      return;
    }
    childRef.current = child;
    child.document.title = `${title} — Orbit Studio`;
    cloneStyles(document, child.document);
    syncRootAttributes(child.document);
    child.document.body.className = 'detached-body';
    const root = child.document.createElement('div');
    root.className = 'detached-root';
    child.document.body.appendChild(root);
    setMount(root);

    // El tema puede cambiar con la ventana fuera: replica los data-attrs.
    const observer = new MutationObserver(() => syncRootAttributes(child.document));
    observer.observe(document.documentElement, { attributes: true });

    // X nativa (o Alt+F4) → re-acoplar. 'beforeunload' cubre ambos.
    const handleClosed = () => onCloseRef.current();
    child.addEventListener('beforeunload', handleClosed);

    return () => {
      observer.disconnect();
      child.removeEventListener('beforeunload', handleClosed);
      childRef.current = null;
      setMount(null);
      if (!child.closed) child.close();
    };
    // name identifica la ventana: si cambia, es otra ventana.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // El título puede cambiar (p. ej. renombrar patrón) sin reabrir la ventana.
  useEffect(() => {
    if (childRef.current && !childRef.current.closed) {
      childRef.current.document.title = `${title} — Orbit Studio`;
    }
  }, [title]);

  if (!mount) return null;
  return createPortal(<div className="detached-fill">{children}</div>, mount);
}
