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
    this.started = false;
  }

  // ── Consulta ───────────────────────────────────────────────────────────────

  /** ¿Está el contenido de este sample en la sala? */
  has(hash: string): boolean {
    return this.assets.has(hash);
  }

  /** Bytes publicados bajo ese hash, o null si la sala no los tiene. */
  get(hash: string): Uint8Array | null {
    return this.assets.get(hash)?.bytes ?? null;
  }

  /** Ficha del asset (sin tocar el blob si solo quieres el nombre/tamaño). */
  meta(hash: string): Omit<SampleAsset, 'bytes'> | null {
    const asset = this.assets.get(hash);
    if (!asset) return null;
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
      if (!this.sizes.has(hash)) {
        this.sizes.set(hash, asset.size ?? asset.bytes.byteLength);
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
}
