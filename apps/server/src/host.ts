/**
 * Dónde escucha el servidor de colaboración.
 *
 * Aislado del arranque (que tiene efectos de red al importarse) para poder
 * probarlo sin levantar nada, y compartido entre el CLI y la app: el panel
 * guarda una dirección elegida a mano (localhost, la del VPN, la de la LAN o
 * "todas") y aquí se decide si esa elección se puede cumplir HOY.
 *
 * La regla importante: atarse a una IP que ya no existe (el VPN apagado, el
 * cable fuera) tira el arranque con EADDRNOTAVAIL. Antes que no arrancar,
 * `resolveHost` cae a localhost y quien llama avisa de que se quedó en local.
 */

/** Solo esta máquina. */
export const HOST_LOCAL = '127.0.0.1';
/** Todas las interfaces (LAN, VPN, lo que haya). */
export const HOST_ALL = '0.0.0.0';

/** Una IPv4 de esta máquina, con el nombre de su interfaz para enseñarlo. */
export interface HostAddress {
  /** Nombre de la interfaz tal cual lo da el sistema ("Radmin VPN", "Ethernet"…). */
  name: string;
  address: string;
}

/** ¿Ese host acepta conexiones de fuera de esta máquina? */
export function isOpenToNetwork(host: string): boolean {
  return host !== HOST_LOCAL && host !== 'localhost' && host !== '::1';
}

/**
 * Host con el que arrancar de verdad, a partir de lo que se pidió y de las
 * direcciones que tiene la máquina AHORA. Lo que no se puede cumplir cae a
 * localhost en vez de reventar el arranque.
 */
export function resolveHost(
  requested: string | undefined,
  available: readonly string[],
): string {
  const want = (requested ?? '').trim();
  if (want === '' || want === HOST_LOCAL || want === 'localhost' || want === '::1') {
    return HOST_LOCAL;
  }
  if (want === HOST_ALL) return HOST_ALL;
  return available.includes(want) ? want : HOST_LOCAL;
}

/**
 * ¿Se pudo cumplir lo que se pidió? Sirve para decirle al usuario "elegiste la
 * IP del VPN pero no está levantado, así que esto solo se oye aquí".
 */
export function hostWasHonored(requested: string | undefined, resolved: string): boolean {
  const want = (requested ?? '').trim();
  if (want === '' || want === HOST_LOCAL || want === 'localhost' || want === '::1') {
    return resolved === HOST_LOCAL;
  }
  return resolved === want;
}

/**
 * Etiqueta legible de una dirección para el desplegable del panel. Reconoce
 * las VPN que se usan para tocar con gente de fuera (Radmin, Hamachi,
 * ZeroTier, Tailscale) porque es LA que hay que compartir, y marca lo que casi
 * nunca sirve (adaptadores de máquinas virtuales, WSL, APIPA 169.254.x).
 */
export function describeAddress(entry: HostAddress): string {
  const name = entry.name.trim();
  const lower = name.toLowerCase();
  if (/radmin|hamachi|zerotier|tailscale|wireguard/.test(lower)) return `${name} (VPN)`;
  if (/wsl|hyper-v|virtualbox|vmware|vethernet|docker/.test(lower)) return `${name} (virtual)`;
  if (entry.address.startsWith('169.254.')) return `${name} (sin red)`;
  return name;
}

/**
 * Orden en el que enseñar las direcciones: primero las VPN (lo normal para
 * tocar con alguien de fuera), luego las reales, y al final las virtuales y las
 * que no llevan a ningún sitio.
 */
export function sortAddresses(entries: readonly HostAddress[]): HostAddress[] {
  const rank = (entry: HostAddress): number => {
    const label = describeAddress(entry);
    if (label.endsWith('(VPN)')) return 0;
    if (label.endsWith('(sin red)')) return 3;
    if (label.endsWith('(virtual)')) return 2;
    return 1;
  };
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address));
}
