/**
 * Pestaña "Sonido": las perillas del instrumento del canal.
 *
 * Se generan desde `INSTRUMENT_PARAMS[channel.kind]`, así que un instrumento
 * nuevo aparece aquí solo con declarar sus parámetros — sin casos especiales
 * por kind. La única excepción es el sampler: su bloque de recorte
 * (start/end/fades/reverse/fase/loop/gain) se saca aparte y encima va la forma
 * de onda, porque "acortarlo" o "invertirlo" es justo lo que se viene a hacer
 * aquí y buscarlo entre veinte perillas sería absurdo.
 *
 * Cada perilla lleva su `paramRef`, así que el clic derecho da automatización
 * y LFO igual que en el mixer.
 */

import { INSTRUMENT_PARAMS, type Channel, type SampleRef } from '@orbit/core';
import { store } from '../../state/app';
import { usePluginsStore } from '../../state/plugins';
import { ParamControl } from './ParamControl';
import { SampleWave } from './SampleWave';

/**
 * Parámetros del sampler que forman el bloque de recorte y forma. El orden es
 * el de la cabeza: primero dónde entra y dónde corta, luego cómo entra y sale.
 */
const TRIM_KEYS = ['start', 'end', 'fadeIn', 'fadeOut', 'gain', 'reverse', 'polarity', 'loop'];

export interface SoundTabProps {
  channel: Channel;
  sample: SampleRef | undefined;
}

export function SoundTab({ channel, sample }: SoundTabProps) {
  const plugins = usePluginsStore((s) => s.plugins);
  const plugin = channel.instrumentPluginId
    ? plugins.find((p) => p.id === channel.instrumentPluginId)
    : undefined;

  const specs = INSTRUMENT_PARAMS[channel.kind];
  const isSampler = channel.kind === 'sampler';
  const trim = isSampler ? specs.filter((s) => TRIM_KEYS.includes(s.key)) : [];
  const rest = isSampler ? specs.filter((s) => !TRIM_KEYS.includes(s.key)) : specs;

  const start = channel.params['start'] ?? 0;
  const end = channel.params['end'] ?? 1;

  /** El mergeKey funde la ráfaga de una perilla arrastrada en UN solo undo. */
  const setParam = (key: string, value: number, label = key) =>
    store.dispatch(
      { type: 'setChannelParam', channelId: channel.id, key, value },
      { label: `${channel.name}: ${label}`, mergeKey: `chan:${channel.id}:${key}` },
    );

  return (
    <div className="chan-tab">
      {channel.instrumentPluginId !== undefined && (
        <section className="chan-group">
          <h4 className="chan-group-title">
            Plugin JS · {plugin?.name ?? channel.instrumentPluginId}
          </h4>
          {plugin ? (
            <div className="chan-knobs">
              {plugin.params.map((spec) => (
                <ParamControl
                  key={spec.key}
                  spec={spec}
                  value={channel.params[spec.key] ?? spec.default}
                  onChange={(v) => setParam(spec.key, v, spec.label)}
                  // Los rangos de un plugin viven en su archivo, no en el
                  // registro de params: sin spec, automatización y LFO no
                  // sabrían desnormalizar y darían valores absurdos.
                  paramRef={undefined}
                />
              ))}
            </div>
          ) : (
            <p className="chan-warn">
              El plugin no está cargado: el canal suena con su motor interno y estas perillas
              son las de abajo.
            </p>
          )}
        </section>
      )}

      {isSampler && (
        <section className="chan-group">
          <h4 className="chan-group-title">
            Recorte y forma
            <span className="chan-group-sub">{sample ? sample.name : 'Sin sample cargado'}</span>
          </h4>
          {sample ? (
            <SampleWave
              sample={sample}
              start={start}
              end={end}
              color={channel.color}
              onTrim={(patch) => {
                if (patch.start !== undefined) setParam('start', patch.start, 'Start');
                if (patch.end !== undefined) setParam('end', patch.end, 'End');
              }}
            />
          ) : (
            <p className="chan-warn">
              Este canal no tiene sample. Arrastra un sonido del Browser al Channel Rack para
              cargarlo.
            </p>
          )}
          <div className="chan-knobs">
            {trim.map((spec) => (
              <ParamControl
                key={spec.key}
                spec={spec}
                value={channel.params[spec.key] ?? spec.default}
                onChange={(v) => setParam(spec.key, v, spec.label)}
                paramRef={{ kind: 'channel', channelId: channel.id, param: spec.key }}
              />
            ))}
          </div>
        </section>
      )}

      <section className="chan-group">
        <h4 className="chan-group-title">{isSampler ? 'Reproducción' : 'Instrumento'}</h4>
        {rest.length === 0 ? (
          <p className="chan-warn">Este instrumento no expone perillas propias.</p>
        ) : (
          <div className="chan-knobs">
            {rest.map((spec) => (
              <ParamControl
                key={spec.key}
                spec={spec}
                value={channel.params[spec.key] ?? spec.default}
                onChange={(v) => setParam(spec.key, v, spec.label)}
                paramRef={{ kind: 'channel', channelId: channel.id, param: spec.key }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
