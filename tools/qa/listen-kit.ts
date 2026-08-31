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
 * Tres diferencias con el golden, las tres a propósito:
 *
 * - **Colas largas.** El golden corta a 1-3 s porque tiene que caber en la CI
 *   (regla 3 de `fixtures.ts`). Un piso de continua no se oye en 2 s: se oye
 *   cuando la cola ya decayó y el monitor está arriba. Aquí se añaden 25 s de
 *   cola DESPUÉS del contenido del fixture, que dura ~1,7 s — o sea que el
 *   archivo mide ~26,7 s, no 25. El «25s» del nombre es la cola, y el índice
 *   escribe la duración real medida del archivo para que no haya que deducirla.
 * - **24 bits.** A 16 el propio contenedor esconde residuos que SÍ se oyen.
 *   Se queda en 24 aun sabiendo que para la escucha 1 el contenedor también
 *   esconde lo que se busca: ahí eso es la RESPUESTA, no un defecto — ver la
 *   nota de abajo.
 * - **Las medidas del índice salen del ARCHIVO**, decodificando el `.wav` que
 *   se acaba de escribir, no del buffer float que devolvió el motor.
 *
 * ── Por qué el índice mide el archivo y no lo que devolvió el motor ───────
 *
 * Hasta la v3.9 estas medidas se tomaban sobre `res.left`/`res.right`, el
 * buffer float de `renderProject()`, ANTES de cuantizar. Con eso el índice
 * anunciaba una continua de −364 dBFS en la cola de la reverb e invitaba a
 * subir el monitor a buscarla; pero `encodeWav` redondea
 * (`Math.round(x * 8388607)`, en `packages/engine/src/render/wav.ts`), y todo
 * lo que no llega a MEDIO escalón —0,5/8388607, o sea −144,5 dBFS— sale del
 * redondeo como cero. Los últimos 5 s de las piezas 01 y 02 son cero exacto,
 * bit a bit: el índice describía una señal que no está en el archivo que hay
 * al lado, y encima mandaba a subir el monitor a buscarla.
 *
 * Las dos medidas son legítimas y contestan preguntas distintas —el float dice
 * qué hace el MOTOR, el archivo dice qué va a oír quien lo abra—, así que en
 * las dos piezas donde discrepan el índice da las dos y dice cuál es cuál, con
 * la del archivo delante: esta carpeta existe para escucharse. En el resto la
 * única cifra publicada es la del archivo; no es un detalle, en el autofiltro
 * la cuantización ya movía la aguja medio dB (−37,3 en el float, −37,9 en el
 * `.wav`).
 *
 * Y no se pasa a float32, aunque `encodeWav` acepte `depth: 32` y preservaría
 * el número: −364 dBFS está 220 dB por debajo del escalón de 24 bits y no hay
 * convertidor que lo reproduzca, así que float32 solo movería el cero del
 * archivo al DAC — se pagaría compatibilidad (no todo reproductor abre WAV
 * float) por una promesa que seguiría sin poder cumplirse. Que el piso de los
 * anti-denormal no quepa en el contenedor ES el resultado que se buscaba; lo
 * que había que arreglar es contarlo así.
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
/** Profundidad de los `.wav` del kit; el porqué de que siga en 24, en la cabecera. */
const PROFUNDIDAD_WAV = 24;
/** Cabecera RIFF canónica de `encodeWav`: 44 bytes, sin chunks extra. */
const CABECERA_RIFF = 44;
/** La escala de 24 bits que usa `encodeWav`: `Math.round(x * ESCALA_24)`. */
const ESCALA_24 = 8388607;
/**
 * Medio escalón de 24 bits (−144,5 dBFS). Por debajo de esto `Math.round`
 * devuelve 0: es el umbral por el que un archivo de 24 bits deja de poder
 * contener nada, y el que convierte el piso de los anti-denormal en silencio.
 */
const CERO_DE_24_BITS = 0.5 / ESCALA_24;
/** Cola que se AÑADE detrás del contenido del fixture; no es la duración. */
const COLA_SEGUNDOS = 25;
/** Ventana del final donde se busca el piso, ya con la cola apagada. */
const VENTANA_COLA = 5;

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

/** Cuántos dB por DEBAJO de `ref` se queda `x`; positivo = no llega. */
const dBporDebajo = (x: number, ref: number): string =>
  x <= 0 ? 'inf' : (20 * Math.log10(ref / x)).toFixed(0);

/**
 * Lo que quedó DENTRO del `.wav`: decodifica los mismos bytes que se acaban de
 * escribir en disco, ya pasados por el redondeo a entero. Existe para que
 * medir el archivo sea el camino corto y medir el float haya que pedirlo
 * aparte — justo al revés de como estaba cuando el índice mintió.
 *
 * Solo entiende lo que `encodeWav` produce (PCM entero, estéreo, cabecera de
 * 44 B); cualquier otra cosa es un error, no algo que aproximar.
 */
