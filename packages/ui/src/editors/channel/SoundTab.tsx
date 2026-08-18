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

import { useState } from 'react';
import {
  INSTRUMENT_PARAMS,
  MAX_SLICE_POINTS,
  evenSlicePoints,
  midiToNote,
  normalizeSlicePoints,
  sliceCount,
  type Channel,
  type SampleRef,
} from '@orbit/core';
import { detectTransients } from '@orbit/engine';
import { readSampleBytes } from '../../browser/sound-actions';
import { store } from '../../state/app';
import { usePluginsStore } from '../../state/plugins';
import { ParamControl } from './ParamControl';
import { SampleWave } from './SampleWave';

/**
 * Parámetros del sampler que forman el bloque de recorte y forma. El orden es
 * el de la cabeza: primero dónde entra y dónde corta, luego cómo entra y sale.
 */
const TRIM_KEYS = ['start', 'end', 'fadeIn', 'fadeOut', 'gain', 'reverse', 'polarity', 'loop'];

/**
 * Cuánto se afina el detector de golpes. Un loop de boom bap con el ajuste
 * fino saca 58 trozos —cada mota de un hi-hat— y eso no se toca con el
 * teclado; con el grueso salen los golpes de verdad. La sensibilidad y la
 * separación mínima se mueven juntas porque tiran del mismo lado.
 */
type GrainId = 'pocos' | 'normal' | 'muchos';

const GRAINS: { id: GrainId; label: string; sensitivity: number; minSpacingSec: number }[] = [
  { id: 'pocos', label: 'Golpes grandes', sensitivity: 0.3, minSpacingSec: 0.09 },
  { id: 'normal', label: 'Normal', sensitivity: 0.45, minSpacingSec: 0.05 },
  { id: 'muchos', label: 'Todo detalle', sensitivity: 0.7, minSpacingSec: 0.02 },
];

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
  const isSlicer = channel.kind === 'slicer';
  /** Cortes actuales: los propios del canal o el reparto en partes iguales. */
  const points =
    channel.slicePoints && channel.slicePoints.length > 1
      ? channel.slicePoints
      : evenSlicePoints(channel.params['slices'] ?? 8);
  const hasOwnCuts = (channel.slicePoints?.length ?? 0) > 1;
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [grain, setGrain] = useState<GrainId>('normal');

  /** Guarda los cortes del canal (lista vacía = vuelve a partes iguales). */
  const setSlicePoints = (next: readonly number[] | undefined, label: string) =>
    store.dispatch(
      {
        type: 'patchChannel',
        channelId: channel.id,
        // Se guarda SIEMPRE un array (nunca undefined): un patch con undefined
        // se pierde al serializarlo y por la sala no llegaría a limpiar nada.
        patch: { slicePoints: normalizeSlicePoints(next) ?? [] },
      },
      { label: `${channel.name}: ${label}`, mergeKey: `slices:${channel.id}` },
    );

  /**
   * Busca los golpes del sample y deja un corte en cada uno. Se decodifica
   * aquí (el kernel guarda el PCM, pero el detector vive en el motor offline y
   * quiere el archivo entero) y el resultado se normaliza a 0..1.
   */
  const cutByTransients = async () => {
    if (!sample || detecting) return;
    setDetecting(true);
    setDetectError(null);
    try {
      const bytes = await readSampleBytes(sample.path);
      if (!bytes) throw new Error('no se pudo leer el archivo');
      const ctx = new OfflineAudioContext(2, 1, 48000);
      const decoded = await ctx.decodeAudioData(bytes);
      const left = decoded.getChannelData(0);
      const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
      const preset = GRAINS.find((g) => g.id === grain) ?? GRAINS[1]!;
      const found = detectTransients(left, right, decoded.sampleRate, {
        sensitivity: preset.sensitivity,
        minSpacingSec: preset.minSpacingSec,
        maxCount: MAX_SLICE_POINTS,
      });
      const cuts = found.times.map((t) => t / Math.max(0.001, decoded.duration));
      const clean = normalizeSlicePoints(cuts);
      if (!clean) throw new Error('no se encontró ningún golpe claro');
      setSlicePoints(clean, `${clean.length} trozos por transientes`);
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  };
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

      {isSlicer && (
        <section className="chan-group">
          <h4 className="chan-group-title">
            Trozos
            <span className="chan-group-sub">
              {sample ? sample.name : 'Sin sample cargado'}
            </span>
          </h4>
          {sample ? (
            <>
              <SampleWave
                sample={sample}
                start={0}
                end={1}
                color={channel.color}
                onTrim={() => {
                  // El Slicer no recorta: aquí las marcas son los cortes.
                }}
                slicePoints={points}
                onSlicePoints={(next) => setSlicePoints(next, 'mover corte')}
              />
              <div className="chan-slice-tools">
                <button
                  className="chan-slice-btn primary"
                  onClick={() => void cutByTransients()}
                  disabled={detecting}
                  title="Pone un corte en cada golpe del sample"
                >
                  {detecting ? 'Buscando golpes…' : 'Cortar por transientes'}
                </button>
                <select
                  className="chan-slice-btn"
                  value={grain}
                  onChange={(e) => setGrain(e.target.value as GrainId)}
                  title="Cuánto detalle busca el detector"
                >
                  {GRAINS.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
                <button
                  className="chan-slice-btn"
                  onClick={() =>
                    setSlicePoints(
                      evenSlicePoints(channel.params['slices'] ?? 8),
                      'trozos iguales',
                    )
                  }
                  title="Vuelve al reparto en partes iguales del parámetro Trozos"
                >
                  En {sliceCount(undefined, channel.params['slices'] ?? 8)} iguales
                </button>
                {hasOwnCuts && (
                  <button
                    className="chan-slice-btn"
                    onClick={() => setSlicePoints(undefined, 'quitar cortes propios')}
                    title="Quita los cortes guardados: manda otra vez el parámetro Trozos"
                  >
                    Quitar cortes
                  </button>
                )}
                <span className="chan-group-sub">
                  {points.length} trozos · {midiToNote(36)}–{midiToNote(36 + points.length - 1)}
                  {hasOwnCuts ? ' · cortes propios' : ' · partes iguales'}
                </span>
              </div>
              {detectError && (
                <p className="chan-warn">No se pudo trocear: {detectError}.</p>
              )}
            </>
          ) : (
            <p className="chan-warn">
              Este canal no tiene sample. Arrastra un loop del Browser al Channel Rack para
              trocearlo.
            </p>
          )}
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
