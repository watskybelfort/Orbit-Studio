/**
 * KernelCore: el motor completo, independiente del AudioWorklet.
 * - En vivo: kernel.worklet.ts lo envuelve en un AudioWorkletProcessor.
 * - Offline/tests: se le llama process() en bucle y se recoge el audio.
 * Regla dura: CERO alocaciones dentro de process(); todo se preasigna en
 * setSnapshot()/mensajes (que corren entre bloques).
 */

import type {
  CompiledChannel,
  CompiledEffect,
  CompiledParamTarget,
  CompiledProject,
  FromKernel,
  MeterFrame,
  ToKernel,
} from './protocol';
import { createEffect, type EffectUnit } from './dsp/effects';
import { Biquad } from './dsp/filters';
import { secondsAtBeat } from './tempo';
import { Voice, createVoice, type SampleData, type VoiceContext } from './dsp/voices';

export const MAX_BLOCK = 128;

/**
 * Buffer de la grabación de pista: cuatro veces el intervalo de medidores
 * (16 bloques), margen de sobra para que un frame tardón no pierda audio.
 */
const CAPTURE_BUFFER = MAX_BLOCK * 16 * 4;

interface ActiveVoice {
  voice: Voice;
  /** Beat absoluto en que suelta la nota (Infinity = preview sostenido). */
  offBeat: number;
  /** Offset de sample dentro del bloque de arranque (se consume una vez). */
  pendingOffset: number;
  released: boolean;
  previewKey: string | null;
}

const MAX_VOICES = 64;

/** Instancia creada por la fábrica `createEffect(sampleRate)` de un plugin JS. */
interface PluginInstance {
  setParams?(params: Record<string, number>): void;
  process(l: Float32Array, r: Float32Array, n: number): void;
}

/**
 * Instancia creada por `createInstrument(sampleRate)` de un plugin JS: una por
 * nota, con la misma forma que las voces internas (suma al buffer y devuelve
 * false al terminar), así el kernel no distingue entre unas y otras.
 */
interface InstrumentInstance {
  setParams?(params: Record<string, number>): void;
  noteOn(key: number, velocity: number): void;
  noteOff(): void;
  render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean;
}

export class KernelCore {
  private project: CompiledProject | null = null;
  private samples = new Map<string, SampleData>();
  private voiceCtx: VoiceContext;

  // Buffers por pista de mixer
  private bufL: Float32Array[] = [];
  private bufR: Float32Array[] = [];
  private lastL: Float32Array[] = [];
  private lastR: Float32Array[] = [];
  private dryL = new Float32Array(MAX_BLOCK);
  private dryR = new Float32Array(MAX_BLOCK);
  private effects = new Map<string, EffectUnit>();
  /** EQ de strip por pista (se crea con los buffers, uno por pista). */
  private trackEq: StripEq[] = [];

  // Buffers de los canales que tienen efectos PROPIOS. Un canal sin cadena
  // sigue sumando directo al bus de su pista (camino rápido de siempre); solo
  // los que tienen inserts pasan por un buffer intermedio, y el pool crece
  // pero no se encoge para no realocar en cada snapshot.
  private chBufL: Float32Array[] = [];
  private chBufR: Float32Array[] = [];
  /** channelIndex → índice de buffer, o -1 si el canal entra seco. */
  private chBufOf = new Int32Array(0);
  /** Canales con cadena propia, en orden de índice. */
  private fxChannels: number[] = [];

  private voices: ActiveVoice[] = [];
  private voiceOrder = 0;

  /** Plugins JS de usuario (efectos): fábricas compiladas por pluginId. */
  private plugins = new Map<string, (sr: number) => PluginInstance>();
  /** Plugins JS de usuario (instrumentos): fábricas compiladas por pluginId. */
  private instruments = new Map<string, (sr: number) => InstrumentInstance>();
  /** Snapshot en cola (vista Live): entra al terminar el loop actual. */
  private pendingProject: CompiledProject | null = null;

  // Transport
  playing = false;
  posBeats = 0;
  private tempo = 140;
  private timeSigNum = 4;
  /** Índices de tramo actuales en los mapas de tempo/compás (avanzan solos). */
  private tempoIdx = 0;
  private meterIdx = 0;
  private loopEnabled = true;
  private loopStart = 0;
  private loopEnd = 4;
  /** true = la región de loop la marcó el usuario (y por tanto manda él). */
  private loopUserSet = false;
  metronome = false;
  private clickPhase = 0;
  private clickEnv = 0;
  private clickFreq = 1760;

  // Medición
  private peaks = new Float32Array(1);
  /** Sum-of-squares por pista ((l²+r²)/2 acumulado) para el RMS del frame. */
  private trackSumSq = new Float32Array(1);
  private masterSumSq: [number, number] = [0, 0];
  private meterSamples = 0;
  /** Orbit Scope: anillo con los últimos samples de la pista tapeada (mono). */
  private scopeEnabled = false;
  private scopeTrack = 0;
  private scopeRing = new Float32Array(2048);
  private scopePos = 0;
  /** Grabación de la salida de una pista (-1 = ninguna). */
  private captureTrack = -1;
  private captureL = new Float32Array(CAPTURE_BUFFER);
  private captureR = new Float32Array(CAPTURE_BUFFER);
  private capturePos = 0;

