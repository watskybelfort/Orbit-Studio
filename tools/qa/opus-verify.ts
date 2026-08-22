/**
 * La puerta: que ffmpeg decodifique un `.opus` hecho entero por Orbit.
 *
 *   npx tsx tools/qa/opus-verify.ts
 *
 * Todo lo demás del encoder se puede verificar por propiedades internas —ida y
 * vuelta, biyecciones, que los dos lados calculen igual— y todo eso está en los
 * tests. Pero ninguna de esas comprobaciones responde a la única pregunta que
 * importa: **¿lo abre alguien que no seamos nosotros?**
 *
 * Aquí se genera un tono, se codifica con nuestro encoder, y se le pide a ffmpeg
 * que lo decodifique. Si ffmpeg lo abre y sale la señal, el códec funciona. Si
 * no, no — por muchos tests que estén en verde.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';
import { parseOggOpus } from '../../packages/engine/src/render/ogg-opus';

function findFfmpeg(): string {
  const candidates = [
    'ffmpeg',
    join(
      process.env['LOCALAPPDATA'] ?? '',
      'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0-full_build/bin/ffmpeg.exe',
    ),
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // siguiente
    }
  }
  throw new Error('no se encontró ffmpeg; sin él esta comprobación no vale nada');
}

const ffmpeg = findFfmpeg();
const dir = mkdtempSync(join(tmpdir(), 'orbit-opus-'));
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FALLA'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * Señal de prueba: tres tonos y un poco de ruido, con envolvente.
 *
 * Un seno puro solo probaría dos bandas. Con tres armónicos y ruido de fondo se
 * ejercitan bandas graves, medias y agudas a la vez, que es donde se notan los
 * fallos de reparto de bits.
 */
function tone(seconds: number, channels: number, freq: number): Float64Array {
  const samples = Math.floor(48000 * seconds);
  const out = new Float64Array(samples * channels);
  let seed = 12345 >>> 0;
  for (let i = 0; i < samples; i++) {
    const t = i / 48000;
    const envelope = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const noise = ((seed >>> 8) / 8388608 - 1) * 0.02;
    const value =
      envelope *
      (0.35 * Math.sin(2 * Math.PI * freq * t) +
        0.18 * Math.sin(2 * Math.PI * freq * 3.1 * t) +
        0.09 * Math.sin(2 * Math.PI * freq * 8.7 * t) +
        noise);
    for (let c = 0; c < channels; c++) out[i * channels + c] = value * (c === 1 ? 0.7 : 1);
  }
  return out;
}

function decodeToPcm(path: string, label: string): Float64Array {
  const raw = join(dir, `${label}.f32`);
  execFileSync(ffmpeg, ['-y', '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', raw], {
    stdio: 'pipe',
  });
  const bytes = readFileSync(raw);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return Float64Array.from(floats);
}

/** Correlación entre dos señales, alineadas por el retardo que mejor case. */
function bestCorrelation(a: Float64Array, b: Float64Array, maxLag: number): {
  correlation: number;
  lag: number;
  gain: number;
} {
  let best = { correlation: -2, lag: 0, gain: 1 };
  const n = Math.min(a.length, b.length) - maxLag;
  for (let lag = 0; lag <= maxLag; lag++) {
    let dot = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i < n; i++) {
      const va = a[i]!;
      const vb = b[i + lag]!;
      dot += va * vb;
      ea += va * va;
      eb += vb * vb;
    }
    const correlation = dot / Math.sqrt(ea * eb + 1e-30);
    if (correlation > best.correlation) {
      best = { correlation, lag, gain: Math.sqrt(eb / (ea + 1e-30)) };
    }
  }
  return best;
}

try {
  for (const [label, channels, frameSize, bitrate] of [
    ['mono 20 ms 32k', 1, 960, 32000],
    ['mono 20 ms 64k', 1, 960, 64000],
    ['mono 20 ms 96k', 1, 960, 96000],
    ['estereo 20 ms 64k', 2, 960, 64000],
    ['estereo 20 ms 96k', 2, 960, 96000],
    ['estereo 20 ms 128k', 2, 960, 128000],
    ['estereo 20 ms 256k', 2, 960, 256000],
    ['mono 10 ms 96k', 1, 480, 96000],
    ['estereo 10 ms 128k', 2, 480, 128000],
    ['mono 5 ms 128k', 1, 240, 128000],
    ['estereo 5 ms 192k', 2, 240, 192000],
    ['mono 2,5 ms 256k', 1, 120, 256000],
  ] as const) {
    console.log(`
· ${label}`);
    const original = tone(1.0, channels, 440);
    const file = encodeOpusFile(original, { channels, bitrate, frameSize });
    const path = join(dir, `orbit-${channels}-${frameSize}.opus`);
    writeFileSync(path, file);
    check('el encoder produce bytes', file.length > 0, `${file.length} bytes`);

    // Nuestro propio lector, primero: si esto ya falla, no hace falta ffmpeg.
    const info = parseOggOpus(file);
    check(
      'nuestro demuxer lo lee',
      info.channels === channels && info.packets.length > 0,
      `canales=${info.channels}, paquetes=${info.packets.length}, preSkip=${info.preSkip}`,
    );
    check('todas las páginas pasan el CRC', info.pages.every((p) => p.crcOk));

    // Y ahora el juez.
    let probe = '';
    try {
      probe = execFileSync(
        ffmpeg.replace(/ffmpeg(\.exe)?$/, (mm) => mm.replace('ffmpeg', 'ffprobe')),
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,channels,sample_rate',
          '-of',
          'csv=p=0',
          path,
        ],
        { stdio: 'pipe' },
      ).toString().trim();
    } catch (err) {
      probe = `(ffprobe falló: ${err instanceof Error ? err.message.split('\n')[0] : err})`;
    }
    check('ffprobe reconoce el archivo', probe.includes('opus'), probe);

    let decoded: Float64Array | null = null;
    try {
      decoded = decodeToPcm(path, `orbit-${channels}-${frameSize}`);
      check('ffmpeg lo DECODIFICA', decoded.length > 0, `${decoded.length} muestras`);
    } catch (err) {
      check('ffmpeg lo DECODIFICA', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
    }

    if (decoded && decoded.length > 0) {
      // Se compara el primer canal, tolerando el retardo del códec.
      const left = new Float64Array(Math.floor(original.length / channels));
      for (let i = 0; i < left.length; i++) left[i] = original[i * channels]!;
      const outLeft = new Float64Array(Math.floor(decoded.length / channels));
      for (let i = 0; i < outLeft.length; i++) outLeft[i] = decoded[i * channels]!;

      const { correlation, lag, gain } = bestCorrelation(left, outLeft, 1000);
      check(
        'el audio decodificado SE PARECE al original',
        correlation > 0.9,
        `correlación=${correlation.toFixed(4)}, retardo=${lag}, ganancia=${gain.toFixed(3)}`,
      );
      check(
        'la ganancia es la correcta (no hay factor de escala perdido)',
        gain > 0.8 && gain < 1.25,
        `ganancia=${gain.toFixed(4)}`,
      );
    }
  }
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nLa puerta está abierta: ffmpeg decodifica un .opus hecho entero por Orbit.\n'
    : `\n${failures} comprobación(es) han fallado.\n`,
);
process.exit(failures === 0 ? 0 : 1);
