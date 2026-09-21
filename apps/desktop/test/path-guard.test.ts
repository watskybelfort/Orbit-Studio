import { describe, expect, it } from 'vitest';
import { isBlockedIp, pathWithin } from '../src/main/path-guard';

describe('isBlockedIp — guarda anti-SSRF de gallery:fetch', () => {
  it('bloquea loopback, privadas y link-local (v4)', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // metadatos en la nube
      '0.0.0.0',
      '100.64.0.1', // CGNAT
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('deja pasar IPs públicas', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', '11.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('bloquea loopback/ULA/link-local en IPv6 y la forma mapeada', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false); // DNS público de Google
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('no deja pasar la IPv4 mapeada escrita en hexadecimal ni comprimida', () => {
    for (const ip of [
      '::ffff:7f00:1', // la reproducción medida: loopback en hex
      '::FFFF:7F00:1', // y en mayúsculas
      '0:0:0:0:0:ffff:7f00:1', // sin comprimir
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254', // metadatos por la puerta v6
      '::ffff:a00:1', // 10.0.0.1
      '::127.0.0.1', // forma compatible (obsoleta)
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    // Lo público sigue pasando por la misma notación.
    expect(isBlockedIp('::ffff:808:808')).toBe(false); // 8.8.8.8
  });

  it('reconoce la IPv4 en sus otras notaciones (hex, entero, corta, octal)', () => {
    for (const ip of ['0x7f000001', '2130706433', '127.1', '0177.0.0.1', '127.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    expect(isBlockedIp('0x8080808')).toBe(false); // 8.8.8.8 en hex
    expect(isBlockedIp('134744072')).toBe(false); // 8.8.8.8 en decimal
  });

  it('bloquea también el rango NAT64 cuando el embebido es interno', () => {
    expect(isBlockedIp('64:ff9b::7f00:1')).toBe(true);
    expect(isBlockedIp('64:ff9b::a00:1')).toBe(true); // 10.0.0.1
    expect(isBlockedIp('64:ff9b::808:808')).toBe(false); // 8.8.8.8
    expect(isBlockedIp('64:ff9b::c0a8:101')).toBe(true); // 192.168.1.1
  });

  it('deja pasar IPv6 públicas y documentación', () => {
    expect(isBlockedIp('[2001:db8::1]')).toBe(false);
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false); // Cloudflare
  });

  it('no marca como bloqueada una cadena que no es IPv4 válida', () => {
    expect(isBlockedIp('999.1.1.1')).toBe(false);
    expect(isBlockedIp('1.2.3.4.5')).toBe(false);
    expect(isBlockedIp('::gggg')).toBe(false);
  });
});

describe('pathWithin — prefijo de ruta contra escapes', () => {
  const win = process.platform === 'win32';
  const base = win ? 'C:\\Beats' : '/beats';
  const inside = win ? 'C:\\Beats\\kick.wav' : '/beats/kick.wav';
  const sub = win ? 'C:\\Beats\\drums\\snare.wav' : '/beats/drums/snare.wav';

  it('acepta la propia base y lo que cuelga de ella', () => {
    expect(pathWithin(base, base)).toBe(true);
    expect(pathWithin(inside, base)).toBe(true);
    expect(pathWithin(sub, base)).toBe(true);
  });

  it('rechaza rutas hermanas con el mismo prefijo textual', () => {
    // El clásico: "C:\Beats" no debe abarcar "C:\BeatsX".
    const sibling = win ? 'C:\\BeatsX\\x.wav' : '/beatsX/x.wav';
    expect(pathWithin(sibling, base)).toBe(false);
  });

  it('rechaza rutas fuera de la base', () => {
    const outside = win ? 'C:\\Windows\\system32\\x' : '/etc/passwd';
    expect(pathWithin(outside, base)).toBe(false);
  });

  if (win) {
    it('en Windows no distingue mayúsculas', () => {
      expect(pathWithin('c:\\beats\\KICK.wav', 'C:\\Beats')).toBe(true);
    });
  }
});
