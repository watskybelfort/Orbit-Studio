# Golden tests — fijar el sonido

La regla dura 5 de `CLAUDE.md` dice que cualquier cambio de sonido en `engine`
tiene que actualizar la línea base **conscientemente**. Este documento explica
cómo está montado eso, y —lo que importa más— **qué se midió para decidirlo
así**, porque la diferencia entre un golden que protege y uno decorativo no
está en el diseño sino en si alguien comprobó que muerde.

## Los archivos

| archivo | qué es |
| --- | --- |
| `packages/engine/test/golden/fixtures.ts` | El banco: 24 proyectos deterministas + 2 flujos Opus, uno por familia de sonido |
| `packages/engine/test/golden/fingerprint.ts` | Qué se compara (hash + métricas) y con cuánta tolerancia |
| `packages/engine/test/golden/platform.ts` | La medida de reproducibilidad entre plataformas |
| `packages/engine/test/golden/run.ts` | Renderizar/codificar un fixture; lo comparten test y herramientas |
| `packages/engine/test/golden/baseline.json` | La línea base. **Un diff aquí es un diff de sonido** |
| `packages/engine/test/golden/golden.test.ts` | El test, dentro de `npm test` |
| `tools/qa/golden-update.ts` | `npm run golden:update` — regenerar la línea base |
| `tools/qa/golden-bite.ts` | `npm run golden:bite` — comprobar que ningún fixture se quedó sordo |

## El flujo de trabajo

```bash
npm test                       # el golden va dentro; ~4 s de los 22 s totales
npm run golden:update          # informe del diff de sonido. NO escribe nada
npm run golden:update -- --only fx-vinyl
npm run golden:update -- --accept "el vinilo ya no da silencio exacto"
npm run golden:bite            # ¿algún fixture dejó de medir?
```

**No hay `--update-snapshots`, y es a propósito.** Sin `--accept` el comando
enseña el diff y sale con código 1. Con `--accept "<motivo>"` escribe, guarda el
motivo dentro del propio `baseline.json` (donde sobrevive a que alguien lea el
JSON suelto, cosa que el mensaje de commit no hace) y propone la plantilla del
commit. El commit **tiene que decir qué diff de sonido se aceptó**.

`golden:update` también se **niega** a regenerar desde una arquitectura donde la
reproducibilidad bit a bit no está medida (hoy: cualquiera que no sea x64).
Grabar la línea base desde ahí rompería el hash para toda la CI. Hay un escape,
`--force`, para quien sepa exactamente lo que hace; sale en el propio mensaje de
la negativa. **No lo uses sin haber medido tu plataforma**: una línea base
grabada fuera de x64 deja la CI en rojo permanente.

El motivo de `--accept` tiene que ser texto de verdad. Ni vacío, ni un espacio,
ni el flag siguiente: hasta la v3.7 `--accept --force` guardaba `"--force"` como
motivo **y** activaba el bypass de arriba, de un solo gesto. Hoy eso sale con
código 2 sin escribir nada.

## Qué se compara, y por qué

Dos capas, las dos siempre, en toda plataforma:

1. **El hash** (sha256 de las muestras crudas en float32 LE). Es la capa
   **sensible**: pilla cualquier cosa.
2. **Las métricas con tolerancia** (LUFS, peak, cuatro bandas y correlación
   estéreo, del render entero y de 8 ventanas de tiempo; tolerancia 0,01 dB).
   Es la capa que **explica**: convierte «el sha256 cambió» en «el grave subió
   0,9 dB en la ventana 4».

Las dos hacen falta. Con solo hash, un cambio inofensivo (reordenar una suma)
es indistinguible de uno que arruina el sonido. Con solo métricas, un cambio
real puede colarse por debajo de la tolerancia.

Los flujos Opus llevan **solo hash de bytes**: un bitstream codificado con rango
no admite «casi igual» — un bit distinto es otro archivo a partir de ahí.

## Las medidas

Todo lo de abajo se midió de verdad. Se puede rehacer.

### 1. ¿Es determinista el motor?

