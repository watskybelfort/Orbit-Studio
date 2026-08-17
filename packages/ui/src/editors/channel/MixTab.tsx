/**
 * Pestaña "Mezcla y ruteo": lo que hace el canal DESPUÉS de sus inserts.
 *
 * Volumen y pan van con su `paramRef` de mezcla, así que se automatizan desde
 * aquí igual que desde el rack. El selector de pista de mixer es una lista de
 * verdad y no un número que hay que teclear: en el rack cabía un cuadradito,
 * aquí no hay excusa para no decir a dónde va el sonido.
 */

import { type Channel, type MixerTrack } from '@orbit/core';
import { store } from '../../state/app';
import { useUiStore } from '../../state/ui';
import { Knob } from '../../widgets/Knob';
import { formatGain, formatPan, mixerTrackLabel } from './format';

export interface MixTabProps {
  channel: Channel;
  mixer: MixerTrack[];
  /** Hay algún canal en solo: el resto está callado aunque no esté muteado. */
  anySolo: boolean;
}

export function MixTab({ channel, mixer, anySolo }: MixTabProps) {
  const names = mixer.map((t) => t.name);
  const track = mixer[channel.mixerTrack];
  const audible = !channel.mute && (!anySolo || channel.solo);

  const patch = (p: Partial<Channel>, label: string, mergeKey?: string) =>
    store.dispatch(
      { type: 'patchChannel', channelId: channel.id, patch: p },
      mergeKey ? { label, mergeKey } : { label },
    );

  return (
    <div className="chan-tab">
      <section className="chan-group">
        <h4 className="chan-group-title">Nivel</h4>
        <div className="chan-knobs">
          <Knob
            value={channel.volume}
            min={0}
            max={2}
            defaultValue={0.78}
            size={44}
            label="Volumen"
            format={formatGain}
            onChange={(volume) =>
              patch({ volume }, `Volumen de ${channel.name}`, `chan:${channel.id}:vol`)
            }
            paramRef={{ kind: 'channelMix', channelId: channel.id, param: 'volume' }}
          />
          <Knob
            value={channel.pan}
            min={-1}
            max={1}
            defaultValue={0}
            size={44}
            label="Pan"
            format={formatPan}
            onChange={(pan) => patch({ pan }, `Pan de ${channel.name}`, `chan:${channel.id}:pan`)}
            paramRef={{ kind: 'channelMix', channelId: channel.id, param: 'pan' }}
          />
        </div>
        <div className="chan-toggles">
          <button
            className={`chan-toggle${channel.mute ? ' on' : ''}`}
            title="Silenciar este canal"
            onClick={() =>
              patch(
                { mute: !channel.mute },
                channel.mute ? `Activar ${channel.name}` : `Silenciar ${channel.name}`,
              )
            }
          >
            Mute
          </button>
          <button
            className={`chan-toggle${channel.solo ? ' on' : ''}`}
            title="Escuchar solo este canal"
            onClick={() =>
              patch(
                { solo: !channel.solo },
                channel.solo ? `Quitar solo de ${channel.name}` : `Solo de ${channel.name}`,
              )
            }
          >
            Solo
          </button>
          <span className={`chan-audible${audible ? ' on' : ''}`}>
            {audible ? 'Suena' : 'Callado ahora mismo'}
          </span>
        </div>
      </section>

      <section className="chan-group">
        <h4 className="chan-group-title">Ruteo</h4>
        <label className="chan-field">
          <span>Pista de mixer</span>
          <select
            className="chan-select wide"
            value={channel.mixerTrack}
            onChange={(e) => {
              const mixerTrack = Number(e.target.value);
              patch(
                { mixerTrack },
                `${channel.name} → ${mixerTrackLabel(mixerTrack, names)}`,
              );
            }}
          >
            {mixer.map((t, i) => (
              <option key={t.id} value={i}>
                {mixerTrackLabel(i, names)}
              </option>
            ))}
          </select>
        </label>
        <p className="chan-note">
          Sale por <b>{mixerTrackLabel(channel.mixerTrack, names)}</b>
          {track && track.slots.filter(Boolean).length > 0
            ? ` · ${track.slots.filter(Boolean).length} efecto(s) en esa pista`
            : ' · esa pista está limpia'}
          .
        </p>
        <button
          className="chan-btn"
          title="Abrir el mixer para ver la pista entera"
          onClick={() => {
            useUiStore.setState({ selectedMixerTrack: channel.mixerTrack });
            useUiStore.getState().openWindow('mixer');
          }}
        >
          Abrir en el Mixer
        </button>
      </section>
    </div>
  );
}
