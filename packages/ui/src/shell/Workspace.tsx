/** Área de trabajo: aloja las ventanas internas de los editores. */

import { InternalWindow } from './InternalWindow';
import { ChannelRack } from '../editors/rack';
import { PianoRoll } from '../editors/pianoroll';
import { Mixer } from '../editors/mixer';
import { ExportPanel } from '../export';
import { SettingsPanel } from '../settings/SettingsPanel';
import './shell.css';

function Placeholder({ name }: { name: string }) {
  return <div className="panel-placeholder">{name}: en construcción.</div>;
}

export function Workspace() {
  return (
    <div className="workspace">
      <InternalWindow id="channelRack" title="Channel Rack">
        <ChannelRack />
      </InternalWindow>
      <InternalWindow id="playlist" title="Playlist" minW={480}>
        <Placeholder name="Playlist" />
      </InternalWindow>
      <InternalWindow id="pianoRoll" title="Piano Roll" minW={560}>
        <PianoRoll />
      </InternalWindow>
      <InternalWindow id="mixer" title="Mixer" minW={560}>
        <Mixer />
      </InternalWindow>
      <InternalWindow id="settings" title="Ajustes">
        <SettingsPanel />
      </InternalWindow>
      <InternalWindow id="export" title="Exportar" minW={380}>
        <ExportPanel />
      </InternalWindow>
    </div>
  );
}
