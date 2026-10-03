import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const prefix = resolve(tmpdir(), 'orbit-release-notes-');
const roots: string[] = [];
const helper = readFileSync(new URL('./release-ci-notes.mjs', import.meta.url));
const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const publishStep = workflow.slice(workflow.indexOf('      - name: Publicar/actualizar'));
const shell = publishStep.split('        run: |\n')[1]!.split('\n')
  .filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');

function fixture(body: string) {
  const root = mkdtempSync(prefix);
  roots.push(root);
  mkdirSync(join(root, 'tools/qa'), { recursive: true });
  mkdirSync(join(root, 'apps/desktop/dist'), { recursive: true });
  writeFileSync(join(root, 'tools/qa/release-ci-notes.mjs'), helper);
  writeFileSync(join(root, 'apps/desktop/dist/Orbit Setup.exe'), 'placeholder: nunca se ejecuta');
  const input = join(root, 'body.json');
  const output = join(root, 'published.md');
  const calls = join(root, 'calls.txt');
  writeFileSync(input, JSON.stringify({ body }));
  return { root, input, output, calls };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(prefix) || dirname(root) !== dirname(prefix)) throw new Error('Fuera del temporal del test');
    rmSync(root, { recursive: true, force: true });
  }
});

function runWorkflow(f: ReturnType<typeof fixture>, exists: boolean, status: string, editFails = false) {
  // El shell del workflow es el REAL. gh es una función local sin red: copia
  // sus argumentos y notas para comprobar ambas ramas de publicación.
  const fake = `gh() {
    printf '%s\\n' "$*" >> "$ORBIT_TEST_CALLS"
    if [ "$1 $2" = 'release view' ]; then
      if [ "$ORBIT_TEST_EXISTS" = '1' ]; then cat "$ORBIT_TEST_BODY"; return 0; else return 1; fi
    fi
    if [ "$1 $2" = 'release edit' ] && [ "$ORBIT_TEST_EDIT_FAIL" = '1' ]; then return 1; fi
    if [ "$1 $2" = 'release edit' ] || [ "$1 $2" = 'release create' ]; then
      while [ "$#" -gt 0 ]; do
        if [ "$1" = '--notes-file' ]; then shift; cat "$1" > "$ORBIT_TEST_OUTPUT"; break; fi
        shift
      done
    fi
    return 0
  }\n`;
  const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  return spawnSync(bash, ['-c', fake + shell], {
    cwd: f.root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RUNNER_TEMP: f.root, RELEASE_TAG: 'v4.0.0', CI_STATUS_LINE: status,
      ORBIT_TEST_BODY: f.input, ORBIT_TEST_OUTPUT: f.output, ORBIT_TEST_CALLS: f.calls,
      ORBIT_TEST_EXISTS: exists ? '1' : '0', ORBIT_TEST_EDIT_FAIL: editFails ? '1' : '0' },
  });
}

describe('038: actualizar assets también actualiza la nota CI sin borrar notas', () => {
  it('actualiza release existente y es idempotente, preservando notas como datos', () => {
    const notes = '## Cambios\nTexto con `código`, "comillas", $() y español.\n\n- Sonidos nuevos\n';
    const f = fixture(`Estado de \`CI\` para este commit al momento de publicar: CI VIEJA.\n\n${notes}`);
    const result = runWorkflow(f, true, 'CI ROJA abc123');
    expect(result.status, result.stderr).toBe(0);
    const body = readFileSync(f.output, 'utf8');
    expect(body).toContain('CI ROJA abc123');
    expect(body).not.toContain('CI VIEJA');
    expect(body.endsWith(notes)).toBe(true);
    expect(body.match(/Estado de `CI`/g)).toHaveLength(1);
    const calls = readFileSync(f.calls, 'utf8');
    expect(calls).toContain('release edit v4.0.0 --notes-file');
    expect(calls).toContain('release upload v4.0.0');
    expect(calls).toContain('--clobber');
    writeFileSync(f.input, JSON.stringify({ body }));
    expect(runWorkflow(f, true, 'CI ROJA abc123').status).toBe(0);
    expect(readFileSync(f.output, 'utf8')).toBe(body);
    expect(runWorkflow(f, true, 'CI VERDE def456').status).toBe(0);
    const updated = readFileSync(f.output, 'utf8');
    expect(updated).not.toContain('CI ROJA');
    expect(updated).toContain('CI VERDE def456');
    expect(updated.endsWith(notes)).toBe(true);
  });

  it('crear release nueva sigue incluyendo estado CI y notas generadas', () => {
    const f = fixture('');
    const result = runWorkflow(f, false, 'CI EN CURSO abc123');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.output, 'utf8')).toContain('CI EN CURSO abc123');
    const calls = readFileSync(f.calls, 'utf8');
    expect(calls).toContain('release create v4.0.0');
    expect(calls).toContain('--generate-notes');
    expect(calls).not.toContain('release edit');
  });

  it('si falla actualizar las notas no reemplaza los assets', () => {
    const f = fixture('Notas existentes');
    const result = runWorkflow(f, true, 'CI ROJA abc123', true);
    expect(result.status).toBe(1);
    expect(readFileSync(f.calls, 'utf8')).not.toContain('release upload');
  });
});
