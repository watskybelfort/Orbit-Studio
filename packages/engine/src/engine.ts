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
  /** Duración real de cada sample ya decodificado (segundos). */
  private sampleDurations = new Map<string, number>();
  /**
   * Arranque en vuelo. `init()` tarda dos `await` en asignar `this.ctx`, así que
   * dos llamadas casi a la vez (el pointerdown que despierta el audio y el click
   * que da al play en el primer arranque) veían ambas `ctx === null` y creaban
   * DOS AudioContext + dos worklets; el que quedaba en `this.node` recibía los
   * mensajes y el otro sonaba de fantasma para siempre. Memoizar la promesa hace
   * que la segunda llamada espere a la primera.
   */
  private initPromise: Promise<void> | null = null;

  playMode: PlayMode = { mode: 'song' };
  onMeters: ((frame: MeterFrame) => void) | null = null;
  lastMeters: MeterFrame | null = null;

  get ready(): boolean {
    return this.node !== null;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  /**
   * El AudioContext de la app (null hasta el primer gesto del usuario). Lo
   * necesita quien tenga que sacar audio que NO pasa por el kernel — hoy, el
   * master que llega de otro por la sala.
   */
  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  /** Idempotente; llamar tras un gesto del usuario (autoplay policy). */
  init(): Promise<void> {
    if (this.ctx) {
      return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    }
    // Un solo arranque en vuelo (ver initPromise). Si falla, se limpia para
    // poder reintentar; si no, quedaría una promesa rechazada cacheada.
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    // El nodo tiene UNA entrada: por ahí entra el micro cuando se monitoriza.
    // `explicit` + 2 canales para que un micro mono llegue a los dos lados en
    // vez de quedarse pegado a la izquierda.
    const node = new AudioWorkletNode(ctx, KERNEL_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
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

  /**
   * Registra (o actualiza) un plugin JS de INSTRUMENTO: el archivo declara
   * `createInstrument(sampleRate)` y un canal lo usa por su id. El kernel se
   * queda con las fábricas que traiga el módulo, así que un archivo que
   * exporte las dos (efecto + instrumento) vale para ambos sitios.
   */
  registerInstrument(pluginId: string, code: string): void {
    this.send({ type: 'registerInstrument', pluginId, code });
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
   * Cuenta atrás con el transporte parado: `beats` clics al tempo actual y, si
   * viene `playFrom`, el transporte entra solo justo después del último — en el
   * sample exacto, no cuando despierte un temporizador de la UI.
   */
  countIn(beats: number, beatsPerBar: number, playFrom?: number): void {
    this.send({
      type: 'countIn',
      beats,
      beatsPerBar,
      ...(playFrom === undefined ? null : { playFrom }),
    });
  }

  cancelCountIn(): void {
    this.send({ type: 'cancelCountIn' });
  }

  /**
   * Entrada en vivo. `listening` mide el nivel (para ajustar ganancia sin
   * oírse); `monitor` además la mete en la pista, antes de sus inserts.
   */
  setLiveInput(listening: boolean, monitor: boolean, trackIndex: number, gain = 1): void {
    this.send({ type: 'setLiveInput', listening, monitor, trackIndex, gain });
  }

  /**
   * Guarda la entrada EN CRUDO: mientras está activo, el audio del micro llega
   * en `inputCaptureL/R` de cada frame de medidores. Es la grabación de voz
   * sin códec de por medio.
   */
  setInputCapture(enabled: boolean): void {
    this.send({ type: 'setInputCapture', enabled });
  }


  /**
   * Conecta una fuente de audio a la entrada del kernel (el micro). Devuelve
   * el nodo de origen para poder desconectarlo; null si el audio no arrancó.
   */
  connectInput(stream: MediaStream): MediaStreamAudioSourceNode | null {
    if (!this.ctx || !this.node) return null;
    const source = this.ctx.createMediaStreamSource(stream);
    source.connect(this.node);
    return source;
  }



  /**
   * Activa/apaga el tap del Orbit Scope (evita copiar samples si está cerrado).
   * `trackIndex` elige la pista de mixer tapeada (default 0 = master).
   */
  setScope(enabled: boolean, trackIndex = 0): void {
    this.send({ type: 'setScope', enabled, trackIndex });
  }

  /**
   * Graba la salida post-fader de una pista de mixer: mientras está activo, el
   * audio llega en `captureL`/`captureR` de cada frame de medidores.
   */
  setTrackCapture(trackIndex: number, enabled: boolean): void {
    this.send({ type: 'setTrackCapture', trackIndex, enabled });
  }

  previewNote(channelIndex: number, key: number, on: boolean): void {
    this.send({ type: 'previewNote', channelIndex, key, on });
  }

  /**
   * Dobla el tono del canal, en semitonos. Afecta a lo que ya está sonando y
   * a lo que suene después, hasta que se devuelva a 0.
   */
  pitchBend(channelIndex: number, semitones: number): void {
    this.send({ type: 'pitchBend', channelIndex, semitones });
  }

  /**
   * Decodifica un archivo de audio y lo sube al kernel (una sola vez por id).
   * Devuelve su duración REAL, también si ya estaba subido: quien coloca un
   * clip la necesita, y devolver 0 la segunda vez obligaba a inventársela.
   */
  async loadSample(sampleId: string, data: ArrayBuffer): Promise<{ duration: number }> {
    if (!this.ctx) await this.init();
    const ctx = this.ctx!;
    const known = this.sampleDurations.get(sampleId);
    if (known !== undefined) return { duration: known };
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
    this.sampleDurations.set(sampleId, decoded.duration);
    return { duration: decoded.duration };
  }

  previewSample(sampleId: string, gain = 0.9): void {
    this.send({ type: 'previewSample', sampleId, gain });
  }

  /**
   * Olvida lo que ya no hace falta: `keep` es la lista COMPLETA de samples que
   * siguen en uso (sale de `sampleKeepSet`), y todo lo demás sale de la caché.
   *
   * Es la mitad de arriba de la recolección — la de abajo es el mensaje
   * `collectSamples`, que suelta el audio en el worklet. Las dos van juntas y
   * por el mismo motivo que documenta `dispose()`: `loadSample` devuelve la
   * duración cacheada SIN volver a subir el audio, así que soltar el buffer en
   * el kernel sin olvidarlo aquí dejaría al sampler y a los clips pidiendo un
   * sample que ya no está, y sonando a nada.
   *
   * De ahí la asimetría que conviene tener presente al tocar esto: olvidar de
   * MÁS es inofensivo (se vuelve a leer y a subir), olvidar de MENOS deja mudo.
   */
  keepOnlySamples(keep: readonly string[]): void {
    const alive = new Set(keep);
    for (const id of [...this.loadedSamples]) if (!alive.has(id)) this.loadedSamples.delete(id);
    for (const id of [...this.sampleDurations.keys()]) {
      if (!alive.has(id)) this.sampleDurations.delete(id);
    }
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
    // Sin esto, tras dispose()+init() `loadSample` devolvía la duración cacheada
    // sin re-subir el audio al kernel NUEVO → samplers y clips mudos.
    this.initPromise = null;
    this.loadedSamples.clear();
    this.sampleDurations.clear();
    this.pending = [];
  }
}
