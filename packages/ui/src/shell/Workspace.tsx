/** Área de trabajo: aloja las ventanas internas de los editores. */

import { InternalWindow } from './InternalWindow';
import './shell.css';

/*
 * Los contenidos reales (ChannelRack, PianoRoll, Playlist, Mixer) se enchufan
 * aquí según se van construyendo; mientras, placeholder honesto.
 */

function Placeholder({ name }: { name: string }) {
  return <div className="panel-placeholder">{name}: en construcción.</div>;
}

export function Workspace() {
  return (
    <div className="workspace">
      <InternalWindow id="channelRack" title="Channel Rack">
        <Placeholder name="Channel Rack" />
      </InternalWindow>
      <InternalWindow id="playlist" title="Playlist" minW={480}>
        <Placeholder name="Playlist" />
      </InternalWindow>
      <InternalWindow id="pianoRoll" title="Piano Roll" minW={560}>
        <Placeholder name="Piano Roll" />
      </InternalWindow>
      <InternalWindow id="mixer" title="Mixer" minW={560}>
        <Placeholder name="Mixer" />
      </InternalWindow>
      <InternalWindow id="settings" title="Ajustes">
        <Placeholder name="Ajustes" />
      </InternalWindow>
    </div>
  );
}