function loQueQuedoEnElArchivo(bytes: Uint8Array): {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formato = v.getUint16(20, true);
  const canales = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const datos = v.getUint32(40, true);
  if (formato !== 1 || canales !== 2 || bits !== PROFUNDIDAD_WAV) {
    throw new Error(
      `Se esperaba PCM entero de ${PROFUNDIDAD_WAV} bits en estéreo y llegó ` +
        `formato ${formato}, ${canales} canales, ${bits} bits.`,
    );
  }
  const marcos = Math.floor(datos / (canales * (bits / 8)));
  const left = new Float32Array(marcos);
  const right = new Float32Array(marcos);
  let off = CABECERA_RIFF;
  for (let i = 0; i < marcos; i++) {
    for (const ch of [left, right]) {
      let s = v.getUint8(off) | (v.getUint8(off + 1) << 8) | (v.getUint8(off + 2) << 16);
      if (s & 0x800000) s -= 0x1000000;
      ch[i] = s / ESCALA_24;
      off += 3;
    }
  }
  return { left, right, sampleRate };
}

/**
 * RMS, continua y pico de la última ventana, que es donde vive el piso.
 * `vivas` es lo que separa «hay muy poco» de «no hay nada»: si ninguna muestra
 * es distinta de cero, el archivo es silencio digital y ninguna cifra en dB lo
 * cuenta mejor que decirlo.
 */
