/**
 * Los BYTES de los samples viajan con la sala.
 *
 * El log de comandos replica REFERENCIAS (`SampleRef`), no contenido: al otro
 * lado llegaba "canal sampler con sampleId X", pero su kernel nunca había
 * recibido X, así que la voz salía muda y el clip de audio, silencio. Sonaba
 * "a veces" por casualidad — solo si el otro ya había pinchado ESE mismo sonido
 * de fábrica en su Browser y su kernel lo tenía cacheado bajo el mismo id. Una
 * grabación o un bounce no sonaban nunca en la otra máquina.
 *
 * Aquí va el contenido, en un `Y.Map` 'assets' del MISMO documento, indexado
 * por HASH (el sha1 que `SampleRef.hash` ya trae) y no por id:
 * - el hash es idéntico en las dos máquinas aunque el id no tenga por qué serlo,
 * - dos referencias al mismo archivo comparten un único blob,
 * - y republicar algo que ya está en la sala se detecta sin preguntar a nadie.
 *
 * Lo de fábrica NO se sube: `factory:<ruta>` se resuelve leyendo el pack local
 * en ambas máquinas, y subirlo sería mandar el pack entero por la red.
 *
 * Hay tope por sample y tope por sala porque el documento Yjs vive en memoria
 * en TODOS los clientes y el servidor lo persiste entero: un stem de diez
 * minutos dentro del doc penaliza a todo el mundo, incluido quien no lo usa.
 * Lo que no cabe no se sube y se avisa por `onRejected` (la UI lo enseña).
 */

import * as Y from 'yjs';

/** Tope por sample. Cubre one-shots, loops y tomas de voz normales. */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;

/** Tope de TODO lo publicado en una sala. */
export const MAX_ROOM_ASSET_BYTES = 64 * 1024 * 1024;

/** Un sample publicado en la sala (contenido + lo justo para explicarlo). */
export interface SampleAsset {
  /** sha1 del archivo: la clave del mapa. */
  hash: string;
  /** Nombre visible, solo para los avisos ("«Vox take 3» no cabe…"). */
  name: string;
  /** Tamaño en bytes del archivo original. */
  size: number;
  /** Nombre de quien lo subió. */
  by: string;
  /** Epoch ms del emisor; informativo. */
  at: number;
  bytes: Uint8Array;
}

/** Resultado de intentar publicar un sample. */
export type PublishResult = 'published' | 'duplicate' | 'too-large' | 'room-full' | 'invalid';

/**
 * ¿Este valor tiene la forma de un `SampleAsset`? El Y.Map lo escribe
 * cualquiera que sepa hablar el protocolo (un cliente modificado, un .bin
 * manipulado), así que la sala no se fía de su contenido: sin `bytes` de
 * verdad no hay nada que servir al kernel, y unas `hash`/`name` que no sean
 * texto romperían los avisos y los índices. Lo malformado se ignora, nunca se
 * deja tumbar el scan (que es el que anuncia TODO lo demás).
 */
export function isSampleAsset(value: unknown): value is SampleAsset {
  if (typeof value !== 'object' || value === null) return false;
  const asset = value as Partial<SampleAsset>;
  return (
    typeof asset.hash === 'string' &&
    typeof asset.name === 'string' &&
    asset.bytes instanceof Uint8Array
  );
}

/** Nombre con el que avisar de un asset malformado (aunque no tenga `name`). */
function assetName(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim() !== '') return name;
  }
  return fallback;
}


/** Motivos por los que un sample NO llega a la sala. */
export type RejectReason = Exclude<PublishResult, 'published' | 'duplicate'>;

/** Aviso de sample que se queda fuera (para enseñarlo tal cual en la UI). */
export interface AssetRejection {
  hash: string;
  name: string;
  size: number;
  reason: RejectReason;
  /** Motivo legible en español. */
  message: string;
}

export interface SampleAssetOptions {
  /** Tope por sample (por defecto MAX_ASSET_BYTES). */
  maxAssetBytes?: number;
  /** Tope acumulado de la sala (por defecto MAX_ROOM_ASSET_BYTES). */
  maxRoomBytes?: number;
  /**
   * Hay contenido NUEVO disponible en la sala. Se llama UNA sola vez por hash
   * (lo que publicamos nosotros no se anuncia: ya lo teníamos).
   */
  onAsset?: (asset: SampleAsset) => void;
  /** El sample no entra en la sala (demasiado grande o sala llena). */
  onRejected?: (info: AssetRejection) => void;
}

