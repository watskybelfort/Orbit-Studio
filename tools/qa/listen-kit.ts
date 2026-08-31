/**
 * `npm run listen:kit` — dejar renderizado, en un solo sitio, el material que
 * hay que ESCUCHAR.
 *
 * Existe porque hay una parte de la verificación que ningún test sustituye
 * («¿se oye el piso de continua que meten los anti-denormal?», «¿volvió el
 * zipper?», «¿el pluck tiene punch?») y que hasta ahora obligaba a montar los
 * proyectos a mano cada vez — con lo cual no se hacía, y la tarjeta de escucha
 * lleva dos rondas acumulándose. El material sale de los mismos fixtures del
 * golden, así que lo que se escucha es exactamente lo que el banco fija: si el
 * oído y el hash discrepan, discrepan sobre la MISMA señal.
 *
 * Dos diferencias con el golden, las dos a propósito:
 *
 * - **Colas largas.** El golden corta a 1-3 s porque tiene que caber en la CI
 *   (regla 3 de `fixtures.ts`). Un piso de continua no se oye en 2 s: se oye
 *   cuando la cola ya decayó y el monitor está arriba. Aquí son 25 s.
 * - **24 bits.** El punto de la escucha 1 es comparar contra el piso de ruido
 *   de 24 bits (−144 dBFS). A 16 bits el propio contenedor esconde lo que se
 *   busca.
 *
 * Lo que este comando NO hace, por la misma razón que `golden-bite.ts`: no
 * renderiza el «antes» de un cambio de DSP, porque para eso tendría que editar
 * `packages/engine/src`, y eso un comando no lo hace. Los A/B contra una
 * versión anterior se generan a mano, se dejan en la misma carpeta y se anotan
 * en el índice.
 *
 * Uso:
 *   npm run listen:kit
 *   npm run listen:kit -- --dir out/escucha-v3.9
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderProject } from '../../packages/engine/src/render/offline';
import { encodeOpusFile } from '../../packages/engine/src/render/opus/encoder';
import { encodeWav } from '../../packages/engine/src/render/wav';
import { GOLDEN_FIXTURES } from '../../packages/engine/test/golden/fixtures';
import { describeRuntime } from '../../packages/engine/test/golden/platform';
import { textoDeFlag } from './cli-args';

const SR = 44100;
/** CELT trabaja a 48 kHz; el Opus se renderiza directo ahí, sin remuestrear. */
const OPUS_SR = 48000;

function render(name: string, sampleRate: number, tailSeconds: number) {
  const f = GOLDEN_FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`No existe el fixture "${name}" en GOLDEN_FIXTURES.`);
  return renderProject(f.build(), {
    sampleRate,
    tailSeconds,
    ...(f.samples ? { samples: f.samples() } : null),
  });
}

const dB = (x: number): string => (x <= 0 ? '-inf' : (20 * Math.log10(x)).toFixed(1));

/** RMS, continua y pico de la última ventana, que es donde vive el piso. */
function cola(left: Float32Array, right: Float32Array, sr: number, segundos: number) {
  const n = Math.min(left.length, right.length);
  const desde = Math.max(0, n - Math.round(sr * segundos));
  let suma = 0;
  let cuadrados = 0;
  let pico = 0;
  for (let i = desde; i < n; i++) {
    const m = (left[i]! + right[i]!) / 2;
    suma += m;
    cuadrados += m * m;
    if (Math.abs(m) > pico) pico = Math.abs(m);
  }
  const cuenta = Math.max(1, n - desde);
  return { dc: suma / cuenta, rms: Math.sqrt(cuadrados / cuenta), pico };
}

/**
 * RMS por encima de un corte, con un pasa-altos de un polo. No es un análisis
 * de banda fino y no pretende serlo: el zipper es basura de banda ancha muy
 * por encima del contenido, y un polo la separa de sobra.
 */
