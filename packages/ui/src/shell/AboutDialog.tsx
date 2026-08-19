/**
 * "Acerca de Orbit Studio": qué versión estás usando y sobre qué corre.
 *
 * No es decoración. Cuando algo va raro, lo primero que hay que saber es la
 * versión — y hasta ahora no había forma de verla desde la app (el único número
 * que se exponía era un '0.1.0' escrito a mano en el preload, dos años de
 * releases por detrás). El botón de copiar deja la ficha entera en el
 * portapapeles para pegarla en un reporte.
 */

import { useEffect, useState } from 'react';
import { useUiStore } from '../state/ui';
import './about.css';

interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  dev: boolean;
  userData: string;
}

const PLATFORMS: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

export function AboutDialog() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const close = () => useUiStore.setState({ aboutOpen: false });

  useEffect(() => {
    let alive = true;
    const api = window.orbit;
    if (!api) {
      setFailed(true);
      return;
    }
    void api.app
      .info()
      .then((got) => {
        if (alive) setInfo(got as AppInfo);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc cierra, como cualquier diálogo de la app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rows: [string, string][] = info
    ? [
        ['Versión', `${info.version}${info.dev ? ' (dev)' : ''}`],
        ['Sistema', `${PLATFORMS[info.platform] ?? info.platform} · ${info.arch}`],
        ['Electron', info.electron],
        ['Chromium', info.chrome],
        ['Node', info.node],
        ['Datos', info.userData],
      ]
    : [];

  const copy = () => {
    void navigator.clipboard
      ?.writeText(rows.map(([k, v]) => `${k}: ${v}`).join('\n'))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };

  return (
    <div className="about-backdrop" onPointerDown={close}>
      <div className="about popup" onPointerDown={(e) => e.stopPropagation()}>
        <button className="about-close" title="Cerrar (Esc)" onClick={close}>
          ✕
        </button>
        <div className="about-head">
          <div className="about-mark">◍</div>
          <div>
            <div className="about-name">Orbit Studio</div>
            <div className="about-version">
              {info ? `v${info.version}` : failed ? 'versión no disponible' : '…'}
              {info?.dev ? ' · dev' : ''}
            </div>
          </div>
        </div>

        {failed && <p className="about-error">No se pudo leer la ficha de la aplicación.</p>}

        {rows.length > 0 && (
          <dl className="about-rows">
            {rows.map(([k, v]) => (
              <div key={k} className="about-row">
                <dt>{k}</dt>
                <dd title={v}>{v}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="about-actions">
          <button className="about-btn" onClick={copy} disabled={rows.length === 0}>
            {copied ? 'Copiado' : 'Copiar ficha'}
          </button>
          <button className="about-btn primary" onClick={close}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
