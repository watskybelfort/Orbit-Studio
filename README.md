# Orbit Studio

![versión](https://img.shields.io/badge/versi%C3%B3n-v3.10.0-5aa9e6)
![tests](https://img.shields.io/badge/tests-2456%20passing-7ce65a)

![plataforma](https://img.shields.io/badge/Windows-x64-b45ae6)
![stack](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20AudioWorklet-e6935a)

**El DAW de Orbit.** Un estudio de producción musical completo, hecho desde cero:
secuenciador, piano roll, playlist, mixer con cadenas de efectos, síntesis propia,
librería de sonidos clasificada, colaboración en tiempo real y Claude integrado
como un productor más dentro del proyecto.

![Orbit Studio — tema oscuro](docs/img/hero-dark.png)

> La escena de arriba la montó **Claude en vivo** por el bridge MCP: canales,
> steps, 808 con slide, limiter en el master, clip en la playlist y análisis de
> mezcla — cada tool call aparece en su panel (derecha) mientras la UI se
> actualiza en tiempo real.

## Descargar

**[→ Última release](https://github.com/watskybelfort/Orbit-Studio/releases/latest)** —
`Orbit-Studio-Setup-<versión>.exe`, Windows x64, instalación en un clic y con el
pack de sonidos dentro. No hay nada que configurar después.

El instalador no lleva firma de editor, así que SmartScreen avisa la primera vez:
*Más información → Ejecutar de todas formas*. Para regenerarlo tú mismo,
`npm run dist` en `apps/desktop`.

## Tres temas, mismo estudio

| Claro | Acrílico (blur DWM real) |
|---|---|
| ![Tema claro](docs/img/hero-light.png) | ![Tema acrílico](docs/img/hero-acrylic.png) |

Minimalista, iconografía propia estilo Mac, semáforo de macOS opcional y
customizador integrado (acento, transparencia y tinte del vidrio, temas
guardables con nombre).

## Los seis pilares

1. **Motor de audio propio** — DSP sample-accurate en un AudioWorklet: **10
   instrumentos** (sustractivo, supersaw, FM, 808 con glide, drums sintetizados
   en 3 kits, sampler **con multisample**, slicer, formantes y los dos de
   presets, Nova y Prisma) y

   **16 efectos** (EQ paramétrico, compresor con sidechain real, limiter
   lookahead, reverb, convolución, delay sync, auto-filter con LFO, vinyl,
   gate, mono-maker…), con **4 inserts propios por canal** además del mixer de
   26 pistas con routing libre y sends. El ADN sonoro viene del engine con el
   que ya producimos el catálogo de El Doctor.
2. **Flujo FL Studio completo** — Channel Rack con step sequencer (16/32/64),
   Piano Roll con slide notes, escalas, ghost notes y **teclas que se iluminan
   con lo que suena**, Playlist con clips y arrangements, editor de
   automatización con curvas de tensión y LFOs, Mixer con 10 slots por pista.
   Export offline a WAV 16/24/32, FLAC, MP3, stems por pista y normalización a
   -14 LUFS.
3. **Se toca y se graba** — controladores MIDI de verdad (cada dispositivo
   aparte, canal, octava, curva de pulsación, pedal de sostenido, **rueda de
   tono que reafina la voz viva** en los diez instrumentos y **MIDI learn**
   sobre cualquier perilla), grabación al patrón con el tiempo del evento y
   overdub por vuelta, **monitor de micro con la cadena del canal puesta** y
   tomas grabadas **en crudo por el kernel**, sin códec de por medio.
4. **Librería clasificada** — pack de fábrica *Orbit Essentials* (**84 sonidos
   en 276 grabaciones, 98,87 MB**, generados por síntesis propia, con los **24
   instrumentos en multisample**: tres alturas cada uno, repartidas por el
   teclado) con categorías, tags de género/tonalidad/BPM, detección automática
   de BPM y tonalidad, búsqueda instantánea, **selección múltiple y arrastre
   por grupos**, y preview renderizado por el propio kernel.
5. **Colaboración en tiempo real** — el proyecto es un log de comandos sobre

   CRDT (Yjs): salas por código de 6 letras **con contraseña opcional que nunca
   viaja**, **aforo ajustable (2–64)**, servidor propio que puedes atar a la
   dirección que quieras (localhost, la IP del VPN, la de la LAN o todas),
   convergencia sin conflictos, roles que reparte y hace cumplir el servidor,
   chat anclado al timeline, modo seguidor y undo POR USUARIO (tu Ctrl+Z no
   deshace lo del otro).
6. **Claude dentro del estudio** — la app expone un servidor MCP con **22 tools**

   (`.mcp.json` en el repo): Claude lee el proyecto, escribe notas, programa
   steps, ajusta la mezcla, añade efectos, renderiza y analiza LUFS/balance —
   todo por el mismo bus de comandos, visible en vivo y deshacible.

## Lo último

**v3.10.0 — "lo que se perdía en silencio".** La ronda empezó por el paso 0 del
ciclo —comprobar que lo que la v3.9 prometió es real— y esta vez lo que encontró
no eran promesas exageradas: eran **dos caminos por los que la app perdía audio
del usuario sin decir nada.**

**Un Ctrl+Z mientras normalizabas podía llevarse el sample recién creado.** Entre
subir el audio al motor y registrarlo en el proyecto hay una ventana en la que no
lo sujeta nadie, y el recolector se dispara justo con Ctrl+Z. La tarjeta suponía
que duraba «el mismo tick»; al medirla resultó que dentro hay dos `await` que
ceden el hilo de verdad. Estaba en cinco sitios, y el peor era el grabador: un
bucle sobre todas las tomas con un guardado y un hash por toma, o sea cientos de
milisegundos con audio recién grabado colgando. Los cinco cerrados, cada uno con
un control en negativo que demuestra que sin la sujeción el clip queda apuntando
a un sample que el motor ya no tiene.

**Y el nombre de archivo era un borrado.** Las ediciones se guardaban como
`Edit HH.MM.SS.wav` —sin fecha— y el almacén pisa por nombre: una edición de hoy
a las 14:03:22 se llevaba por delante el audio de la de ayer a la misma hora, con
el proyecto viejo apuntando ahí. El nombre pasa a derivarse del contenido, lo que
además recorta el disco un 80 %: cinco Normalizar dejan un archivo en vez de
cinco, porque a partir del segundo el WAV sale byte a byte idéntico.

**La red también tenía agujeros, y estaban todos dormidos.** El linter de
fronteras no miraba `require()`, dejaba pasar un nombre prohibido por
`import()` dinámico, y un barril podía colar `ws` y `node:http` al bundle del
renderer. Los dos linters de color eran ciegos a un `RGB(` en mayúsculas, por la
misma regex copiada dos veces. Y los `package.json` eran una cuarta escritura del
grafo de paquetes que también mentía. Todo cerrado con un test por agujero, cada
uno comprobado desactivando su arreglo y viéndolo caer.

**La CI dejó de publicar a ciegas.** La v3.8.0 se cortó con la CI en rojo para su
propio commit y nadie se enteró. Ahora `Release` consulta el estado de ese SHA y
lo escribe en la primera línea de la GitHub Release, y `npm run ci:status` lo
contesta en una línea. No bloquea —un tag y la CI son triggers independientes, y
esperar puede colgarse— pero ya no sale en silencio.

**Y el kit de escucha mentía sin querer.** Medía el buffer float del motor y lo
publicaba como lo que se oye: los −364 dBFS de continua de los anti-denormal
están 220 dB por debajo del medio escalón de 24 bits, así que en el `.wav` esos
cinco segundos son silencio digital exacto. Que el piso no quepa en el contenedor
**es** la respuesta que se buscaba; lo que había que arreglar es contarlo así.
Ahora mide el archivo decodificado y, donde las dos cifras difieren, da las dos.

**v3.9.0 — "el rojo que nadie miró".** La ronda empezó por el paso 0 del ciclo,
comprobar que lo que la v3.8 prometió es real, y lo primero que apareció no
estaba en ninguna tarjeta: **la CI llevaba seis pushes en rojo y la release de la
v3.8.0 se cortó encima del último.** Ubuntu en verde y Windows en rojo en la
misma corrida, siempre por lo mismo — un test que lee código fuente afirmaba
tres líneas con `
` literales, y en Windows el checkout entrega el archivo con
CRLF. Reproducido pasando el archivo a CRLF a propósito: la lectura de antes
contesta `false` a esa aserción y la normalizada `true`. El arreglo no es el
archivo sino la clase: los tests que leen fuente entran ahora por
`read-source.ts`. (Y de paso, una lección de medir: dije que el repo tenía 577
archivos con CRLF y era falso — `git ls-files --eol` da 584 de 584 en LF. Había
medido el árbol de trabajo, que es una medida del `git config` de quien la corre.)

**Dos reglas duras que describían un repo que no existe.** La 6 decía que `ui`
solo puede importar `core`, `engine` y `collab`, y el repo tenía doce
dependencias que eso prohíbe — entre ellas ocho a `sound-library`, un paquete
que la regla ni nombraba. Se eligió reescribir la regla, no romper el código, y
por una razón concreta: `ARCHITECTURE.md` ya describía en prosa las aristas que
su propia lista negaba, así que la lista era de la v0.1 y nadie la remidió.
Ahora el grafo se escribe **una sola vez** en `tools/eslint/package-graph.json`,
y lo leen la regla de ESLint que lo hace cumplir y un test que falla si CLAUDE.md
o ARCHITECTURE.md dejan de decir lo mismo. La regla 4 pasó por lo mismo:
veintitantos colores literales fuera de `theme/` salen a token, y los tres
editores que pintan en `<canvas>` conservan su paleta local **por un motivo
técnico** — `getComputedStyle()` no resuelve una custom property que referencia
otra, así que centralizarlas no arreglaría nada. Eso ahora lo dice la regla, y lo
vigila un `npm run lint:css`.

**Tres cachés de audio, una sola política.** La v3.7 arregló una de las tres. La
del editor de audio crecía *garantizado* —cada Normalizar hace `newId()` y la
entrada vieja quedaba retenida para siempre— y el barrido solo corría al
exportar, así que la cota real no era «el proyecto abierto» sino «el último
proyecto que se exportó». Ahora cada caché se acota por su **conjunto vivo**, que
lo define su consumidor, y el barrido cuelga de las cuatro puertas que
reemplazan el proyecto entero. Cinco Normalizar pasan de 6 entradas a 2; a
escala real, de ~69 MB retenidos a ~23 de techo.

**Y lo que se arregla mirando dónde ya estaba resuelto.** El scope de la vista de
instrumento medía el máster cuando el canal salía por un bus; la regla ya existía
con nombre (`trackOfChannel`) y ya la usaban otros tres sitios, así que el
arreglo fue usarla en vez de escribir la tercera copia. Y un arrastre del
deslizador de ganancia de entrada dejaba hasta 80 filas en el historial: el
`mergeKey` entra en el envoltorio, no en el sitio nuevo, así que el próximo campo
que se agregue no reabre el bug.

**`npm run listen:kit`.** La parte de la verificación que ningún test sustituye
—una cola de reverb en silencio con el monitor arriba, un barrido automatizado,
el `.opus` propio contra libopus— llevaba dos rondas sin hacerse por pura
fricción. Ahora sale renderizada de los mismos fixtures del golden, con 25 s de
cola añadida detrás del fixture y a 24 bits, y un índice que dice qué escuchar en
cada archivo. Primera corrida y ya contesta un punto, aunque no como se esperaba:
dentro del motor la continua que dejan los anti-denormal es −364 dBFS en la
reverb y −264 en el delay, pero eso cae cientos de dB por debajo del medio
escalón de 24 bits (−144,5 dBFS), así que en el `.wav` los últimos 5 s salen como
silencio digital exacto. Que el piso no quepa en el contenedor **es** la
respuesta; lo que había que arreglar es que el índice midiera el buffer float y
lo publicara como lo que se oye. Ahora mide el archivo decodificado y, donde las
dos cifras difieren, da las dos y dice cuál es cuál.

**v3.8.0 — "cuando la red deja de mirar".** La ronda empezó comprobando que lo
que la v3.7 prometió es real, y eso solo ya destapó tres cosas que el verde de
los tests no contaba.

**El pluck recupera su punch, y de paso enseñó cómo se pierde una red.** El
filtro suavizaba sus coeficientes en 5 ms para matar el zipper al automatizar,
pero eso vale para quien lo mueve **por bloque**; el sintetizador y el
autofiltro lo movían por MUESTRA, con una envolvente que ya es continua, y se
comían un one-pole de 5 ms encima de un ataque de 5 ms. Ahora el filtro sabe de
qué clase es su llamante (`CoefSource`, en el constructor) y el que modula por
muestra no paga nada: el 90 % del brillo llega a **3,42 ms en vez de 6,37**, que
es exactamente la referencia sin suavizar. El one-pole no se acelera, desaparece.

Lo interesante vino después. Al quitarles el suavizado a los tres grandes
consumidores, **el golden perdió mordida sobre esa constante**: de 7 fixtures a
3. No es un descuido, es la consecuencia lógica — pero dejaba sin fijar justo la
pieza que ahora impide que vuelva el zipper (el autofiltro deslizando él mismo
lo que le llega por bloque). El banco pasaba igual con esa pieza y sin ella.
Existe por eso `fx-autofilter-sweep`, el fixture 25, y se comprobó quitándole la
pieza a propósito: **14,694 dB** de basura en la banda alta. La lección quedó
escrita en `docs/GOLDEN.md`: si una fila de la tabla de mordida **baja**,
preguntate si bajó porque el motor mejoró o porque el banco dejó de mirar.

**Un export se puede cancelar.** Doce stems tardan minutos y hasta ahora solo
podías esperar o matar la app —lo que deja archivos a medias—. Hay botón, y la
cancelación se atiende también DENTRO del render de una pista, que era el punto
que faltaba. El checkpoint no cuesta nada en el bucle caliente: cuelga del mismo
`if` que ya pagaba el progreso, medido en −3,79 %, o sea dentro del ruido. Lo ya
escrito se conserva, y nada queda a medio escribir porque el corte se lee antes
de empezar cada archivo, nunca contra uno en marcha.

**La guarda del micro baja al sitio donde no se puede esquivar.** Estaba en el
componente, así que el primer atajo de teclado o acción de MCP que alguien
añadiera resucitaba el bug entero. Ahora vive en las funciones y la UI **lee** el
motivo en vez de repetirlo. Y se cubren los dos caminos que nadie había mirado:
desconectar la interfaz a mitad de una toma ya no deja la captura muda en
silencio — para la grabación y avisa de que la toma se cortó ahí.

**Y las dos cosas que la verificación encontró y que no eran verdad.** El
`--accept` de los golden tests, que es lo que hace que aceptar un cambio de
sonido cueste un gesto deliberado, se tragaba el flag siguiente como motivo:
`--accept --force` guardaba `"--force"` como explicación **y** saltaba la guarda
de arquitectura, de una sola vez. Y «seis de los once avisos de dependencias
eran bugs de verdad» no se sostuvo al verificar los seis: en todos, la
dependencia que faltaba ya estaba cubierta por otra de la misma lista. Los
cambios valen igual y se quedan; la frase, corregida en los cuatro sitios donde
estaba escrita.

Cinco tests que medían la CPU de la máquina en vez del código dejan de
parpadear, comprobado con veinte procesos quemando CPU en paralelo.


**v3.7.0 — "la red que la regla daba por hecha".** La ronda que cierra lo que
la v3.6 dejó a medias, y que empieza por la deuda más vieja del repo.

**Los golden tests existen.** La regla dura 5 de `CLAUDE.md` mandaba desde hacía
tiempo actualizar los hashes de `engine/test/golden` ante cualquier cambio de
sonido, y ese directorio no existía: nueve cambios de sonido habían entrado sin
nada que los fijara. Ahora son 24 renders deterministas y dos flujos Opus, con
**dos capas**: el hash bit a bit y una matriz de medidas perceptuales que dice
*qué* se movió. La utilidad de tener las dos se demostró sola — multiplicar por
diez una constante anti-denormal mueve el hash de siete fixtures y no mueve ni
una medida.

Y lo difícil, la estabilidad entre plataformas, se **midió** en vez de suponerse:
el mismo bundle en cinco entornos con Docker sale bit a bit idéntico en x64
aguantando cambio de sistema operativo y tres versiones mayores de V8. Por eso el
hash se compara sin condicional, que es la única forma de que no acabe en un
`skip` y deje de proteger. Muerde, comprobado ocho veces perturbando coeficientes
reales.

**La otra fuga de audio, cerrada.** El `sampleCache` del render vivía en el hilo
de la UI y no lo vaciaba nadie: cinco proyectos de dieciséis tomas largas
acumulaban **6460 MiB**. Ahora quedan **1292** — lo que registra el último
proyecto que se **exportó**. El barrido vive dentro de `collectSamples()`, así
que hoy solo corre al exportar, hacer bounce o freeze: cablearlo también a abrir
un proyecto sigue pendiente.

**Los once avisos de dependencias, uno a uno.** Cinco sobraban a propósito y
ahora dicen por qué; los otros seis se completaron. Lo que **no** quedó
demostrado es que alguno produjera un fallo visible: al revisarlos uno a uno, la
dependencia que faltaba ya estaba cubierta transitivamente por otra de la misma
lista, o apuntaba a una identidad estable. El cambio vale igual —deja de
depender de una cobertura accidental que el próximo "limpiar deps" rompería— y
con él `exhaustive-deps` sube de aviso a error: uno nuevo rompe la CI en vez de
sumarse a la pila.

**Las dos puntas sueltas de la v3.5**: la ganancia de una ruta de entrada ya
tiene mando (el modelo, el comando y el kernel ya la aplicaban; faltaba el
deslizador), y **un instrumento pinta su propia interfaz en el Channel Rack**,
reusando el mismo worker aislado que ya usaba el mixer.

**v3.6.0 — "revisar lo que ya se dio por hecho".** Una ronda entera dedicada a
comprobar que las diecinueve tareas de la v3.5 de verdad hacían lo que decían.
Cinco auditorías independientes contrastaron lo prometido en cada tarjeta
contra el código que quedó, y **la app se abrió y se condujo de verdad** — algo
que la ronda anterior dio por imposible.

El veredicto honesto: **trece cumplían, cinco cumplían con reparos, y una no
cumplía nada de lo que decía.** Lo que salió:

- **La recolección de samples no liberaba nada** mientras trabajas. Solo corría
  al reemplazar el proyecto entero, y aunque hubiera corrido tampoco habría
  soltado nada: un sample cuenta como vivo mientras esté registrado, y nadie lo
  desregistraba nunca. El problema original —la RAM del worklet solo crece—
  seguía intacto. Ahora se pregunta si algún undo puede volver a nombrarlo antes
  de soltarlo, y cuando duda, conserva.
- **Los denormales se taparon en la reverb y en ningún otro sitio.** El delay
  con feedback, el flanger, el phaser y el EQ que corre en *cada canal del
  mixer* tenían el mismo lazo sin arreglar. Un Biquad resonante tras el silencio
  entraba en un ciclo límite permanente en rango subnormal, a 73 ns/muestra
  contra 9-12 de referencia, para siempre.
- **Un ciclo de enrutado dejaba la mezcla en silencio absoluto sin avisar.**
  Esto salió de abrir la app y probar: rutar 1→3 y luego 3→1 tiraba la salida a
  −240 dBFS sin error, sin aviso y sin marca. El detector de ciclos ya existía
  —el editor de nodos lo usaba— pero el menú del mixer entraba por otra puerta.
- **Cuatro bugs de UI**, el peor: cambiar de dispositivo grabando truncaba la
  toma en silencio, y no te enterabas hasta escucharla.
- **Un stem que fallaba se llevaba por delante** hasta tres hermanos ya
  renderizados de su lote.
- **El acorde**, que era la última cifra en rojo del encoder, pasó de −10,99 a
  **−10,61 dB** pesando el Viterbi por importancia espectral — con la percusión
  idéntica dígito a dígito.

Y lo que se aprendió del método: **la mitad de "no se pudo comprobar" era
falso.** Orbit se levanta con `ORBIT_DEBUG_PORT=9223` y se conduce por CDP;
con eso se vio el espectro, el LUFS, el cartel de versión, los buses y las
ramas del historial en los tres temas. Lo que sigue necesitando manos humanas
es **oír** y el **hardware**.

**El encoder Opus dejó de decidirse a ciegas.** La v3.4 implementó la dispersión
adaptativa, midió −0,02 dB —ruido— y la tiró, porque sin demostrar la mejora no
se sube. La medida no decía que no sirviera: decía que **no la veía**. La SNR
mide error total, y la dispersión *reparte* el error dentro de la banda en vez
de reducirlo.

Ahora el banco tiene una medida perceptual —PEAQ simplificado sobre el modelo de
oído de la BS.1387— y para decidir manda ella. Lo que ve y la SNR no, con
números: ante el mismo error enmascarado o no, **la SNR da 30,0043 por los dos
lados, idéntica hasta el decimotercer decimal**, y la nueva separa 40,4 dB.

Con eso a la vista cayeron cuatro cosas:

- **La dispersión adaptativa entró**, y vale +0,40 dB.
- **Los transitorios**, que resultaron ser el agujero grande y no lo tonal. El
  pre-eco de un click aislado baja de −12,6 a **−32,5 dB**, por delante de
  libopus.
- **Un bug de sincronía que arrastraba desde el primer día**: el encoder
  marcaba una trama como silencio y **seguía escribiendo**, mientras el
  decodificador —al leer esa bandera— descartaba el resto y dejaba todas las
  bandas en silencio. Los dos lados predecían desde sitios distintos y el
  desfase se amplificaba banda a banda. Se oía justo donde hay silencio digital
  entre golpes: **en cada golpe del pack de batería**. Lo aisló un piso
  *inaudible* de −140 dBFS que solo impedía que la bandera se disparara.
- **El postfiltro, que no era la pieza cara que este README decía.** Llevaba
  escrito que «pide correr el decodificador dentro del encoder». No lo pide: el
  prefiltro es un lazo abierto —FIR sobre la entrada en el encoder, IIR sobre su
  propia salida en el decodificador—, así que si lo reconstruido coincide con lo
  codificado, sale la señal original por inducción.

La distancia media a libopus pasa de **−3,59 a −0,22 dB** de patrón — y el
reparto de bits (VBR por trama, intensidad estéreo y estéreo dual), que este
README llegó a listar como lo que faltaba, entró en la misma versión.

**Y el DAW también.** La reverb gastaba **34× más CPU en silencio** —al decaer
sin llegar a cero el estado entra en rango denormal— con la máquina calentándose
justo cuando la música para. El worklet **no soltaba un solo sample** en toda la
vida de la app: ahora abrir otro proyecto libera el audio del anterior. El export
de stems clonaba el proyecto entero una vez por pista. Los filtros escalonaban
al automatizar. Y la regla de «cero alocaciones en el audio thread», que hasta
hoy era disciplina humana, **tiene por fin un test que la rompe si alguien se
descuida**: sustituye `Float32Array` por una subclase que cuenta y exige cero.

Entran además el **espectro por pista y el LUFS en vivo** (para ver que vas a
−14 antes de exportar, no después), **entradas de más de dos canales**,
**compensación de latencia de la toma** —donde lo difícil no era medir sino **no
medir mal**, porque un retardo equivocado corre todas las tomas en la dirección
contraria—, **buses de grupo** en el rack, **historial de undo en árbol**,
**plantillas de proyecto**, **una tercera capa de fuerza en el pack** (con las
dos anteriores conservadas bit a bit) y **vistas propias para los plugins**, con
la frontera hecha de datos y no de DOM.

**Las otras dos veces que la doc mentía**: `CLAUDE.md` manda actualizar unos
golden tests que **no existen**, y `ARCHITECTURE.md` decía que el undo por
usuario es un `Y.UndoManager` de Yjs — no hay ni uno en todo el repo. Lo segundo
está corregido; lo primero es tarea de la ronda siguiente.

<details>
<summary><b>v3.4.0 — "lo de fuera entra, y el gesto se queda"</b></summary>

Archivos sueltos del Explorador al keymap, al rack y a la playlist —y resultó
que la puerta que parecía haber que abrir en el proceso principal no había que
abrirla: un arrastre trae `File`, que son `Blob`, y los bytes se leen en el
renderer. La rueda de tono pasa a ser un parámetro (`Channel.bend`) y con eso
se graba, se automatiza y viaja a la sala. Y la `alloc_trim` del encoder Opus
deja de estar fija en neutro.

</details>

<details>
<summary><b>v3.3.0 — "el piano responde a los dedos"</b></summary>

Los 24 instrumentos del pack se
grababan a tres alturas y con UNA pulsación: un piano golpeado flojo salía
igual que uno golpeado fuerte, solo más bajito. Ahora cada altura trae dos
grabaciones, y el instrumento entra en el rack repartido por el teclado *y* por
la fuerza.

**Bajar el fader no es tocar flojo.** En un instrumento de verdad la fuerza
cambia el TIMBRE, y cada familia con su moneda: en un piano acústico se empina
la caída espectral y se apaga el martillo (menos energía en el golpe, menos
parciales de arriba excitados); en uno eléctrico la pulsación **es** el índice
de FM, así que al tocar flojo desaparece el diente y queda la campana redonda
de debajo; en una cuerda pulsada es lo romo de la excitación —la yema contra la
uña—; en un bajo, cuánto se abre la envolvente de filtro; en una campana, el
badajo. Y en un órgano casi nada, que es la respuesta correcta: un Hammond no
responde a la pulsación, así que solo ceden el click de los contactos, la
percusión y los drawbars de arriba.

**Lo que no cambió es lo que más importa.** La capa fuerte es la síntesis de
siempre, y no de boquilla: al regenerar el pack, de los 133 archivos que ya
estaban el único que cambió es `manifest.json`. Los 132 WAV salen byte a byte
idénticos, así que ningún proyecto guardado suena hoy distinto que ayer.

**Las dos capas son la misma cuerda.** La pulsación no entra en la semilla del
ruido, y es justo lo contrario de lo que se hizo con la altura: dos alturas
suenan JUNTAS —un acorde— y compartiendo aleatoriedad se funden en una sola
fuente, mientras que dos capas de la misma nota no suenan nunca a la vez y
comparten desafinación, fases y deriva para que cruzar el borde de velocidad
suene a pegar más fuerte y no a cambiar de piano. De ahí sale la regla al tocar
cualquier síntesis del pack: la pulsación cambia amplitudes, índices y cortes,
nunca la estructura de los bucles.

El pack pasa de 42 a 70 MB y de 132 a 204 archivos. Y esto se mide, no se
opina: la capa floja es más oscura en los 24 instrumentos y en las tres
alturas, y tocada por el kernel —con el canal y el máster puestos— la misma
tecla a velocidad 0,25 sale entre un 6 % y un 46 % menos brillante que a 0,9.

</details>

<details>
<summary><b>v3.2.0 — "el pack suena a instrumentos"</b></summary>

Tres entregas que van juntas
porque las tres arreglan la misma cosa: que Orbit sonara a *muestras* y no a
*instrumentos*.

**El pack de fábrica, en multisample.** Los 24 instrumentos eran una muestra
estirada por cinco octavas — justo lo que la v3.1 vino a arreglar y que el pack
todavía no usaba. Ahora cada uno se graba en su registro natural y una octava a
cada lado, y entra en el rack ya repartido por el teclado. Que la altura fuera
un parámetro y no una constante sacó cuatro cosas que solo se ven al grabar el
mismo instrumento en dos octavas: las tres tomas de un pad compartían las fases
y la deriva del ruido (sonaban a una fuente doblada, no a una sección); los
filtros de los sintéticos no seguían a la nota (el pad grave brillante, el
agudo apagado, y el escalón justo al cruzar de zona); la cuerda pulsada iba
desafinada consigo misma porque su retardo estaba redondeado a muestras
enteras; y el tine 14:1 del piano eléctrico doblaba por encima del muestreo en
el registro alto. **Y el bajo del pack ahora suena donde dice el piano roll** —
antes, grabado en C2 y colocado en la tecla 60, sonaba dos octavas más abajo
que lo que enseñaba la pantalla.

De regalo, el techo de banda sube de 12 a 14 kHz: existía para dejar sitio al
estiramiento, y ahora el estiramiento es la sexta parte. En PCM el tamaño
depende de la duración, no del ancho de banda, así que son 2 kHz de aire
gratis. El pack pasa de 22 a 41 MB.

**La rueda de tono dobla el tono.** Entraba como un mando más: doblaba lo que
le hubieras asignado, o nada. Ahora reafina la voz VIVA, en los diez
instrumentos — cada uno con su moneda: frecuencia los sintes, ritmo de lectura
el sampler, la fundamental de la que cuelgan las capas en Nova y Prisma, y en
el kit la parte tonal *y* el filtro, porque un hat es ruido y no tiene altura
que doblar pero su banda sí se mueve. La otra mitad del trabajo es que el
kernel se guarda los semitonos por canal: una nota tocada con la rueda sujeta
**nace ya doblada**, en vez de trepar sola durante el ataque. Rango elegible
(±1 a ±24) y zona muerta en el centro, porque una rueda con muelle no vuelve
nunca al 8192 exacto.

**Muestras al keymap en bloque.** Montar un piano de treinta muestras eran
treinta arrastres y treinta deshaceres. Ahora el Browser tiene selección
múltiple (Ctrl y Mayús) y las cabeceras arrastran su grupo entero — una
categoría, una carpeta tuya, un pack generado — y el drop cae en un solo
deshacer, reparta zonas de keymap, canales del rack o clips de la playlist.
Por el camino salieron dos falsos positivos del auto-mapa que soltar una
carpeta habría vuelto lo normal: la nota se buscaba en la RUTA entera (una
carpeta llamada «Piano C3» colocaba las treinta muestras en el mismo do) y
`take01/02/03` se leían como las teclas 1, 2 y 3.

Y un tercero que no era de esta entrega: **el generador del pack llevaba roto**
y nadie podía verlo, porque `packages/*/generate` no estaba en el typecheck.

</details>

<details>
<summary><b>v3.1.0 — "el instrumento entero"</b></summary>

Un canal de sampler tenía UN sample y lo
estiraba por todo el teclado con keytrack: un piano grabado en do sonaba a
chipmunk dos octavas arriba y a monstruo dos abajo, porque cambiar la
velocidad de lectura mueve las formantes y el tiempo del ataque con el tono.

Ahora el canal admite un **keymap**: varias muestras repartidas por teclas y
por velocidad, cada una sonando a su nota real. Una zona es un rectángulo
(tecla × velocidad) con su muestra, su raíz, su afinación fina y su ganancia, y
las zonas **pueden solaparse a propósito** — así se hacen las capas suave/fuerte
y así se apilan dos micros de la misma toma.

Lo que hace que se use es el **auto-mapa**: se sueltan las muestras en el editor
y entran con su nota leída del nombre del archivo, repartiéndose los rangos
solas. Lo difícil ahí no es leer `Piano_C3.wav`, son los falsos positivos —
`Bass2.wav` no es un si y `Deep4.wav` no es un re—, y lo que no sabe leer lo
dice en vez de colocarlo a bulto: una nota en el sitio equivocado no se ve, se
descubre tocando. Claude lo monta también, con la tool `set_keymap`.

De regalo, un fallo que habría salido mudo: el recolector de samples del
**export** miraba solo el sample del canal, así que un instrumento multisample
se habría renderizado en silencio. Ahora esa decisión es una función pura con
sus pruebas.

</details>

<details>
<summary><b>v3.0.0 — "la toma en vivo"</b></summary>

 Orbit producía de maravilla y no se tocaba.
Esta versión cierra el agujero por el que entra el sonido de fuera: el
controlador MIDI, el micro y el clic de la cuenta.

Es un salto de versión mayor porque el estudio deja de ser una cosa en la que
solo se *programa* música: ahora se toca y se graba dentro. Y por debajo cambia
la forma del motor — el nodo del kernel tiene entrada, el protocolo de
medidores lleva la señal que entra, y la grabación ya no pasa por el navegador.

**El controlador, en serio.** Cada dispositivo se enciende y se apaga por su
cuenta, con su canal, su transposición por octavas y su curva de pulsación;
pedal de sostenido con los dos casos que dejan notas colgando resueltos
—repicar una tecla con el pedal pisado, apagar el teclado sin levantarlo—; y
**MIDI learn** sobre cualquier perilla o fader del programa: clic derecho,
mueves el mando y quedan casados. El mando escribe por el bus de comandos, así
que tiene undo y viaja a la sala, y un barrido entero es UN paso de undo.

**Grabar tocando cuadra donde tocaste.** La nota caía donde estaba el playhead
cuando la UI se enteraba, no cuando la tocaste: hasta 46 ms repartidos al azar.
Ahora se usa el sello del evento. La rejilla se elige (sin cuantizar incluido) y
lo tocado cae al patrón al cerrar CADA vuelta del loop, sin parar.

**El micro se oye con su cadena puesta.** El nodo del kernel tenía
`numberOfInputs: 0` —no había por dónde meter audio de fuera—. Ahora la entrada
se suma a su pista de mixer *antes* de los inserts: cantar oyendo el reverb y el
compresor que va a llevar la toma, no la voz seca. Medir el nivel y oírse son
dos interruptores distintos, que ajustar la ganancia no puede obligarte a montar
un acople.

**Y la toma se graba en crudo.** Esto era una pérdida de calidad escondida a
plena vista: la grabación la hacía `MediaRecorder`, que en este Electron solo
sabe **webm/opus**. Cada toma se comprimía con pérdida y se volvía a decodificar
para escribirla como un WAV de 24 bits que ya no tenía 24 bits de información.
Ahora las muestras vuelven del kernel tal cual —antes de la ganancia y de la
cadena— y van directas a WAV.

**La cuenta atrás suena.** El metrónomo del kernel solo clica rodando, así que
grabar desde el compás 1, donde no hay sitio por delante para el pre-roll,
enseñaba el conteo en pantalla y no sonaba nada. Ahora la cuenta la lleva el
kernel, con clics sample-accurate, y un beat después del último arranca él
mismo: la cuenta y el compás 1 comparten reloj.

</details>

## Roadmap

Lo que hay pensado a continuación. Nada de esto está prometido con fecha: se
saca cuando toca, en el mismo orden en que estorba no tenerlo. Las tres filas de
entrada en vivo que abrían este roadmap —controlador MIDI, monitor del micro y
clic de la cuenta— salieron en la **v3.0**; el multisample, en la **v3.1**; el
pack de fábrica en multisample, en la **v3.2**; y sus capas de fuerza, en la
**v3.3**; y los archivos del Explorador, la rueda grabada y la primera decisión
fina del encoder Opus, en la **v3.4**. Lo de abajo es lo que dejaron detrás.


### Siguiente

| Qué | Por qué |
|---|---|
| **La sombra del VBR en el fundido de salida** | El peor caso sigue siendo el acorde estéreo a 128k (−10,61 dB). Pesar el Viterbi por importancia espectral se llevó parte —de −10,99 a −10,61— pero lo que queda **no lo causa el detector de transitorios**: se midió apagándolo por tonalidad, los falsos positivos bajan de 5-6 a 1 de cada 75 tramas y la cifra no se mueve. Lo que queda es cómo reparte bits el VBR en el fundido |
| **Probarlo con manos y oídos** | Lo que se ve ya se comprobó conduciendo la app por CDP; lo que falta es **hardware**: una interfaz de más de dos canales entregando los 8 de verdad, y la calibración de latencia con el bucle físico altavoz→micro |

### Más adelante

| Qué | Por qué |
|---|---|
| **Las cachés de audio del hilo de UI** | La del render ya se acota, pero solo al exportar. Quedan sin freno el `pcmCache` del editor de audio —que crece garantizado: cada Normalizar deja la entrada anterior retenida— y la de picos |
| **Firmar el instalador** | Sin firma de editor, SmartScreen avisa a todo el que lo baja. El camino queda preparado en el workflow: falta el certificado |
| **Cancelar un export a medias** | Hoy un export de doce stems que tarda minutos no se puede parar |

### Horizonte

| Qué | Estado |
|---|---|
| **Puente CLAP / VST3** | Necesita un host nativo con GUI embebida: proyecto aparte, no un rato |
| **SDK de plugins con interfaz propia** | Que un plugin JS pueda pintar su propia UI (canvas) además de declarar perillas |
| **Export de vídeo para visuales** | Un visualizador que renderice el tema a vídeo; fuera del alcance del DAW hasta que el resto esté redondo |
| **Kernel con SIMD (WASM)** | Llevar el hilo de audio a WebAssembly con SIMD y un pool de voces para acercarse a "cero alocaciones por bloque" |

## Encoder Opus propio

Orbit exporta `.opus` con un **códec escrito entero en casa**: range coder,
MDCT, PVQ, cuantización de energía, asignador de bits y contenedor Ogg. Sin
librerías de terceros.

La referencia es la implementación normativa incluida en la **RFC 6716**
(Apéndice A), extraída del propio documento y verificada por SHA-1
(`86a927223e73d2476646a1b933fcd3fffb6ecc8c`). Las 721 constantes del formato no
están copiadas a mano: las extrae `tools/opus-tables.ts` del fuente, con
aserciones de tamaño e invariantes.

### Que funciona no es una opinión

```bash
npx tsx tools/qa/opus-verify.ts
```

Genera audio, lo codifica con Orbit y se lo da a **ffmpeg** para que lo
decodifique. Doce configuraciones —mono y estéreo, tramas de 2,5 a 20 ms, de 32
a 256 kbps— con correlación **0,997 a 1,000** contra el original, retardo cero y
ganancia 1,000.

Esa comprobación externa existe por una razón muy concreta, y hay dos bugs de
esta implementación que la justifican: una división entera que redondeaba hacia
−∞ donde C trunca hacia cero, y un `+1` de más en la cuenta de bits gastados.
Los dos lados de Orbit compartían el error, así que la ida y vuelta contra
nuestro propio decodificador pasaba en verde mientras el archivo era ilegible
para cualquier otro. Ningún test interno los habría pillado. **Sólo los vio
ffmpeg.**

### Lo que todavía no hace

Le queda una decisión: el **reparto de bits** — VBR por trama e intensidad
estéreo. Eso es una *decisión*, no sintaxis: da un archivo válido que suena algo
peor que el de libopus a igualdad de bits, no uno roto.

Sí están el dynalloc (refuerzo a las bandas que sobresalen sobre sus vecinas,
sin el cual un tono puro suena sucio a bitrate medio), la elección intra/inter
de la energía —que se decide **codificando las dos y quedándose con la que
menos recorta**—, la **inclinación del reparto**, que sale de la pendiente del
espectro en vez de estar fija en neutro, la **dispersión adaptativa** —que
estuvo un tiempo fuera por no poder demostrarse y entró en cuanto hubo con qué
medirla (abajo)—, la **detección de transitorios** y el **postfiltro**.

Del postfiltro conviene desmentir algo que este README llegó a afirmar: **no
hace falta correr el decodificador dentro del encoder**. El encoder es un FIR
sobre la entrada (`y[n] = x[n] − g·x[n−T]`) y el decodificador un IIR sobre su
propia salida (`z[n] = ŷ[n] + g·z[n−T]`) — lazo abierto, y si `ŷ = y` entonces
`z = x`. Lo que sí hay que mantener en sintonía son los parámetros de la trama
anterior, y para eso el encoder guarda lo *transmitido*, nunca lo medido.

### Cuánto se pierde por bit

```bash
npx tsx tools/qa/opus-quality.ts
```

La misma señal codificada con Orbit y con libopus al mismo bitrate, las dos
decodificadas con ffmpeg y comparadas con el original. Cuatro señales elegidas
por lo que ponen a prueba, cinco combinaciones de canales y bitrate. **Dos
medidas por cada una**, y no miden lo mismo:

| | Orbit | libopus | distancia | la peor |
|---|---|---|---|---|
| **Patrón** (perceptual) | 30,05 dB | 30,27 dB | **−0,22 dB** | −10,61 dB · acorde estéreo 128k |
| SNR (error) | 16,83 dB | 16,74 dB | +0,09 dB | −6,27 dB · tonal estéreo 96k |

**Para decidir manda el patrón.** Es un PEAQ simplificado sobre el modelo de
oído de la BS.1387 —109 celdas de 0,25 Bark, oído externo y medio, ruido
interno, dispersión frecuencial de dos pendientes, suavizado temporal— con dos
términos: la distancia entre patrones de excitación, y la diferencia de
**planitud espectral** por banda, que es lo que distingue si algo suena a ruido
o a tonos. La SNR se queda al lado como red de seguridad: es ciega a lo
perceptual, pero cazaría una catástrofe de fase, a la que el patrón sí es ciego.

Por qué hicieron falta las dos, con números: ante el mismo error repartido
esparcido o denso, la SNR da 3,385 contra 3,353 —0,03 dB, ruido— y el patrón
8,82 contra 16,88. Ante el mismo error enmascarado o no, **la SNR da 30,0043 por
los dos lados, idéntica hasta el decimotercer decimal**, y el patrón separa 40,4
dB.

Y midiendo bien se cae una conclusión vieja de este README: aquello de que en
ruido y en mezcla salíamos *por delante* de libopus —que no era buena noticia,
sino señal de gastar bits donde no hacen falta— **desaparece**. Percusión
estéreo 96k pasa de +0,25 dB de SNR a −4,37 de patrón; el ruido rosa, de +1,85 a
−0,24; la mezcla, de +1,21 a −0,69.

La dispersión adaptativa es el caso de libro. Se implementó, midió −0,02 dB de
SNR —ruido— y **no entró**, porque sin poder demostrar la mejora no se sube. No
era que no sirviera: era que la SNR no la ve, porque la dispersión *reparte* el
error dentro de la banda en vez de reducirlo. Con el patrón vale **+0,40 dB**,
casi dos tercios de lo que vale la dispersión entera, y entró. Se ve incluso sin
modelo de oído: en ruido rosa estéreo 64k la banda de aire tiene planitud 0,562
en el original, vuelve a 0,256 sin dispersión —silbidos—, a 0,393 con la
constante y a 0,620 con la adaptativa.

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # Electron + Vite (la app) — renderer en localhost:5900
npm run server     # servidor de colaboración (puerto 7900)
npm test           # 2456 tests (core, engine, collab, claude-bridge, sound-library, ui, server, desktop)

npm run typecheck  # tsc --noEmit sobre todo el monorepo
npm run lint       # reglas duras + hooks; exhaustive-deps es error, rompe la CI
```

> Si tras `npm install` Electron no arranca (allow-scripts se salta su
> postinstall): `cd node_modules/electron && node install.js`.

> El dev server usa el puerto **5900**: el 5173 de Vite cae dentro de un rango
> que Windows reserva para Hyper-V en algunas máquinas y moría con `EACCES`.

**Claude como colaborador:** abre la carpeta con Claude Code y la app en
marcha; el `.mcp.json` del repo conecta el bridge (stdio → WS local 7855) y las
22 tools aparecen solas. Todo lo que haga Claude sale en su panel (menú Ver →
Panel de Claude).

## Documentación

| Documento | Qué contiene |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | Catálogo completo de funciones, versión a versión |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitectura técnica del monorepo |
| [docs/COLLAB.md](docs/COLLAB.md) | Colaboración en tiempo real (salas, aforo, roles, samples) |
| [docs/CLAUDE-INTEGRATION.md](docs/CLAUDE-INTEGRATION.md) | Claude como colaborador (MCP) |
| [docs/PLUGINS.md](docs/PLUGINS.md) | SDK de plugins JS (efectos e instrumentos) con ejemplo |
| [docs/THEMING.md](docs/THEMING.md) | Sistema de temas: oscuro, claro, acrílico, semáforo Mac |
| [docs/PLAN.md](docs/PLAN.md) | Plan por fases, con lo que se quedó fuera y su motivo |

## Estructura

```
orbit-studio/
├─ apps/
│  ├─ desktop/        Shell Electron (ventana, acrílico DWM, IPC, bridge host)
│  └─ server/         Servidor de colaboración (rooms, aforo, persistencia)
├─ packages/
│  ├─ core/           Modelo de proyecto, bus de comandos, undo, formato .orbit
│  ├─ engine/         Motor de audio DSP (AudioWorklet + render offline)
│  ├─ ui/             Interfaz React (rack, piano roll, playlist, mixer, browser…)
│  ├─ collab/         Sesión Yjs + protocolo y-websocket
│  ├─ claude-bridge/  Tools MCP + executor + relay stdio⇄WS
│  └─ sound-library/  Pack de fábrica generado por síntesis + manifest
├─ tools/qa/          QA en vivo: driver CDP, peer de presencia, beat por el bridge
└─ docs/              Toda la documentación
```

## Historial

<details>
<summary><b>v2.9.0 — "la casa revisada de arriba a abajo"</b></summary>

Auditoría profunda del árbol entero, zona por zona, con arreglo y test de cada
cosa encontrada: suplantación y borrado de pistas ajenas en la sala, SSRF y
escapes por enlace en el shell de escritorio, cotas del bridge y ReDoS del
parser de la galería, un stop que en realidad era pausa, undo que perdía datos,
batch no atómico, MIDI sin cambios de tempo, audio fantasma, loop que se moría,
pan de nota muerto, limiter que dejaba pasar picos, foldback en contrafase y un
notch que amplificaba.

</details>

<details>
<summary><b>v2.8.0 — "el códec propio"</b></summary>

Orbit exporta `.opus` con un códec escrito entero en casa — range coder, MDCT,
PVQ, cuantización de energía, asignador de bits y contenedor Ogg — con la
RFC 6716 como referencia y verificado contra ffmpeg. La sección **Encoder Opus
propio**, más abajo, lo cuenta entero (incluidos los dos bugs que solo vio un
decodificador ajeno).

</details>

<details>
<summary><b>v1.2.0 — "la casa en orden"</b></summary>

Auditoría extensa cerrada: aislamiento de los plugins JS (parseo estático, CSP y
worker), endurecimiento del servidor y de Electron, token por sesión en el bridge,
render offline en un worker aislado, `mixerTrack` por carril de la playlist y
botón para arrancar el servidor desde el panel.

</details>

<details>
<summary><b>v1.1.0 — "cada sonido a solas"</b></summary>

**Orbit Prisma**, el instrumento grande de presets: **125 sonidos** en 16
categorías, hasta cuatro capas por preset sobre **nueve motores propios** (tabla
de ondas con morph, pulso PWM, ruido filtrado, FM con realimentación, cuerda
pulsada, órgano aditivo, campana inarmónica, formantes vocales y sub), filtro con
envolvente y keytrack, LFO por voz, unísono, modo Poly/Mono/Legato y **ocho
macros por preset**.

**Editor de sonido por canal** (doble clic en el rack): las perillas del
instrumento, el recorte del sample con la onda y las marcas de start/end
arrastrables —acortar, invertir el tiempo, invertir la fase, fades, loop— y
**cuatro inserts propios del canal**, para bajarle el reverb a UN sonido sin
tocar los demás de su pista.

Y tres bugs que se notaban a diario: en colaboración viajaban los comandos pero
**nunca los bytes de los sonidos**, los menús contextuales se recortaban dentro
de los editores, y el shim de escala no se instalaba al 100 %.

</details>

<details>
<summary><b>v1.0.0 — "el estudio completo"</b></summary>

**Orbit Nova** (26 presets sobre los motores propios), **paridad FL** (compases
variables, tempo por marcador, historial de undo navegable, pincel/cortar, riff
machine determinista, graph editor de velocity, count-in), **audio pro**
(pitch-shift de clips, afinador PSOLA, transientes, convolución particionada,
vinyl/lo-fi, carriles de toma y congelar pista), **Orbit Vox** y **Orbit
Slicer**, plugins JS de instrumento, detección de BPM y tonalidad, plantillas, y
el **asistente de mezcla de Claude** (`advise_mix`), que diagnostica LUFS, bandas
y fase y propone la cadena con valores reales.

</details>
