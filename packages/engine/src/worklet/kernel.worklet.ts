/**
 * Envoltorio AudioWorklet del KernelCore. Se carga con
 * `audioWorklet.addModule(...)` (Vite lo empaqueta como worker).
 */

import { KernelCore } from '../kernel-core';
import { KERNEL_NAME, METER_INTERVAL_BLOCKS, type ToKernel } from '../protocol';

class OrbitKernelProcessor extends AudioWorkletProcessor {
  private core = new KernelCore(sampleRate);
  private blocks = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToKernel>) => {
      this.core.handleMessage(e.data);
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const l = out[0]!;
    const r = out[1] ?? out[0]!;
    // Entrada en vivo (micro/instrumento). Sin nada conectado el array viene
    // vacío, y con un micro mono viene un solo canal: el kernel lo duplica.
    const input = inputs[0];
    const inL = input && input.length > 0 ? input[0] : undefined;
    const inR = input && input.length > 1 ? input[1] : undefined;
    this.core.process(l, r, l.length, inL, inR);

    if (++this.blocks >= METER_INTERVAL_BLOCKS) {
      this.blocks = 0;
      this.port.postMessage({ type: 'meters', frame: this.core.meterFrame() });
    }
    return true;
  }
}

registerProcessor(KERNEL_NAME, OrbitKernelProcessor);