  constructor(public readonly sr: number) {
    // Los buffers de trabajo se crean UNA vez y los comparten todas las voces
    // (Nova los usa para saturar la suma de sus capas sin alocar por nota).
    this.voiceCtx = {
      sr,
      samples: this.samples,
      scratchL: new Float32Array(MAX_BLOCK),
      scratchR: new Float32Array(MAX_BLOCK),
    };
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  handleMessage(msg: ToKernel): void {
    switch (msg.type) {
      case 'snapshot':
        this.pendingProject = null; // un snapshot directo cancela la cola
        this.setSnapshot(msg.project);
        break;
      case 'queueSnapshot':
        // Sonando: entra al cerrar el loop (cambio cuantizado). Parado: ya.
        if (this.playing) this.pendingProject = msg.project;
        else this.applyQueued(msg.project);
        break;
      case 'registerPlugin':
      case 'registerInstrument':
        // El módulo se compila igual en los dos casos: lo que decide qué es un
        // plugin son las fábricas que exporta, no el mensaje que lo trajo.
        this.registerPlugin(msg.pluginId, msg.code);
        break;
      case 'play':
        this.posBeats = msg.fromBeat;
        this.playing = true;
        this.resyncCursor();
        this.applyMaps();
        break;
      case 'stop':
        this.playing = false;
        this.releaseAllVoices();
        break;
      case 'seek':
        this.posBeats = msg.beat;
        this.resyncCursor();
        this.applyMaps();
        // Saltar deja huérfanas las notas que estaban sonando: su note-off
        // vivía en un punto del timeline que ya no vamos a pisar.
        this.releaseSequencedVoices();
        break;
      case 'setLoop':
        this.loopEnabled = msg.enabled;
        // Solo una región marcada a mano congela los límites; al quitarla,
        // el siguiente snapshot vuelve a estirar el loop a todo el timeline.
        this.loopUserSet = msg.enabled;
        this.loopStart = msg.start;
        this.loopEnd = Math.max(msg.start + 0.25, msg.end);
        break;
      case 'setMetronome':
        this.metronome = msg.enabled;
        break;
      case 'setScope':
        this.scopeEnabled = msg.enabled;
        this.scopeTrack = msg.trackIndex ?? 0;
        break;
      case 'setTrackCapture':
        this.captureTrack = msg.enabled ? msg.trackIndex : -1;
        this.capturePos = 0;
        break;
      case 'setTempo':
        this.tempo = msg.tempo;
        if (this.project) this.project.tempo = msg.tempo;
        this.updateEffectTempos();
        break;
      case 'channelParam': {
        const ch = this.project?.channels[msg.channelIndex];
        if (ch) {
          ch.params[msg.key] = msg.value;
          this.pushInstrumentParams(msg.channelIndex);
        }
        break;
      }
      case 'channelMix': {
        const ch = this.project?.channels[msg.channelIndex];
        if (ch) {
          ch.volume = msg.volume;
          ch.pan = msg.pan;
          ch.audible = msg.audible;
        }
        break;
      }
      case 'mixerParam': {
        const t = this.project?.mixer[msg.trackIndex];
        if (t) t[msg.key] = msg.value;
        break;
      }
      case 'mixerAudible': {
        const p = this.project;
        if (p) {
          for (let i = 0; i < p.mixer.length && i < msg.audible.length; i++) {
            p.mixer[i]!.audible = msg.audible[i]!;
          }
        }
        break;
      }
      case 'effectParam': {
        const slot = this.project?.mixer[msg.trackIndex]?.slots[msg.slotIndex];
        if (slot) {
          slot.params[msg.key] = msg.value;
          this.effects.get(slot.id)?.setParams(slot.params);
        }
        break;
      }
      case 'effectState': {
        const slot = this.project?.mixer[msg.trackIndex]?.slots[msg.slotIndex];
        if (slot) {
          slot.enabled = msg.enabled;
          slot.mix = msg.mix;
        }
        break;
      }
      case 'channelEffectParam': {
        const slot = this.project?.channels[msg.channelIndex]?.fx?.[msg.slotIndex];
        if (slot) {
          slot.params[msg.key] = msg.value;
          this.effects.get(slot.id)?.setParams(slot.params);
        }
        break;
      }
      case 'channelEffectState': {
        const slot = this.project?.channels[msg.channelIndex]?.fx?.[msg.slotIndex];
        if (slot) {
          slot.enabled = msg.enabled;
          slot.mix = msg.mix;
        }
        break;
      }
      case 'loadSample':
        this.samples.set(msg.sampleId, {
          left: msg.left,
          right: msg.right,
          rate: msg.sampleRate,
        });
        break;
      case 'previewNote':
        if (msg.on) this.previewOn(msg.channelIndex, msg.key);
        else this.previewOff(msg.channelIndex, msg.key);
        break;
      case 'previewSample':
        this.previewSamplePlay(msg.sampleId, msg.gain);
        break;
    }
  }

  private setSnapshot(p: CompiledProject): void {
    this.project = p;
    this.tempo = p.tempo;
    this.timeSigNum = p.timeSigNum ?? 4;
    const n = p.mixer.length;
    if (this.bufL.length !== n) {
      this.bufL = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.bufR = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.lastL = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.lastR = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.peaks = new Float32Array(n);
      this.trackSumSq = new Float32Array(n);
      this.trackEq = Array.from({ length: n }, () => new StripEq());
    }
    // Canales con inserts propios: un buffer para cada uno. Basta con que el
    // slot EXISTA (aunque esté en bypass) para reservarle sitio, si no
    // reactivar un efecto sin recompilar se quedaría sin buffer donde sonar.
    const nCh = p.channels.length;
    if (this.chBufOf.length !== nCh) this.chBufOf = new Int32Array(nCh);
    this.chBufOf.fill(-1);
    this.fxChannels.length = 0;
    for (let i = 0; i < nCh; i++) {
      const fx = p.channels[i]!.fx;
      if (!fx || !fx.some((s) => s !== null)) continue;
      this.chBufOf[i] = this.fxChannels.length;
      this.fxChannels.push(i);
    }
    while (this.chBufL.length < this.fxChannels.length) {
      this.chBufL.push(new Float32Array(MAX_BLOCK));
      this.chBufR.push(new Float32Array(MAX_BLOCK));
    }

    // Instancias de efecto: reusar por id (conserva colas), crear nuevas, purgar.
    const alive = new Set<string>();
    const ensureUnit = (slot: CompiledEffect): void => {
      alive.add(slot.id);
      let unit = this.effects.get(slot.id);
      if (!unit) {
        unit =
          (slot.kind === 'plugin'
            ? this.makePluginUnit(slot.pluginId)
            : createEffect(slot.kind, this.sr)) ?? undefined;
        if (unit) this.effects.set(slot.id, unit);
      }
      unit?.setParams(slot.params);
      unit?.setTempo?.(this.tempo);
    };
    for (const t of p.mixer) {
      for (const slot of t.slots) if (slot) ensureUnit(slot);
    }
    for (const ci of this.fxChannels) {
      for (const slot of p.channels[ci]!.fx!) if (slot) ensureUnit(slot);
    }
    for (const id of this.effects.keys()) {
      if (!alive.has(id)) this.effects.delete(id);
    }
    // Sin región marcada por el usuario, el loop cubre TODO el timeline y lo
    // sigue cubriendo cuando crece: antes solo se reajustaba si se quedaba
    // más largo que el proyecto, así que un patrón que pasaba de 4 a 8 beats
    // seguía dando la vuelta en el 4 y solo sonaba su primera mitad.
    if (!this.loopUserSet || this.loopEnd > p.lengthBeats || this.loopEnd <= this.loopStart) {
      this.loopStart = 0;
      this.loopEnd = p.lengthBeats;
    }
    this.eventCursor = 0;
    this.resyncCursor();
    this.resetLfoState(p);
    this.applyMaps();
  }

  private updateEffectTempos(): void {
    const p = this.project;
    if (!p) return;
    for (const t of p.mixer) {
      for (const slot of t.slots) {
        if (slot) this.effects.get(slot.id)?.setTempo?.(this.tempo);
      }
    }
    for (const ci of this.fxChannels) {
      for (const slot of p.channels[ci]?.fx ?? []) {
        if (slot) this.effects.get(slot.id)?.setTempo?.(this.tempo);
      }
    }
  }

  // ── Plugins JS de usuario ─────────────────────────────────────────────────
  // El archivo del plugin define `createEffect(sampleRate)` y/o
  // `createInstrument(sampleRate)` (y opcionalmente `name`/`params`). Se
  // compila UNA vez por id; cada slot —o cada nota, en los instrumentos—
  // instancia la fábrica. Un plugin que lanza se desactiva solo (bypass),
  // nunca tira el hilo de audio.

  private registerPlugin(pluginId: string, code: string): void {
    try {
      // `typeof` sobre un identificador no declarado no lanza, así que el
      // mismo preámbulo sirve para archivos que solo traen una de las dos.
      const mod = new Function(
        `${code}\n;return {` +
          `effect: typeof createEffect === 'function' ? createEffect : null,` +
          `instrument: typeof createInstrument === 'function' ? createInstrument : null };`,
      )() as {
        effect: ((sr: number) => PluginInstance) | null;
        instrument: ((sr: number) => InstrumentInstance) | null;
      };
      let found = false;
      if (typeof mod.effect === 'function') {
        this.plugins.set(pluginId, mod.effect);
        found = true;
      }
      if (typeof mod.instrument === 'function') {
        this.instruments.set(pluginId, mod.instrument);
        found = true;
      }
      // Si el proyecto ya referencia este plugin, re-instancia sus slots (las
      // voces no hace falta: la fábrica nueva entra en la siguiente nota).
      if (found && this.project) this.setSnapshot(this.project);
    } catch {
      // Código roto: el plugin no se registra (el slot queda en bypass).
    }
  }

  private makePluginUnit(pluginId: string | undefined): EffectUnit | null {
    const factory = pluginId ? this.plugins.get(pluginId) : undefined;
    if (!factory) return null;
    let inst: PluginInstance;
    try {
      inst = factory(this.sr);
      if (!inst || typeof inst.process !== 'function') return null;
    } catch {
      return null;
    }
    let broken = false;
    return {
      setParams: (p) => {
        if (broken) return;
        try {
          inst.setParams?.(p);
        } catch {
          broken = true;
        }
      },
      process: (l, r, n) => {
        if (broken) return;
        try {
          inst.process(l, r, n);
        } catch {
          broken = true; // bypass permanente: el audio sigue limpio
          return;
        }
        // Un solo NaN/Inf de un plugin envenena PARA SIEMPRE los estados IIR de
        // los efectos que vengan detrás (biquads, delays, reverb): NaN×feedback =
        // NaN. Si la salida no es finita, se pone el bloque a cero y a bypass.
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(l[i]!) || !Number.isFinite(r[i]!)) {
            l.fill(0, 0, n);
            r.fill(0, 0, n);
            broken = true;
            break;
          }
        }
      },
    };
  }

  /** Aplica un snapshot en cola: loop completo del nuevo timeline, desde 0. */
  private applyQueued(p: CompiledProject): void {
    this.setSnapshot(p);
    this.loopStart = 0;
    this.loopEnd = p.lengthBeats;
    this.loopEnabled = true;
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  private eventCursor = 0;

  private resyncCursor(): void {
    const events = this.project?.events;
    if (!events) return;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid]!.start < this.posBeats - 1e-9) lo = mid + 1;
      else hi = mid;
    }
    this.eventCursor = lo;
  }

  /** Dispara eventos en [fromBeat, toBeat); offsets relativos a sampleBase. */
  private triggerRange(fromBeat: number, toBeat: number, sampleBase: number, spb: number): void {
    const p = this.project;
    if (!p) return;
    const events = p.events;
    while (this.eventCursor < events.length) {
      const ev = events[this.eventCursor]!;
      if (ev.start >= toBeat) break;
      this.eventCursor++;
      if (ev.start < fromBeat - 1e-9) continue;
      const ch = p.channels[ev.channelIndex];
      if (!ch || !ch.audible) continue;
      const offset = Math.min(
        MAX_BLOCK - 1,
        Math.max(0, sampleBase + Math.round((ev.start - fromBeat) / spb)),
      );
      const offBeat = ev.start + ev.duration;
      if (ev.slide) {
        // Slide: reusa la voz activa del canal (glide 808).
        const existing = this.voices.find(
          (v) => v.voice.channelIndex === ev.channelIndex && !v.released && v.previewKey === null,
        );
        if (existing) {
          existing.voice.glideTo(ev.key, ev.velocity);
          existing.offBeat = Math.max(existing.offBeat, offBeat);
          continue;
        }
      }
      this.spawnVoice(ev.channelIndex, ev.key, ev.velocity, offset, offBeat, null);
    }
  }

  private spawnVoice(
    channelIndex: number,
    key: number,
    velocity: number,
    pendingOffset: number,
    offBeat: number,
    previewKey: string | null,
  ): void {
    const p = this.project;
    if (!p) return;
    const ch = p.channels[channelIndex];
    if (!ch) return;

    // Modo de voces del canal (0 Poly, 1 Mono, 2 Legato). Los instrumentos que
    // no declaran el parámetro son polifónicos, que es como se ha comportado
    // el motor siempre. Solo se aplica entre notas programadas: una audición
    // no debe cortar lo que está sonando.
    const voiceMode = Math.round(ch.params['voiceMode'] ?? 0);
    if (voiceMode > 0 && previewKey === null) {
      const existing = this.voices.find(
        (v) => v.voice.channelIndex === channelIndex && !v.released && v.previewKey === null,
      );
      if (existing) {
        if (voiceMode === 2) {
          // Legato: la misma voz se lleva a la altura nueva sin re-atacar, así
          // que la envolvente y el filtro no vuelven a empezar.
          existing.voice.glideTo(key, velocity);
          existing.offBeat = Math.max(existing.offBeat, offBeat);
          return;
        }
        // Mono: la anterior suelta y la nueva ataca desde cero.
        existing.voice.noteOff();
        existing.released = true;
      }
    }

    if (this.voices.length >= MAX_VOICES) {
      // Roba la voz más antigua. `dispose` devuelve lo que tenga prestado de
      // un pool (las cuerdas pulsadas de Prisma): sin esto, un pasaje denso
      // agotaba el pool y las notas siguientes cambiaban de timbre.
      let oldest = 0;
      for (let i = 1; i < this.voices.length; i++) {
        if (this.voices[i]!.voice.startOrder < this.voices[oldest]!.voice.startOrder) oldest = i;
      }
      this.voices[oldest]!.voice.dispose();
      this.voices.splice(oldest, 1);
    }
    const order = this.voiceOrder++;
    const voice =
      this.makeInstrumentVoice(ch, channelIndex, key, order, velocity) ??
      createVoice(
        ch.kind, channelIndex, key, order, velocity, ch.params, this.voiceCtx,
        ch.sampleId, ch.nova, ch.prisma, ch.slicePoints,
      );
    this.voices.push({ voice, offBeat, pendingOffset, released: false, previewKey });
  }

  /**
   * Voz de plugin JS de instrumento, o null si el canal no usa ninguno, el id
   * no está registrado o la fábrica falla — en esos casos el canal cae a su
   * motor interno, la misma degradación amable que un slot con plugin ausente.
   */
  private makeInstrumentVoice(
    ch: CompiledChannel,
    channelIndex: number,
    key: number,
    order: number,
    velocity: number,
  ): Voice | null {
    const id = ch.instrumentPluginId;
    if (id === undefined) return null;
    const factory = this.instruments.get(id);
    if (!factory) return null;
    try {
      const inst = factory(this.sr);
      if (!inst || typeof inst.render !== 'function' || typeof inst.noteOn !== 'function') {
        return null;
      }
      inst.setParams?.(ch.params);
      inst.noteOn(key, velocity);
      return new PluginVoice(channelIndex, key, order, inst);
    } catch {
      return null; // el plugin revienta al nacer: suena el motor interno
    }
  }

  /**
   * Empuja los params del canal a las voces vivas de su plugin (perilla,
   * automatización o LFO sobre un canal con instrumento JS). Sale enseguida
   * para los canales normales, que son la inmensa mayoría.
   */
  private pushInstrumentParams(channelIndex: number): void {
    const ch = this.project?.channels[channelIndex];
    if (!ch || ch.instrumentPluginId === undefined) return;
    for (const v of this.voices) {
      if (v.voice.channelIndex === channelIndex && v.voice instanceof PluginVoice) {
        v.voice.setParams(ch.params);
      }
    }
  }

  private releaseAllVoices(): void {
    for (const v of this.voices) {
      if (!v.released) {
        v.voice.noteOff();
        v.released = true;
      }
    }
  }

  /**
   * Suelta lo que venía sonando del pase que se acaba de cerrar (el loop dio la
   * vuelta, o el playhead saltó). Las audiciones NO se tocan: esas las suelta
   * quien las está pulsando.
   *
   * Sin esto, una nota que termina JUSTO en el final del patrón —o que lo
   * cruza— no encontraba nunca su note-off: la comparación `posBeats >=
   * offBeat` deja de cumplirse en cuanto el playhead vuelve al principio, así
   * que la voz se quedaba sonando pase tras pase. El resultado eran dos cosas
   * que se notan enseguida: el sonido se solapa consigo mismo, y cuando el pool
   * de 64 voces se llena se roba la MÁS ANTIGUA, que es justo la primera nota
   * del patrón — parecía que se cortaba la primera y las de más adelante no.
   *
   * Soltar no es cortar: arranca la envolvente de release, así que las colas
   * largas siguen sonando como en FL.
   */
  private releaseSequencedVoices(): void {
    for (const v of this.voices) {
      if (!v.released && v.previewKey === null) {
        v.voice.noteOff();
        v.released = true;
      }
    }
  }

  private previewOn(channelIndex: number, key: number): void {
    this.spawnVoice(channelIndex, key, 0.9, 0, Infinity, `${channelIndex}:${key}`);
  }

  private previewOff(channelIndex: number, key: number): void {
    const k = `${channelIndex}:${key}`;
    for (const v of this.voices) {
      if (v.previewKey === k && !v.released) {
        v.voice.noteOff();
        v.released = true;
      }
    }
  }

  private previewSampleId: string | null = null;
  private previewSamplePos = 0;
  private previewSampleGain = 1;

  private previewSamplePlay(sampleId: string, gain: number): void {
    this.previewSampleId = this.samples.has(sampleId) ? sampleId : null;
    this.previewSamplePos = 0;
    this.previewSampleGain = gain;
  }

  /**
   * Tempo y compás del punto en el que está el transporte.
   *
   * Los marcadores pueden cambiar los dos a mitad de canción; el kernel lleva
   * un índice por mapa que avanza o retrocede desde donde estaba (buscar de
   * cero en cada bloque sería tirar trabajo, y saltar hacia atrás con un seek
   * también tiene que funcionar). Se llama ANTES de la automatización, así una
   * curva sobre el tempo sigue mandando por encima del mapa.
   */
  private applyMaps(): void {
    const p = this.project;
    if (!p) return;
    const tempoMap = p.tempoMap;
    if (tempoMap && tempoMap.length > 0) {
      let i = Math.min(this.tempoIdx, tempoMap.length - 1);
      while (i > 0 && tempoMap[i]!.beat > this.posBeats + 1e-9) i--;
      while (i + 1 < tempoMap.length && tempoMap[i + 1]!.beat <= this.posBeats + 1e-9) i++;
      this.tempoIdx = i;
      const tempo = tempoMap[i]!.tempo;
      if (tempo !== this.tempo) {
        this.tempo = tempo;
        this.updateEffectTempos();
      }
    }
    const meterMap = p.meterMap;
    if (meterMap && meterMap.length > 0) {
      let i = Math.min(this.meterIdx, meterMap.length - 1);
      while (i > 0 && meterMap[i]!.beat > this.posBeats + 1e-9) i--;
      while (i + 1 < meterMap.length && meterMap[i + 1]!.beat <= this.posBeats + 1e-9) i++;
      this.meterIdx = i;
      this.timeSigNum = meterMap[i]!.num;
    }
  }

  /**
   * Segundos absolutos del timeline hasta `beat`, integrando el mapa de tempo
   * (suma tramo a tramo). Sin mapa es `beat * 60 / tempo`. Es lo que convierte la
   * posición en beats de un clip de audio a segundos del sample: si se usa el
   * secPerBeat del tempo actual sin integrar el mapa, un cambio de tempo a mitad
   * del clip hace que la lectura del sample salte.
   */
  private secondsAtBeat(beat: number): number {
    // La cuenta vive en tempo.ts: la necesita también el recorte del export, y
    // tenerla duplicada era justo lo que hacía que allí se usara tempo plano.
    return secondsAtBeat(this.project?.tempoMap, beat, this.tempo);
  }

  // ── Automatización ────────────────────────────────────────────────────────

  private applyAutomation(): void {
    const p = this.project;
    if (!p || !this.playing) return;
    for (const a of p.automation) {
      const rel = this.posBeats - a.startBeat;
      if (rel < 0) continue;
      const idx = rel / a.step;
      const i0 = Math.floor(idx);
      if (i0 >= a.values.length) continue;
      const i1 = Math.min(a.values.length - 1, i0 + 1);
      const frac = idx - i0;
      const value = a.values[i0]! * (1 - frac) + a.values[i1]! * frac;
      const t = a.target;
      switch (t.scope) {
        case 'channelParam': {
          const ch = p.channels[t.channelIndex];
          if (ch) {
            ch.params[t.key] = value;
            this.pushInstrumentParams(t.channelIndex);
          }
          break;
        }
        case 'channelMix': {
          const ch = p.channels[t.channelIndex];
          if (ch) {
            if (t.key === 'volume') ch.volume = value;
            else ch.pan = value;
          }
          break;
        }
        case 'mixer': {
          const track = p.mixer[t.trackIndex];
          if (track) track[t.key] = value;
          break;
        }
        case 'effect': {
          const slot = p.mixer[t.trackIndex]?.slots[t.slotIndex];
          if (slot) {
            slot.params[t.key] = value;
            this.effects.get(slot.id)?.setParams(slot.params);
          }
          break;
        }
        case 'channelFx': {
          const slot = p.channels[t.channelIndex]?.fx?.[t.slotIndex];
          if (slot) {
            slot.params[t.key] = value;
            this.effects.get(slot.id)?.setParams(slot.params);
          }
          break;
        }
        case 'transport':
          if (t.key === 'tempo') this.tempo = value;
          break;
      }
    }
  }

  // ── LFOs ──────────────────────────────────────────────────────────────────
  // Un LFO NO dibuja el valor: lo hace oscilar alrededor de su base. La base
  // se re-lee sola cuando alguien externo toca el parámetro (automatización,
  // perilla, snapshot) comparando el valor actual con lo último que escribió
  // este mismo LFO — así ondula sobre la curva de automatización y sigue a la
  // perilla sin necesidad de avisos.

  /** Base normalizada por LFO (índice paralelo a project.lfos). */
  private lfoBase = new Float64Array(0);
  /** Último valor real escrito por cada LFO (para detectar cambios externos). */
  private lfoLast = new Float64Array(0);
  /** 0 mientras la base aún no se ha tomado del parámetro vivo. */
  private lfoPrimed = new Uint8Array(0);

  /** Identidad de cada LFO, para saber cuáles sobreviven a un snapshot. */
  private lfoSig: string[] = [];

  /**
   * Estado de los LFOs tras un snapshot.
   *
   * Antes esto reiniciaba TODOS en cada snapshot, y como el proyecto se
   * recompila con cada comando (también los que llegan del otro lado en
   * colaboración), bastaba con que alguien moviera una perilla para que los
   * LFOs se quedaran clavados. Ahora un LFO que no ha cambiado conserva su
   * base: solo se reinician los nuevos o los que se han tocado de verdad.
   */
  private resetLfoState(p: CompiledProject): void {
    const n = p.lfos.length;
    const sig = p.lfos.map((l) => {
      const t = l.target;
      const target =
        t.scope === 'channelParam' || t.scope === 'channelMix'
          ? `${t.scope}:${t.channelIndex}:${t.key}`
          : t.scope === 'mixer'
            ? `mixer:${t.trackIndex}:${t.key}`
            : t.scope === 'effect'
              ? `fx:${t.trackIndex}:${t.slotIndex}:${t.key}`
              : t.scope === 'channelFx'
                ? `chfx:${t.channelIndex}:${t.slotIndex}:${t.key}`
                : `transport:${t.key}`;
      return `${target}|${l.shape}|${l.rateBeats}|${l.amount}|${l.phase}`;
    });
    const oldBase = this.lfoBase;
    const oldLast = this.lfoLast;
    const oldPrimed = this.lfoPrimed;
    const oldSig = this.lfoSig;
    this.lfoBase = new Float64Array(n);
    this.lfoLast = new Float64Array(n);
    this.lfoPrimed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (i < oldSig.length && oldSig[i] === sig[i] && oldPrimed[i] === 1) {
        this.lfoBase[i] = oldBase[i]!;
        this.lfoLast[i] = oldLast[i]!;
        this.lfoPrimed[i] = 1;
      } else {
        this.lfoBase[i] = p.lfos[i]!.baseNorm;
        this.lfoLast[i] = 0;
        this.lfoPrimed[i] = 0;
      }
    }
    this.lfoSig = sig;
  }

  private readParam(t: CompiledParamTarget): number | null {
    const p = this.project;
    if (!p) return null;
    switch (t.scope) {
      case 'channelParam':
        return p.channels[t.channelIndex]?.params[t.key] ?? null;
      case 'channelMix': {
        const ch = p.channels[t.channelIndex];
        if (!ch) return null;
        return t.key === 'volume' ? ch.volume : ch.pan;
      }
      case 'mixer': {
        const track = p.mixer[t.trackIndex];
        return track ? track[t.key] : null;
      }
      case 'effect':
        return p.mixer[t.trackIndex]?.slots[t.slotIndex]?.params[t.key] ?? null;
      case 'channelFx':
        return p.channels[t.channelIndex]?.fx?.[t.slotIndex]?.params[t.key] ?? null;
      case 'transport':
        return t.key === 'tempo' ? this.tempo : 0;
    }
  }

  private writeParam(t: CompiledParamTarget, value: number): void {
    const p = this.project;
    if (!p) return;
    switch (t.scope) {
      case 'channelParam': {
        const ch = p.channels[t.channelIndex];
        if (ch) {
          ch.params[t.key] = value;
          this.pushInstrumentParams(t.channelIndex);
        }
        break;
      }
      case 'channelMix': {
        const ch = p.channels[t.channelIndex];
        if (ch) {
          if (t.key === 'volume') ch.volume = value;
          else ch.pan = value;
        }
        break;
      }
      case 'mixer': {
        const track = p.mixer[t.trackIndex];
        if (track) track[t.key] = value;
        break;
      }
      case 'effect': {
        const slot = p.mixer[t.trackIndex]?.slots[t.slotIndex];
        if (slot) {
          slot.params[t.key] = value;
          this.effects.get(slot.id)?.setParams(slot.params);
        }
        break;
      }
      case 'channelFx': {
        const slot = p.channels[t.channelIndex]?.fx?.[t.slotIndex];
        if (slot) {
          slot.params[t.key] = value;
          this.effects.get(slot.id)?.setParams(slot.params);
        }
        break;
      }
      case 'transport':
        if (t.key === 'tempo') this.tempo = value;
        break;
    }
  }

  private applyLfos(): void {
    const p = this.project;
    if (!p) return;
    for (let i = 0; i < p.lfos.length; i++) {
      const lfo = p.lfos[i]!;
      const current = this.readParam(lfo.target);
      if (current === null) continue;
      // Cambio venido de fuera (o primer bloque) → nueva base.
      if (this.lfoPrimed[i] === 0 || current !== this.lfoLast[i]) {
        this.lfoBase[i] = invertLut(lfo.lut, current);
        this.lfoPrimed[i] = 1;
      }
      const cycles = this.posBeats / lfo.rateBeats + lfo.phase;
      const norm = clamp01(this.lfoBase[i]! + lfo.amount * lfoWave(lfo.shape, cycles));
      const value = evalLut(lfo.lut, norm);
      this.writeParam(lfo.target, value);
      this.lfoLast[i] = value;
    }
  }

  // ── Proceso principal ─────────────────────────────────────────────────────

  process(outL: Float32Array, outR: Float32Array, n: number): void {
    const p = this.project;
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    if (!p) return;

    const nTracks = p.mixer.length;
    for (let t = 0; t < nTracks; t++) {
      this.bufL[t]!.fill(0, 0, n);
      this.bufR[t]!.fill(0, 0, n);
    }
    for (let c = 0; c < this.fxChannels.length; c++) {
      this.chBufL[c]!.fill(0, 0, n);
      this.chBufR[c]!.fill(0, 0, n);
    }

    // El playhead puede quedar FUERA de la región de loop sin haberse salido
    // tocando: pasar de SONG (beat 200) a PAT (loop de 16), encoger el
    // proyecto por debajo del cursor o hacer seek más allá del final. Cuando
    // pasa, la condición de envolver de más abajo (`posBeats < loopEnd`) es
    // IMPOSIBLE de cumplir: el cursor sube para siempre, no se dispara ni un
    // evento y la app se queda MUDA hasta reiniciarla. Volver al principio del
    // loop es lo que hace FL y lo único que se oye.
    if (this.playing && this.loopEnabled && this.posBeats >= this.loopEnd) {
      this.posBeats = this.loopStart;
      this.resyncCursor();
      this.releaseSequencedVoices();
    }

    this.applyMaps();
    this.applyAutomation();
    this.applyLfos();

    const spb = this.tempo / 60 / this.sr; // beats por sample
    const blockBeats = n * spb;

    // Dónde ABRIÓ el bloque y, si el loop da la vuelta dentro de él, en qué
    // muestra salta y a qué beat se reanuda. Lo que recorre el bloque muestra a
    // muestra (clips de audio y metrónomo) no puede deducirlo restando
    // `blockBeats` a `this.posBeats`: al envolver, `posBeats` ya es el beat de
    // DESPUÉS del salto y esa resta apunta a un tramo que no se ha tocado.
    const blockStartBeat = this.posBeats;
    /** Muestra en la que el loop envuelve dentro de este bloque (-1 = no lo hace). */
    let wrapAt = -1;
    /** Beat en el que se reanuda tras el salto (solo válido con `wrapAt >= 0`). */
    let wrapBeat = 0;

    if (this.playing) {
      const end = this.posBeats + blockBeats;
      if (this.loopEnabled && end > this.loopEnd && this.posBeats < this.loopEnd) {
        // El loop envuelve dentro de este bloque: dos segmentos.
        const wrapSamples = Math.round((this.loopEnd - this.posBeats) / spb);
        this.triggerRange(this.posBeats, this.loopEnd, 0, spb);
        // El pase termina aquí: lo que siguiera sonando se suelta EN el cierre.
        // Si no, nada lo suelta ya (el playhead vuelve atrás) y se acumula.
        this.releaseSequencedVoices();
        const remainBeats = end - this.loopEnd;
        // Cambio cuantizado (vista Live): el snapshot en cola entra EXACTO
        // en el cierre del loop, con precisión de sample.
        if (this.pendingProject) {
          this.applyQueued(this.pendingProject);
          this.pendingProject = null;
          this.releaseAllVoices();
        }
        this.posBeats = this.loopStart;
        this.resyncCursor();
        this.triggerRange(this.loopStart, this.loopStart + remainBeats, wrapSamples, spb);
        this.posBeats = this.loopStart + remainBeats;
        // Se apunta DESPUÉS del snapshot en cola: `applyQueued` puede haber
        // movido `loopStart`, y lo que vale es de dónde se reanuda de verdad.
        wrapAt = Math.min(n, Math.max(0, wrapSamples));
        wrapBeat = this.loopStart;
      } else {
        this.triggerRange(this.posBeats, end, 0, spb);
        this.posBeats = end;
        if (!this.loopEnabled && this.posBeats >= p.lengthBeats) {
          this.playing = false;
          this.releaseAllVoices();
        }
      }
      // Note-off por duración (granularidad de bloque).
      for (const v of this.voices) {
        if (!v.released && this.posBeats >= v.offBeat) {
          v.voice.noteOff();
          v.released = true;
        }
      }
    }

    // Voces → buffer del canal (si tiene inserts) o directo al bus de pista.
    // Con cadena propia las voces se renderizan a ganancia unidad y el
    // volumen/pan del canal se aplica DESPUÉS de los efectos: el fader del
    // canal manda sobre su cadena, no dentro de ella.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const av = this.voices[i]!;
      const chIndex = av.voice.channelIndex;
      const ch = p.channels[chIndex];
      if (!ch) {
        av.voice.dispose();
        this.voices.splice(i, 1);
        continue;
      }
      const slot = this.chBufOf[chIndex] ?? -1;
      const from = av.pendingOffset;
      av.pendingOffset = 0;
      let alive: boolean;
      if (slot >= 0) {
        alive = av.voice.render(this.chBufL[slot]!, this.chBufR[slot]!, from, n, 1, 1);
      } else {
        const track = Math.min(nTracks - 1, Math.max(0, ch.mixerTrack));
        const pan = ch.pan;
        // Mute del canal: la voz sigue viva (y su envolvente avanza) pero no
        // llega nada al bus, igual que hace el mixer con una pista muteada.
        // Antes solo se miraba `audible` al lanzar notas nuevas, así que
        // silenciar un canal dejaba sonando lo que ya estaba sonando.
        const vol = ch.audible ? ch.volume : 0;
        const gainL = vol * Math.cos(((pan + 1) / 4) * Math.PI) * 1.414;
        const gainR = vol * Math.sin(((pan + 1) / 4) * Math.PI) * 1.414;
        alive = av.voice.render(this.bufL[track]!, this.bufR[track]!, from, n, gainL, gainR);
      }
      if (!alive) {
        av.voice.dispose();
        this.voices.splice(i, 1);
      }
    }

    // Cadena de inserts de cada canal → bus de su pista.
    for (let c = 0; c < this.fxChannels.length; c++) {
      const chIndex = this.fxChannels[c]!;
      const ch = p.channels[chIndex];
      if (!ch) continue;
      // Canal muteado: ni se procesa la cadena ni se suma nada. Sin esto, un
      // insert que se inventa señal (vinyl, ruido, un delay con cola) seguía
      // metiendo audio en la pista con el canal silenciado.
      if (!ch.audible) continue;
      const bl = this.chBufL[c]!;
      const br = this.chBufR[c]!;
      const slots = ch.fx;
      if (slots) {
        for (let s = 0; s < slots.length; s++) {
          const slot = slots[s];
          if (!slot || !slot.enabled) continue;
          const unit = this.effects.get(slot.id);
          if (!unit) continue;
          const mix = slot.mix;
          const useDry = mix < 0.999;
          if (useDry) {
            this.dryL.set(bl.subarray(0, n));
            this.dryR.set(br.subarray(0, n));
          }
          const scIdx = slot.sidechainSource;
          const scL = scIdx !== undefined ? this.lastL[scIdx] ?? null : null;
          const scR = scIdx !== undefined ? this.lastR[scIdx] ?? null : null;
          unit.process(bl, br, n, scL, scR);
          if (useDry) {
            for (let i = 0; i < n; i++) {
              bl[i] = this.dryL[i]! * (1 - mix) + bl[i]! * mix;
              br[i] = this.dryR[i]! * (1 - mix) + br[i]! * mix;
            }
          }
        }
      }
      const track = Math.min(nTracks - 1, Math.max(0, ch.mixerTrack));
      const dl = this.bufL[track]!;
      const dr = this.bufR[track]!;
      const pan = ch.pan;
      const gainL = ch.volume * Math.cos(((pan + 1) / 4) * Math.PI) * 1.414;
      const gainR = ch.volume * Math.sin(((pan + 1) / 4) * Math.PI) * 1.414;
      for (let i = 0; i < n; i++) {
        dl[i]! += bl[i]! * gainL;
        dr[i]! += br[i]! * gainR;
      }
    }

    // Clips de audio (posición determinista desde el timeline)
    if (this.playing) {
      // Segundos del timeline en el arranque de CADA tramo, integrando el mapa
      // de tempo. Dentro del bloque el tempo es constante, así que a partir de
      // aquí el avance del sample es tiempo real (i / sr) y no salta si un
      // marcador cambia el tempo a mitad del clip.
      const preStartSec = this.secondsAtBeat(blockStartBeat);
      const postStartSec = wrapAt >= 0 ? this.secondsAtBeat(wrapBeat) : 0;
      const preCount = wrapAt >= 0 ? wrapAt : n;
      const postCount = wrapAt >= 0 ? n - wrapAt : 0;
      for (const clip of p.audioClips) {
        // Con el loop envuelto el bloque cubre DOS ventanas de beats disjuntas:
        // el clip entra si toca cualquiera de las dos.
        const clipEnd = clip.start + clip.length;
        const preHits =
          preCount > 0 && blockStartBeat + preCount * spb > clip.start && blockStartBeat < clipEnd;
        const postHits =
          postCount > 0 && wrapBeat + postCount * spb > clip.start && wrapBeat < clipEnd;
        if (!preHits && !postHits) continue;
        const data = this.samples.get(clip.sampleId);
        if (!data) continue;
        const track = Math.min(nTracks - 1, Math.max(0, clip.mixerTrack));
        const bl = this.bufL[track]!;
        const br = this.bufR[track]!;

        // Time-stretch SOLA: dos grains solapados con crossfade triangular,
        // leídos a velocidad natural (pitch intacto) pero re-posicionados para
        // que el sample llene exactamente la longitud del clip. Sin stretch ni
        // pitch, lectura directa como siempre. Cero alocaciones en los dos
        // caminos: todo son escalares.
        const clipStartSec = this.secondsAtBeat(clip.start);
        const srcSec = data.left.length / data.rate - clip.offset;
        const clipSec = this.secondsAtBeat(clip.start + clip.length) - clipStartSec;
        const doStretch = clip.stretch && srcSec > 0.01 && clipSec > 0.01;
        // Pitch-shift = resample + stretch inverso, con el MISMO motor de
        // grains: `speed` es lo rápido que se lee DENTRO del grain (eso sube o
        // baja el tono y de paso acortaría el clip) y `ratio` lo rápido que
        // avanzan los arranques de grain (eso devuelve la duración a su sitio).
        // Separando las dos velocidades el tono y el tiempo dejan de ir atados.
        const semitones = clip.pitch ?? 0;
        const speed = semitones === 0 ? 1 : Math.pow(2, semitones / 12);
        const useGrains = doStretch || speed !== 1;
        // Avance de la fuente por sample de salida: con stretch, el que haga
        // falta para llenar el clip; sin él, tiempo natural (1).
        const ratio = doStretch ? srcSec / clipSec : 1;
        const hop = Math.max(64, Math.round(0.022 * this.sr)); // medio grain ~22 ms
        const fadeIn = clip.fadeIn ?? 0;
        const fadeOut = clip.fadeOut ?? 0;
        const fadeOutFrom = clip.length - fadeOut;
        const natRate = data.rate / this.sr;
        const srcBase = clip.offset * data.rate;
        const lastIdx = data.left.length - 1;

        for (let i = 0; i < n; i++) {
          // Tras el salto, el sample `i` NO continúa al anterior en el timeline:
          // se reanuda en `wrapBeat`. Sin este tramo aparte, cada vuelta del
          // loop se comía las muestras que quedaban por delante del salto.
          const wrapped = wrapAt >= 0 && i >= wrapAt;
          const segFrom = wrapped ? i - wrapAt : i;
          const beatAt = (wrapped ? wrapBeat : blockStartBeat) + segFrom * spb - clip.start;
          if (beatAt < 0 || beatAt >= clip.length) continue;
          // Segundos reales desde el arranque del clip: lo acumulado hasta el
          // inicio del TRAMO (del mapa de tempo) más el avance dentro del tramo
          // a tiempo real. Sustituye a beatAt × secPerBeat, que saltaba al tempo.
          const elapsedSec =
            (wrapped ? postStartSec : preStartSec) - clipStartSec + segFrom / this.sr;
          let l = 0;
          let r = 0;
          if (useGrains) {
            const tOut = elapsedSec * this.sr;
            const g = Math.floor(tOut / hop);
            const inGrain = tOut - g * hop;
            // Grain g (sube 0→1) + grain g-1 (baja 1→0); en el arranque solo g.
            const w = g === 0 ? 1 : inGrain / hop;
            const posA = srcBase + (g * hop * ratio + inGrain * speed) * natRate;
            const idxA = Math.floor(posA);
            if (idxA >= 0 && idxA < lastIdx) {
              const fA = posA - idxA;
              l += (data.left[idxA]! * (1 - fA) + data.left[idxA + 1]! * fA) * w;
              r += (data.right[idxA]! * (1 - fA) + data.right[idxA + 1]! * fA) * w;
            }
            if (g > 0 && w < 1) {
              const posB = srcBase + ((g - 1) * hop * ratio + (inGrain + hop) * speed) * natRate;
              const idxB = Math.floor(posB);
              if (idxB >= 0 && idxB < lastIdx) {
                const fB = posB - idxB;
                l += (data.left[idxB]! * (1 - fB) + data.left[idxB + 1]! * fB) * (1 - w);
                r += (data.right[idxB]! * (1 - fB) + data.right[idxB + 1]! * fB) * (1 - w);
              }
            }
          } else {
            const srcPos = (clip.offset + elapsedSec) * data.rate;
            const idx = Math.floor(srcPos);
            if (idx < 0 || idx >= lastIdx) continue;
            const frac = srcPos - idx;
            l = data.left[idx]! * (1 - frac) + data.left[idx + 1]! * frac;
            r = data.right[idx]! * (1 - frac) + data.right[idx + 1]! * frac;
          }
          // Fundidos del clip: rampa lineal en amplitud, exactamente la recta
          // que dibuja la playlist. El compilador ya los acotó a la longitud,
          // así que aquí solo se evalúan.
          let fade = 1;
          if (fadeIn > 0 && beatAt < fadeIn) fade = beatAt / fadeIn;
          if (fadeOut > 0 && beatAt > fadeOutFrom) {
            const f = (clip.length - beatAt) / fadeOut;
            if (f < fade) fade = f;
          }
          const g = clip.gain * (fade < 0 ? 0 : fade);
          bl[i]! += l * g;
          br[i]! += r * g;
        }
      }
    }

    // Preview de sample del browser (a master)
    if (this.previewSampleId) {
      const data = this.samples.get(this.previewSampleId);
      if (data) {
        const bl = this.bufL[0]!;
        const br = this.bufR[0]!;
        const rate = data.rate / this.sr;
        for (let i = 0; i < n; i++) {
          const idx = Math.floor(this.previewSamplePos);
          if (idx >= data.left.length - 1) {
            this.previewSampleId = null;
            break;
          }
          const frac = this.previewSamplePos - idx;
          bl[i]! += (data.left[idx]! * (1 - frac) + data.left[idx + 1]! * frac) * this.previewSampleGain;
          br[i]! += (data.right[idx]! * (1 - frac) + data.right[idx + 1]! * frac) * this.previewSampleGain;
          this.previewSamplePos += rate;
        }
      }
    }

    // Metrónomo: dispara cuando un beat ENTERO cae dentro de la ventana de un
    // sample [b, b+spb). (La versión anterior exigía nearest > round(startBeat),
    // que con bloques de 128 samples nunca se cumplía: no sonaba jamás.)
    if (this.metronome && this.playing) {
      const beatsPerBar = Math.max(1, this.timeSigNum);
      for (let i = 0; i < n; i++) {
        // Mismo troceado que los clips: pasada la vuelta del loop, el resto del
        // bloque cuenta beats desde `wrapBeat` y no desde el arranque.
        const wrapped = wrapAt >= 0 && i >= wrapAt;
        const b = (wrapped ? wrapBeat : blockStartBeat) + (wrapped ? i - wrapAt : i) * spb;
        const beatIdx = Math.ceil(b - 1e-9);
        if (beatIdx >= 0 && beatIdx < b + spb - 1e-9) {
          // Flanco de beat: click (agudo y más fuerte en el 1 del compás).
          this.clickEnv = 1;
          this.clickPhase = 0;
          this.clickFreq = beatIdx % beatsPerBar === 0 ? 1760 : 1175;
        }
        if (this.clickEnv > 0.001) {
          this.clickPhase += this.clickFreq / this.sr;
          if (this.clickPhase >= 1) this.clickPhase -= 1;
          const s = Math.sin(2 * Math.PI * this.clickPhase) * this.clickEnv * 0.5;
          this.bufL[0]![i]! += s;
          this.bufR[0]![i]! += s;
          this.clickEnv *= Math.exp(-1 / (0.02 * this.sr));
        }
      }
    }

    // Cadena de mixer en orden topológico
    for (const t of p.mixerOrder) {
      const track = p.mixer[t]!;
      const bl = this.bufL[t]!;
      const br = this.bufR[t]!;

      if (!track.audible) {
        bl.fill(0, 0, n);
        br.fill(0, 0, n);
      } else {
        // Slots de efectos
        for (let s = 0; s < track.slots.length; s++) {
          const slot = track.slots[s];
          if (!slot || !slot.enabled) continue;
          const unit = this.effects.get(slot.id);
          if (!unit) continue;
          const mix = slot.mix;
          const useDry = mix < 0.999;
          if (useDry) {
            this.dryL.set(bl.subarray(0, n));
            this.dryR.set(br.subarray(0, n));
          }
          const scIdx = slot.sidechainSource;
          const scL = scIdx !== undefined ? this.lastL[scIdx] ?? null : null;
          const scR = scIdx !== undefined ? this.lastR[scIdx] ?? null : null;
          unit.process(bl, br, n, scL, scR);
          if (useDry) {
            for (let i = 0; i < n; i++) {
              bl[i] = this.dryL[i]! * (1 - mix) + bl[i]! * mix;
              br[i] = this.dryR[i]! * (1 - mix) + br[i]! * mix;
            }
          }
        }
        // EQ del strip (post-efectos, pre-fader). Plano = ni se toca el audio:
        // los coeficientes solo se recalculan cuando cambian las ganancias.
        const eq = this.trackEq[t];
        if (eq && (track.eqLow !== 0 || track.eqMid !== 0 || track.eqHigh !== 0)) {
          eq.update(track.eqLow, track.eqMid, track.eqHigh, this.sr);
          eq.process(bl, br, n);
        }

        // Width / pan / volumen
        const width = track.stereoWidth;
        const pan = track.pan;
        const vol = track.volume;
        const pgL = Math.cos(((pan + 1) / 4) * Math.PI) * 1.414;
        const pgR = Math.sin(((pan + 1) / 4) * Math.PI) * 1.414;
        for (let i = 0; i < n; i++) {
          let l = bl[i]!;
          let r = br[i]!;
          if (width !== 1) {
            const mid = (l + r) * 0.5;
            const side = (l - r) * 0.5 * width;
            l = mid + side;
            r = mid - side;
          }
          bl[i] = l * vol * pgL;
          br[i] = r * vol * pgR;
        }
      }

      // Copia post-fader para detectores sidechain del siguiente bloque
      this.lastL[t]!.set(bl.subarray(0, n));
      this.lastR[t]!.set(br.subarray(0, n));

      // Medidores: peak con decay visual + sum-of-squares para el RMS por pista
      let peak = this.peaks[t]! * 0.85; // decay visual
      let sumSq = this.trackSumSq[t]!;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(bl[i]!);
        const b = Math.abs(br[i]!);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
        sumSq += (bl[i]! * bl[i]! + br[i]! * br[i]!) * 0.5;
      }
      this.peaks[t] = peak;
      this.trackSumSq[t] = sumSq;

      // Tap del Orbit Scope: copia post-fader de la pista elegida (0 = master)
      if (this.scopeEnabled && t === this.scopeTrack) {
        for (let i = 0; i < n; i++) {
          this.scopeRing[this.scopePos] = (bl[i]! + br[i]!) * 0.5;
          this.scopePos = (this.scopePos + 1) & 2047;
        }
      }

      // Grabación de la salida de una pista: se acumula post-fader y viaja
      // entero en el siguiente frame de medidores (nada se pierde si la UI
      // tarda: el buffer cubre justo el intervalo del frame).
      if (t === this.captureTrack && this.capturePos + n <= this.captureL.length) {
        this.captureL.set(bl.subarray(0, n), this.capturePos);
        this.captureR.set(br.subarray(0, n), this.capturePos);
        this.capturePos += n;
      }

      if (t === 0) {
        // Master → salida
        for (let i = 0; i < n; i++) {
          outL[i] = bl[i]!;
          outR[i] = br[i]!;
          this.masterSumSq[0] += bl[i]! * bl[i]!;
          this.masterSumSq[1] += br[i]! * br[i]!;
        }
        this.meterSamples += n;
      } else if (track.routeTo !== null) {
        const dl = this.bufL[track.routeTo]!;
        const dr = this.bufR[track.routeTo]!;
        for (let i = 0; i < n; i++) {
          dl[i]! += bl[i]!;
          dr[i]! += br[i]!;
        }
      }
      for (const send of track.sends) {
        const dl = this.bufL[send.target];
        const dr = this.bufR[send.target];
        if (!dl || !dr) continue;
        for (let i = 0; i < n; i++) {
          dl[i]! += bl[i]! * send.level;
          dr[i]! += br[i]! * send.level;
        }
      }
    }
  }

  meterFrame(cpu = 0): MeterFrame {
    const ms = Math.max(1, this.meterSamples);
    // RMS por pista: emitir aloca (como peaks.slice()); los acumuladores se resetean.
    const rms = new Float32Array(this.trackSumSq.length);
    for (let i = 0; i < rms.length; i++) rms[i] = Math.sqrt(this.trackSumSq[i]! / ms);
    const frame: MeterFrame = {
      peaks: this.peaks.slice(),
      rms,
      masterRms: [
        Math.sqrt(this.masterSumSq[0] / ms),
        Math.sqrt(this.masterSumSq[1] / ms),
      ],
      positionBeats: this.posBeats,
      playing: this.playing,
      cpu,
    };
    // Teclas que suenan. Solo las voces SIN soltar: una nota en release sigue
    // sonando un rato, pero su tecla ya no está pulsada y debe apagarse. El
    // dato viaja empaquetado (canal<<8 | key) para no alocar un objeto por voz
    // en cada frame de medidores.
    let sounding = 0;
    for (const v of this.voices) if (!v.released) sounding++;
    if (sounding > 0) {
      const notes = new Uint16Array(sounding);
      let n = 0;
      for (const v of this.voices) {
        if (v.released) continue;
        const ch = v.voice.channelIndex;
        const key = Math.round(v.voice.key);
        // Empaquetado de 8+8 bits: lo que no cabe se descarta en vez de
        // encender la tecla de otro canal.
        if (ch < 0 || ch > 255 || key < 0 || key > 255) continue;
        notes[n++] = (ch << 8) | key;
      }
      if (n > 0) frame.notes = n === sounding ? notes : notes.slice(0, n);
    }
    if (this.scopeEnabled) {
      // Copia ordenada del anillo (lo más antiguo primero).
      const scope = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) scope[i] = this.scopeRing[(this.scopePos + i) & 2047]!;
      frame.scope = scope;
    }
    if (this.captureTrack >= 0 && this.capturePos > 0) {
      // Lo grabado desde el frame anterior, en bruto (la UI lo concatena).
      frame.captureL = this.captureL.slice(0, this.capturePos);
      frame.captureR = this.captureR.slice(0, this.capturePos);
      this.capturePos = 0;
    }
    this.masterSumSq[0] = 0;
    this.masterSumSq[1] = 0;
    this.trackSumSq.fill(0);
    this.meterSamples = 0;
    return frame;
  }

  /**
   * Suelta lo que las voces tengan prestado y las descarta.
   *
   * En vivo el kernel no muere nunca, pero el render offline crea uno por
   * export y lo tira al acabar — con voces todavía sonando la cola. Como el
   * pool de líneas de cuerda pulsada de Prisma es de módulo (compartido por
   * todos los kernels del proceso), un solo export lo dejaba a cero PARA
   * SIEMPRE: a partir de ahí las capas `pluck` caían al oscilador de tabla y
   * el proyecto sonaba distinto según cuántas veces hubieras exportado.
   */
  dispose(): void {
    for (const v of this.voices) v.voice.dispose();
    this.voices.length = 0;
    this.effects.clear();
  }
}

