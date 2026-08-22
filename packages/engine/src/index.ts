// @orbit/engine — motor de audio DSP (AudioWorklet + render offline)
export const ENGINE_VERSION = '0.1.0';

export * from './protocol';
export { compileProject, topoOrder, type PlayMode } from './compile';
export { KernelCore, MAX_BLOCK } from './kernel-core';
export { AudioEngine } from './engine';
export { renderProject, renderStems, type RenderOptions, type RenderResult } from './render/offline';
export { encodeWav, type WavDepth } from './render/wav';
export { secondsAtBeat, type TempoSegment } from './tempo';
export { encodeOggFlac, lacing, oggCrc, type OggFlacOptions } from './render/ogg';
export { encodeFlac, encodeFlacStream, type FlacDepth } from './render/flac';
export {
  encodeOggOpus,
  parseOggOpus,
  parseOggPages,
  opusDuration,
  type OggOpusOptions,
  type OpusPacket,
} from './render/ogg-opus';
export {
  encodeOpusFile,
  encodeOpusPackets,
  tocByte,
  PRE_SKIP,
  type EncodeOptions as OpusEncodeOptions,
} from './render/opus/encoder';
export { analyzeMix, gainToTarget, type MixAnalysis } from './render/analysis';
export {
  correctPitch,
  detectPitchTrack,
  scalePitchClasses,
  type CorrectPitchOptions,
  type PitchTrack,
} from './render/pitch';
export {
  detectTransients,
  evenSlices,
  type TransientOptions,
  type TransientResult,
} from './render/transients';
export type { SampleData } from './dsp/voices';
