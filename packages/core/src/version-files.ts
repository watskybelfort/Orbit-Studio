/** Nombres de snapshots compartidos por el escritor y el listado de versiones. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UNIQUE_FILE = new RegExp(`^([0-9]{13})-(${UUID})--([a-z0-9-]{0,40})\\.orbit$`);
const LEGACY_FILE = /^([0-9]{13})-([a-z0-9-]{0,40})\.orbit$/;

export function parseVersionFile(file: string): { at: number; slug: string } | null {
  const unique = UNIQUE_FILE.exec(file);
  if (unique) return { at: Number(unique[1]), slug: unique[3]! };
  const legacy = LEGACY_FILE.exec(file);
  return legacy ? { at: Number(legacy[1]), slug: legacy[2]! } : null;
}

/** El UUID distingue escrituras del mismo milisegundo, etiqueta y contenido. */
export function versionFileName(at: number, label: unknown, nonce: string): string {
  const slug = typeof label === 'string' ? label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) : '';
  const name = `${at}-${nonce}--${slug}.orbit`;
  if (!UNIQUE_FILE.test(name)) throw new Error('Identificador de versión inválido');
  return name;
}
