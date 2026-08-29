/**
 * Entrada de audio dentro de Ajustes: qué micro entra, por qué pista y con
 * cuánta ganancia, con su medidor.
 *
 * El medidor está aquí y no solo en el transporte porque ajustar la ganancia
 * de entrada es EL motivo de poder escuchar sin monitorizar: se ve el nivel
 * mientras se habla, sin sacarlo por los altavoces.
 */

import { useEffect } from 'react';
import {
  refreshInputDevices,
  setInputDevice,
  setInputGain,
  setInputTrack,
  toggleInputListening,
  toggleInputMonitor,
  useInputGuardReason,
  useInputMonitorStore,
} from '../state/input-monitor';
import { useProject } from '../state/useProject';

export function InputSection() {
  const project = useProject();
  const listening = useInputMonitorStore((s) => s.listening);
  const monitor = useInputMonitorStore((s) => s.monitor);
  const devices = useInputMonitorStore((s) => s.devices);
  const deviceId = useInputMonitorStore((s) => s.deviceId);
  const trackIndex = useInputMonitorStore((s) => s.trackIndex);
  const gain = useInputMonitorStore((s) => s.gain);
  const peak = useInputMonitorStore((s) => s.peak);
  const error = useInputMonitorStore((s) => s.error);

  // Cambiar de dispositivo o cerrar el micro cierra el stream, y eso a mitad
  // de una toma la corta en silencio (ver el comentario largo encima de
  // `inputGuardReason` en `input-monitor.ts`). La regla —CUÁNDO se bloquea y
  // CON QUÉ texto— vive solo ahí: `toggleInputListening`/`setInputDevice` ya
  // la aplican de verdad (rechazan aunque algo que no sea este componente los
  // llame), y acá solo se LEE con `useInputGuardReason()` para pintar el
  // mismo motivo, sin repetir la condición `phase !== 'idle'` ni el texto.
  //
  // Decisión: BLOQUEAR, no parar-y-avisar. Parar la toma como efecto
  // colateral de tocar un select sería su propia sorpresa (el usuario pierde
  // igual lo que llevaba cantado, solo que además sin quererlo), y no hay
  // nada en "cambiar de dispositivo" tan urgente que no pueda esperar a que
  // se termine de grabar. Mismo patrón que ya sigue `MidiSection.tsx` con el
  // botón de "Medir latencia" (deshabilitado + título con el motivo mientras
  // `useRecorderStore().phase !== 'idle'`).
  //
  // (El hot-unplug y el cambio de dispositivo del sistema son distintos: ahí
  // no se puede bloquear —el cable ya se fue— así que `input-monitor.ts` para
  // la toma sola y avisa por `useInputMonitorStore().error`, que ya se pinta
  // más abajo.)
  const guardReason = useInputGuardReason();
  const recording = guardReason !== null;

  useEffect(() => {
    void refreshInputDevices();
  }, []);

  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

  return (
    <>
      <h3 className="set-heading">Entrada</h3>

      <div className="set-row">
        <span className="set-label">Micro</span>
        <button
          className={`set-toggle${listening ? ' on' : ''}`}
          disabled={recording}
          title={
            guardReason ?? (listening ? 'Cerrar el micro' : 'Abrir el micro y medir su nivel')
          }
          onClick={() => void toggleInputListening()}
        >
          <span className="set-toggle-knob" />
        </button>
        <span className="set-value">
          {listening ? 'Abierto y midiendo' : 'Cerrado'}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Nivel</span>
        <span className="in-meter">
          <span
            className={`in-meter-fill${peak >= 0.99 ? ' hot' : ''}`}
            style={{ transform: `scaleX(${Math.min(1, peak)})` }}
          />
        </span>
        <span className="set-value">
          {!listening ? '—' : db === -Infinity ? 'Silencio' : `${db.toFixed(1)} dB`}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Dispositivo</span>
        <select
          className="set-select"
          value={deviceId}
          disabled={recording}
          title={guardReason ?? undefined}
          onChange={(e) => void setInputDevice(e.target.value)}
        >
          <option value="">El del sistema</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <span className="set-value">
          {devices.length === 0
            ? 'Abre el micro para ver la lista con nombres'
            : `${devices.length} entrada(s)`}
        </span>
      </div>

      <div className="set-row">
        <span className="set-label">Pista</span>
        <select
          className="set-select"
          value={trackIndex}
          onChange={(e) => setInputTrack(Number(e.target.value))}
        >
          {project.mixer.map((t, i) => (
            <option key={i} value={i}>
              {i === 0 ? 'Master' : `${i} · ${t.name}`}
            </option>
          ))}
        </select>
        <span className="set-value">Se oye con los efectos y el EQ de esa pista</span>
      </div>

      <div className="set-row">
        <span className="set-label">Ganancia</span>
        <input
          type="range"
          min={0}
          max={4}
          step={0.05}
          value={gain}
          onChange={(e) => setInputGain(Number(e.target.value))}
        />
        <span className="set-value">
          {gain === 0 ? 'Cerrada' : `${(20 * Math.log10(gain)).toFixed(1)} dB`}
        </span>
        <button className="set-reset" disabled={gain === 1} title="Ganancia unidad" onClick={() => setInputGain(1)}>
          0 dB
        </button>
      </div>

      <div className="set-row">
        <span className="set-label">Monitor</span>
        <button
          className={`set-toggle${monitor ? ' on' : ''}`}
          title="Sacar la entrada por su pista"
          onClick={() => void toggleInputMonitor()}
        >
          <span className="set-toggle-knob" />
        </button>
        <span className="set-value">{monitor ? 'Sonando' : 'Apagado'}</span>
      </div>

      {recording && <p className="set-error">{guardReason}</p>}
      {monitor && (
        <p className="set-error">
          Con altavoces esto es un acople: el micro coge lo que sale y vuelve a entrar. Cascos.
        </p>
      )}
      {error && <p className="set-error">{error}</p>}
      <p className="set-note">
        La entrada se suma a su pista ANTES de los inserts, así que se oye con la cadena puesta —
        cantar con el reverb y el compresor que va a llevar la toma, no la voz seca. El navegador
        no le mete nada por su cuenta (ni cancelador de eco ni ganancia automática): la cadena la
        pone Orbit.
      </p>
    </>
  );
}
