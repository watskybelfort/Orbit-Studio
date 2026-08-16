/** Barra de transporte: play/stop, PAT/SONG, BPM, swing, metrónomo, posición. */

import { useCallback } from 'react';
import { engine, setPlayMode, stopPlayback, store, togglePlay } from '../state/app';
import { IconMetronome, IconPlay, IconStop } from '../icons';
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

  const setTempo = useCallback((tempo: number) => {
    store.dispatch({ type: 'setTempo', tempo }, { mergeKey: 'transport:tempo' });
  }, []);

  const setSwing = useCallback((swing: number) => {
    store.dispatch({ type: 'setSwing', swing }, { mergeKey: 'transport:swing' });
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
        <button className="tbtn" title="Detener" onClick={stopPlayback}>
          <IconStop size={15} />
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
          step={1}
          decimals={0}
          suffix="BPM"
          onChange={setTempo}
        />
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
      </div>

      <div className="transport-group pos" title="Compás : beat">
        <span className="pos-display">
          {bar}:{beat}
        </span>
      </div>

      <div className="transport-group meter-group" title="Nivel master">
        <LevelMeter peak={masterPeak} height={22} />
      </div>
    </div>
  );
}
