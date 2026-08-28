/**
 * Entrada dentro de Ajustes: qué controladores MIDI escuchan, cómo se
 * interpreta lo que mandan, qué mando está atado a qué parámetro, y —desde el
 * enrutado de entradas— qué canal FÍSICO de la interfaz entra en qué pista.
 *
 * El LED de actividad es la mitad de lo que sirve este panel: cuando un
 * teclado "no funciona" lo primero que hay que saber es si sus mensajes están
 * llegando, y eso no se ve en ningún otro sitio. El medidor por entrada, más
 * abajo, es lo mismo para el audio: con dos micros abiertos es lo único que
 * dice cuál de los dos está saturando.
 */

import { useEffect, useState } from 'react';
import {
  MAX_INPUT_ROUTES,
  describeParamRef,
  projectInputRoutes,
  resolveInputRoutes,
} from '@orbit/core';
import {
  MIDI_QUANTIZE,
  setMidiBendRange,
  setMidiChannel,
  setMidiDeviceEnabled,
  setMidiOctave,
  setMidiQuantize,
  setMidiVelocityCurve,
  useLiveInputStore,
} from '../state/live-input';

import {
  midiSourceLabel,
  removeMidiMapping,
  useMidiLearnStore,
} from '../state/midi-learn';
import { BEND_RANGES, VELOCITY_CURVES } from '../state/midi-message';
import { useProject } from '../state/useProject';
import {
  addInputRoute,
  patchInputRoute,
  removeInputRoute,
  setInputRouteChannels,
  useInputMonitorStore,
} from '../state/input-monitor';
import { useRecorderStore } from '../state/recorder';
import {
  latencyMs,
  refreshStaleness,
  runLatencyCalibration,
  setLatencySamplesManually,
  useLatencyCalibrationStore,
} from '../state/latency-calibration';
import { NumberScrubber } from '../widgets/NumberScrubber';

/** Cuánto se queda encendido el LED tras el último mensaje. */
const ACTIVITY_MS = 250;

