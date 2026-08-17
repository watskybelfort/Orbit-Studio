/**
 * Compilador de proyecto: modelo editable → CompiledProject para el kernel.
 * Aquí se resuelven solo/mute, swing, clips → eventos absolutos y curvas de
 * automatización desnormalizadas a valores reales.
 */

import {
  LFO_SHAPES,
  findFluxPreset,
  paramRefKey,
  paramRefNorm,
  paramRefValue,
  type AutomationPoint,
  type Clip,
  type EffectSlot,
  type Lfo,
  type ParamRef,
  type Project,
} from '@orbit/core';
import {
  LFO_LUT_STEPS,
  type CompiledAudioClip,
  type CompiledAutomationEvent,
  type CompiledChannel,
  type CompiledEffect,
  type CompiledLfo,
  type CompiledMixerTrack,
  type CompiledNoteEvent,
  type CompiledParamTarget,
  type CompiledProject,
} from './protocol';

export type PlayMode =
  | { mode: 'pattern'; patternId: string }
  /**
   * Canción entera o, con `clipIds`, SOLO esos clips (consolidar a audio):
   * el resto del arreglo enmudece pero la cadena de mixer sigue intacta, que
   * es justo lo que se quiere bouncear — el clip con sus efectos, no seco.
   */
  | { mode: 'song'; clipIds?: readonly string[] };

const AUTOMATION_STEP = 1 / 8; // beats entre muestras de curva (1/32 de compás 4/4)

/** Swing FL: desplaza los 1/16 impares hasta medio 1/16. */
function swungStart(start: number, swing: number): number {
  if (swing <= 0) return start;
  const stepIndex = Math.round(start / 0.25);
  if (Math.abs(start - stepIndex * 0.25) > 1e-4) return start; // fuera de rejilla: no tocar
  return stepIndex % 2 === 1 ? start + swing * 0.125 : start;
}

function compileEffect(slot: EffectSlot): CompiledEffect {
  return {
    id: slot.id,
    kind: slot.kind,
    enabled: slot.enabled,
    mix: slot.mix,
    params: { ...slot.params },
    sidechainSource: slot.sidechainSource,
    pluginId: slot.pluginId,
  };
}

/** Curva de un clip de automatización, muestreada a valores REALES. */
function sampleAutomation(
  clip: Clip,
  points: AutomationPoint[],
  target: ParamRef,
  project: Project,
  channelIndexOf: Map<string, number>,
): CompiledAutomationEvent | null {
  const compiledTarget = compileParamTarget(target, channelIndexOf);
  if (!compiledTarget) return null;

  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return null;

  const steps = Math.max(1, Math.ceil(clip.length / AUTOMATION_STEP));
  const values = new Array<number>(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(clip.length, i * AUTOMATION_STEP);
    values[i] = paramRefValue(evalCurve(sorted, t), target, project);
  }
  return {
    startBeat: clip.start,
    step: AUTOMATION_STEP,
    values,
    target: compiledTarget,
  };
}

/** Interpola la curva (0..1) en el tiempo t (beats relativos al clip). */
function evalCurve(points: AutomationPoint[], t: number): number {
  const first = points[0]!;
  if (t <= first.time) return first.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const f = shape((t - a.time) / span, a.tension);
      return a.value + (b.value - a.value) * f;
    }
  }
  return points[points.length - 1]!.value;
}

/** Curvatura por tensión: >0 arranca lento, <0 arranca rápido. */
function shape(t: number, tension: number): number {
  if (tension > 0) return Math.pow(t, 1 + 3 * tension);
  if (tension < 0) return 1 - Math.pow(1 - t, 1 - 3 * tension);
  return t;
}

function compileParamTarget(
  ref: ParamRef,
  channelIndexOf: Map<string, number>,
): CompiledParamTarget | null {
  switch (ref.kind) {
    case 'channel': {
      const idx = channelIndexOf.get(ref.channelId);
      if (idx === undefined) return null;
      return { scope: 'channelParam', channelIndex: idx, key: ref.param };
    }
    case 'channelMix': {
      const idx = channelIndexOf.get(ref.channelId);
      if (idx === undefined) return null;
      return { scope: 'channelMix', channelIndex: idx, key: ref.param };
    }
    case 'mixer':
      return { scope: 'mixer', trackIndex: ref.trackIndex, key: ref.param };
    case 'effect':
      return {
        scope: 'effect',
        trackIndex: ref.trackIndex,
        slotIndex: ref.slotIndex,
        key: ref.param,
      };
    case 'transport':
      return { scope: 'transport', key: ref.param };
  }
}

