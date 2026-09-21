/**
 * Las claves de settings.json que el renderer no puede tocar y la guarda de
 * "abrir el servidor a la red". El patrón es el de path-guard/window-bounds:
 * la regla en un módulo puro, probada sin levantar Electron.
 */

import { describe, expect, it } from 'vitest';
import {
  SETTINGS_LOCKED,
  isAllowedServerHost,
  requiresNetworkConfirmation,
} from '../src/main/settings-guard';

describe('settings-guard: quién escribe qué', () => {
  it('bloquea las listas blancas y el host del servidor de colaboración', () => {
    for (const key of [
      'userFolders',
      'recentProjects',
      'friends',
      'collabServerHost',
      'collabServerOpen',
    ]) {
      expect(SETTINGS_LOCKED.has(key), key).toBe(true);
    }
    // Las preferencias normales del panel siguen pasando por settings:set.
    for (const key of ['collabUserName', 'collabServerUrl', 'collabRoomCapacity']) {
      expect(SETTINGS_LOCKED.has(key), key).toBe(false);
    }
  });

  it('hospedar en loopback no pregunta; abrir a la red sí', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(requiresNetworkConfirmation(host), host).toBe(false);
    }
    for (const host of ['0.0.0.0', '192.168.1.20', '10.8.0.2', '169.254.1.1']) {
      expect(requiresNetworkConfirmation(host), host).toBe(true);
    }
  });

  it('el canal propio del host solo acepta destinos reales', () => {
    const ifaces = ['192.168.1.20', '10.8.0.2'];
    for (const host of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', ...ifaces]) {
      expect(isAllowedServerHost(host, ifaces), host).toBe(true);
    }
    for (const host of ['', '  ', '8.8.8.8', '192.168.1.99', 'evil.example', '$(rm)']) {
      expect(isAllowedServerHost(host, ifaces), host).toBe(false);
    }
  });
});
