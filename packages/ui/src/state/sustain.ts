/**
 * Pedal de sostenido (CC 64) de los controladores MIDI.
 *
 * Con el pedal pisado, un note-off NO suelta la nota: se apunta y se suelta
 * al levantarlo. Y hay dos casos que se olvidan siempre y dejan notas
 * colgando para siempre:
 *
 * 1. **Repicar la misma tecla con el pedal pisado.** El note-on llega a una
 *    fuente que ya está sonando y el kernel lo ignora; hay que soltarla
 *    primero para que la nueva ataque.
 * 2. **Desenchufar el teclado (o apagarlo) con el pedal pisado.** Nadie va a
 *    mandar ya el CC 64 con valor 0.
 *
 * El pedal se lleva POR DISPOSITIVO: con dos teclados enchufados, el pedal de
 * uno no puede sostener lo que toca el otro.
 */

export class SustainPedal {
  /** Dispositivos con el pedal pisado ahora mismo. */
  private down = new Set<string>();
  /** Fuente retenida → dispositivo cuyo pedal la retiene. */
  private waiting = new Map<string, string>();

  /** ¿Está pisado el pedal de este dispositivo? */
  isDown(deviceId: string): boolean {
    return this.down.has(deviceId);
  }

  press(deviceId: string): void {
    this.down.add(deviceId);
  }

  /** Levanta el pedal y devuelve las fuentes que hay que soltar ya. */
  release(deviceId: string): string[] {
    this.down.delete(deviceId);
    const out: string[] = [];
    for (const [source, owner] of this.waiting) {
      if (owner === deviceId) {
        out.push(source);
        this.waiting.delete(source);
      }
    }
    return out;
  }

  /**
   * ¿Se retiene este note-off? `true` = la nota sigue sonando y queda apuntada;
   * `false` = suéltala como siempre.
   */
  holdNoteOff(deviceId: string, source: string): boolean {
    if (!this.down.has(deviceId)) return false;
    this.waiting.set(source, deviceId);
    return true;
  }

  /**
   * Antes de un note-on: si esa fuente estaba retenida por el pedal, hay que
   * soltarla ANTES de atacar la nueva (repicar la misma tecla). Devuelve
   * `true` cuando toca hacerlo, y deja de estar retenida.
   */
  takeRetrigger(source: string): boolean {
    return this.waiting.delete(source);
  }

  /**
   * Olvida lo retenido de un dispositivo (se desenchufó o lo apagaron) y
   * levanta su pedal. Devuelve las fuentes que hay que soltar.
   */
  forgetDevice(deviceId: string): string[] {
    return this.release(deviceId);
  }

  /** Olvida TODO (la ventana perdió el foco, panic). */
  clear(): string[] {
    const out = [...this.waiting.keys()];
    this.waiting.clear();
    this.down.clear();
    return out;
  }

  /** Cuántas notas retiene ahora mismo (para la UI y las pruebas). */
  get holding(): number {
    return this.waiting.size;
  }
}