/**
 * LFO del modelo → LFO compilado, con la LUT norm→valor real del destino.
 * Devuelve null si el destino ya no existe (canal borrado, efecto quitado…).
 */
function compileLfo(
  lfo: Lfo,
  project: Project,
  channelIndexOf: Map<string, number>,
): CompiledLfo | null {
  const target = compileParamTarget(lfo.target, channelIndexOf);
  if (!target) return null;
  const baseNorm = paramRefNorm(lfo.target, project);
  if (baseNorm === null) return null;
  const lut = new Float32Array(LFO_LUT_STEPS + 1);
  for (let i = 0; i <= LFO_LUT_STEPS; i++) {
    lut[i] = paramRefValue(i / LFO_LUT_STEPS, lfo.target, project);
  }
  const shape = Math.max(0, LFO_SHAPES.indexOf(lfo.shape));
  return {
    target,
    shape,
    rateBeats: Math.max(1 / 16, lfo.rateBeats),
    amount: Math.min(1, Math.max(-1, lfo.amount)),
    phase: lfo.phase,
    baseNorm,
    lut,
  };
}

/** Orden topológico del grafo de mixer (fuentes → master al final). */
export function topoOrder(
  tracks: { routeTo: number | null; sends: { target: number }[] }[],
): number[] {
  const n = tracks.length;
  const outs: number[][] = tracks.map((t) => {
    const targets = new Set<number>();
    if (t.routeTo !== null) targets.add(t.routeTo);
    for (const s of t.sends) targets.add(s.target);
    return [...targets].filter((x) => x >= 0 && x < n);
  });
  const indeg = new Array<number>(n).fill(0);
  for (const targets of outs) for (const t of targets) indeg[t]!++;

  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  while (queue.length) {
    const i = queue.shift()!;
    order.push(i);
    for (const t of outs[i]!) {
      if (--indeg[t]! === 0) queue.push(t);
    }
  }
  // Ciclos (sends circulares): añade lo que falte en orden de índice.
  if (order.length < n) {
    const seen = new Set(order);
    for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
  }
  return order;
}

