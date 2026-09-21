/**
 * El chat no puede crecer sin freno. Vive en el MISMO doc que el proyecto, así
 * que cada mensaje de 300 KB se replica a todos y se queda en el .bin.
 *
 * Lo que se comprueba:
 * - `send` recorta al tope de longitud (con aviso), no acepta lo que le llegue;
 * - el tope de mensajes lo aplica CUALQUIER peer al observar, no solo el host:
 *   si depende del host, basta con que el host no mande nada para que la sala
 *   acumule 500 mensajes;
 * - lo que se lee también se recorta: un cliente modificado que escriba un
 *   mensaje gigante directo al Y.Array no revienta la UI de los demás.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_CHAT_TEXT, MAX_CHAT_MESSAGES, ChatBinding, type ChatMessage } from '../src/chat';

/** Relay entre dos docs: cada update local de uno se aplica en el otro. */
function linkDocs(docA: Y.Doc, docB: Y.Doc): void {
  const origin = { link: true };
  docA.on('update', (u: Uint8Array, o: unknown) => {
    if (o !== origin) Y.applyUpdate(docB, u, origin);
  });
  docB.on('update', (u: Uint8Array, o: unknown) => {
    if (o !== origin) Y.applyUpdate(docA, u, origin);
  });
}

function rawMessage(id: string, text: string): ChatMessage {
  return { id, user: 'evil', color: '#000', text, at: 0, client: 1 };
}

describe('ChatBinding: el chat tiene tope de verdad', () => {
  it('send recorta los mensajes que pasan del tope de longitud', () => {
    const doc = new Y.Doc();
    const chat = new ChatBinding(doc, { name: 'Ana', color: '#e6675a' });
    const sent = chat.send('x'.repeat(300_000));
    expect(sent).not.toBeNull();
    expect(sent!.text.length).toBe(MAX_CHAT_TEXT);
    expect(chat.messages[0]!.text.length).toBe(MAX_CHAT_TEXT);
  });

  it('el receptor recorta el tope de mensajes aunque no sea host', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    const a = new ChatBinding(docA, { name: 'Ana', color: '#e6675a' }, { maxMessages: 5 });
    // B se declara NO host a propósito: antes el recorte solo lo hacía el host.
    const b = new ChatBinding(docB, { name: 'Beto', color: '#5aa9e6' }, { maxMessages: 5 });

    // Un cliente modificado mete 8 mensajes directos al Y.Array.
    docA.transact(() => {
      docA.getArray<ChatMessage>('chat').insert(0, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => rawMessage(`m${n}`, `mensaje ${n}`)));
    });

    expect(docB.getArray<ChatMessage>('chat').length).toBeLessThanOrEqual(5);
    expect(docA.getArray<ChatMessage>('chat').length).toBeLessThanOrEqual(5);
    expect(b.messages.length).toBeLessThanOrEqual(5);
    expect(a.messages.length).toBeLessThanOrEqual(5);
    // Y se conservan los MÁS NUEVOS: el recorte es por la cabecera.
    expect(b.messages.map((m) => m.id)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8']);
  });

  it('leer un mensaje gigante escrito a mano no devuelve los 300 KB', () => {
    const docB = new Y.Doc();
    const b = new ChatBinding(docB, { name: 'Beto', color: '#5aa9e6' });
    docB.getArray<ChatMessage>('chat').insert(0, [rawMessage('malo', 'x'.repeat(300_000))]);
    expect(b.messages[0]!.text.length).toBe(MAX_CHAT_TEXT);
  });

  it('el tope por defecto está en MAX_CHAT_MESSAGES', () => {
    const doc = new Y.Doc();
    const chat = new ChatBinding(doc, { name: 'Ana', color: '#e6675a' });
    for (let i = 0; i < MAX_CHAT_MESSAGES + 20; i++) chat.send(`m${i}`);
    expect(doc.getArray<ChatMessage>('chat').length).toBe(MAX_CHAT_MESSAGES);
    expect(chat.messages[0]!.text).toBe('m20');
  });
});