/** Megabytes legibles para los mensajes ("16 MB"). */
function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Enlace del almacén de samples con un Y.Doc. Igual que CommandLogBinding y
 * ChatBinding, no sabe nada de WebSockets: se prueba conectando dos Y.Doc a
 * mano.
 */
export class SampleAssetBinding {
  private readonly doc: Y.Doc;
  private readonly assets: Y.Map<SampleAsset>;
  private readonly maxAssetBytes: number;
  private readonly maxRoomBytes: number;
  private readonly onAsset: ((asset: SampleAsset) => void) | undefined;
  private readonly onRejected: ((info: AssetRejection) => void) | undefined;

  /** Tamaño por hash: así `totalBytes` no toca los blobs. */
  private readonly sizes = new Map<string, number>();
  /** Hashes ya anunciados (o publicados por nosotros): no se repiten. */
  private readonly notified = new Set<string>();
  /** Hashes descartados por pasarse del tope (ya avisados): no se repiten. */
  private readonly oversized = new Set<string>();
  /** Hashes malformados ya avisados: no se repite el aviso en cada scan. */
  private readonly malformed = new Set<string>();
  /** Hashes a los que se les intentó cambiar los bytes (para avisar una vez). */
  private readonly substituted = new Set<string>();
  /** Hashes cuyo contenido no corresponde a la clave (para avisar una vez). */
  private readonly hashFalso = new Set<string>();
  /** Hashes que no caben ya en el presupuesto de la sala (para avisar una vez). */
  private readonly overflow = new Set<string>();
  /**
 * Bytes con los que se aceptó cada hash la PRIMERA vez: una HUELLA, no el audio.
 *
 * El hash ES la identidad del contenido: si el mapa del doc dijera otra cosa más
 * tarde, el audio que oye esta máquina no cambia por sorpresa. El servidor también
 * lo restituye (y con el SHA-1 real lo comprueba), pero un `.bin` manipulado o un
 * cliente modificado pueden llegar al binding antes de que el servidor actúe.
 *
 * Se guarda la huella y no los bytes a propósito: una copia por sample duplicaba
 * hasta 16 MB por entrada en memoria, incluso de los assets que luego se rechazan
 * por los topes. Y la huella NO se borra cuando el asset desaparece del mapa: eso es
 * lo que hace que borrar y volver a publicar el mismo hash con otro audio siga sin
 * colarse (BUG 055).
 */
private readonly identity = new Map<string, string>();
  /**
   * Hashes que NO se sirven, por lo que sea: los que llegaron con bytes distintos de
   * los de su huella, los que no corresponden a su hash, y los que ya no caben en el
   * presupuesto de la sala. Los motivos se recuerdan aparte, para avisar una vez.
   */
  private readonly noServibles = new Set<string>();
  private readonly callbacks = new Set<() => void>();
  private observer: (() => void) | null = null;
  private started = false;

  constructor(doc: Y.Doc, opts: SampleAssetOptions = {}) {
    this.doc = doc;
    this.assets = doc.getMap<SampleAsset>('assets');
    this.maxAssetBytes = opts.maxAssetBytes ?? MAX_ASSET_BYTES;
    this.maxRoomBytes = opts.maxRoomBytes ?? MAX_ROOM_ASSET_BYTES;
    this.onAsset = opts.onAsset;
    this.onRejected = opts.onRejected;
  }

  /**
   * Empieza a observar. Anuncia primero lo que la sala ya traía (el que se une
   * tarde recibe todo el contenido junto con el proyecto).
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.observer = () => this.scan();
    this.assets.observe(this.observer);
    this.scan();
  }

  /** Suelta el observer. No borra nada del doc. */
  destroy(): void {
    if (this.observer) {
      this.assets.unobserve(this.observer);
      this.observer = null;
    }
    this.callbacks.clear();
    // Las huellas también se van: no hacen falta sin estar escuchando, y no tiene
    // sentido acumular la identidad de todo lo que se oyó en una sesión cerrada.
    this.identity.clear();
    this.noServibles.clear();
    this.started = false;
  }

  // ── Consulta ───────────────────────────────────────────────────────────────

  /** ¿Está el contenido de este sample en la sala? */
  has(hash: string): boolean {
    return isSampleAsset(this.assets.get(hash));
  }

