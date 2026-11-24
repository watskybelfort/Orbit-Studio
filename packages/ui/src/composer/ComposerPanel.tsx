/**
 * Panel Compositor: beats enteros, cada parte por separado, desde dentro de
 * Orbit.
 *
 * Es una ventana interna y no un modal a propósito: se compone, se le da a
 * play, se escucha y se vuelve a pedir otra melodía sin cerrar nada. El
 * panel solo dibuja y recoge gestos; las reglas del formulario viven en
 * `composer-form.ts` y el trabajo (medir, guardar, despachar) en
 * `state/composer.ts`, que es el mismo camino que usa el MCP.
 */

import { useEffect, useState, type DragEvent } from 'react';
import { SCALES } from '@orbit/core';
import {
  COMPOSER_GENRES,
  COMPOSER_ROLES,
  GENRE_PRESETS,
  genreVariants,
  NOTE_LABELS,
  ROLE_LABELS,
  guessGenre,
  type ComposerRole,
} from '@orbit/sound-library';
import {
  clearReference,
  composeIntoProject,
  deleteProfile,
  loadComposer,
  recomposeLast,
  setReferenceFile,
  trainFromFiles,
  trainFromFolder,
  updateForm,
  useComposerStore,
} from '../state/composer';
import { askName } from '../shell/name-dialog';
import { bpmHint, rollSeed, toComposeOptions } from './composer-form';
import './composer.css';

const pct = (v: number): string => `${Math.round(v * 100)} %`;