function cola(left: Float32Array, right: Float32Array, sr: number, segundos: number) {
  const n = Math.min(left.length, right.length);
  const desde = Math.max(0, n - Math.round(sr * segundos));
  let suma = 0;
  let cuadrados = 0;
  let pico = 0;
  let vivas = 0;
  for (let i = desde; i < n; i++) {
    const m = (left[i]! + right[i]!) / 2;
    suma += m;
    cuadrados += m * m;
    if (Math.abs(m) > pico) pico = Math.abs(m);
    if (left[i] !== 0 || right[i] !== 0) vivas++;
  }
  const cuenta = Math.max(1, n - desde);
  return { dc: suma / cuenta, rms: Math.sqrt(cuadrados / cuenta), pico, vivas, cuenta };
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
  /** Escribe la pieza y devuelve lo que quedó dentro del archivo, decodificado. */
  const wav = (nombre: string, l: Float32Array, r: Float32Array, sr: number) => {
    const bytes = encodeWav(l, r, sr, PROFUNDIDAD_WAV);
    writeFileSync(join(dir, nombre), bytes);
    return loQueQuedoEnElArchivo(bytes);
  };

  // 1. El piso de continua de los anti-denormal. Se busca en la COLA, cuando
  // la música ya paró: es ahí donde el estado de un lazo con realimentación
  // entra en rango denormal y donde el flush deja su offset. Es la única
  // escucha en la que el archivo y el motor no dicen lo mismo, y por eso la
  // única que publica las dos cifras (cabecera).
  for (const [fx, nombre, que] of [
    [
      'fx-reverb',
      `01-cola-de-reverb-${COLA_SEGUNDOS}s.wav`,
      'La cola de reverb decayendo hasta el silencio',
    ],
    [
      'fx-delay',
      `02-delay-realimentado-${COLA_SEGUNDOS}s.wav`,
      'El delay con realimentación',
    ],
  ] as const) {
    const res = render(fx, SR, COLA_SEGUNDOS);
    const archivo = wav(nombre, res.left, res.right, res.sampleRate);
    const enArchivo = cola(archivo.left, archivo.right, archivo.sampleRate, VENTANA_COLA);
    const enElMotor = cola(res.left, res.right, res.sampleRate, VENTANA_COLA);
    const duracion = archivo.left.length / archivo.sampleRate;
    const mudo = enArchivo.vivas === 0;
    piezas.push({
      archivo: nombre,
      que:
        `${que}. Dura ${duracion.toFixed(3)} s: ${(duracion - COLA_SEGUNDOS).toFixed(3)} s de ` +
        `contenido del fixture más ${COLA_SEGUNDOS} s de cola añadida detrás — el ` +
        `«${COLA_SEGUNDOS}s» del nombre es esa cola, no la duración del archivo.`,
      escuchar: mudo
        ? `Déjalo correr hasta el final, pero sabiendo qué hay: los últimos ${VENTANA_COLA} s ` +
          'de este archivo son cero exacto, bit a bit, así que si subes el monitor ahí lo que ' +
          'se oye es tu propia cadena y no el render. Lo que sí se juzga es el tramo con ' +
          'señal: que la cola se apague sin click ni zumbido de continua.'
        : 'Súbelo hasta oír el ruido de tu propia cadena y déjalo correr hasta el final. Lo ' +
          'que se busca es un zumbido o un click de continua al apagarse la cola, no la cola ' +
          'en sí.',
      medida:
        `EN EL ARCHIVO, últimos ${VENTANA_COLA} s: ` +
        (mudo
          ? `silencio digital — las ${enArchivo.cuenta} muestras valen cero exacto.`
          : `continua ${enArchivo.dc.toExponential(2)} (${dB(Math.abs(enArchivo.dc))} dBFS), ` +
            `RMS ${dB(enArchivo.rms)} dBFS, pico ${dB(enArchivo.pico)} dBFS ` +
            `(${enArchivo.vivas} de ${enArchivo.cuenta} muestras distintas de cero).`) +
        ` · EN EL MOTOR, el float antes de cuantizar: continua ` +
        `${enElMotor.dc.toExponential(2)} (${dB(Math.abs(enElMotor.dc))} dBFS), ` +
        `RMS ${dB(enElMotor.rms)} dBFS — o sea ` +
        `${dBporDebajo(enElMotor.rms, CERO_DE_24_BITS)} dB por debajo del medio escalón ` +
        `(${dB(CERO_DE_24_BITS)} dBFS) que ${PROFUNDIDAD_WAV} bits redondea a cero. Esa ` +
        'distancia es la respuesta de esta escucha: el piso de los anti-denormal no llega ' +
        'ni al contenedor, y menos a un convertidor.',
    });
    console.log(
      `  ${nombre}  archivo: ${mudo ? 'silencio digital' : `RMS ${dB(enArchivo.rms)} dBFS`}` +
        `  ·  motor: DC ${enElMotor.dc.toExponential(2)} RMS ${dB(enElMotor.rms)} dBFS`,
    );
  }

  // 2. Zipper en el camino que SÍ necesita suavizado: `fx-autofilter-sweep`
  // automatiza el corte POR BLOQUE, y `fx-eq-smoothing` mueve un EQ con un LFO.
  // La nota del deslizado va por pieza porque solo habla del autofiltro.
  for (const [fx, nombre, que, nota] of [
    [
      'fx-autofilter-sweep',
      '03-autofiltro-automatizado.wav',
      'El corte del autofiltro automatizado por bloque',
      ' (quitándole al autofiltro su deslizado propio se midió 18,4 dB peor)',
    ],
    ['fx-eq-smoothing', '04-eq-en-movimiento.wav', 'Un EQ movido por un LFO', ''],
  ] as const) {
    const res = render(fx, SR, 3);
    const archivo = wav(nombre, res.left, res.right, res.sampleRate);
    const alto = agudos(archivo.left, archivo.right, archivo.sampleRate, 6000);
    piezas.push({
      archivo: nombre,
      que,
      escuchar:
        'Se busca el zipper: una escalera o un crujido fino montado sobre el barrido, sobre ' +
        'todo donde el corte se mueve más rápido. Si suena liso, la pieza está.',
      medida: `RMS por encima de 6 kHz en el archivo: ${dB(alto)} dBFS${nota}`,
    });
    console.log(`  ${nombre}  >6 kHz: ${dB(alto)} dBFS`);
  }

  // 3. El punch del ataque, que es lo que movió la v3.8.
  for (const [fx, nombre, que] of [
    ['inst-prisma-default', '05-pluck-prisma.wav', 'PrismaVoice con el preset por defecto (capas + pluck)'],
    ['inst-synth-sweep', '06-synth-barrido.wav', 'SynthVoice con el SVF resonante barrido'],
  ] as const) {
    const res = render(fx, SR, 2);
    const archivo = wav(nombre, res.left, res.right, res.sampleRate);
    const alto = agudos(archivo.left, archivo.right, archivo.sampleRate, 3000);
    piezas.push({
      archivo: nombre,
      que,
      escuchar:
        'El ataque: ¿pega, o entra con un velo? La v3.8 le quitó al filtro un one-pole de 5 ms ' +
        'que se apilaba sobre el ataque del ADSR (90 % del brillo a 3,42 ms en vez de 6,37).',
      medida: `RMS por encima de 3 kHz en el archivo: ${dB(alto)} dBFS`,
    });
    console.log(`  ${nombre}  >3 kHz: ${dB(alto)} dBFS`);
  }

  // 4. El encoder Opus propio contra libopus, mismo material y mismo bitrate.
  //
  // Aquí el encoder propio recibe el float y libopus lee el `.wav` de 24 bits,
  // así que las dos entradas se separan en el ruido de cuantización: −144 dBFS,
  // cuarenta y pico dB por debajo de lo que cualquiera de los dos conserva a
  // 64-96 kbps. Queda anotado para que no parezca un descuido; igualarlo
  // reescribiría los `.opus` sin cambiar nada de lo que se juzga oyéndolos.
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
    'Todas salen de decodificar el `.wav` que hay al lado —lo que va a oír quien lo abra—,',
    `no del buffer float que devolvió el motor. No es lo mismo: el redondeo a ${PROFUNDIDAD_WAV} bits`,
    `manda a cero todo lo que no llegue a medio escalón (${dB(CERO_DE_24_BITS)} dBFS), y el piso`,
    'de continua de los anti-denormal está cientos de dB por debajo de ahí. Donde las dos',
    'cifras dicen cosas distintas, el índice da las dos y dice cuál es cuál.',
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
