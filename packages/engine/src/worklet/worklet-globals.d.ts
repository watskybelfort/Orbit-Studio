/** Globals del AudioWorkletGlobalScope (no están en lib.dom). */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  },
): void;

declare const sampleRate: number;
declare const currentFrame: number;
