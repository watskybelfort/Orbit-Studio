// @orbit/engine/analysis — tempo y tonalidad offline (DSP puro, determinista).
export {
  NOTE_NAMES,
  KEY_MODE_LABELS,
  MAX_GRID_BEATS,
  type AudioAnalysis,
  type AudioAnalysisOptions,
  type BeatGrid,
  type KeyCandidate,
  type KeyEstimate,
  type KeyMode,
  type NoteName,
  type TempoCandidate,
  type TempoEstimate,
} from './types';

export { analyzeAudio, analyzeStereo, estimateKey, estimateTempo } from './audio';
export { countAttacks, onsetEnvelope, type OnsetEnvelope, type OnsetOptions } from './onset';
export { detectTempo, type TempoOptions } from './tempo';
export {
  camelotOf,
  chromagram,
  detectKey,
  keyFromProfile,
  keyName,
  tonalProfile,
  type ChromaOptions,
} from './key';
export {
  ANALYSIS_RATE,
  analysisWindows,
  hannWindow,
  mixToMono,
  peakOf,
  resampleMono,
  rmsDb,
  sliceWindow,
} from './signal';
