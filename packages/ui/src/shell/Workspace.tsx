/** Área de trabajo: aloja las ventanas internas de los editores. */

import { InternalWindow } from './InternalWindow';
import { CollabPanel } from '../collab';
import { AudioEditor } from '../editors/audio';
import { AutomationEditor } from '../editors/automation';
import { ChannelRack } from '../editors/rack';
import { ChannelEditor } from '../editors/channel';
import { NovaPanel } from '../editors/nova';
import { PrismaPanel } from '../editors/prisma';
import { HistoryPanel } from '../editors/history';
import { LfoPanel } from '../editors/lfo';
import { ProjectInfo } from '../editors/project-info';
import { LiveView } from '../editors/live';
import { PianoRoll } from '../editors/pianoroll';
import { Mixer } from '../editors/mixer';
import { Playlist } from '../editors/playlist';
import { ExportPanel } from '../export';
import { ScopePanel } from '../scope';
import { SettingsPanel } from '../settings/SettingsPanel';
import './shell.css';

export function Workspace() {
  return (
    <div className="workspace">
      <InternalWindow id="channelRack" title="Channel Rack">
        <ChannelRack />
      </InternalWindow>
      <InternalWindow id="playlist" title="Playlist" minW={480}>
        <Playlist />
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
      <InternalWindow id="collab" title="Colaboración" minW={380}>
        <CollabPanel />
      </InternalWindow>
      <InternalWindow id="automation" title="Automatización" minW={520}>
        <AutomationEditor />
      </InternalWindow>
      <InternalWindow id="lfo" title="LFOs" minW={520} minH={200}>
        <LfoPanel />
      </InternalWindow>
      <InternalWindow id="nova" title="Orbit Nova" minW={560} minH={340}>
        <NovaPanel />
      </InternalWindow>
      <InternalWindow id="prisma" title="Orbit Prisma" minW={720} minH={460}>
        <PrismaPanel />
      </InternalWindow>
      <InternalWindow id="channelEditor" title="Editor de sonido" minW={560} minH={360}>
        <ChannelEditor />
      </InternalWindow>
      <InternalWindow id="history" title="Historial" minW={360} minH={260}>
        <HistoryPanel />
      </InternalWindow>
      <InternalWindow id="projectInfo" title="Info del proyecto" minW={380} minH={300}>
        <ProjectInfo />
      </InternalWindow>
      <InternalWindow id="scope" title="Orbit Scope" minW={360} minH={240}>
        <ScopePanel />
      </InternalWindow>
      <InternalWindow id="audioEditor" title="Editor de audio" minW={480} minH={240}>
        <AudioEditor />
      </InternalWindow>
      <InternalWindow id="liveView" title="Vista Live" minW={360} minH={260}>
        <LiveView />
      </InternalWindow>
    </div>
  );
}
