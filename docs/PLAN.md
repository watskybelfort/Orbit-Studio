# Plan de trabajo — Orbit Studio

Plan por fases. Cada fase deja el producto **usable y coherente**; cada entrega
dentro de una fase es su propio commit. El release formal (tag + GitHub release)
se saca al final, cuando el conjunto está pulido.

---

## Estado — 31-08-2026: v3.10.0

**"Lo que se perdía en silencio".** La ronda arrancó por el paso 0 del ciclo, y
por primera vez lo que encontró no fueron promesas exageradas sino **dos caminos
por los que la app perdía audio del usuario sin avisar**.

### La auditoría (cinco lanes de solo lectura)

Se comprobó y SÍ se sostiene: los once tests que leen fuente entran todos por el
helper; el test del grafo muerde en sus tres comparaciones por separado y su
lista de símbolos se re-deriva de verdad; las cuatro puertas del barrido existen
(y hay una quinta no anunciada); no queda ningún `channel.mixerTrack` crudo
midiendo señal salvo el que ya estaba fichado; y el índice del kit acierta en
nombres, cabeceras y bytes.

Lo que falló se convirtió en seis tarjetas, y una se arregló en el sitio (la
lista de comandos, dos líneas que esta misma ronda había introducido, con un test
que impide que vuelva). Además, **tres cifras de la v3.9 no aguantaron la
remedición** y están corregidas: «doce dependencias» (lo reproducible son seis
aristas en 16 archivos), «los nueve tests que leen fuente» (once al cerrar la
ronda) y un «siete archivos» que ya era falso el día que se escribió.

### Lo que cerró la ronda

- **Dos caminos de pérdida de audio.** La ventana sin sujetar entre subir un
  sample y registrarlo —alcanzable con Ctrl+Z, y en el grabador durante cientos
  de milisegundos con tomas del usuario— cerrada en los cinco sitios. Y el nombre
  de archivo por reloj, que pisaba la edición de ayer a la misma hora: ahora se
  deriva del contenido, lo que de paso recorta el disco un 80 %.
- **La quinta puerta**: entrar en una sala de colaboración reemplaza el proyecto
  y no soltaba el audio del anterior. Se barre después de subir, con el porqué
  escrito, y el arreglo cerró además un agujero propio (`loadedIds` rancio dejaba
  el sample mudo).
- **Cuatro agujeros del linter de fronteras** (`require()`, `import()`, un barril,
  y los alias sin sincronizar) y **dos de los linters de color** (mayúsculas, y
  una regex copiada dos veces que ahora vive una sola).
- **Los `package.json`**, cuarta escritura del grafo, completados y vigilados por
  un cuarto assert del test que ya comparaba las otras tres.
- **La CI dejó de publicar a ciegas**, y `npm run ci:status` contesta en una línea.
- **Dos bugs de historial**: el pan de un send dejaba 40 undos por arrastre (vivo,
  encontrado al barrer) y `setInputRouteChannels` esquivaba su envoltorio.
- **El kit de escucha** mide el archivo y no el buffer, con el arreglo hecho
  estructural para que la prosa se derive de la medida.
- **El sexto test que medía la CPU**, cazado por la CI: hacía un `expect()` por
  muestra sobre 180.000. De 1200 ms a 261 sin tocar el margen.

### Estado de la red

2456 tests en 195 archivos, lint limpio (ESLint + `lint:css`), typecheck limpio,
build en verde. Golden: 25 renders + 2 flujos Opus, mordida **25/25**.

### Lo que queda abierto

- **Escuchar y probar con hardware** — la única que no puede hacer una sesión.
- La mitad del proceso main del barrido de grabaciones, que hoy decide bien y no
  manda nada; la sujeción por contador de referencias en vez de por `Set`; y el
  aviso de tests que se acercan a su timeout. Los tres, tarjetas ya escritas.

---

## Estado — 31-08-2026: v3.9.0

**"El rojo que nadie miró".** La ronda arrancó por el paso 0 del ciclo
—comprobar que lo que la v3.8 prometió es real— y lo primero que apareció no
estaba en ninguna tarjeta del tablero.

### Lo que la verificación encontró antes de tocar nada

- **La CI llevaba SEIS pushes en rojo, y la release de la v3.8.0 se cortó encima
  del último.** Ubuntu verde y Windows rojo en las mismas corridas, siempre por
  la misma causa: `input-section-recording-guard.test.ts` afirmaba un fragmento
  de tres líneas con `
` literales sobre un archivo que el checkout de Windows
  (`core.autocrlf=true`, el que trae el runner `windows-latest`) entrega con
  CRLF. Reproducido, no deducido: pasando `InputSection.tsx` a CRLF a propósito,
  la lectura de antes contesta `false` a esa aserción y la normalizada `true`.
  Arreglado por la clase — los **nueve** tests que leen código fuente entran
  ahora por `packages/ui/test/read-source.ts` — y la CI volvió a verde en los dos
  sistemas (run `33358761394`).
- **Una cifra mía, mal medida.** En el commit del arreglo escribí que el repo
  tenía «577 archivos versionados con CRLF». Falso: `git ls-files --eol` da 584
  archivos de texto y los 584 en LF. Había medido el árbol de trabajo, que con
  `autocrlf=true` ya está convertido — o sea una medida del `git config` de quien
  la corre, no del repositorio. Corregido en el propio archivo para que no vuelva
  a caer nadie, y el número bueno además refuerza la decisión: si el índice es
  todo LF, un `.gitattributes` con `eol=lf` no tendría nada que renormalizar.
- **Que la release salga con la CI roja es un agujero del proceso**, no del test
  que fallaba. Queda como tarea nueva del tablero, con las tres salidas posibles
  escritas.

### Lo que cerró la ronda

- **Las dos reglas duras que no describían el repo.** La 6 (grafo de imports) se
  reescribió con el grafo real —decisión A, con cuatro razones medidas, entre
  ellas que `ARCHITECTURE.md` ya describía en prosa las aristas que su lista
  negaba— y el grafo pasa a escribirse UNA vez en
  `tools/eslint/package-graph.json`, leído por la regla de ESLint y por un test
  que falla si CLAUDE.md o ARCHITECTURE.md divergen. La 4 (colores) sacó
  veintitantos literales y cinco fallbacks hex a tokens, y **nombra ahora su
  excepción**: los editores que pintan en `<canvas>` conservan su paleta local
  con valores literales porque `getComputedStyle()` no resuelve una custom
  property que referencia otra. La vigila un `npm run lint:css` nuevo.
- **Las tres cachés de audio del hilo de UI comparten política**: cada una se
  acota por su conjunto vivo, que lo define su consumidor. La del editor lleva
  además tope de recencia, porque es la única a la que el barrido por proyecto no
  acota. Y el barrido dejó de colgar de «se exportó»: cuelga de
  `collectWorkletSamples`, o sea de abrir proyecto, plantilla, restaurar versión
  y recuperar autosave. De 6 entradas a 2 tras cinco Normalizar; ~69 MB → ~23 de
  techo.
- **El scope del instrumento medía el máster** cuando el canal salía por un bus.
  La regla ya existía con nombre (`trackOfChannel`) y ya la usaban MixTab,
  run-export y el executor: el arreglo fue usarla, no escribir la tercera copia.
- **Un arrastre del deslizador de ganancia dejaba 80 undos.** El `mergeKey` entra
  en el envoltorio y lleva el id de la ruta *y* el campo, así que cubre los tres
  llamantes y el próximo campo de `InputRoute` no reabre el bug.
