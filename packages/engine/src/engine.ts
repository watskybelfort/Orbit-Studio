/**
 * AudioEngine: controlador del kernel en vivo (hilo UI).
 * Crea el AudioContext, carga el worklet y traduce el proyecto editable a
 * snapshots compilados. La UI habla con esto, nunca con el worklet directo.
 */

import type { Project } from '@orbit/core';
import { compileProject, type PlayMode } from './compile';
import {
  KERNEL_NAME,
  type FromKernel,
  type MeterFrame,
  type ToKernel,
} from './protocol';
// Vite empaqueta el worklet como worker aparte y nos da su URL.
import workletUrl from './worklet/kernel.worklet?worker&url';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pending: ToKernel[] = [];
  private loadedSamples = new Set<string>();

  playMode: PlayMode = { mode: 'song' };
  onMeters: ((frame: MeterFrame) => void) | null = null;
  lastMeters: MeterFrame | null = null;

  get ready(): boolean {
    return this.node !== null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  /** Idempotente; llamar tras un gesto del usuario (autoplay policy). */
  async init(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, KERNEL_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent<FromKernel>) => {
      const msg = e.data;
      if (msg.type === 'meters') {
        this.lastMeters = msg.frame;
        this.onMeters?.(msg.frame);
      }
    };
    node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    for (const m of this.pending) this.send(m);
    this.pending = [];
  }

  send(msg: ToKernel, transfer: Transferable[] = []): void {
    if (this.node) this.node.port.postMessage(msg, transfer);
    else this.pending.push(msg);
  }

  /** Compila y envía el proyecto entero (llamar en cada cambio del store). */
  syncProject(project: Project): void {
    this.send({ type: 'snapshot', project: compileProject(project, this.playMode) });
  }

  /**
   * Cambio CUANTIZADO (vista Live): compila `play` y lo pone en cola; el
   * kernel lo aplica justo al cerrar el loop actual. No toca this.playMode —
   * la UI lo actualiza cuando detecta el salto de posición.
   */
  queueSnapshot(project: Project, play: PlayMode): void {
    this.send({ type: 'queueSnapshot', project: compileProject(project, play) });
  }

  /** Registra (o actualiza) un plugin JS de usuario en el kernel. */
  registerPlugin(pluginId: string, code: string): void {
    this.send({ type: 'registerPlugin', pluginId, code });
  }

  play(fromBeat = 0): void {
    this.send({ type: 'play', fromBeat });
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  seek(beat: number): void {
    this.send({ type: 'seek', beat });
  }

  setLoop(start: number, end: number, enabled: boolean): void {
    this.send({ type: 'setLoop', start, end, enabled });
  }

  setMetronome(enabled: boolean): void {
    this.send({ type: 'setMetronome', enabled });
  }

  /**
   * Activa/apaga el tap del Orbit Scope (evita copiar samples si está cerrado).
   * `trackIndex` elige la pista de mixer tapeada (default 0 = master).
   */
  setScope(enabled: boolean, trackIndex = 0): void {
    this.send({ type: 'setScope', enabled, trackIndex });
  }

  previewNote(channelIndex: number, key: number, on: boolean): void {
    this.send({ type: 'previewNote', channelIndex, key, on });
  }

  /** Decodifica un archivo de audio y lo sube al kernel (una sola vez por id). */
  async loadSample(sampleId: string, data: ArrayBuffer): Promise<{ duration: number }> {
    if (!this.ctx) await this.init();
    const ctx = this.ctx!;
    if (this.loadedSamples.has(sampleId)) return { duration: 0 };
    const decoded = await ctx.decodeAudioData(data.slice(0));
    const left = decoded.getChannelData(0).slice();
    const right = (decoded.numberOfChannels > 1
      ? decoded.getChannelData(1)
      : decoded.getChannelData(0)
    ).slice();
    this.send(
      { type: 'loadSample', sampleId, left, right, sampleRate: decoded.sampleRate },
      [left.buffer, right.buffer],
    );
    this.loadedSamples.add(sampleId);
    return { duration: decoded.duration };
  }

  previewSample(sampleId: string, gain = 0.9): void {
    this.send({ type: 'previewSample', sampleId, gain });
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
  }
}
