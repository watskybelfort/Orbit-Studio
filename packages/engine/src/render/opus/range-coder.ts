/**
 * Range coder de Opus (RFC 6716 §4.1), las dos direcciones.
 *
 * Es el cimiento de todo el códec: en Opus **no hay campos de bits**. Cada
 * decisión (¿silencio?, ¿transitorio?, la energía de esta banda, la forma de
 * este vector) se codifica contra un modelo de probabilidad, y el decodificador
 * las lee EN EL MISMO ORDEN y con el MISMO modelo. Si el encoder y el decoder
 * discrepan en un solo símbolo, todo lo que viene detrás sale basura — no hay
 * resincronización posible. Por eso esto va primero, aparte, y con tests que lo
 * machacan antes de que exista una sola muestra de audio.
 *
 * Tres cosas del formato que NO son opcionales:
 *
 * 1. **Los bits crudos se escriben desde el FINAL del paquete, hacia atrás.**
 *    Opus mete por un extremo los símbolos del range coder y por el otro los
 *    bits que no necesitan modelo (los signos de la PVQ, por ejemplo). Los dos
 *    flujos crecen el uno hacia el otro.
 * 2. **El paquete mide lo que se decidió al empezar**, y el hueco que quede en
 *    medio va a ceros. No se puede compactar: el decodificador cuenta desde el
 *    final para los bits crudos, así que mover ese extremo lo desincroniza. Es
 *    justo por eso que el tamaño se le da al constructor.
 * 3. **El acarreo se propaga hacia atrás** sobre lo ya escrito: se guarda un
 *    byte pendiente (`rem`) y cuántos 0xFF van detrás (`ext`); cuando sale un
 *    byte que no es 0xFF, se resuelve la cadena entera.
 *
 * Aritmética: JS no tiene enteros de 32 bits sin signo, y `<<` opera en 32 bits
 * CON signo. Donde un valor puede llegar a 2^31 o pasar de ahí se multiplica y
 * se enmascara en coma flotante (exacto hasta 2^53) en vez de desplazar.
 */

const EC_SYM_BITS = 8;
const EC_CODE_BITS = 32;
const EC_SYM_MAX = 0xff;
/** 2^31. Como número, no como `1 << 31` (que en JS es negativo). */
const EC_CODE_TOP = 2147483648;
/** 2^23: por debajo de aquí hay que renormalizar. */
const EC_CODE_BOT = 8388608;
/** 2^32: el estado del encoder vive ahí, y ese bit de más ES el acarreo. */
const EC_WRAP = 4294967296;
/** Bits del primer byte que entran en `val` al arrancar el decodificador. */
const EC_CODE_EXTRA = ((EC_CODE_BITS - 2) % EC_SYM_BITS) + 1;
/** Tope de los enteros que se codifican con modelo antes de tirar de bits crudos. */
const EC_UINT_BITS = 8;

/** Bits significativos de un entero (0 → 0). */
function ilog(x: number): number {
  let n = 0;
  let v = x;
  while (v > 0) {
    n++;
    v = Math.floor(v / 2);
  }
  return n;
}

/**
 * Los tres pasos de refinado que la spec usa para contar FRACCIONES de bit.
 * Es el mismo cálculo en el encoder y en el decoder, y de ahí sale que los dos
 * lados sepan exactamente cuánto se ha gastado.
 */
function fracFromRange(nbitsTotal: number, rng: number): number {
  const l = ilog(rng);
  let r = Math.floor(rng / 2 ** (l - 16));
  let b = 0;
  for (let i = 0; i < 3; i++) {
    r = Math.floor((r * r) / 32768);
    const shift = r >= 65536 ? 1 : 0;
    b = b * 2 + shift;
    r = shift ? Math.floor(r / 2) : r;
  }
  // Sin `+1`: un codificador recién creado declara 1 bit usado, que en octavos
  // son exactamente 8. Un desplazamiento constante aquí es invisible en una ida
  // y vuelta contra uno mismo —los dos lados lo comparten— pero descuadra TODAS
  // las decisiones de presupuesto contra cualquier otro decodificador.
  return nbitsTotal * 8 - (l * 8 + b);
}

// ── Encoder ──────────────────────────────────────────────────────────────────

export class RangeEncoder {
  private buf: Uint8Array;
  /** Bytes escritos por delante (el flujo del range coder). */
  private offs = 0;
  /** Bytes escritos por detrás (el flujo de bits crudos). */
  private endOffs = 0;
  /** Acumulador y bits pendientes del flujo de atrás. */
  private endWindow = 0;
  private endBits = 0;