- **`npm run listen:kit`**: el material de escucha renderizado de los fixtures
  del golden, con 25 s de cola añadida detrás del fixture (el archivo mide ~26,7
  s, no 25), a 24 bits, y un índice que dice qué buscar en cada archivo. Existe
  porque la tarjeta de escucha llevaba dos rondas parada por fricción, no por
  falta de ganas. Las medidas del índice salen de decodificar el `.wav`, no del
  buffer float del motor: la continua de los anti-denormal (−364 dBFS en la
  reverb) no llega al medio escalón de 24 bits (−144,5 dBFS) y el archivo la
  guarda como silencio digital exacto, así que el índice da las dos cifras y dice
  cuál es cuál.

### Estado de la red

2330 tests en 183 archivos, lint limpio (ESLint + `lint:css`), typecheck limpio,
build en verde. Golden: 25 renders + 2 flujos Opus, mordida **25/25**.

### Lo que queda abierto

- **Escuchar la v3.7/v3.8 y probarla con hardware** — la única que no puede hacer
  una sesión: entradas multicanal con la interfaz real, calibración de latencia
  con el bucle físico, y el juicio del oído sobre lo que el kit deja renderizado.
- La tanda nueva del tablero, generada al cerrar esta ronda.

---

## Estado — 29-08-2026: v3.8.0

**"Cuando la red deja de mirar".** La ronda arrancó por el paso 0 del ciclo
—comprobar que lo que la v3.7 prometió es real— y ese paso solo ya destapó tres
cosas que el verde de los tests no contaba. Luego cerró las cuatro tareas
ejecutables que quedaban en el tablero.

### Lo que la verificación encontró

Tres auditorías independientes contrastaron lo prometido en cada tarjeta de la
v3.7 contra el código que quedó:

- **La fuga de audio del hilo de UI sigue viva.** El arreglo de la v3.7 es real
  y está bien hecho, pero tapó un archivo y no la clase: hay una **tercera**
  caché idéntica en `AudioEditor.tsx:29` (`pcmCache`) sin `delete`, `clear` ni
  tope, y crece *garantizado* — cada Normalizar/Reverse/Fade hace `newId()`, el
  clip repunta al sample nuevo y la entrada vieja queda retenida para siempre.
  Y la cota real no es «el proyecto abierto» sino «el último proyecto que se
  exportó», porque el barrido solo corre dentro de `collectSamples()`.
  **Cerrado**: las tres cachés comparten ahora una política escrita en
  `state/sample-gc.ts` —cada una se acota por su conjunto vivo, que define su
  consumidor— y el barrido cuelga de `collectWorkletSamples`, o sea de las
  cuatro puertas que reemplazan el proyecto entero, no de exportar. La del
  editor lleva además tope de recencia, porque es la única cuyo conjunto vivo
  es O(1) y a la que el barrido por proyecto no acota: los cinco samples de
  cinco Normalizar siguen registrados.
- **«Seis de los once avisos eran bugs de verdad» no se sostiene.** Se
  verificaron los seis y en todos la dependencia ausente ya estaba cubierta
  transitivamente por otra de la misma lista, o apuntaba a una identidad
  estable. Los cambios valen igual —dejan de depender de una cobertura
  accidental— pero la frase describía un fallo de usuario que nadie demostró.
  Corregida en los cuatro sitios donde estaba escrita.
- **Los golden tests muerden de verdad**, comprobado perturbando coeficientes
  reales del motor. Pero su `--accept` se tragaba el flag siguiente como motivo:
  `--accept --force` guardaba `"--force"` como explicación y saltaba la guarda
  de arquitectura a la vez. Arreglado, con la regla en un módulo compartido.

### Lo que se entregó

- **El pluck recupera su punch.** `CoefSource` en el constructor de `SVF` y
  `Biquad`: quien ya modula por muestra no paga el one-pole de 5 ms que existe
  para el llamante por bloque. 90 % del brillo a **3,42 ms en vez de 6,37**,
  exactamente la referencia sin suavizar. Y la otra mitad del trato:
  `AutofilterUnit` desliza ella misma el `cutoff`/`resonance` que sí le llegan
  por bloque — buscándolo apareció un bug latente, su guarda miraba solo el
  corte, así que automatizar la resonancia no llegaba nunca al filtro.
- **El fixture 25.** Ese cambio bajó la mordida del banco sobre
  `COEF_SMOOTH_SECONDS` de 7 fixtures a 3, y dejó sin fijar justo la pieza
  anti-zipper recién construida. `fx-autofilter-sweep` la fija: comprobado
  quitándola, 14,694 dB de basura en la banda alta.
- **Cancelar un export**, con la cancelación atendida dentro del render de una
  pista y sin coste en el bucle caliente.
- **La guarda del micro** en las funciones, y el hot-unplug avisando de que la
  toma se cortó.
- **Cinco tests** que medían la CPU de la máquina dejan de parpadear.
- **Nueve sitios** de documentación que no decían la verdad.

### Lo que queda abierto

- **Escuchar y probar con hardware.** Sigue siendo lo único que necesita al
  usuario: la cola de reverb y el piso de los anti-denormal, el barrido de
  filtro, el pluck (ahora que cambió), el `.opus` del acorde y del pack de
  batería, las entradas multicanal con la interfaz real y la calibración de
  latencia con el bucle físico.
- **Las cachés de audio del hilo de UI** (`pcmCache`, picos, y cablear el
  barrido a abrir proyecto).
- **Las dos reglas duras que no describen el repo**: la 6 (el grafo de imports
  real tiene seis aristas que la regla no permite, en 16 archivos) y la 4 (colores
  literales fuera de `theme/`, y tres editores con su propia paleta). Las dos
  piden una decisión antes que un arreglo: o se corrige la regla, o se corrige
  el código.
- **El deslizador de ganancia de entrada** dispara sin `mergeKey`: hasta 80
  entradas de historial por arrastre.
- **El tap del scope** de la vista de instrumento ignora el bus de la carpeta.
- **Más tests sensibles a carga** fuera del alcance de esta ronda:
  `engine/test/dsp-denormal.test.ts:121`, `engine/test/engine.test.ts:138`,
  `ui/test/plugin-parse.test.ts:87-89`, y los que comparten el patrón caro de
  `resetModules()` + reimport de `state/app`.
- **Firmar el instalador**: el camino está preparado en el workflow, falta el
  certificado.

### Números

179 archivos de test, **2301 tests**, lint sin avisos, typecheck limpio, build
en verde. Golden: 25 renders + 2 flujos Opus, 33 tests, mordida 25/25.

---

## Estado — 29-08-2026: v3.7.0

**La ronda que cierra el árbol de tareas de la revisión.** La v3.6 salió con
cuatro tareas todavía abiertas porque los arreglos que destapó la auditoría se
comieron la ronda; esta las cierra.

### La deuda más vieja, saldada

`packages/engine/test/golden` **existe**. La regla dura 5 llevaba tiempo
apuntando al vacío y nueve cambios de sonido habían entrado sin fijar.

Lo que hay que saber para trabajar con ella:

- **Dos capas a propósito.** El hash sha256 dice QUE algo cambió; la matriz de
  medidas perceptuales (LUFS, peak, cuatro bandas, correlación, del total y de
  ocho ventanas, con 0,01 dB de tolerancia) dice QUÉ cambió. Multiplicar por
  diez una constante anti-denormal mueve el hash de siete fixtures y no mueve
  ni una medida — el test lo dice con esas palabras.
- **El hash se compara sin condicional**, y eso está medido: el mismo bundle en
  cinco entornos con Docker sale bit a bit idéntico en x64 aguantando cambio de
  SO y tres versiones mayores de V8. La matriz de la CI cae dentro. Poner un
  `skip` por plataforma habría sido el camino fácil y habría dejado de proteger.
