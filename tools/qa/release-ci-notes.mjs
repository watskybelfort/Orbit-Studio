// Actualiza únicamente nuestro aviso de CI; el resto de las notas se conserva.
// La entrada es `gh release view --json body`, no texto interpolado en shell.
import { readFileSync, writeFileSync } from 'node:fs';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Uso: release-ci-notes.mjs body.json notas.md');
const { body } = JSON.parse(readFileSync(source, 'utf8'));
if (typeof body !== 'string') throw new Error('La respuesta de la release no contiene un body válido');
const status = (process.env.CI_STATUS_LINE || 'sin dato').replace(/[\r\n]+/g, ' ').trim();
const start = '<!-- orbit-ci-status:start -->';
const end = '<!-- orbit-ci-status:end -->';
const note = `Estado de \`CI\` para este commit al momento de publicar: ${status}.`;
const remaining = body
  .replace(/<!-- orbit-ci-status:start -->[\s\S]*?<!-- orbit-ci-status:end -->\r?\n?/g, '')
  // Compatibilidad con la línea sin marcadores que publicaban versiones previas.
  .replace(/^Estado de `CI` para este commit al momento de publicar:[^\r\n]*(?:\r?\n|$)/gm, '')
  .replace(/^(?:\r?\n)+/, '');
writeFileSync(destination, `${start}\n${note}\n${end}\n${remaining ? `\n${remaining}` : ''}`, 'utf8');
