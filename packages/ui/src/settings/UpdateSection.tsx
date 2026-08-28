/**
 * Ajustes → Actualizaciones: el interruptor del aviso de versión nueva.
 *
 * Orbit no tiene autoUpdater — se instala por NSIS y ahí se acaba. Esto solo
 * mira si hay una release más nueva publicada y, si la hay, enseña un cartel
 * discreto con el enlace (ver `state/update-check.ts`). Nada se descarga ni
 * se reinicia solo. Apagado aquí, el cartel no vuelve a salir hasta que se
 * encienda de nuevo — un DAW que interrumpe a mitad de una toma es peor que
 * uno viejo.
 */

import { useEffect, useState } from 'react';
import { setUpdateCheckEnabled, UPDATE_CHECK_ENABLED_KEY } from '../state/update-check';

export function UpdateSection() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    void (async () => {
      const settings = (await window.orbit?.settings.get().catch(() => undefined)) ?? {};
      setEnabled(settings[UPDATE_CHECK_ENABLED_KEY] !== false);
    })();
  }, []);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    void setUpdateCheckEnabled(next);
  };

  return (
    <>
      <h3 className="set-heading">Actualizaciones</h3>
      <div className="set-row">
        <span className="set-label">Avisar de versión nueva</span>
        <button className={`set-toggle${enabled ? ' on' : ''}`} onClick={toggle}>
          <span className="set-toggle-knob" />
        </button>
        <span className="set-value">
          {enabled
            ? 'Se mira una vez al día; sin descargar ni reiniciar nada'
            : 'No se comprueba nada'}
        </span>
      </div>
    </>
  );
}