export type { FromKernel };

// ── Voz de plugin JS de instrumento ──────────────────────────────────────────

/**
 * Envuelve una instancia de `createInstrument(sampleRate)` como una voz más.
 * Cualquier excepción del código de usuario la deja muda PARA SIEMPRE y la da
 * por terminada (el kernel la recicla en el acto): el bloque se sigue
 * renderizando y el resto de la mezcla ni se entera, igual que el bypass de
 * los efectos.
 */
class PluginVoice extends Voice {
  private broken = false;

  constructor(
    channelIndex: number,
    key: number,
    order: number,
    private readonly inst: InstrumentInstance,
  ) {
    super(channelIndex, key, order);
  }

  setParams(params: Record<string, number>): void {
    if (this.broken) return;
    try {
      this.inst.setParams?.(params);
    } catch {
      this.broken = true;
    }
  }

  noteOff(): void {
    this.releasing = true;
    if (this.broken) return;
    try {
      this.inst.noteOff();
    } catch {
      this.broken = true;
    }
  }

  /** Slide: sin API de glide en el contrato, lo más cercano es re-atacar. */
  override glideTo(key: number, velocity: number): void {
    super.glideTo(key, velocity);
    if (this.broken) return;
    try {
      this.inst.noteOn(key, velocity);
    } catch {
      this.broken = true;
    }
  }