function agudos(left: Float32Array, right: Float32Array, sr: number, hz: number): number {
  const k = Math.exp((-2 * Math.PI * hz) / sr);
  let lp = 0;
  let acc = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const m = (left[i]! + right[i]!) / 2;
    lp = m * (1 - k) + lp * k;
    const hp = m - lp;
    acc += hp * hp;
  }
  return Math.sqrt(acc / Math.max(1, n));
}

interface Pieza {
  archivo: string;
  que: string;
  escuchar: string;
  medida: string;
}

function main(): void {
  const dir = resolve(textoDeFlag(process.argv, 'dir') ?? 'out/escucha');
  mkdirSync(dir, { recursive: true });
  console.log(`Kit de escucha -> ${dir}`);
  console.log(`Runtime: ${describeRuntime()}`);
  console.log('');

  const piezas: Pieza[] = [];
  const wav = (nombre: string, l: Float32Array, r: Float32Array, sr: number) => {
    writeFileSync(join(dir, nombre), encodeWav(l, r, sr, 24));
  };

  // 1. El piso de continua de los anti-denormal. Se busca en la COLA, cuando
  // la música ya paró: es ahí donde el estado de un lazo con realimentación
  // entra en rango denormal y donde el flush deja su offset.
  for (const [fx, nombre, que] of [
    ['fx-reverb', '01-cola-de-reverb-25s.wav', 'La cola de reverb, 25 s, decayendo hasta el silencio'],
    ['fx-delay', '02-delay-realimentado-25s.wav', 'El delay con realimentación, 25 s'],
  ] as const) {
    const res = render(fx, SR, 25);
    wav(nombre, res.left, res.right, res.sampleRate);
    const c = cola(res.left, res.right, res.sampleRate, 5);
    piezas.push({
      archivo: nombre,
      que,
      escuchar:
        'Súbelo hasta oír el ruido de tu propia cadena y déjalo correr hasta el final. Lo que ' +
        'se busca es un zumbido o un click de continua al apagarse la cola, no la cola en sí.',
      medida:
        `últimos 5 s — continua ${c.dc.toExponential(2)} (${dB(Math.abs(c.dc))} dBFS), ` +
        `RMS ${dB(c.rms)} dBFS, pico ${dB(c.pico)} dBFS · piso de 24 bits: −144 dBFS`,
    });
    console.log(`  ${nombre}  cola: DC ${c.dc.toExponential(2)}  RMS ${dB(c.rms)} dBFS`);
  }

  // 2. Zipper en el camino que SÍ necesita suavizado: `fx-autofilter-sweep`
  // automatiza el corte POR BLOQUE, y `fx-eq-smoothing` mueve un EQ con un LFO.
  for (const [fx, nombre, que] of [
    ['fx-autofilter-sweep', '03-autofiltro-automatizado.wav', 'El corte del autofiltro automatizado por bloque'],
    ['fx-eq-smoothing', '04-eq-en-movimiento.wav', 'Un EQ movido por un LFO'],
  ] as const) {
    const res = render(fx, SR, 3);
    wav(nombre, res.left, res.right, res.sampleRate);
    const alto = agudos(res.left, res.right, res.sampleRate, 6000);
    piezas.push({
      archivo: nombre,
      que,
      escuchar:
        'Se busca el zipper: una escalera o un crujido fino montado sobre el barrido, sobre ' +
        'todo donde el corte se mueve más rápido. Si suena liso, la pieza está.',
      medida:
        `RMS por encima de 6 kHz: ${dB(alto)} dBFS (quitándole al autofiltro su deslizado ` +
        'propio se midió 18,4 dB peor)',
    });
    console.log(`  ${nombre}  >6 kHz: ${dB(alto)} dBFS`);
  }

  // 3. El punch del ataque, que es lo que movió la v3.8.
  for (const [fx, nombre, que] of [
    ['inst-prisma-default', '05-pluck-prisma.wav', 'PrismaVoice con el preset por defecto (capas + pluck)'],
    ['inst-synth-sweep', '06-synth-barrido.wav', 'SynthVoice con el SVF resonante barrido'],
  ] as const) {
    const res = render(fx, SR, 2);
    wav(nombre, res.left, res.right, res.sampleRate);
    const alto = agudos(res.left, res.right, res.sampleRate, 3000);
    piezas.push({
      archivo: nombre,
      que,
      escuchar:
        'El ataque: ¿pega, o entra con un velo? La v3.8 le quitó al filtro un one-pole de 5 ms ' +
        'que se apilaba sobre el ataque del ADSR (90 % del brillo a 3,42 ms en vez de 6,37).',
      medida: `RMS por encima de 3 kHz: ${dB(alto)} dBFS`,
    });
    console.log(`  ${nombre}  >3 kHz: ${dB(alto)} dBFS`);
  }

  // 4. El encoder Opus propio contra libopus, mismo material y mismo bitrate.
  for (const [fx, base, kbps] of [
    ['inst-supersaw-chord', '07-acorde', 96],
    ['inst-sub808-glide', '08-sub808', 64],
  ] as const) {
    const res = render(fx, OPUS_SR, 2);
    const n = Math.min(res.left.length, res.right.length);
    wav(`${base}-fuente.wav`, res.left, res.right, res.sampleRate);

    const pcm = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      pcm[i * 2] = res.left[i]!;
      pcm[i * 2 + 1] = res.right[i]!;
    }
    const propio = encodeOpusFile(pcm, { channels: 2, bitrate: kbps * 1000 });
    writeFileSync(join(dir, `${base}-orbit-${kbps}k.opus`), propio);

    let referencia = 'ffmpeg no disponible: sin referencia con la que comparar';
    try {
      execFileSync(
        'ffmpeg',
        [
          '-y', '-loglevel', 'error',
          '-i', join(dir, `${base}-fuente.wav`),
          '-c:a', 'libopus', '-b:a', `${kbps}k`,
          join(dir, `${base}-libopus-${kbps}k.opus`),
        ],
        { stdio: 'pipe' },
      );
      referencia = `${base}-libopus-${kbps}k.opus (misma fuente, mismo bitrate)`;
    } catch {
      /* sin ffmpeg no hay referencia, y el resto del kit sigue valiendo */
    }
    piezas.push({
      archivo: `${base}-orbit-${kbps}k.opus`,
      que: `${fx} pasado por el encoder Opus propio a ${kbps} kbps`,
      escuchar:
        'A/B contra la referencia de libopus al mismo bitrate y contra la fuente sin ' +
        'comprimir. Lo que se juzga es el agujero tonal y el manchón de los transitorios.',
      medida: `${propio.length} bytes · referencia: ${referencia}`,
    });
    console.log(`  ${base}: orbit ${propio.length} B`);
  }

  const indice = [
    '# Kit de escucha',
    '',
    `Generado por \`npm run listen:kit\`. Runtime: ${describeRuntime()}.`,
    '',
    'El material sale de los fixtures del golden, así que lo que se oye aquí es exactamente',
    'lo que el banco fija. Las medidas son de referencia: la pregunta que contesta esta',
    'carpeta no es cuánto mide, es si molesta.',
    '',
    ...piezas.flatMap((p) => [
      `## ${p.archivo}`,
      '',
      `**Qué es.** ${p.que}`,
      '',
      `**Qué escuchar.** ${p.escuchar}`,
      '',
      `**Medido.** ${p.medida}`,
      '',
    ]),
    '## Lo que este kit NO trae',
    '',
    '- El «antes» de un cambio de DSP: para eso habría que editar `packages/engine/src`, y',
    '  un comando no hace eso (mismo motivo que `golden-bite.ts`). Los A/B contra una',
    '  versión anterior se generan a mano y se dejan aquí, anotados.',
    '- Nada que necesite hardware: entradas multicanal, calibración de latencia con el bucle',
    '  físico y la ganancia por ruta sobre una señal real. Eso sigue siendo de la tarjeta de',
    '  escucha, no de aquí.',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'INDICE.md'), indice);
  console.log(`\n${piezas.length} piezas + INDICE.md`);
}

main();
