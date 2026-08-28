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
  /** Pan de la NOTA (-1..1, 0 = centro). Se combina con el pan del canal. */
  pan: number;
  /**
   * Sample(s) que esta voz puede estar leyendo: el id suelto (sampler, slicer),
   * la lista del keymap, o null si el instrumento no toca ningún sample.
   *
   * Se copia del canal al nacer la voz —del array que `setSnapshot` dejó ya
   * hecho, así que no se aloca nada aquí— y se guarda TAL COMO ESTABA el canal
   * entonces: una voz nacida con el sample A sigue protegiendo A aunque el
   * canal haya pasado a B mientras su cola termina de sonar.
   */
  sampleRef: string | readonly string[] | null;
}

const MAX_VOICES = 64;

/**
 * Los samples que una voz de este canal puede acabar leyendo.
 *
 * El keymap devuelve TODAS sus zonas y además el `sampleId` del canal: elegir
 * zona por tecla y velocidad es cosa de la voz, y adivinarlo aquí para afinar
 * la cuenta sería duplicar esa lógica en dos sitios que se desincronizan. De
 * más protege; de menos suelta audio que alguien está leyendo.
 */
function channelSampleRef(ch: CompiledChannel): string | readonly string[] | null {
  const keymap = ch.keymap;
  if (keymap && keymap.length > 0) {
    const ids: string[] = [];
    if (ch.sampleId) ids.push(ch.sampleId);
    for (const zone of keymap) if (!ids.includes(zone.sampleId)) ids.push(zone.sampleId);
    return ids;
  }
  return ch.sampleId ?? null;
}

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
  /**
   * Rueda de tono, en semitonos. Es OPCIONAL a propósito: un instrumento JS
   * que no la declare simplemente no dobla, y eso es mejor que fingirlo
   * re-atacando la nota —que suena a nota nueva, no a tono doblado—.
   */
  setBend?(semitones: number): void;
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

  // ── Recolección de samples (ver el mensaje `collectSamples`) ──
  /**
   * Sample(s) que puede leer cada canal, resueltos UNA vez por snapshot.
   *
   * Existe para que nacer una voz no cueste una alocación: `spawnVoice` corre
   * dentro de `process()` y lo único que hace es copiar esta referencia.
   */
  private channelSampleIds: (string | readonly string[] | null)[] = [];
  /**
   * Ids que sobran pero que todavía lee alguna voz: se sueltan en cuanto la
   * última muera. Borrar el buffer bajo los pies de una voz viva es, en el
   * mejor caso, un clic.
   */
  private pendingRelease: string[] = [];
  /** Set de trabajo de la recolección; se reutiliza, no se aloca por mensaje. */
  private keepSet = new Set<string>();

  // Buffers por pista de mixer
  private bufL: Float32Array[] = [];
  private bufR: Float32Array[] = [];
  private lastL: Float32Array[] = [];
  private lastR: Float32Array[] = [];
  private dryL = new Float32Array(MAX_BLOCK);
  private dryR = new Float32Array(MAX_BLOCK);
  /**
   * Copia de la señal ANTES del fader, para los envíos pre.
   *
   * Un par y no uno por pista: los envíos de una pista se resuelven dentro de
   * su propia vuelta del bucle, así que cuando le toca a la siguiente ya nadie
   * mira esto. Reservar 26 pares sería malgastar memoria del worklet.
   */
  private preL = new Float32Array(MAX_BLOCK);
  private preR = new Float32Array(MAX_BLOCK);
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
  /**
   * Semitonos de rueda de tono que tiene puestos cada canal AHORA MISMO.
   *
   * Es lo que convierte la rueda en una rueda de verdad: sin este estado,
   * doblar movía lo que ya sonaba pero la nota siguiente nacía sin doblar, y
   * al tocar con la rueda sujeta salían unas notas dobladas y otras no. Vive
   * por canal —no global— porque cada canal es un instrumento distinto y la
   * rueda es del que estás tocando.
   */
  private bendByChannel = new Float32Array(0);

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

  // Cuenta atrÃ¡s con el transporte PARADO (el metrÃ³nomo de arriba solo suena
  // rodando). Va con su propia envolvente: la cuenta puede seguir sonando la
  // cola del Ãºltimo clic cuando el transporte ya entrÃ³ y el metrÃ³nomo empieza.
  /** Clics de cuenta que faltan por disparar. */
  private countInLeft = 0;
  /** Samples hasta el siguiente clic de la cuenta (0 = ya). */
  private countInWait = 0;
  private countInBeatsPerBar = 4;
  /** Beat de la cuenta ya disparado (para acentuar el 1 de cada compÃ¡s). */
  private countInBeat = 0;
  /** Beat en el que entra el transporte al cerrar la cuenta (null = no entra). */
  private countInPlayFrom: number | null = null;
  private ciEnv = 0;
  private ciPhase = 0;
  private ciFreq = 1760;
  /**
   * El clic de la cuenta NO puede sumarse a la pista master: el master
   * ESCRIBE sobre la salida (`outL[i] = ...`), no suma, y ademÃ¡s puede estar
   * muteada o con el fader abajo. Se renderiza aparte y se vuelca al final.
   */
  private countInBuf = new Float32Array(MAX_BLOCK);

  // ── Entrada en vivo (micro / instrumento) ──
  /** Medir lo que entra (para ajustar ganancia sin oírse). */
  private inputListening = false;
  /** Además meterlo en la pista, antes de sus inserts. */
  private inputMonitor = false;
  private inputTrack = 0;
  private inputGain = 1;
  /** Pico del bloque, ANTES de la ganancia: un micro que satura se ve igual. */
  private inputPeak = 0;
  /** Guardar la entrada en crudo (grabación de micro sin códec de por medio). */
  private inputCapture = false;
  private inputCapL = new Float32Array(CAPTURE_BUFFER);
  private inputCapR = new Float32Array(CAPTURE_BUFFER);
  private inputCapPos = 0;




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
        // Un play a mano manda sobre la cuenta atrás en marcha: si no, la
        // cuenta seguiría contando y al cerrar saltaría el transporte a SU
        // beat, pisando el que acaba de pedir el usuario.
        this.cancelCountIn();
        // Un play mientras ya sonaba (salto de posición sin stop, p. ej. seguir

        // un transporte remoto) deja huérfanas las notas vivas: su note-off
        // estaba en un punto del timeline que el salto se lleva por delante.
        if (this.playing) this.releaseSequencedVoices();
        this.posBeats = msg.fromBeat;
        this.playing = true;
        this.resyncCursor();
        this.applyMaps();
        break;
      case 'stop':
        this.playing = false;
        this.cancelCountIn();
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
        // `enabled` = "que el transporte CICLE"; la región es aparte. Tres casos:
        //  - enabled + región (end>start): región marcada a mano; manda el
        //    usuario (loopUserSet) y se cicla dentro de ella.
        //  - enabled sin región (end<=start): quitar la región y volver a ciclar
        //    el timeline entero (el "clear" de la playlist). Antes esto apagaba
        //    el ciclado y el patrón sonaba UNA vez y el transporte se moría.
        //  - !enabled: no ciclar, sonar el rango una vez y parar al final. Es lo
        //    que usa el render offline (setLoop(0, len, false)).
        if (msg.enabled && msg.end > msg.start) {
          this.loopEnabled = true;
          this.loopUserSet = true;
          this.loopStart = msg.start;
          this.loopEnd = Math.max(msg.start + 0.25, msg.end);
        } else if (msg.enabled) {
          this.loopEnabled = true;
          this.loopUserSet = false;
          this.loopStart = 0;
          this.loopEnd = this.project ? this.project.lengthBeats : this.loopEnd;
        } else {
          this.loopEnabled = false;
          this.loopUserSet = false;
          this.loopStart = msg.start;
          this.loopEnd = Math.max(msg.start + 0.25, msg.end);
        }
        break;
      case 'setMetronome':
        this.metronome = msg.enabled;
        break;
      case 'countIn':
        // Solo tiene sentido parado: rodando ya hay metrÃ³nomo y arrancar el
        // transporte "otra vez" al cerrar la cuenta serÃ­a un salto.
        if (this.playing) break;
        this.countInLeft = Math.max(1, Math.round(msg.beats));
        this.countInBeatsPerBar = Math.max(1, Math.round(msg.beatsPerBar));
        this.countInBeat = 0;
        this.countInWait = 0; // el primer clic entra en el sample siguiente
        this.countInPlayFrom = msg.playFrom ?? null;
        this.ciEnv = 0;
        break;
      case 'cancelCountIn':
        this.cancelCountIn();
        break;
      case 'setLiveInput':
        this.inputListening = msg.listening;
        this.inputMonitor = msg.monitor;
        this.inputTrack = Math.max(0, Math.round(msg.trackIndex));
        this.inputGain = Math.max(0, msg.gain);
        // Al dejar de escuchar, el medidor cae a cero en el acto: si no, el
        // último pico se queda clavado en pantalla como si siguiera entrando.
        if (!msg.listening) this.inputPeak = 0;
        break;
      case 'setInputCapture':
        this.inputCapture = msg.enabled;
        this.inputCapPos = 0;
        break;



      case 'setScope': {
        // Al activar o cambiar de pista se limpia el anillo: si no, el primer
        // frame del Orbit Scope enseña 2048 muestras de la pista anterior (o de
        // hace minutos, si el scope llevaba rato apagado).
        const nextTrack = msg.trackIndex ?? 0;
        if (msg.enabled && (!this.scopeEnabled || nextTrack !== this.scopeTrack)) {
          this.scopeRing.fill(0);
        }
        this.scopeEnabled = msg.enabled;
        this.scopeTrack = nextTrack;
        break;
      }
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
        // Subir un sample lo saca de la lista de espera de la recolección: si
        // no, el aplazamiento de la versión ANTERIOR (una voz que aún sonaba)
        // borraría la que se acaba de cargar en cuanto esa voz muriese.
        this.unpend(msg.sampleId);
        break;
      case 'collectSamples':
        this.collectSamples(msg.keep);
        break;
      case 'previewNote':
        if (msg.on) this.previewOn(msg.channelIndex, msg.key);
        else this.previewOff(msg.channelIndex, msg.key);
        break;
      case 'previewSample':
        this.previewSamplePlay(msg.sampleId, msg.gain);
        break;
      case 'pitchBend':
        this.setPitchBend(msg.channelIndex, msg.semitones);
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
    // La rueda sobrevive a recompilar: mover una perilla mientras se dobla no
    // puede soltar la rueda de golpe. Lo que sobra al encoger se pierde, que
    // es lo correcto — ese canal ya no existe.
    if (this.bendByChannel.length !== nCh) {
      const prev = this.bendByChannel;
      this.bendByChannel = new Float32Array(nCh);
      this.bendByChannel.set(prev.subarray(0, Math.min(prev.length, nCh)));
    }
    // Y desde que la rueda es un parámetro del proyecto (v3.4), el canal que
    // DICE algo de ella manda: abrir un .orbit con la rueda guardada deja el
    // canal doblado donde toca sin que nadie mueva nada.
    //
    // El que no dice nada se respeta, y ahí está la diferencia que importa:
    // ausente NO significa "la rueda está en el centro", significa "este canal
    // no tiene opinión". Si significara centro, cualquier recompilación
    // —mover una perilla mientras se dobla— soltaría la rueda de golpe en
    // mitad del gesto, que es justo lo que el gesto en vivo no puede permitir.
    // Recentrar lo hace el mensaje de la rueda al soltarla, que es quien sabe
    // que se ha soltado.
    for (let i = 0; i < nCh; i++) {
      const declarado = p.channels[i]!.bend;
      if (declarado !== undefined) this.setPitchBend(i, declarado);
    }
    // Sample(s) que puede leer cada canal. Se resuelve aquí, una vez por
    // snapshot, para que `spawnVoice` —que corre dentro de process()— solo
    // tenga que copiar la referencia.
    this.channelSampleIds.length = nCh;
    for (let i = 0; i < nCh; i++) this.channelSampleIds[i] = channelSampleRef(p.channels[i]!);
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
      // El reset NO es una región del usuario: si dejáramos loopUserSet en true,
      // una región [8,16] que no cabe en el proyecto nuevo se reescribe a [0,4]
      // y quedaría CONGELADA como si el usuario hubiera pedido ciclar 0-4.
      this.loopUserSet = false;
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
      // Si el proyecto ya referencia este plugin, re-instancia sus slots. Hay
      // que BORRAR primero las unidades de ese plugin de `this.effects`: como el
      // id del slot no cambia, `ensureUnit` reutilizaría la unidad vieja y
      // seguiría corriendo el código anterior (o el bypass permanente si aquella
      // versión lanzó). Las voces de instrumento no: la fábrica nueva entra en
      // la siguiente nota.
      if (found && this.project) {
        for (const t of this.project.mixer) {
          for (const slot of t.slots) {
            if (slot && slot.kind === 'plugin' && slot.pluginId === pluginId) {
              this.effects.delete(slot.id);
            }
          }
        }
        for (const ch of this.project.channels) {
          for (const slot of ch.fx ?? []) {
            if (slot && slot.kind === 'plugin' && slot.pluginId === pluginId) {
              this.effects.delete(slot.id);
            }
          }
        }
        this.setSnapshot(this.project);
      }
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
    // Estos límites los pone el sistema, no el usuario: si no, una región
    // marcada antes seguiría diciendo "manda el usuario" sobre un loop que ya
    // no marcó él.
    this.loopUserSet = false;
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
      this.spawnVoice(ev.channelIndex, ev.key, ev.velocity, offset, offBeat, null, ev.pan);
    }
  }

  private spawnVoice(
    channelIndex: number,
    key: number,
    velocity: number,
    pendingOffset: number,
    offBeat: number,
    previewKey: string | null,
    pan = 0,
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
        ch.sampleId, ch.nova, ch.prisma, ch.slicePoints, ch.keymap,

      );
    // Con la rueda sujeta, la nota nace YA doblada (`snap`): dejarla subir sola
    // desde la nota sin doblar durante los primeros milisegundos es un
    // portamento que nadie pidió.
    const bend = this.bendByChannel[channelIndex] ?? 0;
    if (bend !== 0) voice.setBend(bend, true);
    this.voices.push({
      voice,
      offBeat,
      pendingOffset,
      released: false,
      previewKey,
      pan,
      // Copiar, no calcular: la lista la dejó hecha `setSnapshot`.
      sampleRef: this.channelSampleIds[channelIndex] ?? null,
    });
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

  /**
   * La rueda de un canal escrita DESDE EL MODELO (curva de automatización o
   * LFO): deja el valor en el proyecto compilado y reafina lo que suena.
   *
   * Las dos mitades van juntas y no por gusto. Solo el valor, y las voces
   * vivas no se enteran: la curva no se oiría hasta la nota siguiente. Solo
   * las voces, y el valor se pierde en la próxima recompilación —que ahora
   * adopta el del canal— así que el canal volvería al centro solo.
   */
  private setChannelBend(channelIndex: number, semitones: number): void {
    const ch = this.project?.channels[channelIndex];
    if (ch) ch.bend = semitones;
    this.setPitchBend(channelIndex, semitones);
  }

  /**
   * Rueda de tono de un canal: dobla lo que ya suena y se queda puesta para lo
   * que suene después.
   */
  private setPitchBend(channelIndex: number, semitones: number): void {
    if (channelIndex < 0 || channelIndex >= this.bendByChannel.length) return;
    if (this.bendByChannel[channelIndex] === semitones) return;
    this.bendByChannel[channelIndex] = semitones;
    for (const v of this.voices) {
      // Las audiciones también: doblar mientras suena una tecla del piano roll
      // es exactamente el gesto que se hace.
      if (v.voice.channelIndex === channelIndex) v.voice.setBend(semitones);
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
    // Escuchar algo que estaba en la cola de descarga lo saca de ella: mientras
    // suena es una referencia viva como cualquier otra.
    if (this.previewSampleId) this.unpend(this.previewSampleId);
  }

  // ── Recolección de samples ────────────────────────────────────────────────
  //
  // Quién decide que un sample sobra vive FUERA del hilo de audio: la UI cuenta
  // referencias contra el proyecto editable (`sampleKeepSet`) y manda la lista
  // de los que se quedan. Aquí solo se resta y se comprueban las referencias
  // que la UI no puede ver: el proyecto compilado que está puesto, el que
  // espera en cola, el preview y las voces vivas.

  /** Cuántos samples tiene cargados el worklet ahora mismo. */
  get sampleCount(): number {
    return this.samples.size;
  }

  hasSample(id: string): boolean {
    return this.samples.has(id);
  }

  /** Ids que sobran pero esperan a que muera la voz que los está leyendo. */
  get pendingSampleRelease(): readonly string[] {
    return this.pendingRelease;
  }

  /**
   * Suelta todo lo cargado que no esté en `keep` ni proteja el kernel.
   *
   * Corre en el handler de mensajes —entre bloques, como el snapshot—, nunca
   * dentro de `process()`.
   */
  private collectSamples(keep: readonly string[]): void {
    // La lista de espera se rehace entera en cada recolección: lo que aplazó la
    // anterior puede haber vuelto a hacer falta, y arrastrarlo sería soltar más
    // tarde algo que ahora suena.
    this.pendingRelease.length = 0;
    if (this.samples.size === 0) return;
    const set = this.keepSet;
    set.clear();
    for (let i = 0; i < keep.length; i++) set.add(keep[i]!);
    this.addKernelRoots(set);
    // Borrar dentro del recorrido del mapa es seguro: un Map salta las entradas
    // que se borran antes de visitarlas.
    for (const id of this.samples.keys()) {
      if (set.has(id)) continue;
      // Lo que suena AHORA no se refuta, se espera: sale de la lista y se
      // suelta en cuanto deje de sonar.
      if (this.busyWithSample(id)) this.pendingRelease.push(id);
      else this.samples.delete(id);
    }
  }

  /**
   * Lo que el kernel protege por su cuenta, diga lo que diga la UI.
   *
   * No es desconfianza gratuita: el proyecto COMPILADO puede ir por delante o
   * por detrás del editable —un `queueSnapshot` que aún no entró, una vista de
   * patrón que no compila ni un clip de audio—, así que una lista de la UI a
   * la que le falte algo no puede dejar mudo lo que el motor tiene puesto.
   */
  private addKernelRoots(set: Set<string>): void {
    this.addProjectRoots(this.project, set);
    this.addProjectRoots(this.pendingProject, set);
  }

  /** ¿Se está oyendo ahora mismo? (voz viva o preview del Explorador.) */
  private busyWithSample(id: string): boolean {
    return this.previewSampleId === id || this.heldByVoice(id);
  }

  private addProjectRoots(p: CompiledProject | null, set: Set<string>): void {
    if (!p) return;
    for (const ch of p.channels) {
      if (ch.sampleId) set.add(ch.sampleId);
      for (const zone of ch.keymap ?? []) set.add(zone.sampleId);
    }
    for (const clip of p.audioClips) set.add(clip.sampleId);
  }

  /** ¿Alguna voz viva puede estar leyendo este sample? */
  private heldByVoice(id: string): boolean {
    for (let i = 0; i < this.voices.length; i++) {
      const ref = this.voices[i]!.sampleRef;
      if (ref === null) continue;
      if (typeof ref === 'string') {
        if (ref === id) return true;
      } else {
        for (let z = 0; z < ref.length; z++) if (ref[z] === id) return true;
      }
    }
    return false;
  }

  /** Saca un id de la lista de espera (volvió a hacer falta). */
  private unpend(id: string): void {
    for (let i = this.pendingRelease.length - 1; i >= 0; i--) {
      if (this.pendingRelease[i] !== id) continue;
      this.pendingRelease[i] = this.pendingRelease[this.pendingRelease.length - 1]!;
      this.pendingRelease.length--;
    }
  }

  /**
   * Reintenta los aplazados. La llama `process()` cuando hay algo pendiente —
   * una comparación de enteros por bloque en el caso normal, que es que no hay
   * nada— porque las voces solo mueren ahí dentro.
   *
   * No aloca: recorrido por índice, borrado por intercambio y `Map.delete`.
   */
  private flushPendingRelease(): void {
    for (let i = this.pendingRelease.length - 1; i >= 0; i--) {
      const id = this.pendingRelease[i]!;
      const rooted = this.isRooted(id);
      if (!rooted && this.busyWithSample(id)) continue; // todavía suena
      if (!rooted) this.samples.delete(id);
      this.pendingRelease[i] = this.pendingRelease[this.pendingRelease.length - 1]!;
      this.pendingRelease.length--;
    }
  }

  /** Versión de `addKernelRoots` para UN id, sin construir el set. */
  private isRooted(id: string): boolean {
    return this.projectHasSample(this.project, id) || this.projectHasSample(this.pendingProject, id);
  }

  private projectHasSample(p: CompiledProject | null, id: string): boolean {
    if (!p) return false;
    for (let i = 0; i < p.channels.length; i++) {
      const ch = p.channels[i]!;
      if (ch.sampleId === id) return true;
      const keymap = ch.keymap;
      if (keymap) {
        for (let z = 0; z < keymap.length; z++) if (keymap[z]!.sampleId === id) return true;
      }
    }
    for (let i = 0; i < p.audioClips.length; i++) {
      if (p.audioClips[i]!.sampleId === id) return true;
    }
    return false;
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
            else if (t.key === 'bend') this.setChannelBend(t.channelIndex, value);
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
        if (t.key === 'volume') return ch.volume;
        // Sin doblar es 0, no "no hay valor": un LFO sobre la rueda tiene que
        // poder oscilar sobre el centro, que es donde está casi siempre.
        if (t.key === 'bend') return ch.bend ?? 0;
        return ch.pan;
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
          else if (t.key === 'bend') this.setChannelBend(t.channelIndex, value);
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

  // ── Cuenta atrás ──────────────────────────────────────────────────────────

  /** Corta la cuenta atrás y su arranque diferido (deja la cola del clic). */
  private cancelCountIn(): void {
    this.countInLeft = 0;
    this.countInWait = 0;
    this.countInPlayFrom = null;
  }

  /** Beats que faltan para que entre el transporte, contando el que suena. */
  get countInBeatsLeft(): number {
    return this.countInLeft + (this.countInWait > 0 ? 1 : 0);
  }

  /**
   * Renderiza la cuenta atrás en `countInBuf` y, si se cierra dentro de este
   * bloque, ARRANCA el transporte. Devuelve `true` si hay algo que volcar.
   *
   * Se llama al abrir el bloque, antes de que el transporte avance: cuando la
   * cuenta cierra a mitad de bloque el transporte entra con hasta 128 samples
   * (2,7 ms) de adelanto. Es la alternativa a partir el bloque en dos, y a esa
   * escala no se oye — lo que sí se oía era el `setTimeout` de antes.
   */
  private renderCountIn(n: number): boolean {
    if (this.countInLeft <= 0 && this.countInPlayFrom === null && this.ciEnv <= 0.001) {
      return false;
    }
    const buf = this.countInBuf;
    buf.fill(0, 0, n);
    const samplesPerBeat = (60 / Math.max(1, this.tempo)) * this.sr;
    const bpb = this.countInBeatsPerBar;
    for (let i = 0; i < n; i++) {
      if (this.countInWait <= 0) {
        if (this.countInLeft > 0) {
          this.ciEnv = 1;
          this.ciPhase = 0;
          this.ciFreq = this.countInBeat % bpb === 0 ? 1760 : 1175;
          this.countInBeat++;
          this.countInLeft--;
          this.countInWait = samplesPerBeat;
        } else if (this.countInPlayFrom !== null) {
          // Un beat DESPUÉS del último clic: la cuenta de "4" entra en el 5.
          this.posBeats = this.countInPlayFrom;
          this.countInPlayFrom = null;
          this.playing = true;
          this.resyncCursor();
          if (this.project) this.applyMaps();
        }
      }
      if (this.countInWait > 0) this.countInWait--;
      if (this.ciEnv > 0.001) {
        this.ciPhase += this.ciFreq / this.sr;
        if (this.ciPhase >= 1) this.ciPhase -= 1;
        buf[i] = Math.sin(2 * Math.PI * this.ciPhase) * this.ciEnv * 0.5;
        this.ciEnv *= Math.exp(-1 / (0.02 * this.sr));
      }
    }
    return true;
  }

  // ── Proceso principal ─────────────────────────────────────────────────────

  /**
   * `inL`/`inR` son la entrada en vivo del nodo (micro, instrumento). Llegan
   * como parámetros y no como estado porque el worklet las recibe por bloque:
   * el render offline y las pruebas simplemente no las pasan.
   */
  process(
    outL: Float32Array,
    outR: Float32Array,
    n: number,
    inL?: Float32Array,
    inR?: Float32Array,
  ): void {
    const p = this.project;
    // Samples que esperaban a que muriese la voz que los leía. Las voces solo
    // mueren aquí dentro, así que el reintento tiene que vivir aquí; en el caso
    // normal —nada pendiente— es una comparación de enteros por bloque y no se
    // toca el mapa ni se aloca nada.
    if (this.pendingRelease.length > 0) this.flushPendingRelease();
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    // Antes que nada: la cuenta puede ENCENDER el transporte en este bloque.
    const countIn = this.renderCountIn(n);
    if (!p) {
      if (countIn) this.mixCountIn(outL, outR, n);
      return;
    }



    const nTracks = p.mixer.length;
    for (let t = 0; t < nTracks; t++) {
      this.bufL[t]!.fill(0, 0, n);
      this.bufR[t]!.fill(0, 0, n);
    }
    for (let c = 0; c < this.fxChannels.length; c++) {
      this.chBufL[c]!.fill(0, 0, n);
      this.chBufR[c]!.fill(0, 0, n);
    }

    /*
     * Entrada en vivo. Va aquí, con los buffers de pista recién puestos a
     * cero y ANTES de que la mesa procese nada: eso es exactamente
     * "pre-inserts" — lo que entra por el micro pasa por los efectos de su
     * pista, su EQ y su fader igual que si fuera audio del proyecto. Es lo
     * único que hace útil el monitor: cantar oyendo el reverb y el compresor
     * que va a llevar la toma, no la voz seca.
     */
    if (this.inputListening && inL) {
      const right = inR ?? inL;
      const count = Math.min(n, inL.length);
      let peak = 0;
      for (let i = 0; i < count; i++) {
        const l = inL[i]!;
        const r = right[i]!;
        const a = Math.abs(l);
        const b = Math.abs(r);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      this.inputPeak = peak;
      // La toma se guarda ANTES de la ganancia de entrada y de la cadena: es
      // la señal del micro tal cual, que es lo que hay que poder volver a
      // mezclar mañana con otra idea.
      if (this.inputCapture && this.inputCapPos + count <= this.inputCapL.length) {
        this.inputCapL.set(inL.subarray(0, count), this.inputCapPos);
        this.inputCapR.set(right.subarray(0, count), this.inputCapPos);
        this.inputCapPos += count;
      }
      const dl = this.bufL[this.inputTrack];

      const dr = this.bufR[this.inputTrack];
      if (this.inputMonitor && dl && dr) {
        const g = this.inputGain;
        for (let i = 0; i < count; i++) {
          dl[i]! += inL[i]! * g;
          dr[i]! += right[i]! * g;
        }
      }
    } else if (this.inputPeak !== 0) {
      this.inputPeak = 0;
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
        // Con inserts, el pan del CANAL se aplica post-cadena; el de la NOTA se
        // aplica aquí, en la voz. Sin pan de nota (el caso normal) es unidad, y
        // el render sale bit-idéntico al de siempre.
        let ngL = 1;
        let ngR = 1;
        if (av.pan !== 0) {
          ngL = Math.cos(((av.pan + 1) / 4) * Math.PI) * 1.414;
          ngR = Math.sin(((av.pan + 1) / 4) * Math.PI) * 1.414;
        }
        alive = av.voice.render(this.chBufL[slot]!, this.chBufR[slot]!, from, n, ngL, ngR);
      } else {
        const track = Math.min(nTracks - 1, Math.max(0, ch.mixerTrack));
        // Pan de la nota combinado con el del canal (sumados y acotados): una
        // nota a la derecha en un canal a la derecha suena a tope a la derecha.
        // Sin pan de nota queda exactamente el pan del canal de antes.
        const pan = av.pan !== 0 ? Math.max(-1, Math.min(1, ch.pan + av.pan)) : ch.pan;
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

      // Pre-fader es antes del FADER, no antes del mute: una pista silenciada
      // no manda nada por ningún sitio, que es lo que uno espera al muteala.
      const needsPre = track.sends.some((send) => send.tap === 'pre' && !send.mute);

      if (!track.audible) {
        bl.fill(0, 0, n);
        br.fill(0, 0, n);
        if (needsPre) {
          this.preL.fill(0, 0, n);
          this.preR.fill(0, 0, n);
        }
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

        /*
         * Toma pre-fader. Se copia justo aquí —después de efectos y EQ, antes
         * de width/pan/volumen— porque eso es lo que significa "pre-fader" en
         * una mesa: la reverb que se queda cuando cierras el fader sigue
         * llevando el sonido procesado de la pista, no el crudo.
         *
         * Solo se copia si alguien la va a usar: es un memcpy por pista y por
         * bloque, y casi ninguna sesión tiene envíos pre.
         */
        if (needsPre) {
          this.preL.set(bl.subarray(0, n));
          this.preR.set(br.subarray(0, n));
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
      /*
       * Envíos. Ya no son "suma esto con esta ganancia": cada uno decide de
       * dónde toma la señal, qué parte de ella manda y con qué polaridad, que
       * es lo que los convierte en un proceso del enrutado.
       *
       * `mid` y `side` son la descomposición de siempre (m = (L+R)/2,
       * s = (L−R)/2). El side se reconstruye en estéreo como +s / −s: así, un
       * bus de lados suena a lo que se sale del centro, y devolverlo con la
       * polaridad invertida cancela justo esa parte.
       *
       * `left` y `right` salen en MONO a las dos salidas: se extrae un canal
       * para tratarlo, y dejarlo pegado a su lado obligaría a corregir el pan
       * en el destino.
       */
      for (const send of track.sends) {
        if (send.mute || send.level === 0) continue;
        const dl = this.bufL[send.target];
        const dr = this.bufR[send.target];
        if (!dl || !dr) continue;
        const sl = send.tap === 'pre' ? this.preL : bl;
        const sr = send.tap === 'pre' ? this.preR : br;
        const gain = send.invert ? -send.level : send.level;
        // Pan del envío con la misma ley de potencia constante que el strip.
        const p = send.pan;
        const gl = p === 0 ? gain : gain * Math.cos(((p + 1) / 4) * Math.PI) * 1.414;
        const gr = p === 0 ? gain : gain * Math.sin(((p + 1) / 4) * Math.PI) * 1.414;

        switch (send.part) {
          case 'mid':
            for (let i = 0; i < n; i++) {
              const m = (sl[i]! + sr[i]!) * 0.5;
              dl[i]! += m * gl;
              dr[i]! += m * gr;
            }
            break;
          case 'side':
            for (let i = 0; i < n; i++) {
              const sd = (sl[i]! - sr[i]!) * 0.5;
              dl[i]! += sd * gl;
              dr[i]! += -sd * gr;
            }
            break;
          case 'left':
            for (let i = 0; i < n; i++) {
              dl[i]! += sl[i]! * gl;
              dr[i]! += sl[i]! * gr;
            }
            break;
          case 'right':
            for (let i = 0; i < n; i++) {
              dl[i]! += sr[i]! * gl;
              dr[i]! += sr[i]! * gr;
            }
            break;
          default:
            for (let i = 0; i < n; i++) {
              dl[i]! += sl[i]! * gl;
              dr[i]! += sr[i]! * gr;
            }
            break;
        }
      }
    }

    if (countIn) this.mixCountIn(outL, outR, n);
  }

  /** Vuelca el clic de la cuenta atrás sobre la salida ya montada. */
  private mixCountIn(outL: Float32Array, outR: Float32Array, n: number): void {
    const buf = this.countInBuf;
    for (let i = 0; i < n; i++) {
      outL[i]! += buf[i]!;
      outR[i]! += buf[i]!;
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
      inputPeak: this.inputPeak,
    };

    const countInLeft = this.countInBeatsLeft;
    if (countInLeft > 0) frame.countInBeatsLeft = countInLeft;

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
    if (this.inputCapture && this.inputCapPos > 0) {
      frame.inputCaptureL = this.inputCapL.slice(0, this.inputCapPos);
      frame.inputCaptureR = this.inputCapR.slice(0, this.inputCapPos);
      this.inputCapPos = 0;
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
  // Scratch propio: el instrumento renderiza aquí y solo se suma al bus si la
  // salida es finita (ver render). Se alocan la primera vez y se reutilizan.
  private scratchL: Float32Array | null = null;
  private scratchR: Float32Array | null = null;

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

  /**
   * Rueda de tono: se la pasa al instrumento si la sabe llevar. Si no, la voz
   * no se mueve — y no se disimula.
   */
  protected override retune(): void {
    if (this.broken) return;
    try {
      this.inst.setBend?.(this.bend);
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
    const sl = (this.scratchL ??= new Float32Array(MAX_BLOCK));
    const sr = (this.scratchR ??= new Float32Array(MAX_BLOCK));
    sl.fill(0, from, to);
    sr.fill(0, from, to);
    let ret: boolean;
    try {
      // El instrumento escribe en el scratch a ganancia 1; el gain se aplica al
      // sumar. Solo un `false` explícito mata la voz; si el plugin se olvida de
      // devolver nada se queda viva hasta que el robo de voces la recicle.
      ret = this.inst.render(sl, sr, from, to, 1, 1) !== false;
    } catch {
      this.broken = true;
      return false;
    }
    // Un solo NaN/Inf del instrumento envenenaría PARA SIEMPRE los estados IIR
    // de la cadena del canal y del master (igual que el scrub del camino de
    // efectos): se descarta el tramo y la voz pasa a bypass permanente.
    for (let i = from; i < to; i++) {
      if (!Number.isFinite(sl[i]!) || !Number.isFinite(sr[i]!)) {
        this.broken = true;
        return false;
      }
    }
    for (let i = from; i < to; i++) {
      outL[i]! += sl[i]! * gainL;
      outR[i]! += sr[i]! * gainR;
    }
    return ret;
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