  render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean {
    if (this.broken) return false;
    try {
      // Solo un `false` explícito mata la voz; si el plugin se olvida de
      // devolver nada se queda viva hasta que el robo de voces la recicle.
      return this.inst.render(outL, outR, from, to, gainL, gainR) !== false;
    } catch {
      this.broken = true;
      return false;
    }
  }
}

// ── EQ de strip ──────────────────────────────────────────────────────────────

/** Frecuencias fijas del EQ rápido de pista (shelf · campana · shelf). */
const EQ_LOW_HZ = 120;
const EQ_MID_HZ = 1000;
const EQ_MID_Q = 0.9;
const EQ_HIGH_HZ = 6000;

/**
 * EQ de 3 bandas por pista: dos shelves y una campana, en estéreo. Los
 * coeficientes se recalculan SOLO cuando cambia alguna ganancia (moverlos por
 * bloque con un LFO encima costaría más que filtrar).
 */
class StripEq {
  private lowL = new Biquad();
  private lowR = new Biquad();
  private midL = new Biquad();
  private midR = new Biquad();
  private highL = new Biquad();
  private highR = new Biquad();
  private low = NaN;
  private mid = NaN;
  private high = NaN;

  update(low: number, mid: number, high: number, sr: number): void {
    if (low === this.low && mid === this.mid && high === this.high) return;
    this.low = low;
    this.mid = mid;
    this.high = high;
    this.lowL.lowShelf(EQ_LOW_HZ, low, sr);
    this.lowR.copyFrom(this.lowL);
    this.midL.peaking(EQ_MID_HZ, mid, EQ_MID_Q, sr);
    this.midR.copyFrom(this.midL);
    this.highL.highShelf(EQ_HIGH_HZ, high, sr);
    this.highR.copyFrom(this.highL);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      l[i] = this.highL.tick(this.midL.tick(this.lowL.tick(l[i]!)));
      r[i] = this.highR.tick(this.midR.tick(this.lowR.tick(r[i]!)));
    }
  }
}

