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

/**
 * El problema de un mensaje de chat, o `null` si su forma sirve.
 *
 * El chat viaja en un `Y.Array` que escribe CUALQUIER peer del protocolo y no pasa
 * por la validación del log de comandos (un mensaje no es una mutación del proyecto,
 * no entra en el undo ni lo filtran los roles). Leer la conversación con un `null`
 * dentro —lo que un invitado puede meter a mano— reventaba con `Cannot read
 * properties of null (reading 'text')` al pintar, tanto en el host como en quien
 * entra tarde, y el servidor guardaba el dato inválido en el `.bin`: el chat quedaba
 * inservible hasta limpiar el documento a mano.
 */
export function chatProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'no es un mensaje';
  }
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string') return 'sin id';
  if (typeof m.user !== 'string') return 'sin autor';
  if (typeof m.color !== 'string') return 'sin color';
  if (typeof m.text !== 'string') return 'sin texto';
  if (typeof m.at !== 'number' || !Number.isFinite(m.at)) return 'sin fecha';
  if (typeof m.client !== 'number' || !Number.isFinite(m.client)) return 'sin client';
  if (m.beat !== undefined && (typeof m.beat !== 'number' || !Number.isFinite(m.beat))) {
    return 'con un ancla que no es un numero';
  }
  return null;
}

/** ¿Es un mensaje de chat con la forma que se puede pintar y borrar? */
export function isChatMessage(value: unknown): value is ChatMessage {
  return chatProblem(value) === null;
}

/** Tope de mensajes retenidos en el doc (lo recorta CUALQUIER peer). */
export const MAX_CHAT_MESSAGES = 300;

/**
 * Tope de longitud de un mensaje, en caracteres. El chat viaja en el MISMO
 * documento que el proyecto y el servidor lo persiste entero: un mensaje de
 * cientos de KB se replica a todos y se queda en el .bin.
 */
export const MAX_CHAT_TEXT = 4000;

export interface ChatOptions {
  /** Tope de mensajes (por defecto MAX_CHAT_MESSAGES). */
  maxMessages?: number;
  /** Tope de longitud por mensaje (por defecto MAX_CHAT_TEXT). */
  maxTextLength?: number;
}

/**
 * Enlace del chat con un Y.Doc. No sabe nada de WebSockets: se puede probar
 * conectando dos Y.Doc a mano, igual que CommandLogBinding.
 */
export class ChatBinding {
  private readonly doc: Y.Doc;
  private readonly user: CollabUser;
  private readonly list: Y.Array<ChatMessage>;
  private readonly maxMessages: number;
  private readonly maxTextLength: number;
  private readonly callbacks = new Set<(messages: ChatMessage[]) => void>();
  private observer: (() => void) | null = null;

  constructor(doc: Y.Doc, user: CollabUser, opts: ChatOptions = {}) {
    this.doc = doc;
    this.user = user;
    this.list = doc.getArray<ChatMessage>('chat');
    this.maxMessages = opts.maxMessages ?? MAX_CHAT_MESSAGES;
    this.maxTextLength = opts.maxTextLength ?? MAX_CHAT_TEXT;
    this.observer = () => {
      // El recorte va ANTES de avisar: cualquier peer que vea la conversación
      // pasada de largo la recorta, sin esperar a que el host mande algo.
      this.trim();
      const messages = this.messages;
      for (const cb of this.callbacks) cb(messages);
    };
    this.list.observe(this.observer);
  }

  /** Conversación completa en orden de llegada (orden total del CRDT). */
  get messages(): ChatMessage[] {
    return this.lectura();
  }

  /**
   * La conversación legible: solo los mensajes que SÍ tienen forma, con el texto
   * recortado.
   *
   * Lo inválido no se filtra por índice (eso parte el array del CRDT): simplemente no
   * se devuelve, así que pintar, leer las notas ancladas o borrar un mensaje siguen
   * funcionando aunque el chat lleve dentro un mensaje envenenado. Quien lo quita del
   * doc es el servidor, que es el único que puede hacerlo sin dividirlo entre peers.
   */
  private lectura(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of this.list.toArray()) {
      if (!isChatMessage(m)) continue;
      out.push({ ...m, text: this.capText(m.text) });
    }
    return out;
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
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const clean = this.capText(trimmed);
    if (clean.length < trimmed.length) {
      console.warn(`[collab] mensaje de chat recortado a ${this.maxTextLength} caracteres`);
    }
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
    // Con un mensaje inválido en medio, los índices del array del doc y los de la
    // lectura no coinciden: se busca sobre el array REAL con la misma guarda.
    const index = this.list.toArray().findIndex((m) => isChatMessage(m) && m.id === id);
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

  /** Recorta un texto al tope (lo usan `send` y la lectura). */
  private capText(text: string): string {
    return text.length > this.maxTextLength ? text.slice(0, this.maxTextLength) : text;
  }

  /**
   * Recorta la cabecera cuando la conversación se pasa del tope. Lo hace
   * CUALQUIER peer, no solo el host: la regla ("sobran los `length - max` más
   * viejos") es determinista e idéntica en todos, así que converge sola y un
   * cliente modificado no puede esperar a que el host se conecte para inflar
   * el documento de todos.
   */
  private trim(): void {
    const excess = this.list.length - this.maxMessages;
    if (excess <= 0) return;
    this.doc.transact(() => {
      this.list.delete(0, excess);
    }, this);
  }
}
