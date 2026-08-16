/** Barra de transporte: play/stop, PAT/SONG, BPM, swing, metrónomo, posición. */

import { useCallback, useRef } from 'react';
import { engine, pausePlayback, setPlayMode, stopPlayback, store, togglePlay } from '../state/app';
import { toggleMidiArmed, useLiveInputStore } from '../state/live-input';
import { toggleRecording, useRecorderStore } from '../state/recorder';
import { IconMetronome, IconPause, IconPianoRoll, IconPlay, IconStop } from '../icons';
import { useProject } from '../state/useProject';
import { useUiStore } from '../state/ui';
import { Knob } from '../widgets/Knob';
import { NumberScrubber } from '../widgets/NumberScrubber';
import { LevelMeter } from '../widgets/LevelMeter';
import './shell.css';

export function Transport() {
  const project = useProject();
  const playing = useUiStore((s) => s.playing);
  const playMode = useUiStore((s) => s.playMode);
  const positionBeats = useUiStore((s) => s.positionBeats);
  const metronome = useUiStore((s) => s.metronome);
  const masterPeak = useUiStore((s) => s.masterPeakL);
  const masterRms = useUiStore((s) => s.masterRms);
  const clipped = useUiStore((s) => s.clipped);
  const cpu = useUiStore((s) => s.cpu);
  const recPhase = useRecorderStore((s) => s.phase);
  const recError = useRecorderStore((s) => s.error);
  const midiArmed = useLiveInputStore((s) => s.armed);
  const midiInputs = useLiveInputStore((s) => s.midiInputs);

  const setTempo = useCallback((tempo: number) => {
    store.dispatch({ type: 'setTempo', tempo }, { mergeKey: 'transport:tempo' });
  }, []);

  const setSwing = useCallback((swing: number) => {
    store.dispatch({ type: 'setSwing', swing }, { mergeKey: 'transport:swing' });
  }, []);

  // Compás: el motor solo usa num para los compases; den queda en 4 u 8.
  const setTimeSigNum = useCallback(
    (num: number) => {
      store.dispatch(
        { type: 'setTimeSig', timeSig: { num: Math.round(num), den: project.timeSig.den } },
        { label: 'Compás', mergeKey: 'transport:timesig' },
      );
    },
    [project.timeSig.den],
  );

  const setTimeSigDen = useCallback(
    (den: number) => {
      store.dispatch(
        { type: 'setTimeSig', timeSig: { num: project.timeSig.num, den: Math.round(den) } },
        { label: 'Compás', mergeKey: 'transport:timesig' },
      );
    },
    [project.timeSig.num],
  );

  // Tap tempo: media de los últimos intervalos (se reinicia tras 2.5 s quieto).
  const taps = useRef<number[]>([]);
  const tapTempo = useCallback(() => {
    const now = performance.now();
    const list = taps.current;
    if (list.length > 0 && now - list[list.length - 1]! > 2500) list.length = 0;
    list.push(now);
    if (list.length > 6) list.shift();
    if (list.length < 2) return;
    const avgMs = (list[list.length - 1]! - list[0]!) / (list.length - 1);
    // BPM con 1 decimal, igual que el scrubber de tempo.
    const bpm = Math.min(999, Math.max(20, Math.round((60000 / avgMs) * 10) / 10));
    store.dispatch({ type: 'setTempo', tempo: bpm }, { mergeKey: 'transport:tempo' });
  }, []);

  const bar = Math.floor(positionBeats / project.timeSig.num) + 1;
  const beat = Math.floor(positionBeats % project.timeSig.num) + 1;

  return (
    <div className="transport">
      <div className="transport-group">
        <button
          className={`tbtn play${playing ? ' active' : ''}`}
          title="Reproducir (Espacio)"
          onClick={() => void togglePlay()}
        >
          <IconPlay size={15} />
        </button>
        <button
          className="tbtn"
          title="Pausa (conserva la posición)"
          disabled={!playing}
          onClick={pausePlayback}
        >
          <IconPause size={15} />
        </button>
        <button className="tbtn" title="Detener" onClick={stopPlayback}>
          <IconStop size={15} />
        </button>
        <button
          className={`tbtn rec${recPhase === 'recording' ? ' active' : ''}`}
          title={
            recError
              ? `Grabación: ${recError}`
              : recPhase === 'recording'
                ? 'Grabando — clic para parar y colocar la toma'
                : 'Grabar el micro a la playlist'
          }
          disabled={recPhase === 'saving'}
          onClick={() => void toggleRecording()}
        >
          <span className="rec-dot" />
        </button>
        <button
          className={`tbtn${midiArmed ? ' active' : ''}`}
          title={`Grabación MIDI ${midiArmed ? 'armada — lo que toques cae al patrón al parar' : 'apagada'} · toca con el teclado del PC (fila Z/Q)${midiInputs > 0 ? ` · ${midiInputs} dispositivo(s) MIDI` : ''}`}
          onClick={toggleMidiArmed}
        >
          <IconPianoRoll size={15} />
        </button>
        <button
          className={`tbtn mode${playMode === 'song' ? ' active' : ''}`}
          title="Modo patrón / canción (L)"
          onClick={() => setPlayMode(playMode === 'song' ? 'pattern' : 'song')}
        >
          {playMode === 'song' ? 'SONG' : 'PAT'}
        </button>
        <button
          className={`tbtn${metronome ? ' active' : ''}`}
          title="Metrónomo"
          onClick={() => {
            const next = !metronome;
            useUiStore.setState({ metronome: next });
            engine.setMetronome(next);
          }}
        >
          <IconMetronome size={15} />
        </button>
      </div>

      <div className="transport-group">
        <NumberScrubber
          value={project.tempo}
          min={20}
          max={999}
          step={0.1}
          dragStep={1}
          decimals={1}
          suffix="BPM"
          onChange={setTempo}
        />
        <span className="timesig" title="Compás (pulsos por compás / figura)">
          <NumberScrubber
            value={project.timeSig.num}
            min={1}
            max={16}
            step={1}
            onChange={setTimeSigNum}
          />
          <span className="timesig-sep">/</span>
          <NumberScrubber
            value={project.timeSig.den}
            min={4}
            max={8}
            step={4}
            dragStep={1}
            onChange={setTimeSigDen}
          />
        </span>
        <Knob
          value={project.swing}
          min={0}
          max={1}
          defaultValue={0}
          label="Swing"
          size={26}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={setSwing}
        />
        <button className="tbtn tap" title="Tap tempo: marca el pulso con clics" onClick={tapTempo}>
          TAP
        </button>
      </div>

      <div className="transport-group pos" title="Compás : beat">
        <span className="pos-display">
          {bar}:{beat}
        </span>
      </div>

      <div className="transport-group meter-group" title="Nivel master (peak + línea RMS)">
        <LevelMeter peak={masterPeak} rms={masterRms} height={22} />
        <button
          className={`clip-led${clipped ? ' on' : ''}`}
          title={clipped ? 'Hubo clipping — clic para resetear' : 'Sin clipping'}
          onClick={() => useUiStore.setState({ clipped: false })}
        />
      </div>

      <div className="transport-group" title="Carga del motor de audio">
        <span className={`cpu-display${cpu > 0.85 ? ' hot' : cpu > 0.6 ? ' warm' : ''}`}>
          CPU {Math.round(cpu * 100)}%
        </span>
      </div>
    </div>
  );
}