export function ComposerPanel() {
  const form = useComposerStore((s) => s.form);
  const profiles = useComposerStore((s) => s.profiles);
  const reference = useComposerStore((s) => s.reference);
  const training = useComposerStore((s) => s.training);
  const busy = useComposerStore((s) => s.busy);
  const status = useComposerStore((s) => s.status);
  const error = useComposerStore((s) => s.error);
  const last = useComposerStore((s) => s.last);
  const [newSound, setNewSound] = useState(false);
  const [dropTarget, setDropTarget] = useState<'train' | 'reference' | null>(null);

  useEffect(() => {
    void loadComposer();
  }, []);

  const variants = genreVariants(form.genre);
  const preset = variants.find((v) => v.id === form.variant)?.preset ?? GENRE_PRESETS[form.genre];
  const profile = profiles.find((p) => p.id === form.profileId) ?? null;
  const working = busy || training !== null;

  const compose = (seed = form.seed) => {
    if (seed !== form.seed) updateForm({ seed });
    const options = toComposeOptions({ ...form, seed }, profiles, reference);
    composeIntoProject(options);
  };

  const toggleRole = (role: ComposerRole) => {
    const has = form.roles.includes(role);
    const roles = has ? form.roles.filter((r) => r !== role) : [...form.roles, role];
    // Siempre queda al menos una parte: un beat sin nada no es un beat.
    if (roles.length > 0) updateForm({ roles: COMPOSER_ROLES.filter((r) => roles.includes(r)) });
  };

  const askProfileName = () =>
    askName({ title: 'Entrenar estilo', label: 'Nombre del perfil', initial: 'Mis beats', confirmLabel: 'Entrenar' });

  const onTrainFolder = async () => {
    const name = await askProfileName();
    if (name !== null) await trainFromFolder(name);
  };

  // El drop lee los archivos ANTES de cualquier await: `dataTransfer` se
  // vacía en cuanto el manejador cede el turno.
  const onDrop = (zone: 'train' | 'reference') => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropTarget(null);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    if (zone === 'reference') {
      void setReferenceFile(files[0]!);
      return;
    }
    void askProfileName().then((name) => {
      if (name !== null) void trainFromFiles(files, name, null);
    });
  };

  const dragProps = (zone: 'train' | 'reference') => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDropTarget(zone);
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: onDrop(zone),
  });

  const ref = reference?.tracks[0];

  return (
    <div className="composer-panel">
      <section className="cmp-block">
        <h3 className="cmp-heading">Género</h3>
        <div className="cmp-genres" role="radiogroup" aria-label="Género">
          {COMPOSER_GENRES.map((g) => (
            <button
              key={g}
              role="radio"
              aria-checked={form.genre === g}
              className={`cmp-chip${form.genre === g ? ' selected' : ''}`}
              onClick={() => updateForm({ genre: g, variant: null })}
            >
              {GENRE_PRESETS[g].name}
            </button>
          ))}
        </div>
        {variants.length > 0 && (
          <div className="cmp-genres" role="radiogroup" aria-label="Variante">
            <button
              role="radio"
              aria-checked={form.variant === null}
              className={`cmp-chip${form.variant === null ? ' selected' : ''}`}
              onClick={() => updateForm({ variant: null })}
            >
              {GENRE_PRESETS[form.genre].variantName ?? 'Clásico'}
            </button>
            {variants.map((v) => (
              <button
                key={v.id}
                role="radio"
                aria-checked={form.variant === v.id}
                className={`cmp-chip${form.variant === v.id ? ' selected' : ''}`}
                onClick={() => updateForm({ variant: v.id })}
              >
                {v.name}
              </button>
            ))}
          </div>
        )}
        <p className="cmp-note">{preset.description}</p>
      </section>

      <section className="cmp-block">
        <h3 className="cmp-heading">Tu estilo</h3>
        <div className="cmp-row">
          <label className="cmp-label" htmlFor="cmp-profile">Perfil</label>
          <select
            id="cmp-profile"
            className="cmp-select"
            value={form.profileId ?? ''}
            onChange={(e) => updateForm({ profileId: e.target.value || null })}
          >
            <option value="">Solo el género</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.tracks.length} pistas
              </option>
            ))}
          </select>
          {profile && (
            <button className="cmp-btn subtle" title="Borrar este perfil" onClick={() => void deleteProfile(profile.id)}>
              Borrar
            </button>
          )}
        </div>
        {(profile || reference) && (
          <div className="cmp-row">
            <label className="cmp-label" htmlFor="cmp-influence">Influencia</label>
            <input
              id="cmp-influence"
              className="cmp-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={form.influence}
              onChange={(e) => updateForm({ influence: Number(e.target.value) })}
            />
            <span className="cmp-value">{pct(form.influence)}</span>
          </div>
        )}
        <div className="cmp-row cmp-actions-left">
          <button className="cmp-btn" disabled={working} onClick={() => void onTrainFolder()}>
            Entrenar con una carpeta…
          </button>
          {profile && (
            <button
              className="cmp-btn"
              disabled={working}
              onClick={() => void trainFromFolderInto(profile.id)}
            >
              Añadir pistas a «{profile.name}»…
            </button>
          )}
        </div>
        <div className="cmp-drops">
          <div className={`cmp-drop${dropTarget === 'train' ? ' over' : ''}`} {...dragProps('train')}>
            Suelta aquí tus beats para entrenar un perfil
          </div>
          <div className={`cmp-drop${dropTarget === 'reference' ? ' over' : ''}`} {...dragProps('reference')}>
            {ref ? (
              <span>
                Referencia: <strong>{ref.name}</strong>
                {ref.bpm !== null ? ` · ${Math.round(ref.bpm)} BPM` : ''}
                {ref.keyRoot !== null ? ` · ${NOTE_LABELS[ref.keyRoot]} ${ref.keyMode === 'major' ? 'mayor' : 'menor'}` : ''}
                {` · suena a ${GENRE_PRESETS[guessGenre(ref)].name}`}
                <button className="cmp-link" onClick={() => clearReference()}>
                  Quitar
                </button>
              </span>
            ) : (
              'Suelta una pista para sacar beats con su temática'
            )}
          </div>
        </div>
        {ref && guessGenre(ref) !== form.genre && (
          <button className="cmp-link" onClick={() => updateForm({ genre: guessGenre(ref), variant: null })}>
            Usar el género que sugiere la referencia ({GENRE_PRESETS[guessGenre(ref)].name})
          </button>
        )}
      </section>

      <section className="cmp-block">
        <h3 className="cmp-heading">Ajustes</h3>
        <div className="cmp-grid">
          <label className="cmp-label" htmlFor="cmp-key">Tonalidad</label>
          <div className="cmp-pair">
            <select
              id="cmp-key"
              className="cmp-select"
              value={form.keyRoot ?? ''}
              onChange={(e) => updateForm({ keyRoot: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">Auto</option>
              {NOTE_LABELS.map((n, i) => (
                <option key={n} value={i}>{n}</option>
              ))}
            </select>
            <select
              aria-label="Escala"
              className="cmp-select"
              value={form.scale ?? ''}
              onChange={(e) => updateForm({ scale: e.target.value || null })}
            >
              <option value="">Escala del género</option>
              {Object.keys(SCALES).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <label className="cmp-label" htmlFor="cmp-bpm">Tempo</label>
          <input
            id="cmp-bpm"
            className="cmp-input"
            type="number"
            min={40}
            max={250}
            placeholder={`Auto · ${bpmHint(form.genre, form.variant)}`}
            value={form.bpm ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value);
              updateForm({ bpm: v !== null && Number.isFinite(v) && v >= 40 && v <= 250 ? v : null });
            }}
          />

          <span className="cmp-label">Forma</span>
          <div className="cmp-pair">
            <div className="cmp-seg">
              <button className={`cmp-seg-btn${form.shape === 'song' ? ' selected' : ''}`} onClick={() => updateForm({ shape: 'song' })}>
                Tema completo
              </button>
              <button className={`cmp-seg-btn${form.shape === 'loop' ? ' selected' : ''}`} onClick={() => updateForm({ shape: 'loop' })}>
                Bucle
              </button>
            </div>
            {form.shape === 'loop' && (
              <select
                aria-label="Compases del bucle"
                className="cmp-select"
                value={form.loopBars}
                onChange={(e) => updateForm({ loopBars: Number(e.target.value) })}
              >
                {[2, 4, 8, 16].map((n) => (
                  <option key={n} value={n}>{n} compases</option>
                ))}
              </select>
            )}
          </div>

          <label className="cmp-label" htmlFor="cmp-complexity">Densidad</label>
          <div className="cmp-pair">
            <input
              id="cmp-complexity"
              className="cmp-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={form.complexity}
              onChange={(e) => updateForm({ complexity: Number(e.target.value) })}
            />
            <span className="cmp-value">{pct(form.complexity)}</span>
          </div>

          <label className="cmp-label" htmlFor="cmp-variation">Sonidos nuevos</label>
          <div className="cmp-pair">
            <input
              id="cmp-variation"
              className="cmp-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={form.soundVariation}
              onChange={(e) => updateForm({ soundVariation: Number(e.target.value) })}
            />
            <span className="cmp-value">{pct(form.soundVariation)}</span>
          </div>
        </div>
      </section>

      <section className="cmp-block">
        <h3 className="cmp-heading">Partes</h3>
        <div className="cmp-roles">
          {COMPOSER_ROLES.map((role) => (
            <label key={role} className="cmp-check">
              <input type="checkbox" checked={form.roles.includes(role)} onChange={() => toggleRole(role)} />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </section>

      <section className="cmp-block cmp-go">
        <div className="cmp-row">
          <label className="cmp-label" htmlFor="cmp-seed">Semilla</label>
          <input
            id="cmp-seed"
            className="cmp-input cmp-seed"
            type="number"
            min={0}
            value={form.seed}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) updateForm({ seed: Math.floor(v) >>> 0 });
            }}
          />
          <button className="cmp-btn subtle" title="Otra semilla" onClick={() => updateForm({ seed: rollSeed() })}>
            Dado
          </button>
        </div>
        <div className="cmp-row cmp-actions">
          <button className="cmp-btn" disabled={working} onClick={() => compose(rollSeed())}>
            Otro beat
          </button>
          <button className="cmp-btn primary" disabled={working} onClick={() => compose()}>
            Componer
          </button>
        </div>
      </section>

      {last && (
        <section className="cmp-block">
          <h3 className="cmp-heading">Cambiar una parte del último beat</h3>
          <div className="cmp-roles">
            {last.plan.parts.map((p) => (
              <button key={p.role} className="cmp-chip" disabled={working} onClick={() => recomposeLast(p.role, newSound)}>
                {p.name}
              </button>
            ))}
          </div>
          <label className="cmp-check">
            <input type="checkbox" checked={newSound} onChange={(e) => setNewSound(e.target.checked)} />
            Con sonido nuevo
          </label>
        </section>
      )}

      {training && (
        <p className="cmp-status" role="status">
          Aprendiendo {training.done + 1} de {training.total}: {training.current}
        </p>
      )}
      {!training && status && <p className="cmp-status" role="status">{status}</p>}
      {error && <p className="cmp-error" role="alert">{error}</p>}
    </div>
  );
}

/** «Añadir pistas a este perfil»: carpeta nueva, mismo perfil. */
function trainFromFolderInto(profileId: string): Promise<void> {
  const profile = useComposerStore.getState().profiles.find((p) => p.id === profileId);
  return trainFromFolder(profile?.name ?? 'Mi estilo', profileId);
}