- **En arm64 difieren dos fixtures por FMA** (1,9e-13 dB de diferencia sonora).
  Ahí el test DEBE ponerse rojo, y `golden:update` bloquea regenerar la línea
  base desde arm64: hacerlo rompería el hash de toda la CI.
- **Actualizar pide un gesto**: `npm run golden:update` enseña el diff y no
  escribe; escribir pide `--accept "<motivo>"`. Nunca un `--update-snapshots`.

Tres cosas quedaron escritas en `docs/GOLDEN.md` en vez de tapadas: por qué se
quitó el fixture de percusión Opus (fijaba la versión de V8 y no el encoder, y
además no cubría nada), por qué `fx-delay` no fija el flush de denormales de
`DelayUnit` pese a lo que sugiere su nombre (línea de retardo en Float32, pierde
el 1e-20 en el redondeo), y por qué comparar el Opus por perfil de tamaños de
paquete sería portable pero no muerde.

### Lo demás de la ronda

- **El `sampleCache` del render** ya no crece sin freno: de 6460 a 1292 MiB en
  el escenario de cinco proyectos con tomas largas. Se desaloja al final de
  `collectSamples()`, nunca antes, así que jamás tira algo que la propia llamada
  necesita.
- **Seis de los once avisos de `exhaustive-deps` eran bugs reales** —manejadores
  del piano roll y la playlist leyendo valores rancios—, cinco sobran a
  propósito y ahora lo dicen. La regla sube de aviso a error.
- **Ganancia por ruta de entrada** (faltaba solo el mando: modelo, comando y
  kernel ya la aplicaban) y **vista de instrumento en el Channel Rack**,
  reusando el worker aislado del mixer en vez de un segundo camino de dibujo.

### Lo que sigue abierto

Lo que necesita manos y oídos: escuchar los cambios de sonido de las dos últimas
rondas —la cola de reverb con el piso nuevo, el pluck que perdió punch, el
`.opus` del acorde— y el hardware (interfaz de más de dos canales, bucle físico
de latencia). Más el punch del pluck, cuya solución de verdad pide que SVF y
Biquad sepan saltarse su suavizado interno, y la cancelación de un export.

---

## Estado — 29-08-2026: v3.6.0

**La ronda de revisar lo entregado.** Se auditaron las diecinueve tareas de la
v3.5 contrastando lo prometido en cada tarjeta contra el código que quedó, y
además **se abrió la app de verdad**. Veredicto: 13 cumplían, 5 con reparos, 1
no cumplía nada.

### El hallazgo de método, que vale más que los arreglos

**La v3.5 se cerró casi entera diciendo «no se pudo ver funcionando: no hay
pantalla ni tarjeta de sonido». La mitad de eso era falso.** La máquina tiene
pantalla. Orbit se levanta con `ORBIT_DEBUG_PORT=9223 npm run dev` y se conduce
con `tools/qa/cdp.mjs` (`eval` y `shot`), que ya existía en el repo.

Con eso se comprobó de verdad, y en los tres temas: el espectro por pista, el
LUFS en vivo, el cartel de versión nueva, los buses y —lo más difícil de
falsear— **las ramas del historial**, divergiendo a mano y viendo aparecer «1
rama guardada · 1 cambio que el undo normal habría borrado». Y las tools MCP de
`orbit-studio` escriben en la app viva por el bus de comandos, así que montar un
proyecto real para probarlo cuesta segundos. También sirve para MEDIR sin oír:
subiendo y bajando el fader de un bus, `analyze_mix` dio los 20 dB clavados.

**Regla para las próximas rondas: no volver a cerrar una tarea diciendo que no
se pudo ver.** Lo que sigue necesitando manos humanas es oír (ningún sustituto
numérico es escuchar) y el hardware.

### Lo que la revisión encontró roto

1. **El GC de samples no cumplía nada de lo que decía** (era la única «NO
   CUMPLE»). Solo disparaba al reemplazar el proyecto entero, y aunque hubiera
   disparado no habría liberado: un sample cuenta como vivo mientras esté en
   `project.samples`, `removeChannel` no lo quita —a propósito, para que el undo
   devuelva el audio— y `unregisterSample` tenía cero llamadas en la UI.
   La pieza que faltaba era saber **cuándo deja de ser recuperable**:
   `ProjectStore.unreachableIds()` responde qué ids ya no aparecen en ningún
   comando del historial —ni pasado, ni futuro, ni archivado en una rama— ni en
   sus inversos. Cuando duda, conserva.
   Ojo con el detalle que costó un bug: despachar la limpieza con `origin:
   'local'` justo tras Ctrl+Z **archiva el redo del usuario en una rama** vía
   `stashRedo`. Va con `origin: 'gc'`.
2. **Se tapó un archivo, no la clase de problema.** El anti-denormal estaba solo
   en `reverb.ts`. Faltaba en `filters.ts` (Biquad, SVF, Allpass1) y en delay,
   flanger y phaser. Y Biquad es `StripEq`, que corre en cada canal del mixer.
   Medido: un Biquad resonante tras el silencio entra en un **ciclo límite
   permanente** en rango subnormal —confirmado a 8 millones de muestras— a 73
   ns/muestra contra 9-12 de referencia.
3. **Un ciclo de enrutado enmudecía la mezcla entera sin avisar** (−240 dBFS).
   El detector `wouldLoop` ya existía y el editor de nodos lo usaba; el menú del
   mixer y el puente MCP entraban por otra puerta. Ahora `setRoute` lo rechaza
   antes de mutar y el menú enseña el motivo.
4. Cuatro bugs de UI, un stem que se llevaba a sus hermanos de lote, y el
   roadmap del README listando como pendiente casi todo lo ya entregado.

### Lo que se midió y NO funcionó (para no repetir el camino)

- **La guarda de umbral no recupera el punch del pluck.** Se añadió el 0,2% que
  ya usaba `prisma-voice.ts` al suavizado por muestra de `voices.ts`, y se midió:
  durante los 5 ms de ataque el corte cambia más de ese 0,2% en el 90-100% de las
  muestras, así que dispara casi igual. Tiempo hasta el 90% de brillo: 6,76 ms
  con guarda y sin ella, contra 3,70 sin suavizar. Arreglarlo pide que SVF y
  Biquad sepan saltarse su suavizado interno para quien ya los modula de forma
  continua — cambia el sonido, es decisión aparte.
- **Apagar el detector de transitorios por tonalidad no arregla el acorde.**
  Reduce los falsos positivos de 5-6 a 1 de cada 75 tramas y **la cifra objetivo
  no se mueve** (la empeora una décima). Lo que queda del acorde es la sombra
  del VBR en el fundido de salida, no el detector. Queda implementado y apagado.

### Lo que sigue abierto

- **Los golden tests siguen sin existir**, y ahora hay más cambios de sonido sin
  fijar: los denormales tocaron cinco unidades más. Es la tarea número uno.
- Ganancia por ruta, vista de instrumento en el rack, el `sampleCache` del
  render, los 11 avisos de exhaustive-deps y firmar el instalador.

---

## Estado — 28-08-2026: v3.5.0

**Diecinueve tareas de una auditoría del árbol entero**, ejecutadas en paralelo
por agentes con reparto exclusivo de archivos. Lo que hay que saber para seguir:

### Lo que se aprendió, más allá de las funciones

**Tres veces la documentación afirmaba algo falso, y las tres tenían
consecuencias de diseño.** No son erratas: son premisas sobre las que se estaban
tomando decisiones.

1. **El postfiltro no pedía un decodificador embebido.** Este PLAN y el README
   lo daban por hecho, y por eso llevaba catalogado como «la pieza cara» y iba
   detrás en el roadmap. El prefiltro de CELT es un lazo abierto: FIR sobre la
   entrada en el encoder, IIR sobre su propia salida en el decodificador. Costó
   mucho menos de lo escrito. **Corregido.**