// ── Matemáticas de los LFOs ──────────────────────────────────────────────────

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Oscilador bipolar -1..1. Todas las formas arrancan en 0 subiendo (salvo la
 * cuadrada, que arranca arriba, y S&H, que es escalonada) para que cambiar de
 * forma no salte de valor.
 */
export function lfoWave(shape: number, cycles: number): number {
  const ph = cycles - Math.floor(cycles);
  switch (shape) {
    case 1: // triángulo
      return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 2: // sierra ascendente
      return 2 * ph - 1;
    case 3: // cuadrada
      return ph < 0.5 ? 1 : -1;
    case 4: // sample & hold (determinista por ciclo)
      return hashUnit(Math.floor(cycles)) * 2 - 1;
    default: // seno
      return Math.sin(2 * Math.PI * ph);
  }
}

/** Ruido reproducible 0..1 a partir de un entero (S&H sin estado). */
function hashUnit(n: number): number {
  let x = Math.imul(n | 0, 1103515245) + 12345;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x / 4294967295;
}

/** LUT norm→valor real con interpolación lineal (norm ya viene en 0..1). */
export function evalLut(lut: Float32Array, norm: number): number {
  const last = lut.length - 1;
  const x = clamp01(norm) * last;
  const i = Math.min(last - 1, Math.floor(x));
  const f = x - i;
  return lut[i]! * (1 - f) + lut[i + 1]! * f;
}

/**
 * Inversa de `evalLut`: valor real → norm 0..1. La LUT es monótona (todas las
 * curvas de parámetro lo son), así que basta una búsqueda binaria.
 */
export function invertLut(lut: Float32Array, value: number): number {
  const last = lut.length - 1;
  const lo = lut[0]!;
  const hi = lut[last]!;
  const asc = hi >= lo;
  if (asc ? value <= lo : value >= lo) return 0;
  if (asc ? value >= hi : value <= hi) return 1;
  let a = 0;
  let b = last;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    const v = lut[mid]!;
    if (asc ? v <= value : v >= value) a = mid;
    else b = mid;
  }
  const va = lut[a]!;
  const vb = lut[b]!;
  const span = vb - va;
  const f = span === 0 ? 0 : (value - va) / span;
  return (a + f) / last;
}