  /** Bytes publicados bajo ese hash, o null si la sala no los tiene. */
  get(hash: string): Uint8Array | null {
    const asset = this.assets.get(hash);
    if (!asset || !isSampleAsset(asset)) return null;
    // El receptor tampoco se fía: un blob por encima del tope por sample no se
    // sirve al kernel aunque esté en el doc (un cliente modificado o un .bin
    // manipulado podría haberlo colado saltándose la validación del emisor).
    if (asset.bytes.byteLength > this.maxAssetBytes) return null;
    // Si estos bytes no son los de la huella que se aceptó para ese hash, no se
    // sirven: el hash es la identidad y el servidor va a devolver el original
    // (BUG 055). Antes se guardaba una copia congelada de los bytes; ahora se
    // guarda solo la huella, así que aquí lo sano es no servir antes de que llegue.
    if (this.noServibles.has(hash)) return null;
    return asset.bytes;
  }

  /** Ficha del asset (sin tocar el blob si solo quieres el nombre/tamaño). */
  meta(hash: string): Omit<SampleAsset, 'bytes'> | null {
    const asset = this.assets.get(hash);
    if (!asset || !isSampleAsset(asset)) return null;
    const { hash: h, name, size, by, at } = asset;
    return { hash: h, name, size, by, at };
  }

  /** Hashes disponibles en la sala. */
  get hashes(): string[] {
    return [...this.assets.keys()];
  }

  /** Cuántos bytes ocupa el contenido publicado en la sala. */
  get totalBytes(): number {
    let total = 0;
    for (const size of this.sizes.values()) total += size;
    return total;
  }

  /** Suscripción a "cambió el almacén". Devuelve el unsubscribe. */
  onChanged(cb: () => void): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  // ── Publicación ────────────────────────────────────────────────────────────

