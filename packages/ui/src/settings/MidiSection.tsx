/**
 * MIDI dentro de Ajustes: qué controladores escuchan, cómo se interpreta lo
 * que mandan y qué mando está atado a qué parámetro.
 *
 * El LED de actividad es la mitad de lo que sirve este panel: cuando un
 * teclado "no funciona" lo primero que hay que saber es si sus mensajes están
 * llegando, y eso no se ve en ningún otro sitio.
 */

import { useEffect, useState } from 'react';
import { describeParamRef } from '@orbit/core';
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

  // El LED se apaga solo: sin este tic nadie repinta cuando dejan de llegar
  // mensajes y se quedaría encendido para siempre tras la última nota.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 150);
    return () => clearInterval(id);
  }, []);
  const active = lastMessageAt > 0 && performance.now() - lastMessageAt < ACTIVITY_MS;

  const mappingList = Object.values(mappings).sort((a, b) => a.source.localeCompare(b.source));

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
    </>
  );
}
