// @orbit/claude-bridge — servidor MCP: Claude como colaborador del proyecto
//
// Este índice solo exporta lo browser-safe (tools + executor, para el
// renderer). El lado Node (host WS para Electron main y relay MCP stdio) se
// importa por subruta: '@orbit/claude-bridge/node/ws-host'.
export const BRIDGE_VERSION = '0.1.0';

export { TOOLS, findTool, type ToolDef, type ToolInputSchema } from './tools';
export {
  ToolExecutor,
  type GeneratePackFn,
  type GeneratedPackInfo,
  type SaveFileFn,
} from './executor';
export {
  CEILING_DB,
  GENRE_LABELS,
  GENRE_PROFILES,
  MONO_BELOW_HZ,
  STREAMING_LUFS,
  adviseMix,
  formatAdvice,
  guessGenre,
} from './mix-advisor';
export type {
  ChainStep,
  GainStep,
  MixAdvice,
  MixContext,
  MixGenre,
  MixIssue,
  MixIssueId,
  TrackSlots,
} from './mix-advisor';