export function compileProject(project: Project, play: PlayMode): CompiledProject {
  const channelIds = project.channelOrder;
  const channelIndexOf = new Map(channelIds.map((id, i) => [id, i]));

  // Solo/mute de canales
  const anyChannelSolo = channelIds.some((id) => project.channels[id]?.solo);
  const channels: CompiledChannel[] = channelIds.map((id) => {
    const ch = project.channels[id]!;
    const compiled: CompiledChannel = {
      id: ch.id,
      kind: ch.kind,
      params: { ...ch.params },
      volume: ch.volume,
      pan: ch.pan,
      audible: anyChannelSolo ? ch.solo : !ch.mute,
      mixerTrack: ch.mixerTrack,
      sampleId: ch.sampleId,
    };
    const preset = ch.kind === 'flux' ? findFluxPreset(ch.fluxPreset) : undefined;
    if (preset) {
      compiled.flux = {
        layers: preset.layers.map((l) => ({
          engine: l.engine,
          params: { ...l.params },
          gain: l.gain,
          pan: l.pan,
          transpose: l.transpose,
        })),
        macros: preset.macros.map((m) => ({ targets: m.targets.map((t) => ({ ...t })) })),
      };
    }
    return compiled;
  });

  // Solo/mute del mixer (master siempre audible)
  const anyMixerSolo = project.mixer.some((t, i) => i !== 0 && t.solo);
  const mixer: CompiledMixerTrack[] = project.mixer.map((t, i) => ({
    id: t.id,
    volume: t.volume,
    pan: t.pan,
    stereoWidth: t.stereoWidth,
    eqLow: t.eqLow ?? 0,
    eqMid: t.eqMid ?? 0,
    eqHigh: t.eqHigh ?? 0,
    audible: i === 0 ? true : anyMixerSolo ? t.solo : !t.mute,
    slots: t.slots.map((s) => (s ? compileEffect(s) : null)),
    routeTo: t.routeTo,
    sends: t.sends.map((s) => ({ ...s })),
  }));

  const events: CompiledNoteEvent[] = [];
  const audioClips: CompiledAudioClip[] = [];
  const automation: CompiledAutomationEvent[] = [];
  let lengthBeats = 4;

  const pushPatternEvents = (
    patternId: string,
    atBeat: number,
    window: { offset: number; length: number } | null,
  ) => {
    const pattern = project.patterns[patternId];
    if (!pattern) return;
    for (const [channelId, notes] of Object.entries(pattern.notes)) {
      const channelIndex = channelIndexOf.get(channelId);
      if (channelIndex === undefined) continue;
      for (const note of notes) {
        let start = note.start;
        let duration = note.duration;
        if (window) {
          const winEnd = window.offset + window.length;
          const noteEnd = note.start + note.duration;
          if (noteEnd <= window.offset || note.start >= winEnd) continue;
          // Recorta la nota a la ventana del clip.
          const clippedStart = Math.max(note.start, window.offset);
          const clippedEnd = Math.min(noteEnd, winEnd);
          start = clippedStart - window.offset;
          duration = clippedEnd - clippedStart;
        }
        events.push({
          start: swungStart(atBeat + start, project.swing),
          duration,
          key: note.key,
          velocity: note.velocity,
          pan: note.pan,
          slide: note.slide,
          channelIndex,
        });
      }
    }
  };

  if (play.mode === 'pattern') {
    const pattern = project.patterns[play.patternId];
    if (pattern) {
      pushPatternEvents(pattern.id, 0, null);
      let maxEnd = pattern.length;
      for (const notes of Object.values(pattern.notes)) {
        for (const n of notes) maxEnd = Math.max(maxEnd, n.start + n.duration);
      }
      lengthBeats = Math.max(4, Math.ceil(maxEnd / 4) * 4);
    }
  } else {
    const activeTracks = new Set(
      Object.values(project.playlistTracks)
        .filter((t) => t.arrangementId === project.activeArrangementId && !t.muted)
        .map((t) => t.id),
    );
    const only = play.clipIds ? new Set(play.clipIds) : null;
    for (const clip of Object.values(project.clips)) {
      if (only && !only.has(clip.id)) continue;
      if (clip.muted || !activeTracks.has(clip.playlistTrackId)) continue;
      lengthBeats = Math.max(lengthBeats, clip.start + clip.length);
      if (clip.kind === 'pattern' && clip.patternId) {
        pushPatternEvents(clip.patternId, clip.start, {
          offset: clip.patternOffset ?? 0,
          length: clip.length,
        });
      } else if (clip.kind === 'audio' && clip.sampleId) {
        audioClips.push({
          start: clip.start,
          length: clip.length,
          sampleId: clip.sampleId,
          offset: clip.audioOffset ?? 0,
          gain: clip.audioGain ?? 1,
          mixerTrack: 0,
          stretch: clip.audioStretch === true,
        });
      } else if (clip.kind === 'automation' && clip.target && clip.points) {
        const ev = sampleAutomation(clip, clip.points, clip.target, project, channelIndexOf);
        if (ev) automation.push(ev);
      }
    }
    lengthBeats = Math.ceil(lengthBeats / 4) * 4;
  }

  events.sort((a, b) => a.start - b.start);

  // LFOs: valen en los dos modos (PAT y SONG) porque no viven en la playlist.
  // Dos LFOs sobre el MISMO destino se pelearían por el valor (cada uno vería
  // la escritura del otro como un cambio externo), así que gana el primero.
  const lfos: CompiledLfo[] = [];
  const lfoTargets = new Set<string>();
  for (const lfo of Object.values(project.lfos)) {
    if (!lfo.enabled) continue;
    const key = paramRefKey(lfo.target);
    if (lfoTargets.has(key)) continue;
    const compiled = compileLfo(lfo, project, channelIndexOf);
    if (!compiled) continue;
    lfoTargets.add(key);
    lfos.push(compiled);
  }

  return {
    tempo: project.tempo,
    timeSigNum: project.timeSig.num,
    lengthBeats,
    channels,
    events,
    audioClips,
    automation,
    lfos,
    mixer,
    mixerOrder: topoOrder(mixer),
  };
}
