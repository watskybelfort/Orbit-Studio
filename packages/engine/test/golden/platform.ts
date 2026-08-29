/**
 * ¿Se puede comparar un render de Orbit bit a bit entre plataformas?
 *
 * Esta pregunta decide si el golden sirve o es decorativo, así que NO se
 * respondió por intuición: se midió. Este archivo guarda la medida, para que
 * el día que alguien vea un hash raro no tenga que repetirla —y para que si
 * la repite, sepa contra qué compara.
 *
 * ── El experimento ──────────────────────────────────────────────────────────
 *
 * Se empaquetó el banco entero con esbuild en un solo `.mjs` sin dependencias
 * (el motor no tiene ninguna nativa) y se ejecutó el MISMO archivo en cinco
 * entornos. Cada uno renderizó los 24 fixtures dos veces.
 *
 *   entorno                                  V8                     hashes iguales
 *   ---------------------------------------- ---------------------- --------------
 *   win32  x64    Node 24.18.0  (referencia)  13.6.233.17-node.50    —
 *   linux  x64    Node 24.20.0                13.6.233.17-node.53    24/24
 *   linux  x64    Node 22.23.2                12.4.254.21-node.56    24/24
 *   linux  x64    Node 20.20.2                11.3.244.8-node.38     24/24
 *   linux  arm64  Node 24.20.0                13.6.233.17-node.53    22/24
 *
 * Y en los cinco, las dos pasadas del mismo proceso dieron el mismo hash: el
 * motor es determinista, sin `Math.random` en ninguna parte (osc.ts ya lo
 * decía; ahora hay una medida que lo respalda).
 *
 * ── Lo que sale de ahí ──────────────────────────────────────────────────────
 *
 * **En x64 el render es bit a bit idéntico, y no por poco.** Sobrevive a
 * cambiar de sistema operativo Y a cambiar de versión MAYOR de V8 (11, 12 y
 * 13, tres años de compilador). La razón es conocida: V8 no delega las
 * funciones trascendentes en la libm del sistema —tiene su propio port de
 * fdlibm, precisamente para que `Math.sin` no dependa del sistema
 * operativo— y todo lo demás en el motor es aritmética IEEE-754 en un orden
 * de operaciones fijo. La matriz de la CI (ubuntu-latest + windows-latest,
 * ambos x64, Node 24) cae entera dentro de lo medido.
 *
 * **En arm64 no.** Dos fixtures de 24 (`inst-prisma-default` y
 * `fx-convolver`) dan un hash distinto: son los dos que más multiplicaciones
 * acumuladas encadenan (capas de Prisma, FFT del convolver), que es
 * exactamente donde el backend de arm64 puede contraer un multiply-add en un
 * FMA y quedarse con un bit más de precisión intermedia. La diferencia
 * SONORA es nula: la métrica que más se movió lo hizo 1.9e-13 dB, once
 * órdenes de magnitud por debajo de la tolerancia de 0,01 dB.
 *
 * ── La decisión, y por qué esta y no otra ───────────────────────────────────
 *
 * El hash se compara SIEMPRE, en toda plataforma, sin condicional. La
 * tentación era hacerlo dependiente del arch —«en arm64 solo métricas»— y se
 * descartó por dos razones:
 *
 * 1. Un condicional es la semilla de un `skip`. El día que el hash moleste en
 *    algún sitio, la rama ya está escrita y solo hay que ensancharla. Sin
 *    rama no hay dónde esconder nada.
 * 2. Y sobre todo: en arm64 el hash SÍ debe fallar, porque ahí falla algo de
 *    verdad. Quien regenerara la línea base desde un arm64 escribiría hashes
 *    que luego rompen para toda la CI x64. Que el test se ponga rojo en esa
 *    máquina no es pedantería: es el aviso de que esa máquina no puede fijar
 *    la línea base. `tools/qa/golden-update.ts` lo hace explícito y se niega
 *    a regenerar desde un arch no verificado.
 *
 * Y la comparación por métricas se ejecuta SIEMPRE también, no como plan B:
 * es la que distingue «el sonido cambió» de «cambió el último bit», que son
 * dos diagnósticos distintos con dos respuestas distintas.
 */

/**
 * Arquitecturas donde la reproducibilidad bit a bit está MEDIDA (ver arriba).
 * No es una lista de deseos: cada entrada corresponde a un experimento hecho.
 * Añadir una sin medirla vacía el archivo de sentido.
 */
export const BIT_EXACT_ARCHS: readonly string[] = ['x64'];

export interface RuntimeInfo {
  platform: string;
  arch: string;
  node: string;
  v8: string;
}

export function runtimeInfo(): RuntimeInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    v8: process.versions.v8,
  };
}

export function isBitExactVerified(info: RuntimeInfo = runtimeInfo()): boolean {
  return BIT_EXACT_ARCHS.includes(info.arch);
}

export function describeRuntime(info: RuntimeInfo = runtimeInfo()): string {
  return `${info.platform}/${info.arch} · Node ${info.node} · V8 ${info.v8}`;
}

/** El aviso que se le da a quien corre esto donde la reproducibilidad no se midió. */
export function unverifiedArchWarning(info: RuntimeInfo = runtimeInfo()): string {
  return [
    `Estás en ${describeRuntime(info)}, y la reproducibilidad bit a bit de este`,
    `motor solo está medida en ${BIT_EXACT_ARCHS.join(', ')} (ver platform.ts).`,
    'En arm64 se midió que 2 de 24 fixtures dan otro hash, con una diferencia',
    'sonora de 1.9e-13 dB — o sea, ninguna. Si el hash te falla y las métricas',
    'no se mueven, es esto y no un cambio de sonido. NO regeneres la línea base',
    'desde aquí: romperías el hash de toda la CI, que corre en x64.',
  ].join('\n');
}
