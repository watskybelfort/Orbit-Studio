/**
 * Chat de sesión con notas ancladas al timeline.
 *
 * Viaja por el MISMO canal de colaboración (el documento Yjs de la sala): un
 * `Y.Array<ChatMessage>` llamado 'chat'. Ventajas de guardarlo en el doc en
 * vez de inventar un socket aparte:
 *
 * - se sincroniza con el mismo y-sync que el proyecto (cero servidor nuevo),
 * - quien entra tarde recibe la conversación completa igual que el proyecto,
 * - el servidor ya persiste snapshots del doc, así que sobrevive a una caída,
 * - y NO toca el log de comandos: un mensaje no es una mutación del proyecto,
 *   no entra en el undo ni lo filtran los roles (hasta un oyente puede hablar).
 *
 * Una nota anclada es un mensaje con `beat`: el compás/beat absoluto de la
 * playlist al que se refiere ("aquí falta un break en el compás 33").
 */

import * as Y from 'yjs';
import { newId } from '@orbit/core';
import type { CollabUser } from './command-log';

/** Mensaje del chat de sala (anclado al timeline si trae `beat`). */
export interface ChatMessage {
  id: string;
  /** Nombre visible del autor (el de awareness en el momento de enviarlo). */
  user: string;
  /** Color de identidad del autor (dato de red, no un token de tema). */
  color: string;
  text: string;
  /** Epoch ms del emisor (solo para ordenar visualmente dentro de un peer). */
  at: number;
  /** clientID Yjs del emisor: identifica al autor aunque repita nombre. */
  client: number;
  /** Ancla en beats absolutos de la playlist. Sin él es charla normal. */
  beat?: number;
}

/** Tope de mensajes retenidos en el doc (el host recorta los más viejos). */
export const MAX_CHAT_MESSAGES = 300;

export interface ChatOptions {
  /** Solo el host recorta, igual que en la compactación del log. */
  isHost?: () => boolean;
  /** Tope de mensajes (por defecto MAX_CHAT_MESSAGES). */
  maxMessages?: number;
}

/**
 * Enlace del chat con un Y.Doc. No sabe nada de WebSockets: se puede probar
 * conectando dos Y.Doc a mano, igual que CommandLogBinding.
 */
export class ChatBinding {
  private readonly doc: Y.Doc;
  private readonly user: CollabUser;
  private readonly list: Y.Array<ChatMessage>;
  private readonly isHost: () => boolean;
  private readonly maxMessages: number;
  private readonly callbacks = new Set<(messages: ChatMessage[]) => void>();
  private observer: (() => void) | null = null;

  constructor(doc: Y.Doc, user: CollabUser, opts: ChatOptions = {}) {
    this.doc = doc;
    this.user = user;
    this.list = doc.getArray<ChatMessage>('chat');
    this.isHost = opts.isHost ?? (() => true);
    this.maxMessages = opts.maxMessages ?? MAX_CHAT_MESSAGES;
    this.observer = () => {
      const messages = this.messages;
      for (const cb of this.callbacks) cb(messages);
    };
    this.list.observe(this.observer);
  }

  /** Conversación completa en orden de llegada (orden total del CRDT). */
  get messages(): ChatMessage[] {
    return this.list.toArray().map((m) => ({ ...m }));
  }

  /** Solo las notas ancladas, ordenadas por posición en el timeline. */
  get pinned(): ChatMessage[] {
    return this.messages
      .filter((m) => typeof m.beat === 'number')
      .sort((a, b) => (a.beat ?? 0) - (b.beat ?? 0));
  }

  /**
   * Publica un mensaje. `beat` (opcional) lo ancla a esa posición de la
   * playlist. Devuelve el mensaje ya sellado, o null si el texto está vacío.
   */
  send(text: string, opts: { beat?: number } = {}): ChatMessage | null {
    const clean = text.trim();
    if (clean === '') return null;
    const message: ChatMessage = {
      id: newId(),
      user: this.user.name,
      color: this.user.color,
      text: clean,
      at: Date.now(),
      client: this.doc.clientID,
      ...(opts.beat !== undefined && Number.isFinite(opts.beat)
        ? { beat: Math.max(0, opts.beat) }
        : null),
    };
    this.doc.transact(() => {
      this.list.push([message]);
    }, this);
    this.trim();
    return message;
  }

  /** Quita una nota anclada (o cualquier mensaje) por id. */
  remove(id: string): boolean {
    const index = this.list.toArray().findIndex((m) => m.id === id);
    if (index < 0) return false;
    this.doc.transact(() => {
      this.list.delete(index, 1);
    }, this);
    return true;
  }

  /** Suscripción a cambios del chat. Devuelve el unsubscribe. */
  onChanged(cb: (messages: ChatMessage[]) => void): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  /** Suelta el observer. No borra la conversación del doc. */
  destroy(): void {
    if (this.observer) {
      this.list.unobserve(this.observer);
      this.observer = null;
    }
    this.callbacks.clear();
  }

  /** El host recorta la cabecera cuando la conversación se va de largo. */
  private trim(): void {
    const excess = this.list.length - this.maxMessages;
    if (excess <= 0 || !this.isHost()) return;
    this.doc.transact(() => {
      this.list.delete(0, excess);
    }, this);
  }
}
