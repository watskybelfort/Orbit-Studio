/**
 * QA headless del export: monta un beat con el ToolExecutor (mismo bus de
 * comandos que la app), lo renderiza con el MISMO camino que ExportPanel
 * (compileProject → renderProject → analyzeMix → gainToTarget → encodeWav)
 * y valida el WAV resultante (RIFF, duración, pico, silencio, stem).
 * Corre bajo vitest (el índice de @orbit/engine usa `?worker&url` de Vite):
 *   npx vitest run tools/qa/export-qa.test.ts
 * Salida: $ORBIT_QA_WAV o <tmp>/orbit-export-qa.wav
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ProjectStore } from '@orbit/core';
import { ToolExecutor } from '@orbit/claude-bridge';
import {
  analyzeMix,
  compileProject,
  encodeWav,
  gainToTarget,
  renderProject,
  renderStems,
} from '@orbit/engine';

it('el export headless produce un WAV válido a -14 LUFS', async () => {
  const store = new ProjectStore();
  const ex = new ToolExecutor(store);
  const patternId = store.project.patternOrder[0]!;

  await ex.execute('set_tempo', { bpm: 140 });
  await ex.execute('add_channel', { kind: 'drums', name: 'Kit QA' });
  const drumsId = store.project.channelOrder.at(-1)!;
  await ex.execute('set_steps', { patternId, channelId: drumsId, steps: 'x---x---x---x---' });
  await ex.execute('add_channel', { kind: 'sub808', name: '808 QA' });
  const subId = store.project.channelOrder.at(-1)!;
  await ex.execute('set_notes', {
    patternId,
    channelId: subId,
    notes: [
      { start: 0, duration: 2, note: 'F1' },
      { start: 2, duration: 2, note: 'G#1', slide: true },
    ],
  });
  await ex.execute('add_effect', { trackIndex: 0, slotIndex: 0, kind: 'limiter' });

  // Mismo camino que el panel (fuente: patrón, normalizado a -14 LUFS, 24-bit)
  const compiled = compileProject(store.project, { mode: 'pattern', patternId });
  const mix = renderProject(compiled);
  const analysis = analyzeMix(mix.left, mix.right, mix.sampleRate);
  const gainDb = gainToTarget(analysis, -14);
  const g = Math.pow(10, gainDb / 20);
  for (let i = 0; i < mix.left.length; i++) {
    mix.left[i]! *= g;
    mix.right[i]! *= g;
  }
  const wav = encodeWav(mix.left, mix.right, mix.sampleRate, 24);
  const out = process.env['ORBIT_QA_WAV'] ?? join(tmpdir(), 'orbit-export-qa.wav');
  writeFileSync(out, wav);

  const ascii = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
  expect(ascii(0, 4)).toBe('RIFF');
  expect(ascii(8, 4)).toBe('WAVE');
  const riffLen = new DataView(wav.buffer, wav.byteOffset).getUint32(4, true);
  expect(riffLen + 8).toBe(wav.length);

  const dur = mix.left.length / mix.sampleRate;
  expect(dur).toBeGreaterThan(1);
  expect(dur).toBeLessThan(20);

  let peak = 0;
  for (let i = 0; i < mix.left.length; i++) {
    const a = Math.abs(mix.left[i]!);
    if (a > peak) peak = a;
  }
  expect(peak).toBeGreaterThan(0.05); // ni silencio…
  expect(peak).toBeLessThanOrEqual(1); // …ni clipping

  const finalLufs = analysis.lufsIntegrated + gainDb;
  expect(Math.abs(finalLufs - -14)).toBeLessThan(0.5);

  const stem = renderStems(compiled, [0]).get(0);
  expect(stem && stem.left.length).toBe(mix.left.length);

  console.log(
    `EXPORT QA OK → ${out} · ${wav.length} bytes · ${dur.toFixed(2)} s · ` +
      `LUFS final ${finalLufs.toFixed(1)} (ganancia ${gainDb.toFixed(1)} dB) · ` +
      `pico ${(20 * Math.log10(peak)).toFixed(1)} dBFS`,
  );
});
