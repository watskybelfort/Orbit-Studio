/**
 * Ajustes → Apariencia: tema (oscuro/claro/acrílico), las tres perillas
 * (acento, transparencia, tinte), semáforo Mac y temas custom con nombre.
 * Todo se aplica EN VIVO y se persiste en settings.json.
 */

import { useEffect, useState } from 'react';
import {
  applyTheme,
  isThemeId,
  saveThemeToSettings,
  type ThemeId,
  type ThemeOverrides,
} from '../theme/theme';
import { useUiStore } from '../state/ui';
import './settings.css';

const ACCENT_PALETTE = [
  '#5aa9e6', '#e6675a', '#7ce65a', '#e6c95a',
  '#b45ae6', '#5ae6c9', '#e65aa9', '#e6935a',
];

interface CustomTheme {
  theme: ThemeId;
  overrides: ThemeOverrides;
}

type CustomThemes = Record<string, CustomTheme>;

function parseCustomThemes(raw: unknown): CustomThemes {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: CustomThemes = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = v as Partial<CustomTheme>;
    if (t && isThemeId(t.theme)) {
      out[name] = { theme: t.theme, overrides: t.overrides ?? {} };
    }
  }
  return out;
}

export function SettingsPanel() {
  const [theme, setTheme] = useState<ThemeId>('dark');
  const [overrides, setOverrides] = useState<ThemeOverrides>({});
  const [customThemes, setCustomThemes] = useState<CustomThemes>({});
  const [savingName, setSavingName] = useState<string | null>(null);
  const [acrylicOk, setAcrylicOk] = useState(true);
  const trafficLights = useUiStore((s) => s.trafficLights);

  useEffect(() => {
    void (async () => {
      const settings = (await window.orbit?.settings.get()) ?? {};
      const saved = settings['theme'];
      if (isThemeId(saved)) setTheme(saved);
      setOverrides({
        accent: typeof settings['accent'] === 'string' ? settings['accent'] : undefined,
        glassAlpha: typeof settings['glassAlpha'] === 'number' ? settings['glassAlpha'] : undefined,
        glassTint: typeof settings['glassTint'] === 'string' ? settings['glassTint'] : undefined,
      });
      setCustomThemes(parseCustomThemes(settings['customThemes']));
    })();
  }, []);

  const commit = (nextTheme: ThemeId, nextOverrides: ThemeOverrides) => {
    setTheme(nextTheme);
    setOverrides(nextOverrides);
    void applyTheme(nextTheme, nextOverrides).then((ok) => {
      if (nextTheme === 'acrylic') setAcrylicOk(ok);
    });
    void saveThemeToSettings(nextTheme, { ...nextOverrides, trafficLights });
  };

  const setTraffic = (on: boolean) => {
    useUiStore.setState({ trafficLights: on });
    void window.orbit?.settings.set({ trafficLights: on });
  };

  const saveCustom = (name: string) => {
    const next = { ...customThemes, [name]: { theme, overrides } };
    setCustomThemes(next);
    void window.orbit?.settings.set({ customThemes: next });
    setSavingName(null);
  };

  const deleteCustom = (name: string) => {
    const next = { ...customThemes };
    delete next[name];
    setCustomThemes(next);
    void window.orbit?.settings.set({ customThemes: next });
  };

  return (
    <div className="settings">
      <h3 className="set-heading">Apariencia</h3>

      <div className="set-row">
        <span className="set-label">Tema</span>
        <div className="theme-cards">
          {(
            [
              ['dark', 'Oscuro'],
              ['light', 'Claro'],
              ['acrylic', 'Acrílico'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`theme-card ${id}${theme === id ? ' selected' : ''}`}
              onClick={() => commit(id, overrides)}
            >
              <span className="theme-card-preview">
                <span className="tp-bar" />
                <span className="tp-row" />
                <span className="tp-row short" />
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>
      {theme === 'acrylic' && !acrylicOk && (
        <p className="set-note">
          El acrílico real necesita Windows 11; se aplica el fondo oscuro equivalente.
        </p>
      )}

      <div className="set-row">
        <span className="set-label">Acento</span>
        <div className="swatches">
          {ACCENT_PALETTE.map((c) => (
            <button
              key={c}
              className={`swatch${(overrides.accent ?? '#5aa9e6') === c ? ' selected' : ''}`}
              style={{ background: c }}
              onClick={() => commit(theme, { ...overrides, accent: c })}
            />
          ))}
          <input
            type="color"
            className="color-input"
            value={overrides.accent ?? '#5aa9e6'}
            onChange={(e) => commit(theme, { ...overrides, accent: e.target.value })}
            title="Color personalizado"
          />
        </div>
      </div>

      <div className={`set-row${theme !== 'acrylic' ? ' disabled' : ''}`}>
        <span className="set-label">Transparencia</span>
        <input
          type="range"
          min={0.2}
          max={0.92}
          step={0.01}
          disabled={theme !== 'acrylic'}
          value={overrides.glassAlpha ?? 0.55}
          onChange={(e) => commit(theme, { ...overrides, glassAlpha: Number(e.target.value) })}
        />
        <span className="set-value">
          {Math.round((1 - (overrides.glassAlpha ?? 0.55)) * 100)}% vidrio
        </span>
      </div>

      <div className={`set-row${theme !== 'acrylic' ? ' disabled' : ''}`}>
        <span className="set-label">Tinte</span>
        <input
          type="color"
          className="color-input"
          disabled={theme !== 'acrylic'}
          value={overrides.glassTint ?? '#101114'}
          onChange={(e) => commit(theme, { ...overrides, glassTint: e.target.value })}
        />
      </div>

      <div className="set-row">
        <span className="set-label">Semáforo macOS</span>
        <button
          className={`set-toggle${trafficLights ? ' on' : ''}`}
          onClick={() => setTraffic(!trafficLights)}
        >
          <span className="set-toggle-knob" />
        </button>
        <span className="set-value">
          {trafficLights ? 'Botones a la izquierda, estilo Mac' : 'Botones Windows a la derecha'}
        </span>
      </div>

      <h3 className="set-heading">Mis temas</h3>
      <div className="custom-themes">
        {Object.entries(customThemes).map(([name, t]) => (
          <div key={name} className="custom-theme">
            <button className="custom-apply" onClick={() => commit(t.theme, t.overrides)}>
              <span className="swatch" style={{ background: t.overrides.accent ?? '#5aa9e6' }} />
              {name}
            </button>
            <button className="custom-del" title="Borrar" onClick={() => deleteCustom(name)}>
              ×
            </button>
          </div>
        ))}
        {savingName === null ? (
          <button className="tbtn" onClick={() => setSavingName('')}>
            Guardar tema actual…
          </button>
        ) : (
          <input
            className="scrubber-input"
            autoFocus
            placeholder="Nombre del tema"
            value={savingName}
            onChange={(e) => setSavingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && savingName.trim()) saveCustom(savingName.trim());
              if (e.key === 'Escape') setSavingName(null);
            }}
            onBlur={() => setSavingName(null)}
          />
        )}
      </div>

      <h3 className="set-heading">Audio</h3>
      <p className="set-note">
        Motor: kernel propio en AudioWorklet · bloques de 128 samples · low-end
        mono bajo 110 Hz en master (efecto Stereo).
      </p>
    </div>
  );
}
