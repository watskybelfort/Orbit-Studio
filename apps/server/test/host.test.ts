/**
 * Dónde escucha el servidor: lo que se elige en el panel contra lo que la
 * máquina tiene levantado en ese momento.
 */

import { describe, expect, it } from 'vitest';
import {
  HOST_ALL,
  HOST_LOCAL,
  describeAddress,
  hostWasHonored,
  isOpenToNetwork,
  resolveHost,
  sortAddresses,
} from '../src/host';

const RADMIN = '26.65.104.199';
const LAN = '192.168.40.11';
const HAY = [RADMIN, LAN];

describe('resolveHost', () => {
  it('sin elección, solo esta máquina', () => {
    expect(resolveHost(undefined, HAY)).toBe(HOST_LOCAL);
    expect(resolveHost('', HAY)).toBe(HOST_LOCAL);
    expect(resolveHost('localhost', HAY)).toBe(HOST_LOCAL);
  });

  it('todas las redes se respeta tal cual', () => {
    expect(resolveHost(HOST_ALL, HAY)).toBe(HOST_ALL);
  });

  it('una IP de la máquina se usa como está (la del VPN, por ejemplo)', () => {
    expect(resolveHost(RADMIN, HAY)).toBe(RADMIN);
    expect(resolveHost(LAN, HAY)).toBe(LAN);
  });

  it('una IP que ya no está cae a local en vez de tirar el arranque', () => {
    // El VPN apagado: atarse a esa IP daría EADDRNOTAVAIL.
    expect(resolveHost(RADMIN, [LAN])).toBe(HOST_LOCAL);
    expect(resolveHost('10.0.0.7', [])).toBe(HOST_LOCAL);
  });
});

describe('hostWasHonored', () => {
  it('dice si se pudo hacer lo que se pidió', () => {
    expect(hostWasHonored(RADMIN, RADMIN)).toBe(true);
    expect(hostWasHonored(RADMIN, HOST_LOCAL)).toBe(false);
    expect(hostWasHonored(undefined, HOST_LOCAL)).toBe(true);
    expect(hostWasHonored(HOST_ALL, HOST_ALL)).toBe(true);
  });
});

describe('isOpenToNetwork', () => {
  it('solo localhost se queda dentro de la máquina', () => {
    expect(isOpenToNetwork(HOST_LOCAL)).toBe(false);
    expect(isOpenToNetwork('localhost')).toBe(false);
    expect(isOpenToNetwork(HOST_ALL)).toBe(true);
    expect(isOpenToNetwork(RADMIN)).toBe(true);
  });
});

describe('etiquetas del desplegable', () => {
  it('reconoce las VPN, lo virtual y lo que no lleva a ningún sitio', () => {
    expect(describeAddress({ name: 'Radmin VPN', address: RADMIN })).toBe('Radmin VPN (VPN)');
    expect(describeAddress({ name: 'vEthernet (WSL)', address: '172.30.160.1' })).toContain('(virtual)');
    expect(describeAddress({ name: 'Ethernet', address: '169.254.1.2' })).toContain('(sin red)');
    expect(describeAddress({ name: 'Ethernet', address: LAN })).toBe('Ethernet');
  });

  it('la VPN sale primero y lo virtual al final', () => {
    const orden = sortAddresses([
      { name: 'vEthernet (WSL)', address: '172.30.160.1' },
      { name: 'Ethernet', address: LAN },
      { name: 'Radmin VPN', address: RADMIN },
      { name: 'Ethernet 2', address: '169.254.123.204' },
    ]).map((e) => e.address);
    expect(orden[0]).toBe(RADMIN);
    expect(orden[1]).toBe(LAN);
    expect(orden[3]).toBe('169.254.123.204');
  });
});
