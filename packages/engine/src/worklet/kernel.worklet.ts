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
    // Entrada en vivo (micro/instrumento/interfaz). Sin nada conectado el
    // array viene vacío; con un micro mono viene UN canal y el kernel lo
    // duplica; con una interfaz de ocho entradas vienen los ocho y el kernel
    // reparte cada uno a su pista según `setInputRoutes`.
    //
    // Se le pasa el array ENTERO y no el par de siempre: el nodo ya declara
    // `channelCount` con las entradas reales del aparato (ver `engine.ts`), y
    // quedarse aquí con los dos primeros canales tiraría los otros seis antes
    // de que nadie pudiera elegirlos.
    this.core.process(l, r, l.length, inputs[0]);

    if (++this.blocks >= METER_INTERVAL_BLOCKS) {
      this.blocks = 0;
      // La ÚNICA alocación que se permite en este `process()`, y va firmada:
      // los medidores se emiten por el puerto, y el puerto serializa —
      // `meterFrame()` ya construye su cuadro (peaks.slice(), rms nuevos) para
      // poder mandarlo. Reutilizar aquí el objeto envoltorio no ahorraría
      // nada. Ocurre una vez cada METER_INTERVAL_BLOCKS (≈46 ms), no por
      // bloque, y es lo que hace visible el nivel en la interfaz.
      // eslint-disable-next-line orbit/no-audio-thread-alloc
      this.port.postMessage({ type: 'meters', frame: this.core.meterFrame() });
    }
    return true;
  }
}

registerProcessor(KERNEL_NAME, OrbitKernelProcessor);
