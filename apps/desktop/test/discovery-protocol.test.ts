/**
 * El parseo de lo que llega por UDP: la única frontera del programa a la que
 * le puede escribir cualquiera de la red. Aquí lo que se prueba no es que los
 * paquetes buenos pasen —eso es lo fácil— sino que los malos NO.
 */

import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_VERSION,
  MAX_NAME,
  PEER_TTL_MS,
  cleanName,
  cleanServerUrl,
  encodeMessage,
  isLanAddress,
  parseMessage,
  prunePeers,
  upsertPeer,
  type Peer,
} from '../src/main/discovery-protocol';

const packet = (obj: Record<string, unknown>) => JSON.stringify(obj);

describe('parseMessage: balizas', () => {
  it('acepta una baliza bien formada', () => {
    const msg = parseMessage(packet({ v: 1, kind: 'hello', id: 'abc123', name: 'Orbit de Ana' }));
    expect(msg).toEqual({ kind: 'hello', id: 'abc123', name: 'Orbit de Ana' });
  });

  it('ida y vuelta con encodeMessage', () => {
    const original = { kind: 'hello' as const, id: 'abc123', name: 'Ana' };
    expect(parseMessage(encodeMessage(original))).toEqual(original);
  });

  it('sin nombre no se queda en blanco', () => {
    const msg = parseMessage(packet({ v: 1, kind: 'hello', id: 'abc123' }));
    expect(msg).toMatchObject({ name: 'Sin nombre' });
  });

  it('otra versión del protocolo se ignora entera', () => {
    expect(parseMessage(packet({ v: DISCOVERY_VERSION + 1, kind: 'hello', id: 'abc123' }))).toBeNull();
  });

  it('un JSON roto no lanza, devuelve null', () => {
    expect(parseMessage('{no es json')).toBeNull();
    expect(parseMessage('')).toBeNull();
    expect(parseMessage('null')).toBeNull();
    expect(parseMessage('[]')).toBeNull();
  });

  it('un paquete enorme se descarta sin parsear', () => {
    expect(parseMessage(packet({ v: 1, kind: 'hello', id: 'abc123', name: 'x'.repeat(5000) }))).toBeNull();
  });

  it('un id que no parece un id se rechaza', () => {
    for (const id of ['', 'ab', '../../etc', 'x'.repeat(64), 42]) {
      expect(parseMessage(packet({ v: 1, kind: 'hello', id }))).toBeNull();
    }
  });

  it('un kind desconocido no cuela', () => {
    expect(parseMessage(packet({ v: 1, kind: 'ejecuta-esto', id: 'abc123' }))).toBeNull();
  });
});

describe('parseMessage: invitaciones', () => {
  const base = { v: 1, kind: 'invite', id: 'abc123', name: 'Ana' };

  it('acepta una invitación con sala y servidor válidos', () => {
    const msg = parseMessage(packet({ ...base, room: 'k3p-9qf', url: 'ws://192.168.1.5:7900' }));
    expect(msg).toMatchObject({ kind: 'invite', room: 'K3P9QF', name: 'Ana' });
  });

  it('un código de sala inventado no pasa', () => {
    for (const room of ['', 'K3P', 'K3P-9QFX', 'O0I1AB', 'ñññññ']) {
      expect(parseMessage(packet({ ...base, room, url: 'ws://192.168.1.5:7900' }))).toBeNull();
    }
  });

  it('un esquema que no es ws no pasa: la URL la va a abrir la app', () => {
    for (const url of ['file:///C:/Windows', 'http://x.com', 'javascript:alert(1)', 'ws://']) {
      expect(parseMessage(packet({ ...base, room: 'K3P9QF', url }))).toBeNull();
    }
  });
});

describe('cleanName', () => {
  it('quita controles y saltos de línea', () => {
    expect(cleanName('Ana\nLópez')).toBe('Ana López');
    expect(cleanName('  Ana\t ')).toBe('Ana');
  });

  it('acota la longitud', () => {
    expect(cleanName('x'.repeat(200))).toHaveLength(MAX_NAME);
  });

  it('lo que no es texto no es un nombre', () => {
    expect(cleanName(42)).toBe('');
    expect(cleanName(null)).toBe('');
  });

  it('conserva acentos y emoji (son nombres de verdad)', () => {
    expect(cleanName('Ñoño 🎧')).toBe('Ñoño 🎧');
  });
});

describe('cleanServerUrl', () => {
  it('deja pasar ws y wss', () => {
    expect(cleanServerUrl('ws://10.0.0.4:7900')).toContain('ws://10.0.0.4:7900');
    expect(cleanServerUrl('wss://sala.example.com')).toContain('wss://sala.example.com');
  });

  it('rechaza lo demás', () => {
    for (const url of ['', 'x', 'http://a.b', 'file:///etc/passwd', 'w'.repeat(300)]) {
      expect(cleanServerUrl(url)).toBe('');
    }
  });
});

describe('lista de peers', () => {
  const peer = (id: string, name: string, seenAt: number): Peer => ({
    id,
    name,
    address: '192.168.1.9',
    seenAt,
  });

  it('un peer que vuelve a saludar se refresca, no se duplica', () => {
    let list = upsertPeer([], peer('a', 'Ana', 100));
    list = upsertPeer(list, peer('a', 'Ana', 200));
    expect(list).toHaveLength(1);
    expect(list[0]!.seenAt).toBe(200);
  });

  it('la lista sale ordenada por nombre', () => {
    let list = upsertPeer([], peer('b', 'Zoe', 1));
    list = upsertPeer(list, peer('a', 'Ana', 1));
    expect(list.map((p) => p.name)).toEqual(['Ana', 'Zoe']);
  });

  it('el que lleva rato callado se cae de la lista', () => {
    const list = [peer('a', 'Ana', 0), peer('b', 'Zoe', PEER_TTL_MS)];
    expect(prunePeers(list, PEER_TTL_MS + 1).map((p) => p.id)).toEqual(['b']);
  });
});

describe('isLanAddress', () => {
  it('acepta las redes privadas y el bucle local', () => {
    for (const a of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.1.44', '172.16.0.1', '172.31.255.254', '169.254.1.1', '::1']) {
      expect(isLanAddress(a)).toBe(true);
    }
  });

  it('rechaza internet: la app no puede ser un reflector de paquetes', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '203.0.113.7', 'example.com', '']) {
      expect(isLanAddress(a)).toBe(false);
    }
  });

  it('un octeto fuera de rango no cuela', () => {
    expect(isLanAddress('192.999.1.1')).toBe(false);
  });
});