2. **No hay ningún `Y.UndoManager` en el repo**, aunque `ARCHITECTURE.md` y este
   PLAN dijeran que el undo por usuario es de Yjs. El scoping por origen vive en
   `ProjectStore`. Y eso cambió el diseño del historial en árbol: como en Orbit
   un undo **no rebobina** —aplica el inverso y lo *emite*—, volver a una rama
   funciona en una sala sin protocolo nuevo. **Corregido.**
3. **`packages/engine/test/golden` NO EXISTE**, aunque la regla dura 5 de
   `CLAUDE.md` mande actualizar sus hashes ante cualquier cambio de sonido. Lo
   que hace de red es el banco de aserciones numéricas del engine. **Sin
   corregir: es tarea de la ronda siguiente**, y es seria — esta versión metió
   cuatro cambios de sonido (denormales, suavizado de coeficientes, y dos del
   encoder) sin un hash que los fijara.

### El encoder Opus, decidiéndose con oído

La pieza central es **la medida perceptual** (`tools/qa/opus-metrics.ts`,
`patronDb`): PEAQ simplificado sobre el modelo de oído de la BS.1387, con dos
términos —sonoridad y **planitud espectral por banda**—, porque el primero solo
tampoco veía la dispersión y eso se comprobó barriendo nfft, pendiente y
suavizado. **Para decidir manda el patrón; la SNR se queda como red** porque
cazaría una catástrofe de fase, a la que el patrón es ciego.

Con ella entraron la dispersión adaptativa (+0,40 dB), los transitorios y el
postfiltro. Distancia media a libopus: **−3,59 → −0,79 dB**.

**Y salió un bug que llevaba desde el primer día**: el encoder marcaba la trama
como silencio y seguía escribiendo, mientras el decodificador descartaba el
resto y dejaba todas las bandas en silencio. Los dos lados predecían desde
sitios distintos y el desfase se amplificaba banda a banda por el término
`prev`. Se oía en cada golpe del pack de batería.

**La regla que hay que seguir respetando ahí**: toda decisión que el formato
transmite «solo si cabe» hay que tomarla **DENTRO de la rama que la escribe**.
Ha mordido cinco veces. Las dos últimas piezas añadieron la forma de
demostrarlo: un test que **relee el paquete con el `RangeDecoder`** y comprueba
que lo leído es lo que el encoder usó.

### Lo que queda medido para la ronda siguiente

- **El peor caso sigue siendo tonal (−10,88 dB) pero ya NO por falta de
  predicción de tono**: el postfiltro acierta el período 75/75. Lo que queda es
  reparto de bits entre bandas.
- **Una regresión conocida**: mezcla estéreo 128k es la única que empeoró con el
  postfiltro (−0,37), y ahí el peine se enciende 41/75 con período 827 ± 183 —
  persiguiendo algo que no es periódico. No se tocaron los umbrales porque son
  los de la referencia.
- **`sampleCache` de `render-inputs.ts`** es otra fuga del mismo tipo que la del
  worklet (mapa de módulo con audio decodificado, sin vaciar nunca), pero en el
  hilo de la UI.
- Falta el mando de ganancia por ruta de entrada en la UI (el modelo y el kernel
  ya la llevan), y el Channel Rack no pinta todavía la vista de un plugin de
  instrumento.

## Estado anterior — 26-08-2026: v3.4.0

**El encoder Opus, un poco más fino.** La `alloc_trim` —la pendiente con la que
el asignador reparte bits entre bandas— llevaba fija en neutro desde que el
encoder existe. Con el 5 fijo, un acorde (toda su energía abajo, casi nada
arriba) recibía el mismo esfuerzo en las bandas vacías que en las que llevaban
la música; los bits no se pierden en el aire, se los quita a donde se oyen.
Ahora sale del momento de primer orden del espectro.

Antes de tocar nada se construyó con qué medirlo (`tools/qa/opus-quality.ts`):
la misma señal por Orbit y por libopus al mismo bitrate, las dos decodificadas
por ffmpeg y comparadas con el original. La distancia media pasó de **−2,06 a
−1,21 dB** y la peor de −9,62 a −7,86.

Lo que hay que saber para seguir:

- **El agujero que queda es lo TONAL** (−7,9 dB en el peor caso, y peor en
  estéreo). Ahí ayuda el postfiltro — que resultó NO ser la pieza cara que
  aquí se daba por hecha: no pide correr el decodificador dentro del encoder,
  porque el prefiltro es un lazo abierto (FIR en el encoder sobre la entrada,
  IIR en el decodificador sobre su salida). Ver README.
- **En ruido y en mezcla salimos POR DELANTE de libopus**, y eso no es una
  buena noticia: quiere decir que gastamos bits donde libopus ya sabe que no
  hacen falta.
- **La dispersión adaptativa se implementó y NO entró.** Portada de la
  referencia, funcionaba, y la medida salió neutra (−0,02 dB, que es ruido)
  porque la SNR no ve lo que hace la dispersión — reparte el error dentro de la
  banda, no lo reduce. Sin poder demostrar la mejora no se sube. Para decidirla
  hace falta una medida perceptual, no una de error.
- **La trampa del formato, dos veces**: tanto la inclinación como la dispersión
  solo se transmiten SI CABEN, y cuando no caben el decodificador da por hecho
  el valor por defecto. Así que la decisión hay que tomarla DENTRO de la rama
  que la escribe. Tomarla fuera y escribirla dentro no da error: los dos lados
  reparten distinto, el paquete se descoloca entero y sale ruido.

Y `tools/` entra en el typecheck, que no estaba — el mismo agujero por el que
el generador del pack llevaba meses roto sin que nadie pudiera verlo.


**La rueda de tono, grabada.** Desde la v3.2 la rueda dobla la voz viva en los
diez instrumentos, pero lo que dobló no quedaba en ninguna parte: grabar
tocando guardaba las notas y no el gesto. El motivo era que la rueda no era un
parámetro — era un mensaje suelto al motor, y la automatización solo sabe
escribir parámetros.

Ahora `Channel.bend` existe, en semitonos, y con eso llegan de golpe la curva
de automatización, el LFO (un vibrato sobre la rueda sale gratis), el undo, el
viaje a la sala y la grabación al mover la rueda tocando. Sin comando nuevo:
viaja por `patchChannel`, igual que el keymap y los cortes del Slicer.

Lo que hay que saber para tocarlo:

- **La rueda va por DOS caminos a la vez.** Al motor, directo y en cada
  mensaje, porque es un gesto y entre moverla y oírla no puede haber ni un
  frame. Y al proyecto, una vez por frame y con `mergeKey`, que es lo que la
  convierte en algo que queda sin dejar sesenta pasos de undo por segundo.
- **Ausente NO es centrada.** Un canal que no declara `bend` significa "no
  tengo opinión" y el kernel le respeta lo que tenga puesto; si significara
  centro, cualquier recompilación —mover una perilla mientras se dobla—
  soltaría la rueda de golpe en mitad del gesto. Recentrar lo hace el mensaje
  de la rueda al soltarla, que es quien sabe que se ha soltado. Es la decisión
  que el roadmap pedía tomar, y el test que protege la regla desde la v3.2
  sigue en verde.
- **Soltar la rueda también se vuelca.** Sin eso la curva quedaría colgada
  arriba y la nota siguiente nacería doblada al reproducir.
- **±24 semitonos** es el rango del PARÁMETRO, no el de ninguna rueda: tiene
  que dar cabida al más ancho que ofrece el teclado. Una curva grabada ya no
  sabe de ruedas, guarda semitonos.
- `setChannelBend` en el kernel junta las dos mitades que no pueden separarse:
  el valor en el canal compilado y la reafinación de las voces vivas.

