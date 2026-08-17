/**
 * Panel de Orbit Flux — el browser del instrumento.
 *
 * Izquierda: categorías con su cuenta y un buscador (nombre y tags, sin
 * acentos). Centro: la lista de presets del filtro actual; un clic carga el
 * sonido en el canal y lo hace sonar. Abajo: las ocho perillas del canal, con
 * las dos macros tomando su etiqueta del preset cargado.
 *
 * Cargar un preset es UN comando (`patchChannel` con el id y los params
 * nuevos), así que entra y sale con Ctrl+Z como cualquier otra cosa. El nombre
 * del canal se renombra solo si seguía siendo el del preset anterior: si lo
 * habías puesto tú, no se toca.
 */

import { useMemo, useState } from 'react';
import {
  FLUX_CATEGORIES,
  FLUX_CATEGORY_LABELS,
  FLUX_PRESETS,
  INSTRUMENT_PARAMS,
  defaultInstrumentParams,
  findFluxPreset,
  type Channel,
  type FluxCategory,
  type FluxPreset,
  type Project,
} from '@orbit/core';
import { engine, ensureAudioReady, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { Knob } from '../../widgets/Knob';
import './flux.css';

/** Normaliza para buscar sin acentos ni mayúsculas. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Canal Flux que edita el panel: el elegido, o el primero que haya. */
function pickChannel(project: Project, wanted: string | null): Channel | undefined {
  const chosen = wanted ? project.channels[wanted] : undefined;
  if (chosen?.kind === 'flux') return chosen;
  for (const id of project.channelOrder) {
    const ch = project.channels[id];
    if (ch?.kind === 'flux') return ch;
  }
  return undefined;
}

export function FluxPanel() {
  const project = useProject();
  const fluxChannelId = useUiStore((s) => s.fluxChannelId);
  const [category, setCategory] = useState<FluxCategory | 'all'>('all');
  const [query, setQuery] = useState('');

  const channel = pickChannel(project, fluxChannelId);
  const preset = findFluxPreset(channel?.fluxPreset);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of FLUX_PRESETS) map.set(p.category, (map.get(p.category) ?? 0) + 1);
    return map;
  }, []);

  const list = useMemo(() => {
    const q = fold(query.trim());
    return FLUX_PRESETS.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (!q) return true;
      return fold(`${p.name} ${p.tags.join(' ')} ${p.pack}`).includes(q);
    });
  }, [category, query]);

  if (!channel) {
    return (
      <div className="flux">
        <p className="flux-empty">
          No hay ningún canal de Orbit Flux. Añádelo desde el Channel Rack
          (<b>+ Canal → Orbit Flux</b>) y aquí podrás elegir su sonido entre{' '}
          {FLUX_PRESETS.length} presets: teclas, bajos, leads, pads, plucks,
          campanas, órganos y atmósferas.
        </p>
      </div>
    );
  }

  const channelIndex = project.channelOrder.indexOf(channel.id);

  /** Carga un preset en el canal y lo hace sonar una vez. */
  const load = (next: FluxPreset) => {
    const params = { ...defaultInstrumentParams('flux'), ...channel.params };
    params['macro1'] = next.macros[0].value;
    params['macro2'] = next.macros[1].value;
    const patch: Partial<Omit<Channel, 'id'>> = { fluxPreset: next.id, params };
    // Renombrar solo si el nombre seguía siendo el del preset anterior.
    if (!preset || channel.name === preset.name || channel.name === 'Orbit Flux') {
      patch.name = next.name;
    }
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch },
      { label: `Flux: ${next.name}` },
    );
    audition(channelIndex);
  };

  const setParam = (key: string, value: number) => {
    store.dispatch(
      {
        type: 'patchChannel',
        channelId: channel.id,
        patch: { params: { ...channel.params, [key]: value } },
      },
      { label: `Flux: ${key}`, mergeKey: `flux:${channel.id}:${key}` },
    );
  };

  const specs = INSTRUMENT_PARAMS['flux'];
  const labelOf = (key: string): string => {
    if (key === 'macro1') return preset?.macros[0].label ?? 'Macro 1';
    if (key === 'macro2') return preset?.macros[1].label ?? 'Macro 2';
    return specs.find((s) => s.key === key)?.label ?? key;
  };

  return (
    <div className="flux">
      <div className="flux-head">
        <span className="flux-channel" title="Canal que edita este panel">
          {channel.name}
        </span>
        <span className="flux-preset" title={preset ? `${preset.pack} · ${preset.id}` : ''}>
          {preset ? `${FLUX_CATEGORY_LABELS[preset.category]} · ${preset.name}` : 'Sin preset'}
        </span>
        <button
          className="flux-audition"
          title="Escuchar el sonido cargado"
          onClick={() => audition(channelIndex)}
        >
          ▶ Escuchar
        </button>
      </div>

      <div className="flux-body">
        <div className="flux-cats">
          <input
            className="flux-search"
            placeholder="Buscar sonido…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className={`flux-cat${category === 'all' ? ' on' : ''}`}
            onClick={() => setCategory('all')}
          >
            Todos <span className="flux-count">{FLUX_PRESETS.length}</span>
          </button>
          {FLUX_CATEGORIES.map((c) => (
            <button
              key={c}
              className={`flux-cat${category === c ? ' on' : ''}`}
              onClick={() => setCategory(c)}
            >
              {FLUX_CATEGORY_LABELS[c]} <span className="flux-count">{counts.get(c) ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="flux-list">
          {list.length === 0 && <div className="flux-none">Ningún sonido con ese nombre.</div>}
          {list.map((p) => (
            <button
              key={p.id}
              className={`flux-item${p.id === channel.fluxPreset ? ' on' : ''}`}
              onClick={() => load(p)}
              title={`${p.pack} · ${p.layers.length} capa(s)`}
            >
              <span className="flux-item-name">{p.name}</span>
              <span className="flux-item-tags">{p.tags.slice(0, 3).join(' · ')}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flux-knobs">
        {specs.map((spec) => (
          <Knob
            key={spec.key}
            value={channel.params[spec.key] ?? spec.default}
            min={spec.min}
            max={spec.max}
            defaultValue={spec.default}
            size={34}
            label={labelOf(spec.key)}
            format={(v) =>
              spec.key === 'octave' ? `${v > 0 ? '+' : ''}${Math.round(v)}` : `${Math.round(v * 100)}%`
            }
            onChange={(v) => setParam(spec.key, v)}
            paramRef={{ kind: 'channel', channelId: channel.id, param: spec.key }}
          />
        ))}
      </div>
    </div>
  );
}

/** Nota de prueba (Do central) para oír el preset recién cargado. */
function audition(channelIndex: number): void {
  if (channelIndex < 0) return;
  ensureAudioReady();
  engine.previewNote(channelIndex, 60, true);
  setTimeout(() => engine.previewNote(channelIndex, 60, false), 700);
}
