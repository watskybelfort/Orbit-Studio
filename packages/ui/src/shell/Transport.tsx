/** Barra de transporte: play/stop, PAT/SONG, BPM, swing, metrónomo, posición. */

import { useCallback } from 'react';
import { engine, setPlayMode, stopPlayback, store, togglePlay } from '../state/app';
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
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 1 L11 6 L2 11 Z" fill="currentColor" />
          </svg>
        </button>
        <button className="tbtn" title="Detener" onClick={stopPlayback}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="2" width="8" height="8" fill="currentColor" />
          </svg>
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
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M4 1 h4 l2 10 h-8 Z M6 3 L8.5 9" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
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