Sí. Los fixtures dan el mismo hash en dos renders seguidos del mismo proceso,
en las cinco plataformas probadas — medido sobre los 24 que había entonces; el
banco son 25 desde que la v3.8 añadió `fx-autofilter-sweep`. No hay `Math.random` en el motor
(`osc.ts` ya lo avisaba; ahora hay una medida detrás): el ruido va por xorshift32
con semilla fija, y los ids del proyecto están fijados a mano.

Eso fue el experimento. El test **permanente** de determinismo es más barato a
propósito y comprueba 2 de los 25 en cada corrida (`golden.test.ts`, con el
motivo escrito al lado): renderizar los 25 dos veces en cada `npm test` costaría
el doble del banco entero para volver a demostrar algo que ya se midió. Los 24
se cubren igual en cada corrida contra la línea base, que es la comparación que
de verdad importa.

### 2. ¿Es reproducible entre plataformas?

Se empaquetó el banco con esbuild en un `.mjs` sin dependencias y se corrió el
**mismo archivo** en cinco entornos (Docker para los Linux):

| entorno | V8 | render (24) | Opus (3) |
| --- | --- | --- | --- |
| win32 x64 · Node 24.18.0 | 13.6.233.17 | referencia | referencia |
| linux x64 · Node 24.20.0 | 13.6.233.17 | **24/24** | 3/3 |
| linux x64 · Node 22.23.2 | 12.4.254.21 | **24/24** | 2/3 |
| linux x64 · Node 20.20.2 | 11.3.244.8 | **24/24** | 2/3 |
| linux arm64 · Node 24.20.0 | 13.6.233.17 | 22/24 | 2/3 |

**El render es bit a bit idéntico en x64**, y no por poco: sobrevive a cambiar
de sistema operativo *y* a tres versiones mayores de V8. La razón es que V8 no
delega las funciones trascendentes en la libm del sistema (tiene su propio port
de fdlibm, precisamente para eso) y el resto del motor es IEEE-754 en un orden
fijo. La matriz de la CI (`ubuntu-latest` + `windows-latest`, x64, Node 24) cae
entera dentro de lo medido. **Por eso el hash se compara sin condicional: la
única forma de que acabe en un `skip` es que haya una rama donde esconderlo.**

En **arm64** dos fixtures difieren (`inst-prisma-default`, `fx-convolver`): los
dos que más multiplicaciones encadenan, que es donde el backend puede contraer
un multiply-add en un FMA. La diferencia sonora es **1.9e-13 dB** — once
órdenes de magnitud por debajo de la tolerancia. Que el test se ponga rojo ahí
es correcto, no pedante: avisa de que esa máquina no puede fijar la línea base.

### 3. ¿Muerde?

Se perturbó un coeficiente real del motor cada vez, en una copia del repo, y se
corrió el golden:

| perturbación | qué cambio de sonido representa | fixtures rojos | peor métrica |
| --- | --- | --- | --- |
| `filters.ts` `ANTI_DENORMAL` 1e-20 → 1e-19 | v3.6, Biquad/SVF/Allpass1 | **7** | 0 dB |
| `filters.ts` `COEF_SMOOTH_SECONDS` 5 → 6 ms | v3.5, suavizado de coeficientes | **3** | 0,017 dB (2 de los 3 por métricas) |
| `AutofilterUnit` sin su `cutoffLive` | v3.8, el deslizado propio del autofiltro | **1** (`fx-autofilter-sweep`) | **14,694 dB** (35 medidas) |
| `voices.ts` guarda 0,2 % → 1 % | v3.6, `SynthVoice` | **2** | **0,999 dB** (37 medidas) |
| `reverb.ts` `ANTI_DENORMAL` ×10 | v3.5, denormales de la reverb | **1** (`fx-reverb`) | 0 dB |
| `effects.ts` `ANTI_DENORMAL` ×10 | v3.6, delay/flanger/phaser | **2** (flanger, phaser) | 0 dB |
| `transient.ts` umbral 200 → 220 | v3.5, transitorios del Opus | **1** (`opus-sub`) | — |
| `postfilter.ts` `GAIN_STEP` ×1,017 | v3.5, postfiltro | **2** (los dos Opus) | — |
| `celt-encoder.ts` `tfWeight` → `'plano'` | v3.6, Viterbi por importancia | **1** (`opus-chord`) | — |

