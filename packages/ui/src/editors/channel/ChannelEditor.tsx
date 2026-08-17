/**
 * Editor de sonido de un canal — el panel del doble clic en el Channel Rack.
 *
 * Un canal se tocaba hasta ahora a trozos: dos perillas mini en el rack, el
 * volumen en el mixer y los parámetros del instrumento en ningún sitio. Aquí
 * está TODO lo que se le puede hacer a UN sonido, repartido en pestañas
 * porque son muchas opciones y una rejilla con cuarenta perillas no se lee:
 *
 * - Sonido: las perillas del instrumento (y, en el sampler, el recorte con su
 *   forma de onda: dónde entra, dónde corta, fades, reverse, fase, loop).
 * - Efectos: los cuatro inserts propios del canal, que son lo que permite
 *   bajarle el reverb a ESTE sonido sin tocar a los demás.
 * - Mezcla: volumen, pan, mute/solo y a qué pista de mixer sale.
 *
 * Renombrar, color y el atajo al Piano Roll viven en la cabecera, que se ve
 * desde cualquier pestaña.
 */

import { useEffect, useRef, useState } from 'react';
import { INSTRUMENT_LABELS, type Channel } from '@orbit/core';
import { reportActivity } from '../../collab/presence';
import { engine, ensureAudioReady, store } from '../../state/app';
import { useProject } from '../../state/useProject';
import { useUiStore } from '../../state/ui';
import { FxTab } from './FxTab';
import { MixTab } from './MixTab';
import { SoundTab } from './SoundTab';
import './channel.css';

type TabId = 'sound' | 'fx' | 'mix';

const TABS: { id: TabId; label: string; title: string }[] = [
  { id: 'sound', label: 'Sonido', title: 'Las perillas del instrumento y el recorte del sample' },
  { id: 'fx', label: 'Efectos', title: 'Los cuatro inserts propios de este canal' },
  { id: 'mix', label: 'Mezcla y ruteo', title: 'Volumen, pan, mute/solo y pista de mixer' },
];

/** Altura de preview: kick en drums, C5 en el resto (la misma que el rack). */
function previewKey(channel: Channel): number {
  return channel.kind === 'drums' ? 36 : 60;
}

export function ChannelEditor() {
  const project = useProject();
  const channelId = useUiStore((s) => s.channelEditorId);
  const [tab, setTab] = useState<TabId>('sound');
  const [renaming, setRenaming] = useState(false);
  const cancelRename = useRef(false);

  const channel = channelId ? project.channels[channelId] : undefined;

  // Cambiar de canal cancela el renombrado a medias: el input llevaría el
  // nombre del canal anterior y lo aplicaría al nuevo.
  useEffect(() => {
    setRenaming(false);
  }, [channelId]);

  if (!channel) {
    return (
      <div className="panel-placeholder">
        Doble clic en un canal del Channel Rack para abrir aquí todo lo que se le puede hacer a
        ese sonido.
      </div>
    );
  }

  const channelIndex = project.channelOrder.indexOf(channel.id);
  const sample = channel.sampleId ? project.samples[channel.sampleId] : undefined;
  const anySolo = project.channelOrder.some((id) => project.channels[id]?.solo === true);
  const fxCount = (channel.fx ?? []).filter(Boolean).length;

  const commitName = (raw: string) => {
    setRenaming(false);
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const name = raw.trim();
    if (!name || name === channel.name) return;
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: { name } },
      { label: `Renombrar canal a "${name}"` },
    );
  };

  const preview = (on: boolean) => {
    if (on) ensureAudioReady();
    engine.previewNote(channelIndex, previewKey(channel), on);
  };

  const openPianoRoll = () => {
    useUiStore.setState({ pianoRollChannelId: channel.id });
    useUiStore.getState().openWindow('pianoRoll');
  };

  /** Nova y Prisma tienen su propio browser de presets; desde aquí se llega. */
  const presetWindow = channel.kind === 'nova' ? 'nova' : channel.kind === 'prisma' ? 'prisma' : null;

  return (
    <div className="chan" onPointerDown={() => reportActivity('Editor de sonido')}>
      <div className="chan-head">
        <label className="chan-color" title="Color del canal">
          <span className="chan-dot" style={{ background: channel.color }} />
          <input
            type="color"
            value={channel.color}
            onChange={(e) =>
              store.dispatch(
                { type: 'patchChannel', channelId: channel.id, patch: { color: e.target.value } },
                { label: 'Color de canal', mergeKey: `chan:${channel.id}:color` },
              )
            }
          />
        </label>

        {renaming ? (
          <input
            className="chan-name-input"
            defaultValue={channel.name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commitName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <button
            className="chan-name"
            title="Doble clic para renombrar"
            onDoubleClick={() => setRenaming(true)}
          >
            {channel.name}
          </button>
        )}

        <span className="chan-kind">{INSTRUMENT_LABELS[channel.kind]}</span>

        <div className="chan-head-tools">
          <button
            className="chan-btn"
            title="Escuchar el canal (mantén pulsado)"
            onPointerDown={(e) => {
              if (e.button === 0) preview(true);
            }}
            onPointerUp={() => preview(false)}
            onPointerLeave={() => preview(false)}
            onPointerCancel={() => preview(false)}
          >
            ▶ Escuchar
          </button>
          {presetWindow && (
            <button
              className="chan-btn"
              title={`Elegir preset en ${INSTRUMENT_LABELS[channel.kind]}`}
              onClick={() => {
                useUiStore.setState(
                  channel.kind === 'nova'
                    ? { novaChannelId: channel.id }
                    : { prismaChannelId: channel.id },
                );
                useUiStore.getState().openWindow(presetWindow);
              }}
            >
              Presets
            </button>
          )}
          <button className="chan-btn" title="Editar las notas de este canal" onClick={openPianoRoll}>
            Piano Roll
          </button>
        </div>
      </div>

      <div className="chan-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`chan-tabbtn${tab === t.id ? ' active' : ''}`}
            title={t.title}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'fx' && fxCount > 0 && <span className="chan-tab-count">{fxCount}</span>}
          </button>
        ))}
      </div>

      <div className="chan-body">
        {tab === 'sound' && <SoundTab channel={channel} sample={sample} />}
        {tab === 'fx' && <FxTab channel={channel} mixer={project.mixer} />}
        {tab === 'mix' && <MixTab channel={channel} mixer={project.mixer} anySolo={anySolo} />}
      </div>
    </div>
  );
}
