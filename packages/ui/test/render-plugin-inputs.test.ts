import { afterEach, describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, type EffectSlot } from '@orbit/core';
import { compileProject, renderProject } from '@orbit/engine';
import { collectPluginSources } from '../src/export/render-inputs';
import { usePluginsStore } from '../src/state/plugins';

const SILENCER = 'function createEffect(){return {process(l,r,n){for(let i=0;i<n;i++){l[i]=0;r[i]=0;}}};}';
const TONE = `function createInstrument(sr){let phase=0,on=false;return {
  noteOn(){on=true;}, noteOff(){on=false;}, render(l,r,from,to,gl,gr){
    if(!on)return false;
    for(let i=from;i<to;i++){phase+=220/sr;const v=.2*Math.sin(2*Math.PI*phase);l[i]+=v*gl;r[i]+=v*gr;}
    return true;
  }
};}`;
const slot = (pluginId: string): EffectSlot => ({ id: `slot-${pluginId}`, kind: 'plugin', pluginId, enabled: true, mix: 1, params: {} });
const peak = (pcm: Float32Array) => pcm.reduce((m, value) => Math.max(m, Math.abs(value)), 0);
afterEach(() => { usePluginsStore.setState({ sources: new Map() }); });

function project() {
  const p = createEmptyProject();
  const channel = createChannel('synth', 0);
  applyCommand(p, { type: 'addChannel', channel });
  const patternId = p.patternOrder[0]!;
  applyCommand(p, { type: 'addNotes', patternId, channelId: channel.id, notes: [
    { id: 'n', key: 60, start: 0, duration: 1, velocity: 1, pan: 0, slide: false },
  ] });
  return { p, channel, patternId };
}

describe('fuentes de plugins para export/bounce', () => {
  it('el insert JS de canal conserva su procesamiento en el render', () => {
    const { p, channel, patternId } = project();
    applyCommand(p, { type: 'setChannelEffect', channelId: channel.id, slotIndex: 0, slot: slot('silencer') });
    usePluginsStore.setState({ sources: new Map([['silencer', SILENCER]]) });
    const compiled = compileProject(p, { mode: 'pattern', patternId });
    const options = { sampleRate: 8000, tailSeconds: 0 };
    expect(peak(renderProject(compiled, options).left)).toBeGreaterThan(0.1);
    const collected = collectPluginSources(p);
    const expected = renderProject(compiled, { ...options, plugins: new Map([['silencer', SILENCER]]) });
    const actual = renderProject(compiled, { ...options, plugins: collected.plugins });
    expect(collected.missing).toEqual([]);
    expect(peak(expected.left)).toBe(0);
    expect(peak(actual.left)).toBe(0);
  });

  it('el instrumento JS exporta la misma señal que el kernel con fuente explícita', () => {
    const { p, channel, patternId } = project();
    applyCommand(p, { type: 'patchChannel', channelId: channel.id, patch: { instrumentPluginId: 'tone' } });
    usePluginsStore.setState({ sources: new Map([['tone', TONE]]) });
    const compiled = compileProject(p, { mode: 'pattern', patternId });
    const options = { sampleRate: 8000, tailSeconds: 0 };
    const expected = renderProject(compiled, { ...options, plugins: new Map([['tone', TONE]]) });
    const actual = renderProject(compiled, { ...options, plugins: collectPluginSources(p).plugins });
    expect(peak(expected.left)).toBeGreaterThan(0.05);
    expect(actual.left.every((value, i) => value === expected.left[i])).toBe(true);
    expect(actual.right.every((value, i) => value === expected.right[i])).toBe(true);
  });

  it('deduplica fuentes y avisos entre mixer, instrumento e inserts de canal', () => {
    const { p, channel } = project();
    applyCommand(p, { type: 'setEffect', trackIndex: 0, slotIndex: 0, slot: slot('shared') });
    applyCommand(p, { type: 'setChannelEffect', channelId: channel.id, slotIndex: 0, slot: slot('shared') });
    applyCommand(p, { type: 'patchChannel', channelId: channel.id, patch: { instrumentPluginId: 'shared' } });
    expect(collectPluginSources(p).missing).toEqual(['shared']);
    usePluginsStore.setState({ sources: new Map([['shared', SILENCER]]) });
    expect([...collectPluginSources(p).plugins.keys()]).toEqual(['shared']);
    expect(collectPluginSources(p).missing).toEqual([]);
  });

  it('avisa de fuentes ausentes en canal e instrumento, sin requerir inserts de mixer', () => {
    const { p, channel } = project();
    applyCommand(p, { type: 'setChannelEffect', channelId: channel.id, slotIndex: 0, slot: slot('absent-effect') });
    applyCommand(p, { type: 'patchChannel', channelId: channel.id, patch: { instrumentPluginId: 'absent-instrument' } });
    expect(collectPluginSources(p).missing.sort()).toEqual(['absent-effect', 'absent-instrument']);
  });
});
