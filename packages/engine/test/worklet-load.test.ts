import { afterEach, describe, expect, it, vi } from 'vitest';
import { KernelLoadMeter } from '../src/worklet/load-meter';
import type { FromKernel, ToKernel } from '../src/protocol';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG009: carga medida respecto al presupuesto del bloque', () => {
  it('agrega tiempos por muestras, mantiene una ventana y vuelve a cero al quedar sin trabajo medido', () => {
    let time = 0;
    const meter = new KernelLoadMeter(48000, () => time);
    for (let i = 0; i < 100; i++) { const start = meter.begin(); time += 0.25; meter.end(start, 128); }
    expect(meter.load).toBeCloseTo(0.25 / (128 / 48), 12);
    for (let i = 0; i < 100; i++) meter.end(meter.begin(), 128);
    // La primera ventana incluye seis bloques anteriores; la siguiente ya es reposo.
    expect(meter.load).toBeLessThan(0.01);
    for (let i = 0; i < 100; i++) meter.end(meter.begin(), 128);
    expect(meter.load).toBeCloseTo(0, 12);
  });

  it('pondera tamaños de bloque y acota saturación o un reloj que retrocede', () => {
    let time = 0;
    const meter = new KernelLoadMeter(8000, () => time);
    meter.end(0, 0); expect(meter.load).toBe(0);
    let start = meter.begin(); time += 1; meter.end(start, 80);
    start = meter.begin(); time += 4; meter.end(start, 320);
    expect(meter.load).toBe(0.1);
    start = meter.begin(); time -= 10; meter.end(start, 80);
    expect(meter.load).toBeCloseTo(5 / 60, 12);
    start = meter.begin(); time += 1000; meter.end(start, 1600);
    expect(meter.load).toBe(1);
  });

  it('el worklet real publica carga y audio sin performance en su ámbito', async () => {
    vi.resetModules();
    vi.stubGlobal('performance', undefined);
    vi.stubGlobal('sampleRate', 48000);
    let time = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    const messages: FromKernel[] = [];
    class ProcessorBase {
      port = { onmessage: null as ((event: { data: ToKernel }) => void) | null,
        postMessage: (message: FromKernel) => { messages.push(message); } };
    }
    type Processor = ProcessorBase & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
    let ProcessorClass!: new () => Processor;
    vi.stubGlobal('AudioWorkletProcessor', ProcessorBase);
    vi.stubGlobal('registerProcessor', (_name: string, processor: new () => Processor) => { ProcessorClass = processor; });
    const { KernelCore } = await import('../src/kernel-core');
    const realProcess = KernelCore.prototype.process;
    vi.spyOn(KernelCore.prototype, 'process').mockImplementation(function (this: InstanceType<typeof KernelCore>, ...args) {
      realProcess.apply(this, args);
      time += 0.25; // Reloj determinista; DSP, puerto y consumidor del worklet reales.
    });
    await import('../src/worklet/kernel.worklet');
    const { applyCommand, createEmptyProject, createChannel } = await import('@orbit/core');
    const { compileProject } = await import('../src/compile');
    const p = createEmptyProject(), channel = createChannel('synth', 0);
    const patternId = p.patternOrder[0]!;
    applyCommand(p, { type: 'addChannel', channel });
    applyCommand(p, { type: 'addNotes', patternId, channelId: channel.id, notes: [{ id: 'n', start: 0,
      duration: 4, key: 60, velocity: 1, pan: 0, slide: false }] });
    const processor = new ProcessorClass();
    processor.port.onmessage!({ data: { type: 'snapshot', project: compileProject(p, { mode: 'pattern', patternId }) } });
    processor.port.onmessage!({ data: { type: 'play', fromBeat: 0 } });
    const outputs = [[new Float32Array(128), new Float32Array(128)]];
    let peak = 0;
    for (let i = 0; i < 110; i++) {
      expect(processor.process([], outputs)).toBe(true);
      peak = Math.max(peak, ...outputs[0]![0]!.map(Math.abs));
    }
    const meters = messages.filter((message) => message.type === 'meters');
    expect(meters.length).toBeGreaterThan(3);
    expect(meters.at(-1)!.frame.cpu).toBeCloseTo(0.09375, 12);
    expect(peak).toBeGreaterThan(0.1);
  });
});
