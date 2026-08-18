/**
 * Galería de plugins dentro de Ajustes.
 *
 * Se añaden fuentes (la URL de un índice JSON publicado donde sea), se ve qué
 * ofrecen y se instala de un clic. Lo que baja NO se ejecuta para averiguar
 * qué es: se lee con el parseo estático de siempre y, si de ahí no sale un
 * plugin, no se guarda. El formato del índice está en `docs/plugin-gallery.json`.
 */

import { useEffect, useState } from 'react';
import { usePluginsStore } from '../state/plugins';
import {
  addSource,
  initGallery,
  installPlugin,
  loadSource,
  removeSource,
  uninstallPlugin,
  useGallery,
} from '../state/gallery';

export function GallerySection() {
  const sources = useGallery((s) => s.sources);
  const busy = useGallery((s) => s.busy);
  const notice = useGallery((s) => s.notice);
  const installed = usePluginsStore((s) => s.plugins);
  const [url, setUrl] = useState('');

  useEffect(() => {
    void initGallery();
  }, []);

  const add = () => {
    void addSource(url);
    setUrl('');
  };

  return (
    <>
      <h3 className="set-heading">Galería de plugins</h3>

      <div className="set-row">
        <span className="set-label">Añadir galería</span>
        <input
          className="gal-input"
          value={url}
          placeholder="https://…/plugins.json"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button className="tbtn" onClick={add}>
          Añadir
        </button>
      </div>

      <p className="set-note">
        Una galería es un JSON con la lista de plugins y de dónde bajarlos (el
        formato está en <code>docs/plugin-gallery.json</code>). Lo que se
        descarga se comprueba sin ejecutarlo —tiene que declarar
        <code> createEffect</code> o <code>createInstrument</code>— y se guarda
        en tu carpeta de plugins; a partir de ahí corre como cualquier otro,
        con el mismo bypass anti-crash del kernel.
      </p>

      {notice && <p className="set-note">{notice}</p>}

      {sources.length === 0 && (
        <p className="set-note">Todavía no sigues ninguna galería.</p>
      )}

      {sources.map((source) => (
        <div key={source.url} className="gal-source">
          <div className="gal-source-head">
            <span className="gal-source-name" title={source.url}>
              {source.index?.name ?? source.url}
            </span>
            {source.loading && <span className="gal-tag">cargando…</span>}
            <button className="tbtn small" onClick={() => void loadSource(source.url)}>
              Actualizar
            </button>
            <button className="tbtn small" onClick={() => void removeSource(source.url)}>
              Quitar
            </button>
          </div>
          {source.error && <p className="set-error">{source.error}</p>}
          {source.index?.description && <p className="set-note">{source.index.description}</p>}

          {source.index?.plugins.map((plugin) => {
            const already = installed.some((p) => p.id === plugin.id);
            return (
              <div key={plugin.id} className="gal-plugin">
                <span className="gal-plugin-name">{plugin.name}</span>
                {plugin.author && <span className="gal-tag">{plugin.author}</span>}
                {plugin.kind && <span className="gal-tag">{plugin.kind}</span>}
                <span className="gal-plugin-desc">{plugin.description ?? ''}</span>
                {already ? (
                  <button
                    className="tbtn small"
                    title="Quitarlo de tu carpeta de plugins"
                    onClick={() => void uninstallPlugin(plugin.id)}
                  >
                    Quitar
                  </button>
                ) : (
                  <button
                    className="tbtn small"
                    disabled={busy === plugin.id}
                    onClick={() => void installPlugin(plugin)}
                  >
                    {busy === plugin.id ? '…' : 'Instalar'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
