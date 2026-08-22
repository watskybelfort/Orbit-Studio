# Orbit Studio

![versión](https://img.shields.io/badge/versi%C3%B3n-v2.7.0-5aa9e6)
![tests](https://img.shields.io/badge/tests-964%20passing-7ce65a)
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

## Los cinco pilares

1. **Motor de audio propio** — DSP sample-accurate en un AudioWorklet: **10
   instrumentos** (sustractivo, supersaw, FM, 808 con glide, drums sintetizados
   en 3 kits, sampler, slicer, formantes y los dos de presets, Nova y Prisma) y
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
3. **Librería clasificada** — pack de fábrica *Orbit Essentials* (**84 sonidos**
   generados por síntesis propia) con categorías, tags de género/tonalidad/BPM,
   detección automática de BPM y tonalidad, búsqueda instantánea y preview
   renderizado por el propio kernel.
4. **Colaboración en tiempo real** — el proyecto es un log de comandos sobre
   CRDT (Yjs): salas por código de 6 letras **con contraseña opcional que nunca
   viaja**, **aforo ajustable (2–64)**, servidor propio que puedes atar a la
   dirección que quieras (localhost, la IP del VPN, la de la LAN o todas),
   convergencia sin conflictos, roles que reparte y hace cumplir el servidor,
   chat anclado al timeline, modo seguidor y undo POR USUARIO (tu Ctrl+Z no
   deshace lo del otro).
5. **Claude dentro del estudio** — la app expone un servidor MCP con **21 tools**
   (`.mcp.json` en el repo): Claude lee el proyecto, escribe notas, programa
   steps, ajusta la mezcla, añade efectos, renderiza y analiza LUFS/balance —
   todo por el mismo bus de comandos, visible en vivo y deshacible.

## Lo último

**v2.7.0 — "quién firma esto".** Del roadmap. La galería trae código de terceros
y lo único que la protegía era que ese código **no se ejecuta** para saber qué es
(parseo estático) y que corre aislado. Eso limita el daño, pero no dice nada de
si lo que te llega es lo que el autor publicó: un CDN comprometido o un repo con
permisos de más cambian el archivo y nadie se entera.

Ahora un índice puede ir **firmado**, y la firma cubre el **hash de cada
plugin** — así la cadena llega hasta el código: al instalar, la app baja el
archivo, lo hashea y lo compara. Si no cuadra, no se guarda, aunque la URL sea la
correcta y el servidor conteste 200.

El modelo de confianza es el de SSH: **no hay autoridad que valide a nadie**
(cualquiera puede generar una clave y firmar lo suyo), así que lo que aporta la
firma no es «esto es bueno» sino «esto lo publicó **el mismo de siempre**». La
app acepta la primera clave que ve, la fija y exige que no cambie. Un cambio de
clave no es un aviso: **es un alto** — la lista de plugins desaparece hasta que
una persona compare las dos huellas y decida. Y una galería que estaba firmada y
llega sin firma cuenta igual, porque quitar la firma es justo el ataque que esto
corta.

Lo que se firma no son los bytes del JSON —reformatearlo lo rompería sin que
nadie haya hecho nada malo— sino una cadena canónica con los campos ya validados
y los plugins ordenados por id. Está probado en las dos direcciones: cambiar la
URL de un plugin invalida la firma, y re-serializar el JSON entero no.

Y hay con qué publicar: `tools/gallery-sign.ts` genera el par de claves y firma
un índice (bajando cada plugin para hashearlo), importando la misma
canonicalización que usa la app — no una copia que pueda desviarse.

> La firma **no vuelve seguro el código**. Un plugin firmado puede ser igual de
> malo que uno sin firmar: garantiza autoría e integridad, y de lo que el plugin
> haga siguen protegiéndote el sandbox y el bypass. Eso se dice también en la
> propia pantalla.

**v2.6.0 — "el cable también decide".** Del roadmap: hasta ahora el enrutado
solo sumaba —un envío era «manda esto ahí con esta ganancia»— y el graph editor
recableaba lo que el modelo ya sabía expresar. Ahora los envíos **procesan**.

Cada uno elige tres cosas:

- **De dónde toma la señal.** *Post-fader* (lo de siempre: bajar la pista baja
  lo que mandas) o **pre-fader**, que es lo que hace posible una reverb que se
  queda cuando cierras el fader, o una mezcla de auriculares con sus propias
  proporciones. La toma va después de los efectos y el EQ: lo que viaja es el
  sonido procesado de la pista, no el crudo.
- **Qué parte manda.** Todo, el **centro** (mid), los **lados** (side), o un solo
  canal. Mandar solo los lados a un bus con su compresor era, hasta hoy,
  duplicar la pista y pelearse con las fases.
- **Con qué polaridad.** Invertida, el envío **resta** en vez de sumar: los
  trucos de paralelo y el null test de toda la vida, más pan y mute propios.

Un envío que hace algo especial **se ve sin abrirlo** (una chapita `preSø` en el
strip) y **el grafo dibuja lo que lleva cada cable**: discontinuo si toma antes
del fader, más fino si va solo una parte, rojo si invierte. El grafo pasa de
enseñar por dónde va la señal a enseñar *qué* va por ahí.

Lo que se prueba de esto no es que «se oiga algo» sino **qué** se oye: los lados
de una fuente centrada tienen que dar silencio, el centro de una fuente en
contrafase también, y una pista sumada con su propia copia invertida tiene que
cancelar. Si el kernel se equivoca de signo o de fórmula, eso falla al momento
— y mirando la pantalla no se vería.

**v2.5.0 — "una llave que caduca".** Se cierra el roadmap: la contraseña de sala
cierra la puerta, pero compartirla es para siempre — quien la tiene entra hoy y
el mes que viene, y quitársela a uno se la quita a todos.

Ahora el productor puede crear **invitaciones que caducan**: se elige cuánto
valen (de quince minutos a un día) y para cuánta gente (una, tres o diez), y se
revocan cuando quieras. Entrar con una no pide la contraseña, que es justo la
gracia: **dejar entrar a alguien sin dársela**.

Con eso, el botón «Invitar» de la red local que llegó en v2.4 se cierra del
todo: si la sala está protegida, la invitación sale con un token de **un uso y
media hora**, y al otro le llega el aviso con «Unirme» que entra directo. Sin
código dictado por teléfono y sin contraseña compartida.

El servidor guarda **SHA-256 del secreto**, como con la contraseña, así que el
token se enseña una vez y ni él lo puede repetir: si se pierde, se revoca y se
hace otra. Y un token, a diferencia de la contraseña, **sí viaja** — es un
secreto que le das a alguien para que lo enseñe. Eso no se disimula: se
compensa con que caduque, se gaste y se pueda revocar, y por eso las que genera
el botón son de un solo uso.

**v2.4.0 — "la forma del tema, y quién está al lado".** Dos cosas: la
estructura del beat deja de vivir solo en la cabeza, y meter a alguien en una
sala deja de ser dictarle un código por teléfono.

**Las secciones del arreglo.** Encima de la rejilla de la playlist hay una
franja donde se dibuja la forma: intro, subida, drop, vuelta, outro. Arrastrar
crea, agarrar mueve, el borde derecho estira. Y lo que las convierte en una
herramienta y no en una etiqueta es que las operaciones se llevan lo que hay
dentro: **duplicar un drop copia sus clips, empuja todo lo que venía detrás y
mueve los marcadores** —si el marcador de tempo se quedara donde estaba, el tema
se descuadraría a partir de ahí— y todo eso se deshace con un Ctrl+Z. También
se puede borrar una vuelta cerrando el hueco, o quitar solo la etiqueta.

Un clip pertenece a la sección **donde empieza**, no a la que invade: por
solape, un clip que arranca antes y se mete dentro se copiaría al duplicar y
dejaría un agujero en la sección anterior.

Y el botón **Secciones** trae las tres formas que ya reparte el generador de
beats —de manual, con vuelta larga, al grano— leídas del mismo catálogo que usa
él, para que el generador y el editor no acaben con dos ideas distintas de qué
es un drop.

**Gente en la red.** El panel de Colaboración ahora enseña quién tiene Orbit
abierto en la misma red, deja **guardarlos como amigos** e **invitarlos de un
clic**: al otro le llega un aviso con el botón de entrar. Es una baliza UDP con
TTL 1 —no sale de la subred— sin servidor central ni cuentas, como el resto de
la colaboración.

Dos asimetrías a propósito: **escuchar es siempre** (es lo que hace que te
lleguen las invitaciones) pero **anunciar tu nombre es opcional**; y **una
invitación no entra en ninguna sala**, porque unirse reemplaza el proyecto
abierto y esa decisión no la puede tomar un paquete que llega por el wifi. Todo
lo que entra por el socket se valida: la URL tiene que ser `ws`/`wss` o quien
invita elegiría a qué se conecta el invitado, y solo se manda una invitación a
direcciones de la red local, para que el proceso principal no sea un lanzador de
paquetes a donde le digan.

**v2.3.0 — "la mano encima de la curva".** Sale del roadmap: la automatización
tenía puntos y tensión, pero no se podía **dibujar**. Un barrido de filtro eran
treinta dobles clics, uno por punto, y por eso no se hacían.

**El lápiz.** Se arrastra y se dibuja. El trazo se pinta encima mientras dura
—sin tocar el proyecto: un barrido son cientos de eventos de puntero, y
despachar cada uno llenaría el historial y recompilaría sesenta veces por
segundo— y al soltar se simplifica y sustituye **solo el tramo dibujado**, en un
único paso de undo. Al lado, **Recta** tira una rampa entre dos puntos.

**El generador de formas.** "Forma…" rellena un tramo con una onda: seno,
triángulo, sierra ↗ o ↘, cuadrada y aleatoria con semilla, con sus ciclos, su
recorrido, su fase y los beats que ocupa. Un tremolo, un pan que se mueve o un
filtro que respira pasan de cincuenta puntos a mano a cuatro campos. La
previsualización **se dibuja**, discontinua encima de la curva, y el proyecto no
se toca hasta *Aplicar*.

**Snap del eje de valor** (1/2, 1/4, 1/8, 12, 1/16), con sus alturas pintadas:
con 12 divisiones una automatización de tono cae en semitonos. Ahí salió el
fallo que hacía que no sirviera de nada: el redondeo iba *después* de
simplificar, así que una rampa recta se quedaba en sus dos extremos y redondear
esos dos daba "de 0 a 1". Ahora va antes, y la rampa sale como la escalera que
uno está pidiendo.

Y **Simplificar**, que quita puntos sin cambiar lo que suena: no poda la lista
—eso se llevaría por delante las curvaturas y cambiaría la forma—, sino que
muestrea la curva tal y como la evalúa el motor y simplifica ese trazo.

**v2.2.0 — "lo que se toca todo el rato".** Una revisión de la app entera
mirando lo que se usa en cada sesión, no lo que falta en el roadmap.

**No había portapapeles.** Ninguno: no se podía copiar ni una nota. Ahora
Ctrl+C, Ctrl+X y Ctrl+V trabajan sobre la selección del Piano Roll y de la
Playlist. Lo copiado se guarda normalizado al beat 0, así que pegar es una suma
y la separación entre notas —o entre pistas— se conserva sola; las notas caen en
el caret con el snap vigente y los clips en la pista que tienes bajo el ratón.
Como los dos editores están abiertos a la vez casi siempre, hay un árbitro: el
último editor que tocaste tiene el turno, y es de quien habla el menú Editar.

**Y "Nuevo proyecto" se llevaba por delante una hora de trabajo sin preguntar.**
Ahora hay un estado de cambios sin guardar de verdad: nuevo, plantilla, abrir y
abrir reciente avisan, el título de la ventana lleva el nombre del proyecto y un
punto cuando hay cambios, y **cerrar la ventana lo frena el proceso principal** —
que es el único que se entera de un Alt+F4— con la opción de guardar y salir. Al
separar ese estado apareció el bug de debajo: la marca de "guardado" y la de
"autoguardado" eran la misma variable, así que el primer autosave dejaba el
proyecto marcado como limpio sin haberse guardado nada.

**Volver a un proyecto ya no es buscarlo en el disco**: `Archivo → Abrir
reciente` guarda los diez últimos. La lista la escribe solo el proceso principal
y es, a la vez, la lista blanca que autoriza abrirlos: si el renderer pudiera
escribirla, "abrir un reciente" sería "leer cualquier archivo del disco".

**Los menús.** `Archivo` escupía una entrada por plantilla en el primer nivel y
`Ver` era un volcado de veinte líneas donde nada decía si estaba abierto o
cerrado. Ahora hay submenús (plantillas, recientes, layouts), bloques con
cabecera, y un ✓ en todo lo que se alterna. `Editar` pasa de cuatro entradas sin
editar nada a las seis de siempre —diciendo de qué hablan: "Copiar 3 notas"— y
deshacer dice qué deshace. **Y se manejan con el teclado**: Alt los abre,
flechas, Inicio/Fin, Esc y letra inicial.

**Los atajos salen del markdown** y entran en la app: `Ayuda → Atajos de teclado`
(F1), agrupados, buscables y diciendo dónde vale cada uno. Y la **paleta de
comandos busca por subsecuencia**: "pr" ya encuentra "Abrir Piano Roll" —antes
había que saberse el principio exacto— y, sin escribir nada, arriba están los
últimos comandos que usaste.

**v2.1.0 — "la mesa de trabajo".** Nada de esto salía del roadmap: sale de una
sesión larga usando el programa de verdad, que es de donde salen las cosas que
de verdad estorban.

**La app se quedaba muda y había que reiniciarla.** Pasaba cambiando de SONG a
PAT, y el motivo era del kernel: la condición para dar la vuelta al loop exige
que el cursor esté DENTRO de él, así que al arrancar el patrón (loop de cuatro
beats) desde el beat 200 de la canción no envolvía nunca — el cursor subía al
infinito, no se disparaba ni un evento y no volvía a sonar nada. Pasaba igual
con un seek más allá del final y al recortar el patrón por debajo del cursor.
Ahora el playhead que amanece fuera vuelve al principio del loop, y además PAT
y SONG llevan playheads independientes, que es donde nacía el disparate.

**La playlist tiene selección.** Antes todo era clip a clip. Ahora Ctrl+clic
mete y saca, Ctrl+arrastre en zona vacía dibuja un rectángulo, Ctrl+A coge
todo, y arrastrar un clip marcado mueve el grupo entero conservando su forma
(el clamp es conjunto: acotando clip a clip los del borde se clavan y el resto
se les echa encima). Con botones a la vista, para no depender de saberse los
atajos.

**Y los clips de audio enseñan su forma de onda**, con su offset y su
time-stretch, en vez de una raya en el centro: colocar un golpe deja de ser
adivinar. Encima llevan **fundidos arrastrables** como los de CapCut — un
puntito en cada esquina de arriba, la rampa dibujada es la que suena, y van en
beats, así que siguen al tempo.

**El arpegiador, entero.** El botón "Arp" hacía siempre lo mismo: subir, al
paso del snap. Ahora es un panel con lo que tiene el de FL — recorrido, paso,
Time mul, rango de octavas, Gate, agrupar notas y rampas de Pan/Vel/Tono — y
**cada cambio se oye al momento** sobre las notas de verdad; Esc las devuelve
como estaban. Al lado, el desplegable de acordes por fin se puede **aplicar a
lo que ya está escrito** (Alt+C), ajustado a la escala si tienes el bloqueo
puesto.

**Y la mesa se queda como la dejas**: la disposición de ventanas se guarda entre
sesiones (acotada al escritorio de ahora, que un monitor puede desaparecer), la
toolbar del piano roll pasa de trece botones sueltos a siete bloques con
etiqueta, y por fin se puede ver qué versión estás usando: **Ayuda › Acerca
de**.

**v2.0.0 — "la puerta y el guardia".** Se vacía el "Siguiente" del roadmap, y
una auditoría adversarial de la sala y del motor deja 24 arreglos por el camino.

**La sala tiene puerta.** Hasta ahora el modelo de confianza era el código de
seis caracteres: quien llegaba al puerto y lo sabía, entraba. Ahora una sala
puede pedir **contraseña**, y la contraseña **no viaja** — ni siquiera
derivada. El cliente firma con ella un nonce que pone el servidor (el esquema
de SCRAM, reducido a lo justo), así que la prueba es distinta en cada conexión
y grabar el tráfico no abre nada; el servidor guarda un hash de un hash, con el
que **tampoco se puede entrar**. Y mientras alguien está en la puerta no se le
mira nada más: ni sync, ni presencia, ni audio — la sala ni siquiera se crea.

**Y el guardia se creía tres campos que escribe el cliente.** El rol lo reparte
el servidor desde v1.8, pero el camino que va del socket a la decisión tenía
tres agujeros, los tres explotables con el repo delante: el rol salía de
`entry.client` (un invitado firmaba con el clientID del productor y borraba
pistas), la lista de "ya juzgado" se indexaba por `client:seq` (repetir una
clave saltaba la validación entera) y **el snapshot del proyecto no lo miraba
nadie** (un invitado lo reescribía entero sin tocar el log). Ahora se juzga el
delta de la transacción con el rol del socket que lo entrega, y `meta` también
está vigilado.

**Comparar dos versiones cualesquiera.** El diff musical ya estaba, pero un
lado era siempre el proyecto de ahora. Ahora se eligen los dos, con la
dirección delante — porque "+3 notas" leído al revés es la mentira contraria.

**Beats con estructura entera.** Un loop de cuatro compases no es un beat. La
familia **`beats`** del generador encadena secciones —intro, subida, drop,
vuelta y cierre— con batería, 808 y melodía en un solo archivo, y cada compás
suena según dónde está: el 808 desaparece en la vuelta para que el drop
siguiente vuelva a pegar, y el bombo se calla en el último compás de la subida,
porque lo que hace entrar un drop es el silencio de antes.

**Y 24 arreglos.** Los que más se notan: el **relay MCP** congelaba puerto y
token al arrancar, así que abrir Claude Code antes que la app dejaba el puente
roto para siempre —diciendo que la app estaba cerrada—; el **sampler metía
NaN** con la perilla `start` a tope y el limiter del master lo convertía en un
WAV entero de basura; **una nota muy aguda** desbocaba la fase y sacaba +142 dB;
el **render mutaba el proyecto compilado**, así que los stems no cuadraban con
la mezcla; los **clips de audio perdían muestras en cada vuelta del loop**;
**normalizar una selección corta** la multiplicaba por 631; **"Afinar" con
transposición** se comía media toma; la **cuenta atrás no contaba** si grababas
desde el compás 1; y los **breaks del generador de packs perdían la caja**,
porque el kernel pide los eventos ordenados y las recetas no los ordenaban.

<details>
<summary><b>v1.9.0 — "mirar atrás y repartir"</b></summary>


**Versiones con diff musical.** El proyecto se guarda entero como versión (una
en cada Ctrl+S, y las que pidas con nombre) y cada una se despliega con **lo
que ha cambiado desde entonces contado en música**: "+3 notas en «Patrón 1» ·
Kit", "Canal nuevo «Voz»", "Tempo 140 → 76.25", "fader +2.5 dB". Las notas se
casan por id, así que mover una no se cuenta como borrarla y crearla. Y
restaurar guarda antes el estado de ahora: volver atrás no es una puerta de un
solo sentido.

**Galería de plugins.** El SDK está desde v0.7, pero compartirlos era mandarse
el `.js` por ahí. Ahora se añaden **fuentes** (un índice JSON publicado donde
quieras) y se instala de un clic. Lo que baja no se ejecuta para averiguar qué
es: se lee con el mismo parseo estático de siempre y, si no declara
`createEffect` ni `createInstrument`, no llega al disco.

**El OGG deja de estar descartado.** Lo que faltaba no era un códec: era el
**contenedor**. Un `.ogg` de Orbit es Ogg FLAC — sin pérdida, del mismo
encoder que ya sonaba bit-exacto — y ffmpeg lo decodifica muestra a muestra
igual que el original. Y el **streaming del master ya no viaja crudo**: ADPCM
propio, 192 kbit/s en vez de 768, con cada trozo independiente para que un
paquete perdido no arrastre al siguiente. (Opus entero sigue fuera: eso es un
códec completo, no un envoltorio.)

</details>

**v1.8.0 — "quién manda y qué se oye".** Las tres del "Siguiente".

**El rol ya no es lo que tú digas.** Hasta ahora cada cliente declaraba el
suyo y los demás lo creían: cambiar un campo bastaba para ascender a productor
y borrarle el proyecto a otro. Ahora **lo reparte la sala** — el primero que
entra manda y desde su lista cambia el de los demás; si se va, hereda el más
antiguo — y el **servidor vigila el log**: cada cambio se juzga con el rol que
él tiene apuntado y lo que no pasa se retira. El que lo intentó ve su propio
proyecto volver a lo que dice la sala.

**Oír el master del otro.** El proyecto converge, pero lo que suena no: cada
uno renderiza en su máquina. Con **"Emitir mi master"** tu salida final viaja a
la sala y el botón **Oír** de cada fila la reproduce en la tuya, con su propio
volumen y sin tocar nada del proyecto. Se acabó el "¿lo estás oyendo igual que
yo?".

**Packs con más cuerpo.** A las diez familias de one-shots se suman **loops de
verdad**: melódicos con progresión (la de cada género: i–VI–III–VII para el
trap, i–VII–VI–V para el drill…), breaks de batería con su bombo, su caja y sus
hats —con redoble de tresillos al cerrar en trap y drill— y líneas de 808 que
siguen los acordes con glide. Salen al tempo del estilo, con su tonalidad, y
cortados **exactos en el beat** para que encajen con cualquier proyecto.

**v1.7.0 — "el cable y el sonido".** Se vacía el "Siguiente" del roadmap.

**El enrutado, como grafo.** Ventana **Enrutado**: el camino entero de la
señal a la vista —canales y carriles de audio a la izquierda, pistas de mixer
repartidas por columnas según lo lejos que estén del master, la salida de cada
una en línea llena y sus envíos de puntos con su nivel—. Y se recablea
arrastrando: del puerto de un canal a otra pista para cambiarlo de sitio, del
▸ de una pista para cambiar a dónde desemboca, del ⇢ para añadir un envío. Si
el cable cerraría un **bucle**, se pinta en rojo y no se guarda — el compilador
tolera los ciclos, pero lo que suena entonces no es lo que nadie quería.

**Packs de sonidos a medida.** "Dame 12 hats de drill" y salen: se
**renderizan con el mismo motor que suena en vivo**, se normalizan y aterrizan
en la librería, listos para arrastrar al rack o a la playlist. Diez familias
(kicks, snares, claps, hats, open hats, percusión, 808s, impactos, risers,
downlifters) por siete estilos, con las variaciones repartidas por todo el
rango de la familia —de lo más oscuro a lo más brillante— y deterministas: el
mismo encargo da siempre el mismo pack. Se pide desde el browser o dándoselo a
Claude por su tool nueva (`generate_pack`), que además puede meterte cada
sonido en su canal.

**v1.4.1 — el loop ya no se pisa a sí mismo.** Una nota que acababa justo en el
final del patrón no encontraba nunca su note-off: seguía sonando vuelta tras
vuelta, el sonido se solapaba consigo mismo y, al llenarse el pool de 64 voces,
se robaba la más antigua — parecía que se cortaba la **primera** nota mientras
las de más adelante sonaban. Ahora el cierre del loop (y el salto del playhead)
sueltan lo del pase anterior, con release: las colas siguen sonando. Además, al
dibujar una nota, **el arrastre horizontal le da la duración como en FL** y esa
duración queda de plantilla; el tirador del borde derecho es más fácil de
agarrar y el cursor lo delata.

Historial completo en [Releases](https://github.com/watskybelfort/Orbit-Studio/releases)
y, auditado línea a línea, en [docs/FEATURES.md](docs/FEATURES.md).

## Roadmap

Lo que hay pensado a continuación. Nada de esto está prometido con fecha: se
saca cuando toca, en el mismo orden en que estorba no tenerlo.

### Siguiente

| Qué | Por qué |
|---|---|
| **Encoder Opus propio** | **En marcha**: los cimientos están puestos y verificados (ver abajo). Falta el ensamblador de tramas de CELT y sus tablas de la RFC |

#### Encoder Opus: qué hay hecho y qué falta

Se está construyendo por fases, cada una verificable por sí sola. La referencia
es la implementación normativa incluida en la **RFC 6716** (Apéndice A),
extraída del propio documento y verificada por SHA-1
(`86a927223e73d2476646a1b933fcd3fffb6ecc8c`).

| Pieza | Cómo está verificada |
|---|---|
| **Range coder** (§4.1) | Ida y vuelta exacta en ráfagas mezcladas; 100.000 operaciones con 25 semillas |
| **MDCT + ventana de CELT** | TDAC: ruido, seno, impulso y silencio vuelven enteros a 1e-11 en los cuatro tamaños. Todo lo rápido se compara contra la definición directa |
| **FFT de radix mixto** | Contra la DFT directa. Hace falta porque los tamaños de Opus (120/240/480/960) **no son potencias de dos** |
| **PVQ** | Enumeración **normativa** (port de `cwrs.c`), con la cuenta `V` contrastada contra una recurrencia independiente y biyección probada **agotando** todos los vectores |
| **Tablas de CELT** | 721 valores extraídos **con script** (`tools/opus-tables.ts`), con invariantes y firma por suma tabla a tabla |
| **Caché de pulsos + log2 en coma fija** | Se **genera** desde `V(n,k)`; el logaritmo es exacto en potencias de dos y nunca se queda corto |
| **Codificador Laplace** | Ida y vuelta con el modelo real de las 21 bandas y los 4 tamaños |
| **Energía por bandas** (3 pasadas) | Diez tramas encadenadas: los dos lados acaban con el **mismo estado**, también con el paquete casi lleno |
| **Asignador de bits** | Codificador y decodificador llegan al **mismo reparto** en mono, estéreo, 4 tamaños, 11 inclinaciones, dynalloc e histéresis |
| **Bandas: energía/forma** | Separación sin pérdida, y la energía sobrevive aunque la forma se sustituya por otra |
| **Contenedor Ogg Opus** (RFC 7845) | **Bit a bit contra ffmpeg**: `npx tsx tools/qa/ogg-opus-verify.ts` |

Falta el **ensamblador de trama**: `quant_band` (la cuantización PVQ por banda,
con particiones recursivas y el ángulo de estéreo) y el flujo de trama que lo
pega todo al range coder.

> **Corrección a lo que decía antes esta tabla:** estimé «~1.500 constantes que
> van transcritas exactas». Son **721**, y el grueso de aquella cifra —la caché
> de pulsos— **no se transcribe: se genera** desde los bordes de banda y `V(n,k)`.
> Menos superficie que copiar a ciegas y más que se puede verificar sola.

> **El export a Opus no está disponible todavía**, y no lo estará hasta que
> ffmpeg decodifique un archivo hecho entero por Orbit. Los cimientos pasan sus
> tests, pero unos tests en verde no son un archivo que suene.

### Horizonte

| Qué | Estado |
|---|---|
| **Puente CLAP / VST3** | Necesita un host nativo con GUI embebida: proyecto aparte, no un rato |
| **Export a OGG** | Ya está: el `.ogg` de Orbit es **Ogg FLAC**, sin pérdida y del encoder propio. El contenedor **Ogg Opus** también está escrito y validado; lo que falta para un `.opus` es el códec |
| **Export de vídeo para visuales** | Fuera del alcance del DAW hasta que el resto esté redondo |

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # Electron + Vite (la app) — renderer en localhost:5900
npm run server     # servidor de colaboración (puerto 7900)
npm test           # 964 tests (core, engine, collab, claude-bridge, sound-library, ui, server, desktop)
npm run typecheck  # tsc --noEmit sobre todo el monorepo
```

> Si tras `npm install` Electron no arranca (allow-scripts se salta su
> postinstall): `cd node_modules/electron && node install.js`.

> El dev server usa el puerto **5900**: el 5173 de Vite cae dentro de un rango
> que Windows reserva para Hyper-V en algunas máquinas y moría con `EACCES`.

**Claude como colaborador:** abre la carpeta con Claude Code y la app en
marcha; el `.mcp.json` del repo conecta el bridge (stdio → WS local 7855) y las
21 tools aparecen solas. Todo lo que haga Claude sale en su panel (menú Ver →
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