  /**
   * Sube el contenido de un sample. Idempotente por hash: si la sala ya lo
   * tiene devuelve 'duplicate' SIN volver a escribir (dos personas que arrastran
   * el mismo archivo no lo mandan dos veces). Lo que no cabe se rechaza con
   * aviso: la sesión no se rompe, ese sonido simplemente no suena en la otra
   * máquina y la UI lo dice.
   */
  publish(bytes: Uint8Array, meta: { hash: string; name: string; by: string }): PublishResult {
    const hash = meta.hash.trim();
    if (hash === '' || bytes.byteLength === 0) {
      this.reject(
        hash,
        meta.name,
        bytes.byteLength,
        'invalid',
        `«${meta.name}» no tiene contenido o no trae hash con el que identificarlo.`,
      );
      return 'invalid';
    }
    if (this.assets.has(hash)) {
      // Ya está: nadie lo vuelve a subir y nadie lo vuelve a pedir.
      this.notified.add(hash);
      return 'duplicate';
    }
    if (bytes.byteLength > this.maxAssetBytes) {
      this.reject(
        hash,
        meta.name,
        bytes.byteLength,
        'too-large',
        `«${meta.name}» ocupa ${mb(bytes.byteLength)} y el tope por sample de la sala es ${mb(this.maxAssetBytes)}. ` +
          'Recórtalo o bouncéalo más corto para que suene en la otra máquina.',
      );
      return 'too-large';
    }
    if (this.totalBytes + bytes.byteLength > this.maxRoomBytes) {
      this.reject(
        hash,
        meta.name,
        bytes.byteLength,
        'room-full',
        `La sala ya lleva ${mb(this.totalBytes)} de samples (tope ${mb(this.maxRoomBytes)}) y «${meta.name}» no cabe. ` +
          'Los sonidos nuevos no llegarán a la otra máquina hasta liberar sitio.',
      );
      return 'room-full';
    }

    const asset: SampleAsset = {
      hash,
      name: meta.name,
      size: bytes.byteLength,
      by: meta.by,
      at: Date.now(),
      // Copia propia: el ArrayBuffer de origen puede ser una vista de otro
      // buffer más grande (o reutilizarse) y Yjs se queda con lo que le demos.
      bytes: new Uint8Array(bytes),
    };
    // Lo nuestro no se anuncia: el contenido ya está en nuestro kernel.
    this.notified.add(hash);
    this.doc.transact(() => {
      this.assets.set(hash, asset);
    }, this);
    return 'published';
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  /** Recorre el mapa y anuncia lo que aún no habíamos visto. */
  private scan(): void {
    let changed = false;
    const fresh: SampleAsset[] = [];
    for (const [hash, asset] of this.assets.entries()) {
      // La forma primero: una entrada sin bytes (o con hash/name que no son
      // texto) no se cuenta, no se sirve y NO se propaga el error. Antes este
      // `asset.bytes.byteLength` tumbaba el observer entero, así que un solo
      // asset malo dejaba sin anunciar a TODOS los legítimos.
      if (!isSampleAsset(asset)) {
        if (!this.malformed.has(hash)) {
          this.malformed.add(hash);
          const name = assetName(asset, hash);
          console.warn(`[collab] asset «${name}» (${hash}) con forma inválida: se ignora`);
          this.onRejected?.({
            hash,
            name,
            size: 0,
            reason: 'invalid',
            message:
              `«${name}» llegó a la sala incompleto (sin sus bytes) y se ignora: no sonará ` +
              'en esta máquina.',
          });
        }
        continue;
      }
      const size = asset.bytes.byteLength;
      // El emisor valida los topes al publicar, pero un cliente modificado (o un
      // .bin manipulado) puede meter en el Y.Map blobs por encima del presupuesto
      // que sostiene la arquitectura. El receptor NO los cuenta, NO los anuncia y
      // NO los carga en el kernel; solo avisa una vez.
      if (size > this.maxAssetBytes) {
        if (!this.oversized.has(hash)) {
          this.oversized.add(hash);
          this.onRejected?.({
            hash,
            name: asset.name,
            size,
            reason: 'too-large',
            message:
              `«${asset.name}» llega desde la sala con ${mb(size)} y el tope por sample es ${mb(this.maxAssetBytes)}. ` +
              'Se ignora: no sonará en esta máquina.',
          });
        }
        continue;
      }
      // El tope de la SALA también se comprueba en el receptor, y ANTES de la huella:
      // si el conjunto ya no cabe en el presupuesto, este sample no se cuenta, no se
      // recuerda y no se anuncia. Antes solo se miraba el tope por sample, así que
      // entre todos los clientes podía colarse un conjunto por encima del presupuesto
      // que sostiene la arquitectura (y el contador de la sala llegaba a mentir).
      if (!this.sizes.has(hash) && this.totalBytes + size > this.maxRoomBytes) {
        // Fuera de servicio mientras la sala siga llena: si luego se borra algo y
        // vuelve a caber, la comprobación de arriba la deja pasar sola.
        this.noServibles.add(hash);
        if (!this.overflow.has(hash)) {
          this.overflow.add(hash);
          this.onRejected?.({
            hash,
            name: asset.name,
            size,
            reason: 'room-full',
            message:
              `«${asset.name}» llega con ${mb(size)} y la sala ya lleva ${mb(this.totalBytes)} ` +
              `(tope ${mb(this.maxRoomBytes)}). Se ignora: no sonará en esta máquina.`,
          });
        }
        continue;
      }
      // LA IDENTIDAD, después de los topes: solo se recuerda lo que se acepta, y se
      // recuerda como HUELLA (unos bytes por hash), no como una copia del audio. El
      // hash es la identidad del contenido, así que si más tarde llegan otros bytes
      // bajo la misma clave no se anuncian ni se sirven: el servidor restituye el
      // original y mientras tanto aquí no se sirve nada (BUG 055).
      //
      // La huella no se borra cuando el asset desaparece del mapa, y es lo que cierra
      // el agujero de borrar-y-volver-a-publicar: si el productor borra el sample y
      // luego publica OTRO audio bajo el mismo hash, la huella sigue diciendo cuál
      // era el bueno. Cuesta ~40 bytes por sample, no 16 MB.
      const huella = huellaDe(asset.bytes);
      const previa = this.identity.get(hash);
      if (previa === undefined) {
        this.identity.set(hash, huella);
        this.noServibles.delete(hash);
        // Y la CORRESPONDENCIA de verdad, en segundo plano: la huella dice "son los
        // mismos bytes que la primera vez", pero no dice que esa primera vez
        // fingiera. El servidor ya lo comprueba (sha1 de los bytes contra la clave),
        // y aquí se repite para que una publicación con el hash mentido no llegue
        // ni a anunciarse como audio de fiar en un cliente con el servidor fuera de
        // juego (un `.bin` manipulado, un cliente modificado).
        this.verificarSha1(hash, asset.bytes, asset.name, size);
      } else if (previa !== huella) {
        this.noServibles.add(hash);
        if (!this.substituted.has(hash)) {
          this.substituted.add(hash);
          console.warn(
            `[collab] el asset ${hash.slice(0, 12)} ya estaba publicado con otros bytes; ` +
              'no se sirve y se espera a que el servidor devuelva el original.',
          );
          this.onRejected?.({
            hash,
            name: asset.name,
            size,
            reason: 'invalid',
            message:
              `«${asset.name}» llega con bytes distintos de los ya publicados con ese hash. ` +
              'No se sirven: la identidad de un sample es su contenido.',
          });
        }
        continue;
      } else {
        this.noServibles.delete(hash);
      }
      if (!this.sizes.has(hash)) {
        this.sizes.set(hash, size);
        changed = true;
      }
      if (this.notified.has(hash)) continue;
      this.notified.add(hash);
      fresh.push(asset);
    }
    // El host podría recortar el mapa algún día; el contador no debe mentir.
    for (const hash of [...this.sizes.keys()]) {
      if (!this.assets.has(hash)) {
        this.sizes.delete(hash);
        changed = true;
      }
    }
    // Anunciar DESPUÉS de recorrer: el handler suele volver a consultar el mapa.
    for (const asset of fresh) this.onAsset?.(asset);
    if (changed || fresh.length > 0) {
      for (const cb of this.callbacks) cb();
    }
  }

  private reject(
    hash: string,
    name: string,
    size: number,
    reason: RejectReason,
    message: string,
  ): void {
    this.onRejected?.({ hash, name, size, reason, message });
  }

  /**
   * ¿Son estos bytes los que el hash dice? El SHA-1 de verdad, con `crypto.subtle`
   * (Chromium y Node lo tienen), pero en SEGUNDO PLANO.
   *
   * En segundo plano porque la llegada de un sample no puede esperar a un digest
   * de 16 MB en el hilo principal, y porque el camino síncrono ya está cubierto por
   * la huella: aquí lo que se añade es el otro lado del contrato, que es que la
   * huella misma sea de un archivo que existe. Si el digest no cuadra, el hash pasa
   * a sospechoso —entonces `get()` deja de servirlo— y se avisa una vez.
   *
   * Sin WebCrypto (o con una clave heredada que no es un sha1) no se hace nada: la
   * huella sigue siendo el veredicto, y es el servidor el que exige la
   * correspondencia en ese caso.
   */
  private verificarSha1(
    hash: string,
    bytes: Uint8Array,
    name: string,
    size: number,
  ): void {
    const sutil = globalThis.crypto?.subtle;
    if (sutil === undefined || !/^[0-9a-f]{40}$/i.test(hash)) return;
    // La copia que se hashea: `bytes` puede ser una vista del buffer del doc, y
    // `digest` necesita un ArrayBuffer propio.
    const copia = bytes.slice();
    void sutil
      .digest('SHA-1', copia)
      .then((buf) => {
        if (hex(new Uint8Array(buf)) === hash.toLowerCase()) return;
        this.noServibles.add(hash);
        if (this.hashFalso.has(hash)) return;
        this.hashFalso.add(hash);
        console.warn(
          `[collab] el asset ${hash.slice(0, 12)} no corresponde a su hash; no se sirve.`,
        );
        this.onRejected?.({
          hash,
          name,
          size,
          reason: 'invalid',
          message:
            `«${name}» llega con bytes que no son los de su hash, así que no son su audio. ` +
            'Se ignora: la identidad de un sample es su contenido.',
        });
      })
      .catch(() => undefined);
  }
}

/** Bytes en hexadecimal en minúsculas, como los sha1 que se comparan. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
/**
 * Huella de un contenido: 64 bits en 16 caracteres hex.
 *
 * No es criptográfica y no pretende serlo: solo sirve para responder "¿son los MISMOS
 * bytes?" sin guardarlos. El servidor sí comprueba el SHA-1 real (allí hay
 * `node:crypto`); aquí, en el renderer, hace falta algo síncrono y sin dependencias,
 * y comparar 16 MB en cada consulta sería criminal. Dos acumuladores distintos
 * (FNV-1a y una mezcla con signo) para que la unión sea de 64 bits y no de 32.
 */
function huellaDe(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = (Math.imul(b ^ byte, 0x85ebca6b) + ((b << 13) | (b >>> 19))) >>> 0;
  }
  // El tamaño va dentro: dos contenidos de igual huella pero distinta longitud son
  // distinto contenido, y el recorte no tiene por qué notarlo.
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0)
    .toString(16)
    .padStart(8, '0')}${bytes.length.toString(16)}`;
}
