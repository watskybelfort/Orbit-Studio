/**
 * KernelCore: el motor completo, independiente del AudioWorklet.
 * - En vivo: kernel.worklet.ts lo envuelve en un AudioWorkletProcessor.
 * - Offline/tests: se le llama process() en bucle y se recoge el audio.
 * Regla dura: CERO alocaciones dentro de process(); todo se preasigna en
 * setSnapshot()/mensajes (que corren entre bloques).
 */

import type {
  CompiledProject,
  FromKernel,
  MeterFrame,
  ToKernel,
} from './protocol';
import { createEffect, type EffectUnit } from './dsp/effects';
import { createVoice, type SampleData, type Voice, type VoiceContext } from './dsp/voices';

export const MAX_BLOCK = 128;

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

  private voices: ActiveVoice[] = [];
  private voiceOrder = 0;

  // Transport
  playing = false;
  posBeats = 0;
  private tempo = 140;
  private loopEnabled = true;
  private loopStart = 0;
  private loopEnd = 4;
  metronome = false;
  private clickPhase = 0;
  private clickEnv = 0;
  private clickFreq = 1760;

  // Medición
  private peaks = new Float32Array(1);
  private masterSumSq: [number, number] = [0, 0];
  private meterSamples = 0;

  constructor(public readonly sr: number) {
    this.voiceCtx = { sr, samples: this.samples };
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  handleMessage(msg: ToKernel): void {
    switch (msg.type) {
      case 'snapshot':
        this.setSnapshot(msg.project);
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
    const n = p.mixer.length;
    if (this.bufL.length !== n) {
      this.bufL = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.bufR = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.lastL = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.lastR = Array.from({ length: n }, () => new Float32Array(MAX_BLOCK));
      this.peaks = new Float32Array(n);
    }
    // Instancias de efecto: reusar por id (conserva colas), crear nuevas, purgar.
    const alive = new Set<string>();
    for (const t of p.mixer) {
      for (const slot of t.slots) {
        if (!slot) continue;
        alive.add(slot.id);
        let unit = this.effects.get(slot.id);
        if (!unit) {
          unit = createEffect(slot.kind, this.sr);
          this.effects.set(slot.id, unit);
        }
        unit.setParams(slot.params);
        unit.setTempo?.(this.tempo);
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
      ch.kind, channelIndex, key, this.voiceOrder++, velocity, ch.params, this.voiceCtx, ch.sampleId,
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

    const spb = this.tempo / 60 / this.sr; // beats por sample
    const blockBeats = n * spb;

    if (this.playing) {
      const end = this.posBeats + blockBeats;
      if (this.loopEnabled && end > this.loopEnd && this.posBeats < this.loopEnd) {
        // El loop envuelve dentro de este bloque: dos segmentos.
        const wrapSamples = Math.round((this.loopEnd - this.posBeats) / spb);
        this.triggerRange(this.posBeats, this.loopEnd, 0, spb);
        const remainBeats = end - this.loopEnd;
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
        for (let i = 0; i < n; i++) {
          const beatAt = relBeat + i * spb;
          if (beatAt < 0 || beatAt >= clip.length) continue;
          const srcPos = (clip.offset + beatAt * secPerBeat) * data.rate;
          const idx = Math.floor(srcPos);
          if (idx < 0 || idx >= data.left.length - 1) continue;
          const frac = srcPos - idx;
          bl[i]! += (data.left[idx]! * (1 - frac) + data.left[idx + 1]! * frac) * clip.gain;
          br[i]! += (data.right[idx]! * (1 - frac) + data.right[idx + 1]! * frac) * clip.gain;
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

    // Metrónomo
    if (this.metronome && this.playing) {
      const startBeat = this.posBeats - blockBeats;
      for (let i = 0; i < n; i++) {
        const b = startBeat + i * spb;
        const nearest = Math.round(b);
        if (Math.abs(b - nearest) < spb * 0.5 && nearest > Math.round(startBeat - spb)) {
          if (Math.floor((b + spb) / 1) !== Math.floor(b / 1) || i === 0) {
            // Flanco de beat: dispara click (agudo en el 1 del compás).
            this.clickEnv = 1;
            this.clickFreq = nearest % 4 === 0 ? 1760 : 1175;
          }
        }
        if (this.clickEnv > 0.001) {
          this.clickPhase += this.clickFreq / this.sr;
          if (this.clickPhase >= 1) this.clickPhase -= 1;
          const s = Math.sin(2 * Math.PI * this.clickPhase) * this.clickEnv * 0.25;
          this.bufL[0]![i]! += s;
          this.bufR[0]![i]! += s;
          this.clickEnv *= Math.exp(-1 / (0.01 * this.sr));
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

      // Medidores
      let peak = this.peaks[t]! * 0.85; // decay visual
      for (let i = 0; i < n; i++) {
        const a = Math.abs(bl[i]!);
        const b = Math.abs(br[i]!);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      this.peaks[t] = peak;

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
    const frame: MeterFrame = {
      peaks: this.peaks.slice(),
      masterRms: [
        Math.sqrt(this.masterSumSq[0] / ms),
        Math.sqrt(this.masterSumSq[1] / ms),
      ],
      positionBeats: this.posBeats,
      playing: this.playing,
      cpu,
    };
    this.masterSumSq[0] = 0;
    this.masterSumSq[1] = 0;
    this.meterSamples = 0;
    return frame;
  }
}

export type { FromKernel };
