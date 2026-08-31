/**
 * `npm run ci:status` — cómo quedó el último push, en una línea.
 *
 * Nace de esto: la v3.8.0 se taggeó y publicó (`Release` en verde) mientras
 * `CI` sobre el MISMO commit llevaba seis pushes seguidos en rojo — y nadie lo
 * vio, porque mirarlo significaba acordarse de la sintaxis de
 * `gh run list -w CI -c <sha> --json conclusion,status,url` y teclearla a
 * mano. Un comando que no hay que recordar es un comando que sí se usa.
 *
 * Este script y el chequeo dentro de `release.yml` (ver el comentario de ese
 * archivo) comparten la MISMA pregunta — «¿cómo está `CI` para este SHA?» —
 * así que comparten el mismo código: este archivo es lo que corre en ambos
 * sitios, para que la lógica de qué cuenta como verde/rojo/pendiente no viva
 * duplicada y pueda desalinearse.
 *
 * Uso:
 *   npm run ci:status                    # el HEAD local (el último push, si ya se hizo)
 *   npm run ci:status -- <sha-o-ref>      # cualquier commit, rama o tag
 *
 * Salida: una línea humana por stdout, y el código de salida dice el estado
 * para quien lo use desde un script (`release.yml` lo hace):
 *   0 = verde · 1 = roja · 2 = sin ejecución de CI para ese commit · 3 = en curso
 */

import { execFileSync } from 'node:child_process';

type EstadoRun = {
  conclusion: string;
  status: string;
  url: string;
  headSha: string;
  createdAt: string;
};

function sh(cmd: string, args: string[]): string {
  // stderr en 'ignore': si `git`/`gh` fallan, lo que importa es el mensaje
  // propio de cada `catch` de acá abajo, no el ruido nativo del proceso —
  // este comando promete UNA línea, no un stacktrace ajeno encima.
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Resuelve lo que sea (SHA corto, rama, tag, HEAD) al SHA completo de 40 hex. */
function resolverSha(ref: string): string {
  try {
    return sh('git', ['rev-parse', ref]);
  } catch {
    throw new Error(
      `"${ref}" no es un commit que exista en el checkout local (¿hace falta un \`git fetch\`?).`,
    );
  }
}

function listarRuns(shaCompleto: string): EstadoRun[] {
  const raw = sh('gh', [
    'run',
    'list',
    '--workflow=CI',
    '--commit',
    shaCompleto,
    '--limit',
    '5',
    '--json',
    'conclusion,status,url,headSha,createdAt',
  ]);
  return JSON.parse(raw) as EstadoRun[];
}

function main(): void {
  const ref = process.argv[2] ?? 'HEAD';
  let sha: string;
  try {
    sha = resolverSha(ref);
  } catch (err) {
    // stdout, no stderr: `release.yml` captura esta línea con `$(...)` y
    // tiene que quedarle ALGO que anunciar incluso cuando la consulta falla.
    console.log(`CI — no se pudo resolver "${ref}": ${(err as Error).message}`);
    process.exit(2);
  }
  const corto = sha.slice(0, 7);

  let runs: EstadoRun[];
  try {
    runs = listarRuns(sha);
  } catch (err) {
    // Casi siempre `gh` sin instalar o sin `gh auth login` — no un rojo real,
    // así que se reporta distinto de un rojo de verdad. stdout por la misma
    // razón que en `resolverSha`.
    console.log(
      `CI — no pude consultar \`gh run list\` (¿"gh" instalado y autenticado?): ${
        (err as Error).message
      }`,
    );
    process.exit(2);
    return;
  }

  // Puede haber varios runs para el mismo SHA (un re-run manual, por ejemplo);
  // el más nuevo es el que importa. `gh run list` ya entrega orden descendente
  // por fecha de creación, pero se ordena explícito para no depender de eso.
  const run = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (!run) {
    console.log(
      `CI — sin ejecución para ${corto}: o el push todavía no llegó, o ese commit nunca se` +
        ' empujó a main (una rama local no dispara CI).',
    );
    process.exit(2);
    return;
  }

  if (run.status !== 'completed') {
    console.log(`CI — ${corto} EN CURSO (${run.status}). ${run.url}`);
    process.exit(3);
    return;
  }

  if (run.conclusion === 'success') {
    console.log(`CI — ${corto} VERDE. ${run.url}`);
    process.exit(0);
    return;
  }

  console.log(`CI — ${corto} ROJA (${run.conclusion}). ${run.url}`);
  process.exit(1);
}

main();
