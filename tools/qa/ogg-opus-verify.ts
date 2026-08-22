/**
 * Comprueba el contenedor Ogg Opus contra ffmpeg, de verdad.
 *
 *   npx tsx tools/qa/ogg-opus-verify.ts
 *
 * El truco está en que **no hace falta tener el encoder Opus terminado** para
 * validar el contenedor. El plan:
 *
 *   1. ffmpeg codifica un tono a Ogg Opus. Ese archivo es la referencia.
 *   2. Se le sacan los paquetes Opus crudos con nuestro demuxer.
 *   3. Se vuelven a paginar con NUESTRO muxer.
 *   4. ffmpeg decodifica los dos archivos a WAV y se comparan muestra a muestra.
 *
 * Si el paginado propio estuviera mal —un CRC, un granulado, un trozo mal
 * medido— el paso 4 sale distinto o ffmpeg ni abre el archivo. Y si sale igual,
 * el contenedor está bien: los mismos paquetes, en nuestras páginas, suenan
 * exactamente igual.
 *
 * Esto es lo que separa "los tests pasan" de "esto funciona".
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOggOpus, parseOggOpus } from '../../packages/engine/src/render/ogg-opus';

const FFMPEG_CANDIDATES = [
  'ffmpeg',
  join(
    process.env['LOCALAPPDATA'] ?? '',
    'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.0-full_build/bin/ffmpeg.exe',
  ),
];

function findFfmpeg(): string {
  for (const candidate of FFMPEG_CANDIDATES) {
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
const dir = mkdtempSync(join(tmpdir(), 'orbit-oggopus-'));
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FALLA'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Decodifica a PCM 16 bits crudo para poder comparar muestra a muestra. */
function decodePcm(path: string): Int16Array {
  const out = join(dir, `${Math.abs(hash(path))}.raw`);
  execFileSync(ffmpeg, ['-y', '-i', path, '-f', 's16le', '-acodec', 'pcm_s16le', out], {
    stdio: 'pipe',
  });
  const bytes = readFileSync(out);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

try {
  for (const [label, args] of [
    ['estéreo 48 kHz', ['-ac', '2', '-ar', '48000']],
    ['mono 48 kHz', ['-ac', '1', '-ar', '48000']],
  ] as const) {
    console.log(`\n· ${label}`);

    // 1. Referencia hecha por ffmpeg.
    const reference = join(dir, `ref-${hash(label)}.opus`);
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        ...args,
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        reference,
      ],
      { stdio: 'pipe' },
    );

    // 2. Sacar los paquetes con nuestro demuxer.
    const original = parseOggOpus(new Uint8Array(readFileSync(reference)));
    check(
      'el demuxer lee la cabecera de ffmpeg',
      original.channels === (label.startsWith('mono') ? 1 : 2),
      `canales=${original.channels}, preSkip=${original.preSkip}, vendor="${original.vendor}"`,
    );
    check(
      'todas las páginas pasan el CRC',
      original.pages.every((page) => page.crcOk),
      `${original.pages.length} páginas`,
    );
    check('hay paquetes de audio', original.packets.length > 0, `${original.packets.length}`);

    // 3. Repaginar con el muxer propio. El número de muestras por paquete se
    //    reparte a partes iguales: para este chequeo lo que importa es que el
    //    granulado final coincida con el de ffmpeg.
    const perPacket = Math.round(
      (original.finalGranule - original.preSkip) / original.packets.length,
    );
    const packets = original.packets.map((data, i) => ({
      data,
      samples:
        i === original.packets.length - 1
          ? original.finalGranule - original.preSkip - perPacket * (original.packets.length - 1)
          : perPacket,
    }));
    const mine = encodeOggOpus(packets, {
      channels: original.channels,
      preSkip: original.preSkip,
      inputRate: original.inputRate,
      vendor: 'Orbit Studio',
    });
    const minePath = join(dir, `mine-${hash(label)}.opus`);
    writeFileSync(minePath, mine);

    // 4. Que ffmpeg lo lea, y que suene igual.
    let probe = '';
    try {
      probe = execFileSync(
        ffmpeg.replace(/ffmpeg(\.exe)?$/, (m) => m.replace('ffmpeg', 'ffprobe')),
        ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'csv=p=0', minePath],
        { stdio: 'pipe' },
      ).toString();
    } catch {
      probe = '(ffprobe no disponible)';
    }
    check('ffprobe reconoce el archivo', probe.includes('opus'), probe.trim());

    const referencePcm = decodePcm(reference);
    const minePcm = decodePcm(minePath);
    check(
      'mismo número de muestras que el de ffmpeg',
      referencePcm.length === minePcm.length,
      `ffmpeg=${referencePcm.length}, propio=${minePcm.length}`,
    );

    let worst = 0;
    const shared = Math.min(referencePcm.length, minePcm.length);
    for (let i = 0; i < shared; i++) {
      worst = Math.max(worst, Math.abs(referencePcm[i]! - minePcm[i]!));
    }
    check(
      'el audio sale BIT A BIT idéntico',
      worst === 0 && referencePcm.length === minePcm.length,
      `diferencia máxima = ${worst}`,
    );

    // Y que lo nuestro se vuelva a leer solo.
    const reread = parseOggOpus(mine);
    check(
      'nuestro archivo se lee de vuelta con los mismos paquetes',
      reread.packets.length === original.packets.length &&
        reread.preSkip === original.preSkip &&
        reread.channels === original.channels,
      `paquetes=${reread.packets.length}, muestras=${reread.samples}`,
    );
  }
} finally {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nTodo cuadra: el contenedor Ogg Opus propio es indistinguible del de ffmpeg.\n'
    : `\n${failures} comprobación(es) han fallado.\n`,
);
process.exit(failures === 0 ? 0 : 1);
