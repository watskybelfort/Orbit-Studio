/**
 * Ajustes → Apariencia: tema (oscuro/claro/acrílico), las tres perillas
 * (acento, transparencia, tinte), semáforo Mac, los ajustes de "a mi manera"
 * (escala de la interfaz, tipografía y radio de esquinas) y temas custom con
 * nombre, que además se pueden sacar y meter como archivo.
 * Todo se aplica EN VIVO y se persiste en settings.json.
 */

import { useEffect, useState } from 'react';
import { GallerySection } from './GallerySection';
import { InputSection } from './InputSection';
import { MidiSection } from './MidiSection';

import {
  commitAppearance,
  DEFAULT_APPEARANCE,
  UI_FONTS,
  UI_RADIUS_MAX,
  UI_RADIUS_MIN,
  appearanceFromSettings,
  isUiFontId,
  type Appearance,
} from '../theme/appearance';
import {
  applyTheme,
  isThemeId,
  saveThemeToSettings,
  type ThemeId,
  type ThemeOverrides,
} from '../theme/theme';
import {
  buildThemeFile,
  downloadThemeFile,
  parseThemeFile,
  pickThemeFile,
} from '../theme/theme-file';
import { UI_SCALE_MAX, UI_SCALE_MIN } from '../theme/ui-scale';
import { useUiStore } from '../state/ui';
import { forgetWorkspace, setWorkspaceMemory, workspaceMemoryOn } from '../state/workspace-memory';
import './settings.css';

const ACCENT_PALETTE = [
  '#5aa9e6', '#e6675a', '#7ce65a', '#e6c95a',
  '#b45ae6', '#5ae6c9', '#e65aa9', '#e6935a',
];

const THEME_LABEL: Record<ThemeId, string> = {
  dark: 'Oscuro',
  light: 'Claro',
  acrylic: 'Acrílico',
};

interface CustomTheme {
  theme: ThemeId;
  overrides: ThemeOverrides;
  /** Escala/tipografía/radio; falta en los temas guardados antes de existir. */
  appearance?: Appearance;
}

type CustomThemes = Record<string, CustomTheme>;

function parseCustomThemes(raw: unknown): CustomThemes {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: CustomThemes = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = v as Partial<CustomTheme>;
    if (t && isThemeId(t.theme)) {
      out[name] = {
        theme: t.theme,
        overrides: t.overrides ?? {},
        ...(t.appearance ? { appearance: t.appearance } : null),
      };
    }
  }
  return out;
}

/** Aviso del exportar/importar de temas (verde = bien, rojo = archivo malo). */
type FileNotice = { kind: 'ok' | 'error'; text: string } | null;

