/**
 * Base de las voces de instrumento.
 *
 * Vive aparte de `voices.ts` por una razón muy concreta: los instrumentos
 * grandes (Prisma) están en su propio archivo y heredan de `Voice`, mientras
 * que `voices.ts` necesita importarlos para su fábrica. Con la clase base aquí
 * la dependencia va en un solo sentido y no hay ciclo — un `class X extends Y`
 * con Y a medio evaluar es un ReferenceError al cargar el módulo, no un aviso
 * del compilador.
 */

export interface SampleData {
  left: Float32Array;
  right: Float32Array;
  rate: number;
}

export interface VoiceContext {
  sr: number;
  samples: Map<string, SampleData>;
  /**
   * Buffers de trabajo del kernel, compartidos por todas las voces (se
   * renderiza una detrás de otra en el mismo hilo). Los usa Nova para saturar
   * la suma de sus capas sin alocar nada por nota.
   */
  scratchL?: Float32Array;
  scratchR?: Float32Array;
}

export abstract class Voice {
  releasing = false;

  constructor(
    public readonly channelIndex: number,
    public key: number,
    public readonly startOrder: number,
  ) {}

  abstract noteOff(): void;

  /** Nota slide: la voz cambia de altura sin retrigger (808). */
  glideTo(key: number, _velocity: number): void {
    this.key = key;
  }

  /**
   * Suelta recursos prestados a un pool. El kernel la llama cuando descarta
   * una voz por robo, no solo cuando la voz muere sola: si no, un pool se
   * quedaría sin existencias tras un pasaje denso. Casi ninguna voz necesita
   * esto, de ahí el cuerpo vacío por defecto.
   */
  dispose(): void {}

  /**
   * Renderiza [from, to) sumando en outL/outR con las ganancias dadas.
   * Devuelve false cuando la voz terminó (el kernel la recicla).
   */
  abstract render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    gainL: number,
    gainR: number,
  ): boolean;
}