De paso, un test que fallaba una de cada tres pasadas de la suite entera y no
por lo que parecía: no era una aserción, era el límite de 5 s de vitest contra
un render de cuatro minutos de audio.


**Archivos sueltos del Explorador**, al keymap, al rack y a la playlist. La
fila venía marcada en el roadmap como decisión de seguridad y no como un
handler más, y el motivo era bueno: el proceso principal desconfía a propósito
de las rutas que le pasa el renderer —las carpetas de sonidos solo entran por
el diálogo nativo, `folder:read` no sirve nada de fuera de ellas y
`settings:set` no puede tocar esa lista blanca— porque en ese renderer corre
código que no es nuestro, los plugins JS del usuario.

**Y resultó que la puerta no había que abrirla.** Un arrastre de verdad trae
objetos `File`, que son `Blob`: los bytes se leen en el renderer porque
Chromium los concede al haber un gesto físico del usuario sobre la ventana. El
main no ve una ruta, no lee nada y no se entera. Cero superficie nueva en el
proceso privilegiado.

Lo que sí había que resolver era el día siguiente: un `File` soltado se acaba
al cerrar la app, y un proyecto que apuntara a él saldría MUDO al reabrirlo.
Así que lo soltado se IMPORTA — los bytes se copian a la carpeta de la app,
donde ya viven las tomas y los bounces— y desde ahí es un sample más: rehidrata
al reabrir, viaja por hash a una sala de colaboración y sale en el export.

Lo que hay que saber para tocarlo:

- **Se guarda con el nombre de su CONTENIDO** (`importado-<sha1>.wav`). Por
  nombre, dos `kick.wav` distintos se pisan y el proyecto de la semana pasada
  suena con otro bombo sin avisar; por contenido, además, el mismo archivo
  soltado dos veces cae en el mismo id y no se duplica.
- **Por eso el nombre original viaja en `name`, y de ahí saca la nota el
  auto-mapa.** Un `Piano_C3-ab12cd.wav` le daría a leer un hash hexadecimal
  lleno de letras que son notas y números que parecen octavas.
- **El reparto del arrastre es SÍNCRONO y va antes del primer `await`.**
  `webkitGetAsEntry` —lo único que distingue una carpeta de un archivo— deja de
  responder en cuanto se cede el turno, y `dataTransfer` se vacía. En la
  playlist se lleva por delante también la pista y el beat: `currentTarget` se
  queda en null igual. Por eso `triageDrop` está partido de `importTriaged`.
- Una carpeta soltada no se rechaza como archivo malo: se cuenta aparte y se
  dice por dónde entra de verdad (registrarla, que la indexa entera y no la
  copia).

1661 tests.

## Estado anterior — 26-08-2026: v3.3.0

v3.3, "el piano responde a los dedos". La primera fila del roadmap de la v3.2,
que era la que esa versión dejó fuera con el motivo escrito: los instrumentos
ya se grababan a tres alturas, pero con una sola pulsación.

**Bajar el fader no es tocar flojo.** En un instrumento de verdad la fuerza
cambia el timbre, no el volumen — el volumen ya lo pone el sampler multiplicando
por la velocidad de la nota. Así que cada altura se graba dos veces y cada
familia responde con su moneda:

- El piano acústico empina la caída espectral y apaga el martillo. El martillo
  además entra más oscuro: fieltro que roza, no que percute.
- El eléctrico baja el índice de FM, que es literalmente lo que hace un piano
  eléctrico de verdad al golpear más lejos del tine. Flojo, desaparece el
  diente y queda la campana redonda de debajo.
- La cuerda pulsada cambia lo romo de la excitación —la yema contra la uña—, y
  NO la amortiguación del lazo, aunque sería lo natural: la amortiguación entra
  en el largo del retardo y con él en la afinación, así que moverla dejaría la
  capa floja desafinada respecto de la fuerte en la misma nota.
- El bajo abre menos la envolvente de filtro; el corte de reposo no se toca,
  que es el cuerpo de la nota.
- La campana baja el índice: el badajo. El vibráfono, la dureza del mazo.
- El órgano, casi nada, y esa es la respuesta correcta: un Hammond no responde
  a la pulsación. Ceden el click de los contactos, la percusión y —esto sí por
  decisión, no por imitación— los drawbars de arriba, porque un instrumento del
  pack que ignore del todo la velocidad se siente roto bajo los dedos.

**La capa fuerte es el sonido de siempre, bit a bit.** `dyn` = 1 reproduce la
síntesis anterior exactamente, comprobado toma a toma (72 de 72) antes de
regenerar nada. Al regenerar el pack, de los 133 archivos que ya estaban el
único modificado es `manifest.json`: ningún proyecto guardado cambia de sonido.

**La pulsación NO entra en la semilla del PRNG**, y es lo contrario de lo que se
decidió con la altura en la v3.2. Dos alturas suenan JUNTAS —un acorde— y
compartiendo aleatoriedad se funden en una sola fuente; dos capas de la misma
nota no suenan nunca a la vez y tienen que ser la MISMA cuerda golpeada
distinto, o cruzar el borde de velocidad sonaría a cambiar de instrumento. De
ahí la regla al tocar cualquier síntesis del pack: la pulsación cambia
amplitudes, índices y cortes, nunca la estructura de los bucles — en cuanto
`dyn` cambie cuántos números pide el PRNG, las dos capas se separan.

En la UI, el instrumento entra ya repartido por teclado y por fuerza, con las
franjas leídas del manifest (no repartidas por el orden de llegada), y las zonas
se nombran con su capa: "Piano Suave C4 p" y "Piano Suave C4 f".

El pack pasa de 42 a 70 MB y de 132 a 204 archivos; el tope escrito sube de 48 a
80 MB, en el generador y en su test. 1621 tests.

**Fuera, con motivo escrito**: una tercera capa de fuerza (otras 72 grabaciones
y 28 MB, y el salto que se gana de dos a tres es menor que el que se ganó de una
a dos) y hornear la diferencia de nivel en el archivo (la aplicaría dos veces: el
sampler ya multiplica por la velocidad).

## Estado de la v3.2.0 — 23-08-2026

v3.2, "el pack suena a instrumentos". Tres entregas del roadmap de la v3.1, y
van juntas porque las tres arreglan lo mismo: que Orbit sonara a muestras y no
a instrumentos.

**El pack de fábrica, en multisample.** `rootHz` era mentira: estaba en el
catálogo como metadato del manifest, pero la altura de verdad la ponía una
constante de módulo leída dentro de cada síntesis, así que los dos podían
dejar de coincidir sin que nada se enterase. Ahora es un parámetro
(`render(sr, rootHz)`) y cada instrumento se graba a tres alturas.

Threading la altura salieron cuatro cosas que solo se ven al grabar el mismo
instrumento en dos octavas, y las cuatro se oyen:

- La semilla del PRNG lleva la altura. Con la vieja —solo el slug— las tres
  tomas de un pad compartían desafinaciones, fases y frecuencias de deriva:
  juntas no sonaban a sección, sonaban a una fuente doblada.
- Los filtros de los instrumentos SINTÉTICOS siguen a la nota; los de los
  ACÚSTICOS no. El martillo del piano y el soplo de la flauta son formantes —
  no se mueven con la nota, y esa es exactamente la razón de grabar varias
  alturas en vez de estirar una.
- La cuerda pulsada se afina con retardo fraccionario. Media muestra de
  redondeo son 0,7 cents abajo y 2,6 arriba: la guitarra salía desafinada
  consigo misma y el escalón caía al cruzar de zona.
- Guardas de Nyquist donde el FM se sale (el tine 14:1 del piano eléctrico).

