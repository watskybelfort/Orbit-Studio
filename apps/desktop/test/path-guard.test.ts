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

  it('no marca como bloqueada una cadena que no es IPv4 válida', () => {
    expect(isBlockedIp('999.1.1.1')).toBe(false);
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
