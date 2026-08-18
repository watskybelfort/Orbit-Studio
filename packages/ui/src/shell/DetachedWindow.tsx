/**
 * Ventana desacoplada: abre una ventana NATIVA del OS (window.open, que en
 * Electron crea un BrowserWindow hijo con frame normal) y porta el contenido
 * del editor ahí con createPortal. Mismo contexto JS → los stores, el motor
 * de audio y los atajos siguen siendo los de la app; solo cambia dónde se
 * pinta. Cerrar la ventana nativa (X) re-acopla el editor al workspace.
 *
 * Lo que la convierte en una ventana de verdad y no en un popup:
 *  - su sitio lo recuerda el main entre sesiones (window-bounds.ts) y la lista
 *    de editores fuera se restaura al arrancar (state/detached.ts);
 *  - lleva su propia barra: siempre encima y devolver;
 *  - y el TECLADO funciona dentro. Los atajos de la app (espacio, Ctrl+Z, F5…)
 *    y las teclas del piano escuchan en la ventana PRINCIPAL, así que las
 *    pulsaciones de la hija se reenvían allí; sin eso, un piano roll en el
 *    segundo monitor era un editor mudo.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { setAlwaysOnTop, syncAlwaysOnTop, useDetachedStore } from '../state/detached';
import type { WindowId } from '../state/ui';
import { adoptChildWindow, forgetChildWindow } from '../theme/ui-scale';
import './detached.css';

export interface DetachedWindowProps {
  /** Editor que vive en ella: nombra la ventana nativa y su sitio guardado. */
  name: WindowId;
  title: string;
  width: number;
  height: number;
  /** Se llama cuando la ventana nativa se cierra (re-acoplar). */
  onClose: () => void;
  children: ReactNode;
}

/** ¿Se está escribiendo en un campo? Entonces la tecla no es un atajo. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable === true;
}

/**
 * Reenvía a la ventana principal las teclas de la hija.
 *
 * El clon se construye con el KeyboardEvent de ESTE realm (el módulo vive en
 * la principal), así que los `instanceof` de los manejadores siguen valiendo;
 * y si alguien lo cancela allí, se cancela también el original — o el navegador
 * haría su parte (barra espaciadora haciendo scroll, por ejemplo).
 */
function bridgeKeys(child: Window): () => void {
  const forward = (e: KeyboardEvent) => {
    if (e.defaultPrevented || isTyping(e.target)) return;
    const clone = new KeyboardEvent(e.type, {
      key: e.key,
      code: e.code,
      location: e.location,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      repeat: e.repeat,
      bubbles: true,
      cancelable: true,
    });
    if (!window.dispatchEvent(clone)) e.preventDefault();
  };
  child.addEventListener('keydown', forward);
  child.addEventListener('keyup', forward);
  return () => {
    child.removeEventListener('keydown', forward);
    child.removeEventListener('keyup', forward);
  };
}

/**
 * Copia los estilos de la app (style de Vite en dev, link en producción).
 *
 * La ventana hija nace en `about:blank`, así que NO tiene URL base: cualquier
 * ruta relativa que viaje en el clon (el href de un <link>, un url() de una
 * fuente dentro de un <style>) no resuelve contra nada y se cae. Y una ventana
 * sin hoja de estilos se ve exactamente como "todo corrido". Por eso:
 *  - se planta un <base> con la URL de la ventana principal, que arregla de
 *    golpe las url() relativas de las reglas copiadas;
 *  - y el href de cada <link> se reescribe absoluto (el IDL `.href` ya lo da
 *    resuelto en el documento de origen), sin depender del <base>.
 */
function cloneStyles(from: Document, into: Document): void {
  const base = into.createElement('base');
  base.href = from.baseURI;
  into.head.appendChild(base);
  for (const node of from.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const clone = node.cloneNode(true);
    if (clone instanceof HTMLLinkElement && node instanceof HTMLLinkElement) {
      clone.href = node.href;
    }
    into.head.appendChild(clone);
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
    // Registro explícito en la escala de UI: parchea los globals de ESTA
    // ventana (MouseEvent, devicePixelRatio, getBoundingClientRect) y le pone
    // el zoom vigente. Antes se confiaba en que `window.open` estuviera
    // envuelto, y si aún no lo estaba la ventana heredaba el zoom por el
    // `style` del <html> pero con las coordenadas sin traducir: todo clic
    // aquí dentro caía desplazado.
    adoptChildWindow(child);
    child.document.body.className = 'detached-body';
    const root = child.document.createElement('div');
    root.className = 'detached-root';
    child.document.body.appendChild(root);
    setMount(root);

    // El tema puede cambiar con la ventana fuera: replica los data-attrs.
    const observer = new MutationObserver(() => syncRootAttributes(child.document));
    observer.observe(document.documentElement, { attributes: true });

    // Los atajos y el teclado del piano viven en la ventana principal.
    const unbridge = bridgeKeys(child);

    // X nativa (o Alt+F4) → re-acoplar. 'beforeunload' cubre ambos.
    const handleClosed = () => onCloseRef.current();
    child.addEventListener('beforeunload', handleClosed);

    return () => {
      observer.disconnect();
      unbridge();
      child.removeEventListener('beforeunload', handleClosed);
      forgetChildWindow(child);
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
  return createPortal(
    <>
      <DetachedBar id={name} title={title} onReturn={onClose} />
      <div className="detached-fill">{children}</div>
    </>,
    mount,
  );
}

/** Barra propia de la ventana: lo que su frame nativo no trae. */
function DetachedBar({ id, title, onReturn }: { id: WindowId; title: string; onReturn: () => void }) {
  const onTop = useDetachedStore((s) => s.alwaysOnTop[id] === true);
  // El main aplica el siempre-encima guardado al crear la ventana: el botón
  // pregunta cómo quedó en vez de suponer que empieza apagado.
  useEffect(() => {
    void syncAlwaysOnTop([id]);
  }, [id]);
  return (
    <div className="detached-bar">
      <span className="detached-bar-title">{title}</span>
      <button
        className={`detached-bar-btn${onTop ? ' on' : ''}`}
        title="Mantener esta ventana por encima de las demás"
        onClick={() => void setAlwaysOnTop(id, !onTop)}
      >
        Siempre encima
      </button>
      <button
        className="detached-bar-btn"
        title="Devolver el editor a la ventana principal"
        onClick={onReturn}
      >
        Devolver
      </button>
    </div>
  );
}
