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

  /**
   * Semitonos que la rueda de tono le suma a esta voz, ahora mismo.
   *
   * Vive en la voz y no en el canal porque doblar el tono es doblar lo que YA
   * está sonando: la rueda no dispara nada, mueve lo que hay. El kernel se
   * guarda además el valor por canal para que una nota nacida con la rueda
   * doblada nazca doblada — sin eso, sostener la rueda y tocar una nota nueva
   * daba una nota sin doblar, que es justo la incoherencia que se oye.
   */
  protected bend = 0;

  constructor(
    public readonly channelIndex: number,
    public key: number,
    public readonly startOrder: number,
  ) {}

  abstract noteOff(): void;

  /**
   * Dobla el tono de la voz viva. `semitones` es bipolar (la rueda arriba del
   * todo con rango 2 son +2).
   *
   * Se sale enseguida si el valor no cambió: la rueda manda decenas de
   * mensajes por segundo y hay hasta 64 voces sonando, así que recalcular por
   * gusto es trabajo tirado dentro del hilo de audio.
   */
  setBend(semitones: number, snap = false): void {
    if (semitones === this.bend && !snap) return;
    this.bend = semitones;
    this.retune(snap);
  }

  /**
   * Recalcula la altura desde `key + bend`. Cada instrumento la implementa
   * porque cada uno la guarda a su manera —frecuencia, ritmo de lectura del
   * sample, razón de los osciladores— y el cuerpo vacío por defecto es una
   * decisión: una voz que no sabe reafinarse no debe fingir que sí.
   *
   * La llaman `setBend` y `glideTo`: los dos cambian la altura de una voz
   * viva, y tenerlos apuntando al mismo sitio es lo que evita que el slide
   * arregle una cosa y la rueda se olvide de ella.
   *
   * `snap` distingue los dos casos que NO suenan igual: la rueda moviéndose
   * (el 808 y Prisma arrastran la altura con su portamento, que es su
   * carácter) y una nota que NACE con la rueda ya doblada (tiene que salir ya
   * ahí, no subir sola desde la nota sin doblar durante los primeros 60 ms).
   */
  protected retune(_snap = false): void {}

  /** Nota slide: la voz cambia de altura sin retrigger (808). */
  glideTo(key: number, _velocity: number): void {
    this.key = key;
    this.retune();
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
