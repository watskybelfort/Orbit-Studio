/**
 * KernelCore: el motor completo, independiente del AudioWorklet.
 * - En vivo: kernel.worklet.ts lo envuelve en un AudioWorkletProcessor.
 * - Offline/tests: se le llama process() en bucle y se recoge el audio.
 * Regla dura: CERO alocaciones dentro de process(); todo se preasigna en
 * setSnapshot()/mensajes (que corren entre bloques).
 */

import type {
  CompiledParamTarget,
  CompiledProject,
  FromKernel,
  MeterFrame,
  ToKernel,
} from './protocol';
import { createEffect, type EffectUnit } from './dsp/effects';
import { Biquad } from './dsp/filters';
import { createVoice, type SampleData, type Voice, type VoiceContext } from './dsp/voices';

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

  private voices: ActiveVoice[] = [];
  private voiceOrder = 0;

  /** Plugins JS de usuario: fábricas compiladas por pluginId. */
  private plugins = new Map<string, (sr: number) => PluginInstance>();
  /** Snapshot en cola (vista Live): entra al terminar el loop actual. */
  private pendingProject: CompiledProject | null = null;

  // Transport
  playing = false;
  posBeats = 0;
  private tempo = 140;
  private timeSigNum = 4;
  private loopEnabled = true;
  private loopStart = 0;
  private loopEnd = 4;
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
    // (Flux los usa para saturar la suma de sus capas sin alocar por nota).
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
        this.registerPlugin(msg.pluginId, msg.code);
        break;
      case 'play':
        this.posBeats = msg.fromBeat;
        this.playing = true;
        this.resyncCursor();
        break;
      case 'stop':
        this.playing = false;
        this.releaseAllVoices();
        break;
      case 'seek':
        this.posBeats = msg.beat;
        this.resyncCursor();
        break;
      case 'setLoop':
        this.loopEnabled = msg.enabled;
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
        if (ch) ch.params[msg.key] = msg.value;
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
    // Instancias de efecto: reusar por id (conserva colas), crear nuevas, purgar.
    const alive = new Set<string>();
    for (const t of p.mixer) {
      for (const slot of t.slots) {
        if (!slot) continue;
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
      }
    }
    for (const id of this.effects.keys()) {
      if (!alive.has(id)) this.effects.delete(id);
    }
    // Por defecto el loop cubre el timeline.
    if (this.loopEnd > p.lengthBeats || this.loopEnd <= this.loopStart) {
      this.loopStart = 0;
      this.loopEnd = p.lengthBeats;
    }
    this.eventCursor = 0;
    this.resyncCursor();
    this.resetLfoState(p);
  }

  private updateEffectTempos(): void {
    const p = this.project;
    if (!p) return;
    for (const t of p.mixer) {
      for (const slot of t.slots) {
        if (slot) this.effects.get(slot.id)?.setTempo?.(this.tempo);
      }
    }
  }

  // ── Plugins JS de usuario ─────────────────────────────────────────────────
  // El archivo del plugin define `createEffect(sampleRate)` (y opcionalmente
  // `name`/`params`). Se compila UNA vez por id; cada slot instancia la
  // fábrica. Un plugin que lanza se desactiva solo (bypass), nunca tira el
  // hilo de audio.

  private registerPlugin(pluginId: string, code: string): void {
    try {
      const factory = new Function(
        `${code}\n;return typeof createEffect === 'function' ? createEffect : null;`,
      )() as ((sr: number) => PluginInstance) | null;
      if (typeof factory !== 'function') return;
      this.plugins.set(pluginId, factory);
      // Si el proyecto ya referencia este plugin, re-instancia sus slots.
      if (this.project) this.setSnapshot(this.project);
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
    if (this.voices.length >= MAX_VOICES) {
      // Roba la voz más antigua.
      let oldest = 0;
      for (let i = 1; i < this.voices.length; i++) {
        if (this.voices[i]!.voice.startOrder < this.voices[oldest]!.voice.startOrder) oldest = i;
      }
      this.voices.splice(oldest, 1);
    }
    const voice = createVoice(
      ch.kind, channelIndex, key, this.voiceOrder++, velocity, ch.params, this.voiceCtx,
      ch.sampleId, ch.flux,
    );
    this.voices.push({ voice, offBeat, pendingOffset, released: false, previewKey });
  }

  private releaseAllVoices(): void {
    for (const v of this.voices) {
      if (!v.released) {
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
          if (ch) ch.params[t.key] = value;
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

  private resetLfoState(p: CompiledProject): void {
    const n = p.lfos.length;
    if (this.lfoBase.length !== n) {
      this.lfoBase = new Float64Array(n);
      this.lfoLast = new Float64Array(n);
      this.lfoPrimed = new Uint8Array(n);
    }
    for (let i = 0; i < n; i++) {
      this.lfoBase[i] = p.lfos[i]!.baseNorm;
      this.lfoLast[i] = 0;
      this.lfoPrimed[i] = 0;
    }
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
        if (ch) ch.params[t.key] = value;
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

    this.applyAutomation();
    this.applyLfos();

    const spb = this.tempo / 60 / this.sr; // beats por sample
    const blockBeats = n * spb;

    if (this.playing) {
      const end = this.posBeats + blockBeats;
      if (this.loopEnabled && end > this.loopEnd && this.posBeats < this.loopEnd) {
        // El loop envuelve dentro de este bloque: dos segmentos.
        const wrapSamples = Math.round((this.loopEnd - this.posBeats) / spb);
        this.triggerRange(this.posBeats, this.loopEnd, 0, spb);
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

    // Voces → buffers de pista
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const av = this.voices[i]!;
      const ch = p.channels[av.voice.channelIndex];
      if (!ch) {
        this.voices.splice(i, 1);
        continue;
      }
      const track = Math.min(nTracks - 1, Math.max(0, ch.mixerTrack));
      const pan = ch.pan;
      const gainL = ch.volume * Math.cos(((pan + 1) / 4) * Math.PI) * 1.414;
      const gainR = ch.volume * Math.sin(((pan + 1) / 4) * Math.PI) * 1.414;
      const from = av.pendingOffset;
      av.pendingOffset = 0;
      const alive = av.voice.render(this.bufL[track]!, this.bufR[track]!, from, n, gainL, gainR);
      if (!alive) this.voices.splice(i, 1);
    }

    // Clips de audio (posición determinista desde el timeline)
    if (this.playing) {
      const secPerBeat = 60 / this.tempo;
      for (const clip of p.audioClips) {
        const relBeat = this.posBeats - blockBeats - clip.start;
        const endRel = relBeat + blockBeats;
        if (endRel <= 0 || relBeat >= clip.length) continue;
        const data = this.samples.get(clip.sampleId);
        if (!data) continue;
        const track = Math.min(nTracks - 1, Math.max(0, clip.mixerTrack));
        const bl = this.bufL[track]!;
        const br = this.bufR[track]!;

        // Time-stretch SOLA: dos grains solapados con crossfade triangular,
        // leídos a velocidad natural (pitch intacto) pero re-posicionados para
        // que el sample llene exactamente la longitud del clip. Sin stretch,
        // lectura directa como siempre. Cero alocaciones en ambos caminos.
        const srcSec = data.left.length / data.rate - clip.offset;
        const clipSec = clip.length * secPerBeat;
        const doStretch = clip.stretch && srcSec > 0.01 && clipSec > 0.01;
        const ratio = srcSec / clipSec; // avance de la fuente por sample de salida
        const hop = Math.max(64, Math.round(0.022 * this.sr)); // medio grain ~22 ms
        const natRate = data.rate / this.sr;
        const srcBase = clip.offset * data.rate;
        const lastIdx = data.left.length - 1;

        for (let i = 0; i < n; i++) {
          const beatAt = relBeat + i * spb;
          if (beatAt < 0 || beatAt >= clip.length) continue;
          let l = 0;
          let r = 0;
          if (doStretch) {
            const tOut = beatAt * secPerBeat * this.sr;
            const g = Math.floor(tOut / hop);
            const inGrain = tOut - g * hop;
            // Grain g (sube 0→1) + grain g-1 (baja 1→0); en el arranque solo g.
            const w = g === 0 ? 1 : inGrain / hop;
            const posA = srcBase + (g * hop * ratio + inGrain) * natRate;
            const idxA = Math.floor(posA);
            if (idxA >= 0 && idxA < lastIdx) {
              const fA = posA - idxA;
              l += (data.left[idxA]! * (1 - fA) + data.left[idxA + 1]! * fA) * w;
              r += (data.right[idxA]! * (1 - fA) + data.right[idxA + 1]! * fA) * w;
            }
            if (g > 0 && w < 1) {
              const posB = srcBase + ((g - 1) * hop * ratio + inGrain + hop) * natRate;
              const idxB = Math.floor(posB);
              if (idxB >= 0 && idxB < lastIdx) {
                const fB = posB - idxB;
                l += (data.left[idxB]! * (1 - fB) + data.left[idxB + 1]! * fB) * (1 - w);
                r += (data.right[idxB]! * (1 - fB) + data.right[idxB + 1]! * fB) * (1 - w);
              }
            }
          } else {
            const srcPos = (clip.offset + beatAt * secPerBeat) * data.rate;
            const idx = Math.floor(srcPos);
            if (idx < 0 || idx >= lastIdx) continue;
            const frac = srcPos - idx;
            l = data.left[idx]! * (1 - frac) + data.left[idx + 1]! * frac;
            r = data.right[idx]! * (1 - frac) + data.right[idx + 1]! * frac;
          }
          bl[i]! += l * clip.gain;
          br[i]! += r * clip.gain;
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
      const startBeat = this.posBeats - blockBeats;
      const beatsPerBar = Math.max(1, this.timeSigNum);
      for (let i = 0; i < n; i++) {
        const b = startBeat + i * spb;
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
}

export type { FromKernel };

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