export function MidiSection() {
  const project = useProject();
  const devices = useLiveInputStore((s) => s.devices);
  const channel = useLiveInputStore((s) => s.channel);
  const octave = useLiveInputStore((s) => s.octave);
  const curve = useLiveInputStore((s) => s.velocityCurve);
  const quantize = useLiveInputStore((s) => s.quantize);
  const bendRange = useLiveInputStore((s) => s.bendRange);
  const bend = useLiveInputStore((s) => s.bendSemitones);

  const heldKeys = useLiveInputStore((s) => s.heldKeys);
  const sustainedKeys = useLiveInputStore((s) => s.sustainedKeys);
  const lastMessageAt = useLiveInputStore((s) => s.lastMessageAt);
  const mappings = useMidiLearnStore((s) => s.mappings);
  const learning = useMidiLearnStore((s) => s.learning);

  const inputDeviceId = useInputMonitorStore((s) => s.deviceId);
  const inputDevices = useInputMonitorStore((s) => s.devices);
  const channelCount = useInputMonitorStore((s) => s.channelCount);
  const routePeaks = useInputMonitorStore((s) => s.routePeaks);
  const inputPeak = useInputMonitorStore((s) => s.peak);
  const inputTrack = useInputMonitorStore((s) => s.trackIndex);
  const inputGain = useInputMonitorStore((s) => s.gain);
  const inputMonitor = useInputMonitorStore((s) => s.monitor);
  const recPhase = useRecorderStore((s) => s.phase);
  const latSamples = useLatencyCalibrationStore((s) => s.delaySamples);
  const latSource = useLatencyCalibrationStore((s) => s.source);
  const latStatus = useLatencyCalibrationStore((s) => s.status);
  const latConfidence = useLatencyCalibrationStore((s) => s.confidence);
  const latError = useLatencyCalibrationStore((s) => s.error);
  const latStale = useLatencyCalibrationStore((s) => s.stale);

  // El LED se apaga solo: sin este tic nadie repinta cuando dejan de llegar
  // mensajes y se quedaría encendido para siempre tras la última nota.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 150);
    return () => clearInterval(id);
  }, []);
  const active = lastMessageAt > 0 && performance.now() - lastMessageAt < ACTIVITY_MS;

  // Cambiar de dispositivo de entrada es EL motivo típico de que el número
  // calibrado deje de valer: recalcular el aviso en cuanto pasa (y también al
  // abrir Ajustes, que es cuando de verdad importa que se vea).
  useEffect(() => {
    refreshStaleness();
  }, [inputDeviceId]);

  const mappingList = Object.values(mappings).sort((a, b) => a.source.localeCompare(b.source));

  // Las rutas del proyecto y su resolución contra el aparato abierto. Se
  // resuelve aquí con el MISMO helper que usan el motor y el grabador: si la
  // UI resolviera por su cuenta, el índice de una entrada podría no significar
  // lo mismo en los tres sitios, y ese índice es lo que enlaza una toma con su
  // pista.
  const declaredRoutes = projectInputRoutes(project);
  const resolvedRoutes = resolveInputRoutes(project, {
    ...(channelCount > 0 ? { channelCount } : null),
    fallback: { mixerTrack: inputTrack, gain: inputGain, monitor: inputMonitor },
  });
  // Cuántos canales ofrecer en los selectores: los del aparato abierto, los
  // que declare la lista de dispositivos, o al menos los que ya usa el
  // proyecto (para poder ver —y arreglar— una ruta que apunta a un canal que
  // esta máquina no tiene).
  const declaredChannels = inputDevices.find((d) => d.id === inputDeviceId)?.channels ?? 0;
  const usedChannels = resolvedRoutes.reduce(
    (max, r) => Math.max(max, r.srcL + 1, r.srcR + 1),
    2,
  );
  const channelOptions = Math.max(2, channelCount, declaredChannels, usedChannels);

  return (
    <>
      <h3 className="set-heading">MIDI</h3>

      <div className="set-row">
        <span className="set-label">Actividad</span>
        <span className={`midi-led${active ? ' on' : ''}`} />
        <span className="set-value">
          {devices.length === 0
            ? 'Ningún controlador conectado'
            : `${heldKeys} nota(s) sonando${sustainedKeys > 0 ? ` · ${sustainedKeys} con pedal` : ''}`}
        </span>
      </div>

      {devices.length === 0 ? (
        <p className="set-note">
          Enchufa un teclado o una superficie de mandos y aparecerá aquí sola. Mientras tanto se
          puede tocar con el teclado del PC: fila Z (octava central) y fila Q (la de arriba).
        </p>
      ) : (
        <div className="midi-devices">
          {devices.map((d) => (
            <label key={d.id} className="midi-device">
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => setMidiDeviceEnabled(d.id, e.target.checked)}
              />
              <span className="midi-device-name">{d.name}</span>
            </label>
          ))}
        </div>
      )}

      <div className="set-row">
        <span className="set-label">Canal</span>
        <select
          className="set-select"
          value={channel}
          onChange={(e) => setMidiChannel(Number(e.target.value))}
        >
          <option value={0}>Todos</option>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
        <span className="set-value">
          {channel === 0 ? 'Escucha los 16 canales' : `Solo el canal ${channel}`}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Octava</span>
        <input
          type="range"
          min={-4}
          max={4}
          step={1}
          value={octave}
          onChange={(e) => setMidiOctave(Number(e.target.value))}
        />
        <span className="set-value">
          {octave === 0 ? 'Sin transponer' : `${octave > 0 ? '+' : ''}${octave} octava(s)`}
        </span>
        <button
          className="set-reset"
          disabled={octave === 0}
          title="Volver a la afinación del teclado"
          onClick={() => setMidiOctave(0)}
        >
          0
        </button>
      </div>

      <div className="set-row">
        <span className="set-label">Rueda de tono</span>
        <select
          className="set-select"
          value={bendRange}
          onChange={(e) => setMidiBendRange(Number(e.target.value))}
          title="Cuánto dobla la rueda arriba del todo"
        >
          {BEND_RANGES.map((r) => (
            <option key={r} value={r}>
              &plusmn;{r} {r === 1 ? 'semitono' : 'semitonos'}
            </option>
          ))}
        </select>
        <span className="set-value">
          {/* El valor vivo es la mitad de lo que sirve esto: con la rueda del
              teclado en la mano, es lo único que dice si sus mensajes llegan
              y si el rango es el que se esperaba. */}
          {bend === 0
            ? bendRange === 12
              ? 'Una octava entera'
              : 'Centrada'
            : `Doblando ${bend > 0 ? '+' : ''}${bend.toFixed(2)} st`}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Pulsación</span>
        <select
          className="set-select"
          value={curve}
          onChange={(e) => {
            const id = e.target.value;
            const found = VELOCITY_CURVES.find((c) => c.id === id);
            if (found) setMidiVelocityCurve(found.id);
          }}
        >
          {VELOCITY_CURVES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="set-value">
          {curve === 'soft'
            ? 'Sube las notas flojas (teclados de acción ligera)'
            : curve === 'hard'
              ? 'Baja las notas flojas (hay que pegarle)'
              : curve === 'fixed'
                ? 'Todas las notas con la misma fuerza'
                : 'Tal cual lo manda el teclado'}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Grabar a</span>
        <select
          className="set-select"
          value={quantize}
          onChange={(e) => setMidiQuantize(e.target.value)}
        >
          {MIDI_QUANTIZE.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
        <span className="set-value">
          {quantize === 'off'
            ? 'Los inicios se quedan donde caigan'
            : `Los inicios se cuadran a ${quantize}`}
        </span>
      </div>
      <p className="set-note">
        Grabando sobre un patrón en loop, lo tocado cae al patrón al cerrar cada vuelta: no hay que
        parar para verlo. Las teclas que sigas pulsando se parten en el cierre y siguen en la
        vuelta siguiente.
      </p>

      <h3 className="set-heading">Entradas de audio</h3>
      <p className="set-note">
        Con una interfaz de varias entradas, aquí se dice cuál entra por dónde: el micro de la voz
        a su pista, la guitarra a la suya, y las dos grabando a la vez desde un solo aparato. Sin
        declarar nada, Orbit usa el par 1-2 de siempre.
      </p>

      <div className="set-row">
        <span className="set-label">Aparato</span>
        <span className="set-value">
          {channelCount > 0
            ? `${channelCount} ${channelCount === 1 ? 'entrada' : 'entradas'} abiertas`
            : declaredChannels > 0
              ? `Declara ${declaredChannels} entrada(s) · abre el micro para usarlas`
              : 'Cerrado: abre el micro para saber cuántas entradas trae'}
        </span>
      </div>

      <div className="input-routes">
        {resolvedRoutes.map((route, index) => {
          const declared = route.routeId ? project.inputRoutes[route.routeId] : undefined;
          const mono = route.srcR < 0 || route.srcR === route.srcL;
          const peak = route.routeId ? (routePeaks[index] ?? 0) : inputPeak;
          return (
            <div
              key={route.routeId ?? 'default'}
              className={`input-route${route.available ? '' : ' missing'}`}
            >
              <input
                className="input-route-name"
                value={route.name}
                disabled={!declared}
                title={declared ? 'Nombre de la entrada' : 'La entrada por defecto no tiene nombre propio'}
                onChange={(e) =>
                  declared && patchInputRoute(declared.id, { name: e.target.value })
                }
              />
              <select
                className="set-select"
                value={route.srcL}
                disabled={!declared}
                title="Canal físico de la interfaz"
                onChange={(e) =>
                  declared &&
                  setInputRouteChannels(
                    declared.id,
                    Number(e.target.value),
                    mono ? null : route.srcR,
                  )
                }
              >
                {Array.from({ length: channelOptions }, (_, i) => (
                  <option key={i} value={i}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <select
                className="set-select"
                value={mono ? -1 : route.srcR}
                disabled={!declared}
                title="Canal derecho; en mono el izquierdo llega a los dos lados"
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (declared) setInputRouteChannels(declared.id, route.srcL, value < 0 ? null : value);
                }}
              >
                <option value={-1}>Mono</option>
                {Array.from({ length: channelOptions }, (_, i) => (
                  <option key={i} value={i}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <label className="input-route-track" title="Pista de mixer por la que entra">
                Pista
                <input
                  type="number"
                  min={0}
                  max={project.mixer.length - 1}
                  value={route.mixerTrack}
                  disabled={!declared}
                  onChange={(e) =>
                    declared &&
                    patchInputRoute(declared.id, { mixerTrack: Number(e.target.value) })
                  }
                />
              </label>
              <label className="input-route-flag" title="Graba cuando se pulse Rec">
                <input
                  type="checkbox"
                  checked={route.armed}
                  disabled={!declared}
                  onChange={(e) => declared && patchInputRoute(declared.id, { armed: e.target.checked })}
                />
                Armar
              </label>
              <label className="input-route-flag" title="Se oye por su pista, con su cadena puesta">
                <input
                  type="checkbox"
                  checked={route.monitor}
                  disabled={!declared}
                  onChange={(e) =>
                    declared && patchInputRoute(declared.id, { monitor: e.target.checked })
                  }
                />
                Oír
              </label>
              <span className="input-route-meter" title="Pico de esta entrada, antes de su ganancia">
                <span style={{ width: `${Math.min(100, peak * 100)}%` }} />
              </span>
              {declared && (
                <button
                  className="custom-del"
                  title="Quitar esta entrada"
                  onClick={() => removeInputRoute(declared.id)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="set-row">
        <button
          className="tbtn"
          disabled={declaredRoutes.length >= MAX_INPUT_ROUTES}
          title={
            declaredRoutes.length === 0
              ? 'Hace explícita la entrada de siempre y añade una más'
              : 'Añade otra entrada'
          }
          onClick={addInputRoute}
        >
          Añadir entrada
        </button>
        <span className="set-value">
          {declaredRoutes.length === 0
            ? 'Sin declarar: el par 1-2 a la pista de siempre'
            : `${declaredRoutes.length} de ${MAX_INPUT_ROUTES}`}
        </span>
      </div>

      {resolvedRoutes.some((r) => !r.available) && (
        <p className="set-error">
          Hay entradas apuntando a canales que este aparato no tiene: no suenan ni graban. Se
          quedan donde están —enchufar la interfaz las devuelve a la vida— pero mientras tanto no
          cuentan como armadas.
        </p>
      )}

      <h3 className="set-heading">Mandos aprendidos</h3>

      {learning !== null && (
        <p className="set-note learning">
          Esperando a que muevas un mando para atarlo a{' '}
          <strong>{describeParamRef(learning, project)}</strong>.
        </p>
      )}
      {mappingList.length === 0 ? (
        <p className="set-note">
          Ninguno todavía. Clic derecho en cualquier perilla o fader → <em>Aprender MIDI</em>, y
          mueve el mando del controlador. El mapa se guarda por mando (CC 74, no "el CC 74 de ese
          teclado"), así que cambiar de puerto USB no lo rompe.
        </p>
      ) : (
        <div className="midi-maps">
          {mappingList.map((m) => (
            <div key={m.source} className="midi-map">
              <span className="midi-map-source">{midiSourceLabel(m.source)}</span>
              <span className="midi-map-target">{describeParamRef(m.ref, project)}</span>
              <button
                className="custom-del"
                title="Soltar este mando"
                onClick={() => removeMidiMapping(m.source)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <h3 className="set-heading">Latencia de grabación</h3>
      <p className="set-note">
        Entre el micro y el motor hay un buffer del sistema que nadie compensa solo: cada toma cae
        unos milisegundos tarde respecto de lo que cantaste. Este bucle lo mide sacando un barrido
        por los altavoces y escuchándolo volver por el micro —hace falta que la salida LLEGUE a la
        entrada: un cable de salida a entrada, o altavoces con el micro delante. Con cascos puestos
        no hay bucle que medir, y eso se detecta y se avisa en vez de guardar un cero.
      </p>

      <div className="set-row">
        <span className="set-label">Bucle</span>
        <button
          className="tbtn"
          disabled={latStatus === 'measuring' || recPhase !== 'idle'}
          title={
            recPhase !== 'idle'
              ? 'Para la toma en curso antes de calibrar'
              : 'Saca un barrido por los altavoces y lo escucha volver por el micro'
          }
          onClick={() => void runLatencyCalibration()}
        >
          {latStatus === 'measuring' ? 'Midiendo…' : 'Medir latencia'}
        </button>
        <span className="set-value">
          {latStatus === 'measuring'
            ? 'Sonando el barrido y escuchando el micro…'
            : recPhase !== 'idle'
              ? 'Hay una toma en curso'
              : latConfidence !== null
                ? `Última medida: confianza ${(latConfidence * 100).toFixed(0)}%`
                : latSource === 'manual'
                  ? 'Puesto a mano, sin medir'
                  : 'Sin calibrar todavía'}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Retardo</span>
        <NumberScrubber
          value={latSamples}
          min={0}
          max={48000}
          step={1}
          suffix=" smp"
          onChange={setLatencySamplesManually}
        />
        <span className="set-value">
          {latSamples === 0
            ? 'Sin compensar: el clip cae donde se grabó, tal cual'
            : `≈ ${latencyMs().toFixed(1)} ms · cada toma nueva nace corrida esto hacia atrás`}
        </span>
        <button
          className="set-reset"
          disabled={latSamples === 0}
          title="Quitar la compensación"
          onClick={() => setLatencySamplesManually(0)}
        >
          0
        </button>
      </div>
      <p className="set-note">
        El número es editable a mano: quien conoce su interfaz sabe su cifra. Medirlo de nuevo
        sobrescribe lo que haya, a mano o medido.
      </p>

      {latStale && (
        <p className="set-error">
          El aparato de entrada cambió desde la última calibración: este número podría ya no
          valer. Vuelve a medir.
        </p>
      )}
      {latError && <p className="set-error">{latError}</p>}
    </>
  );
}