Y el bajo del pack ahora suena donde dice el piano roll: grabado en C2 y
colocado en la tecla 60, sonaba dos octavas más abajo que la pantalla.

El pack pasa de 22 a 41 MB, y el techo de banda de 12 a 14 kHz (existía para
dejar sitio al estiramiento, y el estiramiento es ahora la sexta parte; en PCM
el tamaño no depende del ancho de banda).

**La rueda de tono dobla el tono.** `Voice.retune()` es ahora el único sitio
donde una voz se reafina, y de él cuelgan el slide y la rueda: lo que arregle
uno no se le puede olvidar al otro. Cada instrumento lo implementa con su
moneda. El kernel guarda los semitonos POR CANAL, que es la otra mitad: una
nota tocada con la rueda sujeta nace ya doblada (`snap`) en vez de trepar sola.

**Muestras al keymap en bloque.** Payload de arrastre plural (manteniendo el
MIME de siempre, que es lo que consultan los `dragover` de todos los destinos),
selección múltiple en el Browser con su lógica aparte y probada, y cabeceras
que arrastran su grupo. Los tres destinos reparten en un solo deshacer.

**Tres fallos que estaban ahí antes**: el auto-mapa leía la nota de la RUTA
(una carpeta «Piano C3» apilaba treinta muestras en un do) y `take01/02/03` se
tomaban por las teclas 1, 2 y 3; y el generador del pack llevaba roto —le
faltaban campos que el kernel dio por obligatorios— sin que nadie pudiera
verlo, porque `packages/*/generate` no estaba en el typecheck.

**Fuera, con motivo escrito**: capas de velocidad en el pack (otras 48
grabaciones y 20 MB), soltar archivos del Explorador (el proceso principal
desconfía a propósito de las rutas del renderer: es una decisión de seguridad)
y grabar el gesto de la rueda como automatización. 1544 tests.

## Estado de la v3.1.0 — 23-08-2026

v3.1, "el instrumento entero". Multisample: un canal de sampler con varias
muestras repartidas por teclas y por velocidad, en vez de una estirada por todo
el teclado con keytrack (un piano grabado en do sonaba a chipmunk dos octavas
arriba, porque cambiar la velocidad de lectura mueve las formantes y el ataque
con el tono).

Sale de la primera fila del roadmap de la v3.0.

**El modelo** (`core/model/keymap.ts`): una zona es un rectángulo en el plano
(tecla × velocidad) con su muestra, su raíz, su afinación fina y su ganancia.
Las zonas pueden solaparse a propósito —capas suave/fuerte, dos micros de la
misma toma— y todas las que caigan bajo la nota suenan. Viaja por `patchChannel`
como los cortes del Slicer, así que trae undo y colaboración sin comando nuevo,
y se sanea al abrir el .orbit.

**El auto-mapa** (`core/model/keymap-automap.ts`) es lo que hace que se use:
las muestras entran con su nota leída del nombre. Lo difícil no es leer
`Piano_C3.wav`, son los falsos positivos — `Bass2.wav` no es un si. Lo que no
sabe leer NO lo coloca: lo dice.

**El motor**: `MultiSamplerVoice` delega la lectura en `SamplerVoice`, una por
zona, en vez de reimplementarla — ese código tiene guardas de interpolación
bien pagadas (un NaN se queda para siempre en el limiter del master) y dos
copias se desincronizan. Las capas son UNA voz contra el tope del kernel.

**Un fallo que habría salido mudo**: el recolector de samples del render miraba
solo `ch.sampleId`, así que exportar un instrumento multisample lo habría
sacado en silencio. La decisión de qué samples hacen falta es ahora una función
pura con pruebas.

Y la tool 22 del bridge, `set_keymap`: Claude monta el multisample con las
muestras que ya tiene el proyecto.

**Fuera, con motivo escrito**: el pack de fábrica en multisample (toca el
generador, el manifest y el tamaño del instalador: su propia entrega) y soltar
muestras en bloque (el Browser arrastra una entrada cada vez). 1335 tests.

## Estado de la v3.0.0 — 23-08-2026


v3.0, "la toma en vivo". Orbit producía de maravilla y no se tocaba: esta
versión cierra el agujero por el que entra el sonido de fuera. Sale de las tres
primeras filas del roadmap, que eran las tres el mismo problema.

Es mayor y no menor por dos motivos. Uno de producto: el estudio deja de ser
una cosa en la que solo se *programa* música. Y otro técnico: cambia la forma
del motor — el nodo del kernel pasa a tener entrada, `MeterFrame` gana un campo
obligatorio (`inputPeak`) y la ruta de grabación deja de pasar por el navegador.


**El controlador MIDI, en serio.** La entrada era un `for` sobre todas las
entradas de Web MIDI, en todos los canales, con la velocidad tal cual. Ahora
cada dispositivo se enciende y se apaga por su cuenta —y apagado es sin
manejador, mudo del todo—, con filtro de canal, transposición por octavas y
curva de pulsación. La lectura de los bytes vive aparte (`midi-message.ts`) y se
prueba sin hardware: el note-on con velocidad 0 que ES un note-off, el pedal
continuo con histéresis, el pitch bend de dos bytes de 7 bits. El pedal de
sostenido (`sustain.ts`) va por dispositivo y resuelve los dos casos que dejan
notas colgando: repicar una tecla con el pedal pisado y apagar el teclado sin
levantarlo.

**MIDI learn.** Clic derecho en cualquier perilla → mueves el mando → casados.
Hizo falta la mitad que faltaba de `ParamRef`: `paramRefCommand` (core) devuelve
el Command que ESCRIBE cualquier destino, así que un mando físico pasa por el
bus y tiene undo y viaja a la sala. Volcado por frame y `mergeKey` por origen:
un barrido entero es un paso de undo, no doscientos.

**Grabar tocando.** El beat de una nota salía del último frame de medidores
(hasta 46 ms de error repartido al azar); ahora sale del `timeStamp` del evento
contra `beatAt(t)`. Rejilla elegible, sin cuantizar incluido. Y volcado al
patrón al cerrar CADA vuelta del loop, partiendo las teclas que sigan pulsadas.

**El micro entra en el kernel.** El nodo tenía `numberOfInputs: 0`. Ahora tiene
entrada y `setLiveInput` la suma a una pista ANTES de sus inserts — el monitor
suena con la cadena puesta, que es lo único que lo hace útil. Escuchar (medir) y
monitorizar (oírse) son dos interruptores: ajustar la ganancia no puede
obligarte a montar un acople.

**Y la toma se graba en crudo.** `MediaRecorder` en este Electron solo sabe
webm/opus: cada toma se comprimía con pérdida y se volvía a decodificar para
escribirla como un WAV de 24 bits que ya no los tenía. Ahora las muestras
vuelven del kernel tal cual.

**La cuenta atrás suena.** El metrónomo del kernel solo clica rodando, así que
grabar desde el compás 1 enseñaba el conteo sin sonar. La cuenta la lleva ahora
el kernel, y un beat después del último clic arranca él mismo el transporte: la
cuenta y el compás 1 comparten reloj.

**Fuera, con motivo escrito**: la rueda de tono como TONO (pide reafinar voces
vivas y de los diez instrumentos no todos saben hacerlo; a medias se notaría en
unos sonidos sí y en otros no) y las entradas de más de dos canales (la del
kernel es estéreo fija). 1261 tests.

> El detalle de las versiones entre la v1.0 y la v2.9 está en
> [FEATURES.md](FEATURES.md) y en el historial del README.

## Estado anterior — 17-08-2026: v1.0.0


v1.0, "el estudio completo". Cinco bloques cerrados de una tacada, con el
trabajo repartido en agentes en paralelo sobre archivos exclusivos y los
commits granulares de siempre.

