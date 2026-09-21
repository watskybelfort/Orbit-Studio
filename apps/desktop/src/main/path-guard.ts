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
 *
 * `isBlockedIp` compara DIRECCIONES, no cadenas: una IPv6 con la IPv4 embebida
 * en hexadecimal (`::ffff:7f00:1`) o una IPv4 en notación corta/hexadecimal
 * (`127.1`, `0x7f000001`, `2130706433`) son el MISMO destino que el loopback de
 * siempre, y el sistema las resuelve igual. Por eso se normalizan a octetos
 * (expandiendo grupos de IPv6 y aplicando la semántica de inet_aton) y se
 * revalida la dirección resultante; rechazar solo literales "con puntos" era
 * dejar la puerta de atrás abierta.
 */

import { sep } from 'node:path';

/** Igualdad o prefijo de ruta, sin distinguir mayúsculas en Windows. */
export function pathWithin(target: string, base: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const t = norm(target);
  const b = norm(base);
  return t === b || t.startsWith((b.endsWith(sep) ? b : b + sep));
}

/**
 * Octetos de una IPv4 en cualquiera de sus notaciones aceptadas por las APIs
 * del sistema: decimal (`127.0.0.1`), hexadecimal (`0x7f000001`), octal
 * (`0177.0.0.1`), entero de 32 bits (`2130706433`) y corta (`127.1`, donde la
 * última parte ocupa los bytes que faltan). `null` si no es una IPv4 válida.
 */
function parseIpv4(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part === '') return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) n = Number(part);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    values.push(n);
  }
  const last = values.pop()!;
  const trailing = 4 - values.length; // bytes que ocupa la última parte
  if (last >= 256 ** trailing) return null;
  if (values.some((v) => v > 255)) return null;
  const octets = [0, 0, 0, 0];
  values.forEach((v, i) => {
    octets[i] = v;
  });
  let rest = last;
  for (let i = 3; i >= 4 - trailing; i--) {
    octets[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/** ¿Cae esta IPv4 en loopback, privada, link-local, CGNAT o "este host"? */
function blockedV4(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 (este host)
  if (a === 10) return true; // privada
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (¡metadatos en la nube!)
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  return false;
}

/** Expande una IPv6 a sus 16 bytes (con `::` y una IPv4 final si la trae). */
function parseIpv6(text: string): number[] | null {
  const clean = text.replace(/%.*$/, '').toLowerCase(); // quita el zone id (%eth0)
  if (clean === '') return null;
  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (side: string): number[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      // Solo la última puede ser una IPv4 embebida (`::ffff:127.0.0.1`).
      if (i === groups.length - 1 && group.includes('.')) {
        const v4 = parseIpv4(group);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]!);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = parseGroups(halves[1]!);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` comprime al menos un grupo
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

/** ¿Es una IPv6 interna, o una que envuelve una IPv4 interna? */
function blockedV6(bytes: number[]): boolean {
  const at = (i: number) => bytes[i]!;
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);

  if (zero(0, 16)) return true; // ::
  if (zero(0, 15) && at(15) === 1) return true; // ::1
  if ((at(0) & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return true; // link-local fe80::/10

  // IPv4 embebida: ::a.b.c.d (compatible, obsoleta) y ::ffff:a.b.c.d (mapeada,
  // ::ffff:0:0/96). La forma decimal y la hexadecimal (`::ffff:7f00:1`) caen
  // aquí igual porque se compara la dirección expandida, no el texto.
  if (zero(0, 10) && ((at(10) === 0 && at(11) === 0) || (at(10) === 0xff && at(11) === 0xff))) {
    return blockedV4(at(12), at(13), at(14), at(15));
  }

  // NAT64 bien conocido (64:ff9b::/96): traduce a la IPv4 que lleva dentro.
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && zero(4, 12)) {
    return blockedV4(at(12), at(13), at(14), at(15));
  }

  return false;
}

/** ¿La IP (v4 o v6) cae en un rango que no debe alcanzar una descarga externa? */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.trim().replace(/^\[|\]$/g, '');
  if (!bare.includes(':')) {
    const octets = parseIpv4(bare);
    return octets !== null && blockedV4(...octets);
  }
  const bytes = parseIpv6(bare);
  if (!bytes) return false; // no es una IPv6 válida
  return blockedV6(bytes);
}
