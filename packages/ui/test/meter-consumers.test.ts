import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@orbit/core';
import { defaultClipLength } from '../src/state/param-actions';

describe('BUG047: compases en los consumidores del renderer', () => {
  it.each([[6, 8, 12], [6, 4, 24], [1, 8, 2]])('cuatro compases %i/%i crean %f beats de automatización', (num, den, length) => {
    const project = createEmptyProject();
    project.timeSig = { num, den };
    expect(defaultClipLength(project)).toBe(length);
  });

  it('rejillas, snap, paneles y riff convierten compases a negras con el denominador', () => {
    for (const path of ['editors/playlist/Playlist.tsx', 'editors/automation/AutomationEditor.tsx', 'editors/pianoroll/PianoRoll.tsx', 'editors/live/LiveView.tsx', 'export/ExportPanel.tsx', 'collab/CollabPanel.tsx']) {
      const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
      expect(source).toMatch(/beatsInBar\((?:store\.)?project.timeSig\)/);
      expect(source).not.toMatch(/Math.max\(1, project.timeSig.num\)/);
    }
    const transport = readFileSync(new URL('../src/shell/Transport.tsx', import.meta.url), 'utf8');
    expect(transport).toContain('positionBeats / barLength');
    expect(transport).toContain('(positionBeats % barLength) / meterBeatUnit(project.timeSig)');
    const playlist = readFileSync(new URL('../src/editors/playlist/Playlist.tsx', import.meta.url), 'utf8');
    expect(playlist).toContain('beatsInBar({ num: m.timeSigNum, den: project.timeSig.den })');
    const piano = readFileSync(new URL('../src/editors/pianoroll/PianoRoll.tsx', import.meta.url), 'utf8');
    expect(piano).toContain('beatToX(bar * measure)');
  });
});