export function SettingsPanel() {
  const [theme, setTheme] = useState<ThemeId>('dark');
  const [overrides, setOverrides] = useState<ThemeOverrides>({});
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [customThemes, setCustomThemes] = useState<CustomThemes>({});
  const [savingName, setSavingName] = useState<string | null>(null);
  const [acrylicOk, setAcrylicOk] = useState(true);
  const [fileNotice, setFileNotice] = useState<FileNotice>(null);
  const trafficLights = useUiStore((s) => s.trafficLights);
  const [rememberLayout, setRememberLayout] = useState(workspaceMemoryOn());

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
      setAppearance(appearanceFromSettings(settings));
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

  /** Escala/fuente/radio: se aplican al instante y se guardan al parar. */
  const commitLook = (next: Appearance) => {
    setAppearance(next);
    commitAppearance(next);
  };

  const setTraffic = (on: boolean) => {
    useUiStore.setState({ trafficLights: on });
    void window.orbit?.settings.set({ trafficLights: on });
  };

  const saveCustom = (name: string) => {
    const next = { ...customThemes, [name]: { theme, overrides, appearance } };
    setCustomThemes(next);
    void window.orbit?.settings.set({ customThemes: next });
    setSavingName(null);
  };

  const applyCustom = (t: CustomTheme) => {
    commit(t.theme, t.overrides);
    // Los temas guardados antes de que existiera "a mi manera" no traen
    // apariencia: en ese caso se respeta la que el usuario tenga puesta.
    if (t.appearance) commitLook(t.appearance);
  };

  const deleteCustom = (name: string) => {
    const next = { ...customThemes };
    delete next[name];
    setCustomThemes(next);
    void window.orbit?.settings.set({ customThemes: next });
  };

  // ── Tema como archivo ──────────────────────────────────────────────────────

  const exportThemeFile = () => {
    const name = `Tema Orbit ${THEME_LABEL[theme]}`;
    const written = downloadThemeFile(buildThemeFile(name, theme, overrides, appearance));
    setFileNotice({ kind: 'ok', text: `Guardando ${written} (elige dónde en el diálogo).` });
  };

  const importThemeFile = async () => {
    const picked = await pickThemeFile();
    if (!picked) return;
    const result = parseThemeFile(picked.text);
    if (!result.ok) {
      setFileNotice({ kind: 'error', text: `No se pudo importar ${picked.name}: ${result.error}` });
      return;
    }
    const file = result.file;
    commit(file.theme, file.overrides);
    commitLook(file.appearance);
    // Además de aplicarlo, queda en "Mis temas" para poder volver a él.
    const next = {
      ...customThemes,
      [file.name]: { theme: file.theme, overrides: file.overrides, appearance: file.appearance },
    };
    setCustomThemes(next);
    void window.orbit?.settings.set({ customThemes: next });
    setFileNotice({ kind: 'ok', text: `Tema «${file.name}» importado y guardado en Mis temas.` });
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

      <div className="set-row">
        <span className="set-label">Recordar el escritorio</span>
        <button
          className={`set-toggle${rememberLayout ? ' on' : ''}`}
          onClick={() => {
            const next = !rememberLayout;
            setRememberLayout(next);
            setWorkspaceMemory(next, true);
          }}
        >
          <span className="set-toggle-knob" />
        </button>
        <span className="set-value">
          {rememberLayout
            ? 'Las ventanas vuelven a salir donde las dejaste'
            : 'Cada arranque sale con la disposición de fábrica'}
        </span>
        <button
          className="set-reset"
          title="Olvidar la disposición guardada"
          onClick={forgetWorkspace}
        >
          Olvidar
        </button>
      </div>

      <h3 className="set-heading">A mi manera</h3>

      <div className="set-row">
        <span className="set-label">Escala de la UI</span>
        <input
          type="range"
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={0.05}
          value={appearance.scale}
          onChange={(e) => commitLook({ ...appearance, scale: Number(e.target.value) })}
        />
        <span className="set-value">{Math.round(appearance.scale * 100)}%</span>
        <button
          className="set-reset"
          disabled={appearance.scale === DEFAULT_APPEARANCE.scale}
          title="Volver al 100%"
          onClick={() => commitLook({ ...appearance, scale: DEFAULT_APPEARANCE.scale })}
        >
          100%
        </button>
      </div>
      <p className="set-note">
        Escala toda la interfaz de golpe —texto, paneles, perillas y los canvas del piano roll y
        la playlist, que se redibujan a la nueva resolución para no salir borrosos.
      </p>

      <div className="set-row">
        <span className="set-label">Tipografía</span>
        <select
          className="set-select"
          value={appearance.font}
          onChange={(e) => {
            const id = e.target.value;
            if (isUiFontId(id)) commitLook({ ...appearance, font: id });
          }}
        >
          {UI_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="set-value">Fuentes que ya trae el sistema</span>
      </div>

      <div className="set-row">
        <span className="set-label">Radio de esquinas</span>
        <input
          type="range"
          min={UI_RADIUS_MIN}
          max={UI_RADIUS_MAX}
          step={1}
          value={appearance.radius}
          onChange={(e) => commitLook({ ...appearance, radius: Number(e.target.value) })}
        />
        <span className="set-value">{appearance.radius} px</span>
        <span className="radius-preview" style={{ borderRadius: `${appearance.radius}px` }} />
      </div>

      <h3 className="set-heading">Mis temas</h3>
      <div className="custom-themes">
        {Object.entries(customThemes).map(([name, t]) => (
          <div key={name} className="custom-theme">
            <button className="custom-apply" onClick={() => applyCustom(t)}>
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

      <div className="set-row">
        <button className="tbtn" onClick={exportThemeFile}>
          Exportar tema a archivo…
        </button>
        <button className="tbtn" onClick={() => void importThemeFile()}>
          Importar tema…
        </button>
      </div>
      {fileNotice && (
        <p className={fileNotice.kind === 'error' ? 'set-error' : 'set-note'}>{fileNotice.text}</p>
      )}

      <InputSection />

      <MidiSection />

      <GallerySection />

      <h3 className="set-heading">Audio</h3>

      <p className="set-note">
        Motor: kernel propio en AudioWorklet · bloques de 128 samples · low-end
        mono bajo 110 Hz en master (efecto Stereo).
      </p>
    </div>
  );
}
