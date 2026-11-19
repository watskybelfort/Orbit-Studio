/**
 * La tinta de los estados se lee sobre las superficies claras.
 *
 * El verde, el ámbar y el rojo de los medidores son colores de BARRA: sobre
 * blanco, el verde queda en 2,2:1 y el amarillo en 1,6:1, así que una etiqueta
 * de 10 px con ese color se lee como decoración. La capa suave usa los tokens
 * `*-ink` cuando el estado es texto; en oscuro valen el color del medidor y en
 * claro se oscurecen hasta pasar 4,5:1 sobre el relleno claro más oscuro.
 *
 * Se lee el CSS y se calcula el contraste en el test: es aritmética pura sobre
 * los tokens, no hace falta montar nada. Lo que se protege es que nadie
 * "arregle" un token de tinta bajándolo de nuevo a un color de medidor.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const tokens = readSource('theme/tokens.css');
const native = readSource('theme/native.css');

/** Bloque `{ … }` que empieza en el primer `marker` del archivo. */
function blockAfter(css: string, marker: string): string {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`No está «${marker}»`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`Bloque sin cerrar: «${marker}»`);
}

function declaration(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Falta ${name}`);
  return match[1]!.trim();
}

function hex(value: string): [number, number, number] {
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`No es un hex de seis dígitos: ${value}`);
  const n = match[1]!;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(hex(a));
  const lb = luminance(hex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Comprime un color con alfa sobre otro, como hace el navegador. */
function over(fg: [number, number, number], bg: [number, number, number], alpha: number) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i]! * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

const toHex = (rgb: [number, number, number]) =>
  '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

const light = blockAfter(tokens, "html[data-theme='light'] {");

const INKS = ['--meter-ink', '--meter-hot-ink', '--meter-clip-ink', '--danger-ink', '--warn-ink'];

describe('Tinta de estados: legible sobre las superficies claras', () => {
  const white = hex(declaration(light, '--surface'));
  const text = hex(declaration(light, '--text'));
  const fills = {
    surface: toHex(white),
    'surface-2': declaration(light, '--surface-2'),
    'fill-hover': toHex(over(text, white, 0.06)),
    'fill-pressed': toHex(over(text, white, 0.11)),
  };

  it.each(INKS)('%s pasa 4,5:1 sobre cada relleno claro', (token) => {
    const ink = declaration(light, token);
    for (const [where, bg] of Object.entries(fills)) {
      expect(contrast(ink, bg), `${token} sobre ${where}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('en oscuro la tinta es exactamente el color del medidor', () => {
    const root = blockAfter(tokens, ':root {');
    expect(declaration(root, '--meter-ink')).toBe('var(--meter)');
    expect(declaration(root, '--meter-hot-ink')).toBe('var(--meter-hot)');
    expect(declaration(root, '--meter-clip-ink')).toBe('var(--meter-clip)');
    expect(declaration(root, '--danger-ink')).toBe('var(--danger)');
    expect(declaration(root, '--warn-ink')).toBe('var(--warn)');
  });
});

describe('La capa suave usa tinta, no el color de la barra, cuando el estado es texto', () => {
  it('ninguna regla suave pinta texto con un color de medidor crudo', () => {
    expect(native).not.toMatch(
      /color:\s*var\(--(?:meter|meter-hot|meter-clip|danger|warn)\);/,
    );
  });

  const marker = native.indexOf('19. Tinta de los estados');
  // El marcador cae DENTRO del comentario de la sección: hay que saltar hasta
  // su cierre; si no, el texto del comentario se toma como selector.
  const section = native
    .slice(native.indexOf('*/', marker) + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...section.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim()).filter(Boolean),
    body: m[2]!,
  }));

  const expected: [string, string][] = [
    ['.scope-lufs-val', '--meter-ink'],
    ['.strip-lufs-val', '--meter-ink'],
    ['.hist-who.remote', '--meter-ink'],
    ['.scope-lufs-val.hot', '--meter-hot-ink'],
    ['.exp-warn', '--meter-hot-ink'],
    ['.exp-error', '--meter-clip-ink'],
    ['.collab-error', '--meter-clip-ink'],
    ['.pl-color-warn', '--danger-ink'],
    ['.ver-diff-hint', '--warn-ink'],
  ];

  it.each(expected)('%s se pinta con %s', (selector, token) => {
    const full = `html[data-style='soft'] ${selector}`;
    const rule = rules.find((r) => r.selectors.includes(full));
    expect(rule, `no hay regla para ${full}`).toBeTruthy();
    expect(rule!.body).toMatch(new RegExp(`color:\\s*var\\(${token}\\)`));
  });
});
