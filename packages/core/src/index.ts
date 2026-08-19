// @orbit/core — modelo de proyecto, comandos y formato .orbit
export const CORE_VERSION = '0.1.0';

export * from './model/types';
export * from './model/params';
export * from './model/paramref';
export * from './model/nova';
export * from './model/prisma';
export * from './model/templates';
export * from './model/slices';
export * from './model/channel-drop';
export * from './model/routing';
export * from './model/diff';
export * from './model/notes';
export * from './model/fades';
export * from './model/defaults';
export * from './commands';
export * from './store';
export * from './format';
export { newId } from './ids';
export { encodeMidi, type EncodeMidiOptions } from './midi/encode';
export { decodeMidi, type DecodedMidi, type DecodedMidiTrack } from './midi/decode';
export {
  arpeggiate,
  chop,
  humanize,
  riff,
  strum,
  type ArpeggiateOptions,
  type ChopOptions,
  type HumanizeOptions,
  type RiffCharacter,
  type RiffOptions,
  type StrumOptions,
} from './note-tools';