  private val = 0;
  private rng = EC_CODE_TOP;
  /** Byte pendiente de salir, o -1 si aún no hay ninguno. */
  private rem = -1;
  /** Cuántos 0xFF esperan a saber si les llega acarreo. */
  private ext = 0;
  private nbitsTotal = EC_CODE_BITS + 1;
  /** Se pidió más espacio del que hay: el paquete ya no vale. */
  private overflow = false;

  /** `size` es el tamaño EXACTO del paquete (ver la nota 2 de arriba). */
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }

  get busted(): boolean {
    return this.overflow;
  }

  /**
   * Copia exacta del estado, para poder **probar dos codificaciones y quedarse
   * con la mejor**.
   *
   * CELT lo necesita en la energía de banda: se codifica la trama prediciendo de
   * la anterior y también sin predecir, y se elige la que salga mejor. Sin poder
   * clonar habría que elegir a ciegas, y elegir mal deja la energía de la banda
   * en un valor equivocado — que es de las cosas que peor se oyen.
   */
  clone(): RangeEncoder {
    const copy = new RangeEncoder(this.buf.length);
    copy.buf = Uint8Array.from(this.buf);
    copy.offs = this.offs;
    copy.endOffs = this.endOffs;
    copy.endWindow = this.endWindow;
    copy.endBits = this.endBits;
    copy.val = this.val;
    copy.rng = this.rng;
    copy.rem = this.rem;
    copy.ext = this.ext;
    copy.nbitsTotal = this.nbitsTotal;
    copy.overflow = this.overflow;
    return copy;
  }

  /** Vuelca sobre este codificador el estado de otro. La vuelta de `clone`. */
  restore(other: RangeEncoder): void {
    this.buf.set(other.buf);
    this.offs = other.offs;
    this.endOffs = other.endOffs;
    this.endWindow = other.endWindow;
    this.endBits = other.endBits;
    this.val = other.val;
    this.rng = other.rng;
    this.rem = other.rem;
    this.ext = other.ext;
    this.nbitsTotal = other.nbitsTotal;
    this.overflow = other.overflow;
  }

  /**
   * Saca un byte, resolviendo el acarreo pendiente.
   *
   * La comparación es contra **0xFF y no contra 0x100**, y ahí se esconde todo
   * el mecanismo: un byte que vale 0xFF no se puede escribir todavía, porque si
   * luego llega acarreo se convierte en 0x00 y el acarreo sigue hacia atrás. Se
   * cuenta en `ext` y se resuelve cuando salga uno que no sea 0xFF. Cualquier
   * otro valor —incluido 0x100, que ES el acarreo— sí se puede volcar.
   */
  private carryOut(c: number): void {
    if (c !== EC_SYM_MAX) {
      const carry = c >> EC_SYM_BITS;
      if (this.rem >= 0) this.write(this.rem + carry);
      if (this.ext > 0) {
        const sym = (EC_SYM_MAX + carry) & EC_SYM_MAX;
        do {
          this.write(sym);
        } while (--this.ext > 0);
      }
      this.rem = c & EC_SYM_MAX;
    } else {
      this.ext++;
    }
  }

  private write(byte: number): void {
    if (this.offs + this.endOffs >= this.buf.length) {
      this.overflow = true;
      return;
    }
    this.buf[this.offs++] = byte & 0xff;
  }

  /**
   * Renormaliza y saca bytes.
   *
   * `val` vive en 32 bits, no en 31: la suma de `encode` puede desbordar por
   * arriba, y ESE bit de más es el acarreo. Enmascararlo antes de tiempo —que
   * es el error fácil— lo pierde, y el paquete sale desincronizado unos cuantos
   * símbolos más adelante, cuando ya no se sabe de dónde vino.
   */
  private normalize(): void {
    while (this.rng <= EC_CODE_BOT) {
      this.carryOut(Math.floor(this.val / EC_CODE_BOT));
      this.val = (this.val * 256) % EC_CODE_TOP;
      this.rng *= 256;
      this.nbitsTotal += EC_SYM_BITS;
    }
  }

  /** Símbolo con intervalo [fl, fh) sobre `ft`. De aquí salen todos los demás. */
  encode(fl: number, fh: number, ft: number): void {
    const r = Math.floor(this.rng / ft);
    if (fl > 0) {
      this.val = (this.val + this.rng - r * (ft - fl)) % EC_WRAP;
      this.rng = r * (fh - fl);
    } else {
      this.rng -= r * (ft - fh);
    }
    this.normalize();
  }

  /** Un bit cuya probabilidad de ser 0 es 1 − 2^−logp. */
  bitLogp(bit: number, logp: number): void {
    const r = this.rng;
    const s = Math.floor(r / 2 ** logp);
    if (bit) {
      this.val = (this.val + r - s) % EC_WRAP;
      this.rng = s;
    } else {
      this.rng = r - s;
    }
    this.normalize();
  }

  /**
   * Símbolo con tabla ICDF, que es como la spec da casi todos sus modelos:
   * `icdf[i]` guarda `2^ftb − CDF(i)`, así que la tabla termina en 0.
   */
  icdf(s: number, icdf: readonly number[] | Uint8Array, ftb: number): void {
    const r = Math.floor(this.rng / 2 ** ftb);
    if (s > 0) {
      this.val = (this.val + this.rng - r * icdf[s - 1]!) % EC_WRAP;
      this.rng = r * (icdf[s - 1]! - icdf[s]!);
    } else {
      this.rng -= r * icdf[s]!;
    }
    this.normalize();
  }

  /**
   * Entero uniforme en [0, ft). Con más de 8 bits, los altos van por el modelo
   * y los bajos como bits crudos: gastar precisión del range coder en valores
   * uniformes grandes no compensa.
   */
  uint(value: number, ft: number): void {
    const total = ft - 1;
    const bits = ilog(total);
    if (bits > EC_UINT_BITS) {
      const shift = bits - EC_UINT_BITS;
      const top = Math.floor(total / 2 ** shift) + 1;
      const hi = Math.floor(value / 2 ** shift);
      this.encode(hi, hi + 1, top);
      this.bits(value % 2 ** shift, shift);
    } else {
      this.encode(value, value + 1, ft);
    }
  }

  /** Bits crudos, hacia atrás desde el final del paquete. */
  bits(value: number, count: number): void {
    let window = this.endWindow;
    let used = this.endBits;
    if (used + count > 32) {
      do {
        if (this.offs + this.endOffs >= this.buf.length) {
          this.overflow = true;
          break;
        }
        this.buf[this.buf.length - ++this.endOffs] = window & EC_SYM_MAX;
        window = Math.floor(window / 256);
        used -= EC_SYM_BITS;
      } while (used >= EC_SYM_BITS);
    }
    window += value * 2 ** used;
    used += count;
    this.endWindow = window;
    this.endBits = used;
    this.nbitsTotal += count;
  }

  /** Bits gastados, redondeando hacia arriba. */
  tell(): number {
    return this.nbitsTotal - ilog(this.rng);
  }

  /** Bits gastados en OCTAVOS de bit: es lo que mira el asignador de CELT. */
  tellFrac(): number {
    return fracFromRange(this.nbitsTotal, this.rng);
  }

  /**
   * Cierra el paquete. Devuelve el buffer ENTERO del tamaño pedido: el hueco
   * entre los dos flujos va a ceros (ver la nota 2 de la cabecera).
   */
  done(): Uint8Array {
    let l = EC_CODE_BITS - ilog(this.rng);
    let msk = Math.floor((EC_CODE_TOP - 1) / 2 ** l);
    let end = ((this.val + msk) % EC_WRAP) - (((this.val + msk) % EC_WRAP) % (msk + 1));
    // La comparación es en 32 bits SIN signo, como en la spec: la suma puede
    // desbordar, y ese desbordamiento forma parte del cálculo.
    if (end + msk >= (this.val + this.rng) % EC_WRAP) {
      l++;
      msk = Math.floor(msk / 2);
      end = ((this.val + msk) % EC_WRAP) - (((this.val + msk) % EC_WRAP) % (msk + 1));
    }
    while (l > 0) {
      this.carryOut(Math.floor(end / EC_CODE_BOT));
      end = (end * 256) % EC_CODE_TOP;
      l -= EC_SYM_BITS;
    }
    if (this.rem >= 0 || this.ext > 0) this.carryOut(0);

    // Lo que quede en el acumulador de atrás, byte a byte.
    let window = this.endWindow;
    let used = this.endBits;
    while (used >= EC_SYM_BITS) {
      if (this.offs + this.endOffs >= this.buf.length) {
        this.overflow = true;
        break;
      }
      this.buf[this.buf.length - ++this.endOffs] = window & EC_SYM_MAX;
      window = Math.floor(window / 256);
      used -= EC_SYM_BITS;
    }
    // El resto se mete en el último byte del flujo de atrás con un OR: ese byte
    // ya está a medias y los bits que le faltan son justo estos.
    this.buf.fill(0, this.offs, this.buf.length - this.endOffs);
    if (used > 0 && this.endOffs < this.buf.length) {
      this.buf[this.buf.length - this.endOffs - 1]! |= window & EC_SYM_MAX;
    }
    return this.buf;
  }
}