Las tres primeras filas son la razón de que haya dos capas, y cada una enseña
un caso distinto. Multiplicar por diez una constante anti-denormal mueve el hash
de siete fixtures y **no mueve ni una métrica**, porque efectivamente no cambia
el sonido — y el mensaje del test lo dice con esas palabras: ahí el hash detecta
y la tolerancia evita mentir. Tocar el suavizado de coeficientes mueve los
mismos siete fixtures pero **cinco de ellos saltan por métricas**, hasta 0,861 dB:
ahí la capa perceptual detecta sola, con 86 veces el margen de la tolerancia.
Y cambiar la guarda del 0,2 % mueve 33 medidas hasta 0,9 dB, con el informe
listándolas ordenadas.

> Esa fila tiene una historia que conviene leer entera, porque el mismo número
> ha significado dos cosas distintas. Decía **0,017 dB** y estaba **mal**: era el
> Δ de `fx-eq-smoothing` solo —el fixture del nombre más parecido— en vez del
> máximo de la fila. La verificación de la v3.7 la remidió y daba **7 fixtures y
> 0,861 dB**. Y entonces la v3.8 la bajó **de verdad**, a 3 fixtures y 0,017 dB,
> esta vez por diseño y no por descuido: los tres llamantes que movían el corte
> muestra a muestra —`SynthVoice`, `PrismaVoice` y `AutofilterUnit`— pasaron a
> construir su SVF en modo `'per-sample'` (ver `CoefSource` en `filters.ts`) y ya
> no pagan ese one-pole. Lo que sigue apuntando a esa constante son los biquads y
> allpass por bloque, que es para quien se puso.
>
> Esa bajada dejó un hueco, y la fila de debajo es cómo se tapó: al no suavizar
> el filtro, quien desliza el escalón que llega por bloque es la propia
> `AutofilterUnit`, y **ningún fixture automatizaba un parámetro del autofiltro**,
> así que el banco pasaba igual con y sin esa pieza. `fx-autofilter-sweep` existe
> para eso, y se comprobó quitándola: 35 medidas fuera de tolerancia y 14,694 dB
> en la banda alta, que es el zipper.
>
> Dos lecciones para el que toque esta tabla: tomá el **máximo de la fila**, no el
> del fixture que suena parecido; y si una fila **baja**, preguntate si bajó
> porque el motor mejoró o porque el banco dejó de mirar.

### 4. Lo que el banco NO fija

Vale la pena tenerlo escrito, para que nadie confíe de más:

- **El flush de denormales de `DelayUnit`.** Se comprobó: perturbando
  `ANTI_DENORMAL` en `effects.ts`, flanger y phaser saltan y el delay no. Su
  línea de retardo es un `Float32Array`, y mientras quede señal audible en ella
  sumarle 1e-20 se pierde entero en el redondeo; esa DC solo se nota tras ~65 s
  de silencio. Lo fija `dsp-denormal.test.ts`, que mira el estado del filtro en
  vez del audio — la herramienta correcta para una propiedad de CPU.
- **Si el encoder suena mejor o peor.** El golden solo dice que el flujo cambió.
  Quién decide si el cambio es una mejora es `tools/qa/opus-quality.ts`, el
  banco contra libopus.
- **La percusión a través del encoder.** Había un tercer fixture Opus,
  `opus-drums`, y se quitó tras medir dos cosas: (a) con PCM de entrada
  idéntico bit a bit, su flujo salía distinto entre versiones mayores de V8
  (262 bytes de 38 640) y entre arquitecturas (234) — un transitorio deja al
  detector justo sobre su umbral y un último bit decide si la trama va en
  bloques cortos; y (b) las dos veces que saltaba, `opus-chord` saltaba con él.
  Costaba portabilidad y no cubría nada nuevo. Un golden así no fija el
  encoder: fija la versión de V8, y acabaría saltado.

## Añadir un fixture

Uno nuevo en `GOLDEN_FIXTURES` (o `GOLDEN_OPUS_FIXTURES`), con su `covers`
diciendo qué cambio de sonido cubre. Después `npm run golden:update` para verlo
como NUEVO y `--accept` para fijarlo. **Renombrar un fixture pierde su línea
base**: el test lo detecta comparando las dos listas en las dos direcciones,
pero conviene saberlo antes.
