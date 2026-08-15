import { useEffect, useState } from 'react';
import './theme/base.css';
import './theme/tokens.css';
import { TitleBar } from './shell/TitleBar';
import { applyTheme, loadThemeFromSettings } from './theme/theme';

// Shell raíz: carga el tema persistido al montar (fallback: oscuro) y pinta
// la barra de título + el área principal. El layout real (playlist, rack,
// mixer, browser) llega en la fase de layout.

export function App() {
  const [trafficLights, setTrafficLights] = useState(false);

  useEffect(() => {
    let alive = true;
    loadThemeFromSettings()
      .then(({ overrides }) => {
        if (alive) setTrafficLights(overrides.trafficLights ?? false);
      })
      .catch(() => {
        void applyTheme('dark');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="app-shell">
      <TitleBar trafficLights={trafficLights} />
      <main className="app-main" />
    </div>
  );
}