**Orbit Nova** — el instrumento de presets (el equivalente de FLEX): 26 sonidos
en 8 categorías, cada preset una pila de capas sobre los motores que ya
existían (nada de samples: el canal guarda el id y sus macros), 8 perillas
fijas y 2 macros que toman su nombre del preset, con su browser dentro.

**Paridad FL** — compases variables y tempo por marcador (mapas en el
compilador y un índice por mapa en el kernel que avanza *y* retrocede),
historial de undo navegable que no rompe el undo por origen, herramientas
Pincel/Cortar (P·B·C), riff machine determinista por semilla (Alt+G), graph
editor de velocity, randomizar/humanizar, filtros de canal y count-in.

**Audio pro** — pitch-shift de clips sobre el mismo motor SOLA del
time-stretch, afinador de tomas por PSOLA con escala, detección de transientes
y troceado, convolución particionada no uniforme con IR sintética, vinyl/lo-fi
determinista, carriles de toma (comping) y congelar/descongelar pista.

**Instrumentos y librería** — Orbit Vox (formantes) y Orbit Slicer, plugins JS
de instrumento de punta a punta, browser con filtros combinables, favoritos y
colecciones, volumen de preview y detección automática de BPM y tonalidad al
indexar, y plantillas de proyecto (trap, boom bap, reggaetón, voz sobre beat).

**Estudio y entrega** — layouts de ventanas (tres predefinidos + los del
proyecto), escala de UI 80–150 % con su shim de coordenadas, fuentes y radios,
tema exportable a archivo, Ctrl+E, export de la selección, info del proyecto,
colaboración con modo seguidor, chat anclado al timeline y permisos por rol, y
el asistente de mezcla de Claude (`advise_mix`).

De regalo, dos bugs viejos que salieron por el camino: el reverb metía 250 ms
de retardo con predelay 0 (leía el anillo antes de escribirlo) y `add_channel`
del bridge rechazaba instrumentos que su propio esquema anunciaba.

**Fuera, con motivo escrito**: OGG (en este Electron `MediaRecorder` no admite
contenedor Ogg y grabaría en tiempo real; haría falta un encoder Opus propio),
puente CLAP/VST3 (necesita host nativo con GUI embebida) y galería de plugins
de la comunidad (necesita backend). 280 tests.

## Estado anterior — v0.9.0

v0.9, "cierra la pista": **consolidar a audio** (render de los clips de una
pista por la cadena de mixer completa → un clip de audio en su sitio, con el
WAV en userData/recordings y todo en un undo), **grabar la salida de una pista**
del mixer en vivo mediante un tap post-fader en el kernel, **EQ de 3 bandas y
separación estéreo por pista** (automatizables y con LFO) y **altura
arrastrable e icono** por pista de playlist. 145 tests.

## Estado anterior — v0.8.0

v0.8, "la mezcla se mueve sola": **LFO por parámetro** (5 formas, velocidad en
beats, cantidad bipolar y fase; oscila sobre el valor actual y sobre la curva
automatizada si la hay, con la fase derivada de la posición de la canción para
que el export salga idéntico al directo), **menú de automatización en cada
perilla y fader** (crear su clip o colgarle un LFO sin buscar el destino en tres
desplegables) y **grabación de movimientos de perillas** en vivo: al parar,
cada mando movido cae como clip con la curva simplificada por Douglas-Peucker,
todo en un solo undo. 137 tests.

## Estado anterior — v0.7.0

v0.6, "backlog fino + paridad FL": FLAC con encoder propio, sample rates y cola
configurables en el export, snap magnético y bloqueo a escala, atajos FL del
piano roll, menú de canal en el rack, espectro y curva RBJ dentro del EQ, RMS
por strip, color por pista, BPM decimal y compás editable, fix del metrónomo,
**ventanas desacoplables** y toolbar rehecha con modo Zen. v0.7, "el horizonte":
**time-stretch** de clips por SOLA en el kernel, **SDK de plugins JS** de
usuario (carpeta propia, sandbox con bypass, también en el export) y **vista
Live por escenas** (F8) con lanzamiento cuantizado con precisión de sample.

## Estado anterior — v0.5.0

v0.5, "toca y despacha": **tocable en vivo** (Web MIDI + teclado del PC,
grabación MIDI armada al patrón con cuantización, pause real y tap tempo),
**flujo diario** (paleta Ctrl+K, cortar y mutear clips, gestión de
arrangements, export del loop y MP3, carpetas del usuario en el browser),
**el toque Orbit** (cadena vocal de un clic y campo de petición a Claude en
su panel) y **el pack crece a 84 sonidos** con la categoría Instrumentos:
24 instrumentos con altura por síntesis (pianos, guitarras Karplus-Strong,
bajos, órganos, pads, campanas, leads) tocables por nota en el piano roll
vía sampler + keytrack. 107 tests.

## Estado anterior — v0.4.0

v0.4, "graba tu voz": **grabación de micro a la playlist** (botón en el
transport; la toma se guarda como WAV en userData/recordings, se registra
con el esquema `recording:` y cae como clip donde empezó, con rehidratación
al reabrir), **editor de audio estilo Edison** (recorte por asas no
destructivo, ganancia, normalizar/reverse/fades como sample nuevo con undo)
e **import MIDI** (decodificador SMF con round-trip contra el export;
Archivo → Importar crea canales, patrón y tempo en un undo). 79 tests.

## Estado anterior — v0.3.0

v0.1: fases 0–7 completas con QA real contra la app viva. v0.2: fiabilidad
diaria (CI, CPU visible, autosave + crash recovery) y flujo real (export MIDI
multipista, marcadores, drag & drop, clips de audio, rehidratación de samples).
v0.3, "el estudio se siente vivo": **piano roll pro** (arpegiar, strum,
humanize y chop de note-tools, pan por nota en el carril conmutable, minimapa
clicable), **colaboración visible** (cursores remotos con nombre y color en
playlist y piano roll, actividad por peer en el panel y Claude como
colaborador en la presencia) y **mixer fino** (nivel por send con perilla,
línea de RMS + LED de clip enclavado, Orbit Scope real con forma de onda y
espectro del master). 65 tests en verde. Instalador NSIS por release.

Backlog tras v1.0 (detalle en [FEATURES.md](FEATURES.md)): graph editor del
rack por nodos, pre-count visual, agrupación de canales por carpetas, slice por
transientes dentro del Slicer, packs de sonidos generados por Claude, y el
horizonte v1+: puente CLAP/VST3, galería de plugins de la comunidad, streaming
de audio de la sesión y multi-ventana real.

---

## Fase 0 — Fundaciones (docs + esqueleto)

**Objetivo:** el proyecto existe, está documentado y compila.

- [x] Documentación maestra: PLAN, FEATURES, ARCHITECTURE, THEMING, COLLAB, CLAUDE-INTEGRATION.
- [x] Monorepo npm workspaces con TypeScript estricto: `apps/desktop`, `apps/server`,
      `packages/{core,engine,ui,collab,claude-bridge,sound-library}`.
- [x] Repo GitHub privado `Orbit-Studio`.
- [x] CI mínimo (typecheck + tests + build) en GitHub Actions.

**Criterio de salida:** `npm run dev` abre una ventana Electron con la UI base.

---

## Fase 1 — El corazón: modelo + motor de audio

**Objetivo:** suena. Un proyecto en memoria se reproduce con precisión de sample.

### 1a. `packages/core` — el modelo de proyecto
- Tipos completos: proyecto, patrones, canales (instrumentos), notas, playlist
  (pistas y clips), mixer (pistas de insert, slots de efectos, routing, sends),
  automatización, marcadores, arrangements.
- **Bus de comandos**: toda mutación pasa por un comando con inverso → undo/redo
  ilimitado, y la misma vía sirve luego para colaboración y para Claude.