// ── Decoder ──────────────────────────────────────────────────────────────────

export class RangeDecoder {
  private readonly buf: Uint8Array;
  private offs = 0;
  private endOffs = 0;
  private endWindow = 0;
  private endBits = 0;
  private val = 0;
  private rng = 0;
  private rem = 0;
  private nbitsTotal = 0;
  /** `rng/ft` de la última llamada a `decode`, que `update` necesita. */
  private ext = 1;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.nbitsTotal =
      EC_CODE_BITS + 1 - Math.floor((EC_CODE_BITS - EC_CODE_EXTRA) / EC_SYM_BITS) * EC_SYM_BITS;
    this.rng = 2 ** EC_CODE_EXTRA;
    this.rem = this.readByte();
    this.val = this.rng - 1 - (this.rem >> (EC_SYM_BITS - EC_CODE_EXTRA));
    this.normalize();
  }

  private readByte(): number {
    return this.offs < this.buf.length ? this.buf[this.offs++]! : 0;
  }

  private readByteFromEnd(): number {
    return this.endOffs < this.buf.length ? this.buf[this.buf.length - ++this.endOffs]! : 0;
  }

  private normalize(): void {
    while (this.rng <= EC_CODE_BOT) {
      this.nbitsTotal += EC_SYM_BITS;
      this.rng *= 256;
      const old = this.rem;
      this.rem = this.readByte();
      const sym = ((old * 256 + this.rem) >> (EC_SYM_BITS - EC_CODE_EXTRA)) & EC_SYM_MAX;
      this.val = (this.val * 256 + (EC_SYM_MAX - sym)) % EC_CODE_TOP;
    }
  }

  /** Paso 1: dónde cae el valor dentro de un total `ft`. */
  decode(ft: number): number {
    this.ext = Math.floor(this.rng / ft);
    const s = Math.floor(this.val / this.ext);
    return ft - Math.min(s + 1, ft);
  }

  /** Paso 2: confirmar el símbolo una vez conocido su intervalo. */
  update(fl: number, fh: number, ft: number): void {
    const s = this.ext * (ft - fh);
    this.val -= s;
    this.rng = fl > 0 ? this.ext * (fh - fl) : this.rng - s;
    this.normalize();
  }

  bitLogp(logp: number): number {
    const r = this.rng;
    const d = this.val;
    const s = Math.floor(r / 2 ** logp);
    const ret = d < s ? 1 : 0;
    if (!ret) this.val = d - s;
    this.rng = ret ? s : r - s;
    this.normalize();
    return ret;
  }

  icdf(icdf: readonly number[] | Uint8Array, ftb: number): number {
    let s = this.rng;
    const d = this.val;
    const r = Math.floor(s / 2 ** ftb);
    let ret = -1;
    let t = s;
    do {
      t = s;
      s = r * icdf[++ret]!;
    } while (d < s);
    this.val = d - s;
    this.rng = t - s;
    this.normalize();
    return ret;
  }

  uint(ft: number): number {
    const total = ft - 1;
    const bits = ilog(total);
    if (bits > EC_UINT_BITS) {
      const shift = bits - EC_UINT_BITS;
      const top = Math.floor(total / 2 ** shift) + 1;
      const s = this.decode(top);
      this.update(s, s + 1, top);
      return s * 2 ** shift + this.bits(shift);
    }
    const s = this.decode(ft);
    this.update(s, s + 1, ft);
    return s;
  }

  bits(count: number): number {
    let window = this.endWindow;
    let used = this.endBits;
    while (used < count) {
      window += this.readByteFromEnd() * 2 ** used;
      used += EC_SYM_BITS;
    }
    const ret = window % 2 ** count;
    this.endWindow = Math.floor(window / 2 ** count);
    this.endBits = used - count;
    this.nbitsTotal += count;
    return ret;
  }

  tell(): number {
    return this.nbitsTotal - ilog(this.rng);
  }

  tellFrac(): number {
    return fracFromRange(this.nbitsTotal, this.rng);
  }
}
