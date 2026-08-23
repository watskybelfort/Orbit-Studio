/**
 * Dos guardas puras del proceso principal, aparte para poder probarlas sin
 * levantar Electron:
 *
 * - `pathWithin`: ¿una ruta queda dentro de una base? (tras resolver realpath en
 *   el llamador). Cierra el escape por symlink/junction de las lecturas y
 *   escrituras acotadas.
 * - `isBlockedIp`: ¿una IP cae en un rango que una descarga externa no debe
 *   alcanzar? Es la guarda anti-SSRF de `gallery:fetch` — el único sitio desde
 *   el que el renderer (sin red por CSP) puede llegar a la red, incluida la
 *   INTERNA: loopback, la config del router, intranet o el 169.254.169.254 de
 *   metadatos en la nube.
 */

import { sep } from 'node:path';

/** Igualdad o prefijo de ruta, sin distinguir mayúsculas en Windows. */
export function pathWithin(target: string, base: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const t = norm(target);
  const b = norm(base);
  return t === b || t.startsWith((b.endsWith(sep) ? b : b + sep));
}

/** ¿La IP (v4 o v6) cae en un rango que no debe alcanzar una descarga externa? */
export function isBlockedIp(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b].some((n) => n > 255)) return false; // no es una IPv4 válida
    if (a === 0) return true; // 0.0.0.0/8 (este host)
    if (a === 10) return true; // privada
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (¡metadatos en la nube!)
    if (a === 172 && b >= 16 && b <= 31) return true; // privada
    if (a === 192 && b === 168) return true; // privada
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true; // loopback / sin especificar
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // link-local fe80::/10
  // IPv4 mapeada (::ffff:127.0.0.1): se revalida el trozo v4.
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(v6);
  if (mapped?.[1]) return isBlockedIp(mapped[1]);
  return false;
}