- IDs estables (nanoid) en todas las entidades → merge CRDT sin ambigüedad.
- Serialización `.orbit` (JSON versionado; samples referenciados por hash).

### 1b. `packages/engine` — el motor DSP
- Un AudioWorklet único con el kernel completo (sin latencia de grafo Web Audio):
  - **Transport**: play/stop/loop, PPQ 96, tempo y compás variables, metrónomo.
  - **Scheduler**: eventos con precisión de sample, lookahead de un bloque.
  - **Voces**: sustractiva (saw/square/tri/sine + filtro SVF + ADSR), supersaw
    (7 osc detune), FM 2-op, **808** (sine + drive tanh + glide), sampler
    (pitch-shift por velocidad), drums sintetizados (kick, clap, snare, hats por
    ruido filtrado — regla del engine: nunca osciladores para hats), percusión
    latina (conga, rim, shaker).
  - **Efectos** (por slot de mixer): EQ paramétrico 3+ bandas (biquads RBJ),
    compresor, limiter lookahead, reverb (Freeverb/FDN), delay estéreo con
    feedback filtrado, chorus/flanger/phaser, distorsión/bitcrush, filtros con
    envolvente, gate, utilidades estéreo (width, pan), **sidechain** por routing.
  - **Mixer**: N pistas de insert + master, ganancia/pan/mute/solo, sends,
    routing libre (grafo dirigido), medidores peak/RMS enviados a la UI.
- Golden tests de DSP (render determinista con semilla fija → comparar hash).

**Criterio de salida:** un proyecto demo (trap con 808) suena idéntico al render
offline y el CPU se mantiene bajo.

---

## Fase 2 — El shell: ventana, temas, layout

**Objetivo:** se ve como Orbit Studio. Minimalista, iconos estilo Mac, tres temas.

- `apps/desktop`: ventana frameless con **arquitectura A** del skill de acrílico
  (la ventana compone con alfa; el acrílico lo pone DWM con `backgroundMaterial`;
  el CSS deja de pintar opaco; `backdrop-filter` solo en menús/modales/tooltips).
- Temas **oscuro** (defecto), **claro** y **acrílico** por CSS variables.
- Controles de ventana: estilo Windows por defecto, **semáforo de macOS** como
  opción (posición izquierda, hover con glifos, colores exactos).
- Layout: barra superior (menús + transport + CPU/level meter), sistema de
  **ventanas internas** movibles/redimensionables (como FL) sobre un fondo de
  trabajo, barra lateral del Browser, panel de Claude acoplable a la derecha.
- Atajos: F5 playlist, F6 channel rack, F7 piano roll, F9 mixer, F10 ajustes,
  Space play/stop, Ctrl+Z/Y undo/redo… (catálogo completo en FEATURES).

**Criterio de salida:** ciclo ON→OFF→ON del acrílico verificado con captura real
(regla del skill: traer la ventana al frente antes de capturar).

---

## Fase 3 — Los cuatro editores

**Objetivo:** el flujo FL completo: componer → secuenciar → arreglar → mezclar.

1. **Channel Rack**: lista de canales con step sequencer de 16 pasos (extensible),
   LEDs por paso, mute/solo, vol/pan por canal, selector de patrón, swing global,
   click derecho = piano roll del canal, asignación a pista de mixer.
2. **Piano Roll**: dibujar/pintar (brush)/cortar/seleccionar/duplicar notas,
   velocidad y pan por nota, slide notes (para el 808), snap configurable (línea,
   1/2… 1/16, tresillos, none), escala resaltada, ghost notes, zoom H/V,
   herramientas: quantize, arpegiar, strum, humanize, chop, transponer.
3. **Playlist**: pistas ilimitadas; clips de patrón, de audio y de automatización;
   cortar (slip), duplicar (Ctrl+B), pintar clips, marcadores de sección con
   nombre, loop de reproducción, múltiples arrangements.
4. **Mixer**: strips verticales con fader (dB real), pan, mute/solo, 10 slots de
   efectos, routing por click (como FL), sends al master y entre pistas,
   medidores en tiempo real, UI de cada efecto en ventana propia con perillas.

**Criterio de salida:** producir un beat completo de principio a fin sin tocar
código.

---

## Fase 4 — Librería, automatización, export

1. **Browser + sound library**: árbol por categorías (Drums, 808s, Percusión
   latina, Melódicos, FX, Presets, Proyectos), tags (género, mood, tonalidad,
   BPM), búsqueda instantánea, preview al click, drag & drop a channel rack o
   playlist. Contenido de fábrica **generado por síntesis** (port del ADN de
   engine.py) con manifest JSON — todo clasificado, nada suelto.
2. **Automatización**: clips con curvas editables (puntos + tensión), enlazar
   cualquier parámetro ("link to controller" del último tocado), LFO por
   parámetro, grabación de movimientos de perillas.
3. **Export**: render offline (mismo kernel DSP, más rápido que tiempo real) a
   WAV 16/24/32f; master o **stems por pista de mixer**; tail de reverb;
   normalización opcional a -14 LUFS (flujo de streaming de Orbit).

---

## Fase 5 — Colaboración en tiempo real

- El proyecto vive en un **doc Yjs**; los comandos de core mutan el doc y todos
  los clientes convergen sin conflictos.
- `apps/server`: WebSocket propio con **rooms por código** (estilo "entra con
  este código a mi sesión"), persistencia del doc, auth simple por token.
- Presencia: cursores de otros usuarios en playlist/piano roll, colores por
  usuario, "X está editando el Mixer", lista de conectados con avatar.
- Undo **por usuario** (scoping por origen en `ProjectStore` — no `Y.UndoManager`,
  que nunca llegó a existir; ver `docs/HISTORY.md`).
- Modo seguidor: ver la vista de otro usuario en vivo.

---

## Fase 6 — Claude dentro del estudio

- `packages/claude-bridge`: la app expone un **servidor MCP** (WebSocket/stdio)
  con herramientas: `get_project`, `add_notes`, `edit_pattern`, `set_mixer`,
  `add_effect`, `set_automation`, `render`, `analyze_mix`…
- Claude Code se conecta con el `.mcp.json` del repo y trabaja **como un
  colaborador más**: sus ediciones pasan por el mismo bus de comandos → se ven
  en tiempo real, tienen undo y aparecen en la presencia como "Claude".
- **Panel de Claude** en la app: feed de actividad (qué tocó y por qué), y campo
  de petición rápida que lanza a Claude con contexto del proyecto.

---

## Fase 7 — Pulido y release

- Theme customizer completo (perillas transparencia/tinte/acento, picker de
  color, guardar temas con nombre, exportar/importar tema).
- Iconos propios minimalistas estilo Mac (SVG), splash, sonidos de UI sutiles.
- QA del flujo entero: crear → mezclar → automatizar → exportar → colaborar →
  Claude. Rendimiento: proyecto de 100 pistas sin dropouts.
- README con capturas, CHANGELOG, **tag v0.1.0 + GitHub release** (solo al final).

---

## Después de v0.1 (backlog priorizado)

- Grabación de audio (micro/línea) con editor de sample estilo Edison.
- Time-stretch / pitch-shift de clips de audio (fase vocoder / elastique-like).
- SDK de plugins JS (instrumentos y efectos de terceros en sandbox) y puente
  CLAP/VST3 vía proceso nativo.
- Import/export MIDI completo, export MP3/FLAC, export de video para visuales.
- Vista "Live" por escenas (lanzar clips), controladores MIDI hardware
  (Web MIDI ya en v0.x para teclado), macros de mezcla.
- Chat de voz/texto en sesiones colaborativas; historial de versiones del
  proyecto con diff musical ("¿qué cambió en el drop?").
