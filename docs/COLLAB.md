# Colaboración en tiempo real — Orbit Studio

Varias personas dentro del mismo proyecto, editando partes distintas de la pista
a la vez, sin pisarse y sin conflictos.

## Modelo

- El proyecto vive en un **documento Yjs** (CRDT): `Y.Map` para entidades,
  `Y.Array` para listas ordenadas (notas, clips, slots). Los IDs estables de
  core hacen el merge inequívoco.
- **Toda mutación es un comando** de `packages/core`; el comando escribe en el
  doc dentro de una transacción con `origin = userId`. Da igual si el comando
  viene de la UI local, de un colaborador remoto o de Claude: mismo camino.
- Sin sesión activa, el doc Yjs vive solo en local (cero overhead percibido);
  "Iniciar sesión colaborativa" conecta el provider sin migrar nada.

## Servidor (`apps/server`)

- Node + WebSocket con el protocolo y-sync + awareness.
- **Rooms por código** (6 caracteres, estilo "métete a mi sesión: `K3P-9QF`").
  Crear sesión = subir tu proyecto al room; unirse = recibir el doc completo.
- **Aforo de la sala (v1.3)**: cuánta gente cabe se ajusta — campo "Caben" del
  panel (lo guarda `settings.json` y lo aplica el servidor que arranca la app)
  o `ORBIT_ROOM_CAPACITY` para el servidor suelto. 16 por defecto, entre 2 y
  64; `/health` publica `rooms`, `conns` y `roomCapacity`. Al que no cabe se le
  cierra con 1013 y el motivo dentro, y el cliente NO reintenta: lo enseña en
  pantalla ("La sala está llena"). Lo mismo con 1008 (código inválido).
- Persistencia: snapshot del doc + updates incrementales en disco; si el host
  se cae, la sesión sobrevive.
- **Dónde escucha (v1.4)**: el desplegable "Escucha en" del panel elige la
  dirección — solo esta máquina (por defecto), una IPv4 concreta de la máquina
  (Radmin VPN, Wi-Fi, Ethernet…: el main las etiqueta y las ordena poniendo las
  VPN primero) o todas las redes. Se guarda en `collabServerHost` y se aplica al
  arrancar el servidor; la casilla "Abrir a la red" de la v1.3 se sigue leyendo
  para migrar. El aviso va delante: la sala no lleva contraseña, entra quien
  llegue al puerto y sepa el código.
  - Si la IP elegida ya no existe (el VPN apagado), `resolveHost` cae a
    localhost en vez de reventar el arranque con EADDRNOTAVAIL, y el panel avisa
    de que se quedó en local.
  - Atado a una IP concreta, **`localhost` deja de responder hasta para quien
    hospeda**: el panel enseña la dirección que hay que repartir, la copia al
    portapapeles y ofrece "Usarla aquí" para dejarla también en el campo
    Servidor de esta app.
  - Fuera de la app sigue valiendo `HOST=<lo-que-sea> npm run server`.
- Auth simple v0.1: token de room (el código) + nombre de usuario.
- **Roles (v1.0)**: productor (todo), invitado (edita pero no borra pistas ni
  patrones ni toca el master, ni dentro de un batch) y oyente (solo mira y
  escucha). Un patrón cuenta como borrado protegido porque se lleva sus notas y
  todos sus clips por delante; lo que uno crea, uno lo puede deshacer. El
  control está en el log de comandos, que es por donde pasa TODO, con una
  función pura y el rol sellado en la entrada: emisor y receptores dan el mismo
  veredicto, así que la convergencia no se rompe.
- **El rol lo decide el servidor (v1.8)**: era autodeclarado —cambiar un campo
  bastaba para ascender—, así que ahora lo reparte la sala por un canal de
  control propio (mensaje tipo 2): el primero que entra es productor, los demás
  invitados, el productor los cambia desde su lista y, si se va, hereda el más
  antiguo. Y el servidor VIGILA el log: juzga cada entrada nueva con el rol que
  él tiene apuntado para su emisor —no con el que la entrada dice traer— y
  RETIRA la que no pasa. Borrar del log es una operación normal del CRDT, así
  que converge; el cliente que se pasó detecta que le han retirado algo ya
  aplicado y re-deriva desde snapshot + log (distinto de una compactación, que
  también vacía el log y no debe deshacer nada).
- **Streaming del master (v1.8)**: mensaje tipo 3, mono Int16 a la sample rate
  del emisor. El servidor lo reparte y NO lo guarda: no es parte del proyecto.
  El que escucha lo saca por el AudioContext de la app (fuera del kernel) con
  un reloj que re-engancha si un trozo llega tarde y tira el que llega cuando
  la cola ya va muy por delante. Es monitorización: la referencia sigue siendo
  el render.
- **Chat de sesión (v1.0)**: un `Y.Array` en el mismo documento, sin servidor
  nuevo; quien llega tarde recibe la conversación entera. Un mensaje puede
  llevar un beat y queda anclado al timeline. No pasa por el log de comandos:
  no ensucia el undo y hasta un oyente puede hablar.
- **Modo seguidor (v1.0)**: la presencia publica la "vista lógica" (editor
  delante, patrón, canal, pista de mixer, playhead) y puedes seguir a alguien;
  el caret solo te lo mueve con el transporte parado.

## La puerta: contraseña de sala (v2.0)

Hasta v1.9 el modelo de confianza era el código de seis caracteres. Ahora una
sala puede pedir contraseña, y el esquema es el de **SCRAM** reducido a lo justo
(`packages/collab/src/room-auth.ts`):

```
saltedPassword = PBKDF2-SHA256(contraseña, salt, iteraciones)
clientKey      = HMAC(saltedPassword, "Orbit Client Key")
storedKey      = SHA-256(clientKey)          ← lo ÚNICO que guarda el servidor
authMessage    = "<sala>:<nonce>"            ← el nonce lo pone el servidor
proof          = clientKey XOR HMAC(storedKey, authMessage)   ← lo ÚNICO que viaja
```

El servidor recupera `clientKey = proof XOR HMAC(storedKey, authMessage)` y
comprueba que su SHA-256 es el `storedKey` que tiene apuntado. De ahí salen tres
propiedades:

- **La contraseña nunca viaja**, ni siquiera derivada: la prueba es distinta en
  cada conexión (nonce de un solo uso), así que grabar el tráfico no abre nada.
- **El servidor no puede reconstruirla**: guarda un hash de un hash.
- **Robar el archivo de la sala tampoco basta**: para firmar hace falta
  `clientKey`, y de `storedKey` solo se llega por preimagen.

Cómo se comporta el socket:

1. El que conecta a una sala protegida recibe `challenge` y **se queda en la
   puerta**. Mientras está ahí el servidor no mira nada más: ni sync, ni
   presencia, ni audio. La sala ni siquiera se crea — un desconocido no debería
   poder hacer que se abra un `.bin` de 60 MB solo por conectarse.
2. Una prueba por conexión y 20 s de margen. Fallar cierra con **1008** y su
   motivo, que el cliente entiende como "no insistas".
3. Con `authOk` empieza el sync. **El saludo del `onopen` se lo comió la
   puerta**, así que el cliente lo repite (`sendHandshake()` en session.ts): sin
   eso, entrar con la contraseña correcta dejaría la sesión colgada en
   "Conectando…" para siempre.
4. `setPassword` lo juzga el servidor con el rol que **él** reparte: solo el
   productor cambia la cerradura, y cambiarla **no echa** a los que están dentro.

Dónde vive: `<roomsDir>/<código>.auth.json`, escrito de forma atómica y con
permisos de solo-el-dueño donde el sistema los respeta. **Nunca en el Y.Doc**:
lo que se mete en el doc acaba replicado en la máquina de cada invitado. Un
`.auth.json` corrupto deja la sala **cerrada**, no abierta de par en par.

En la app: campo "Contraseña" al crear y al unirse (solo en memoria — no se
guarda en `settings.json`), y bloque "Puerta de la sala" dentro, donde el
productor la pone, la cambia o la quita. Para QA headless:
`ORBIT_COLLAB_PASSWORD=... npx tsx tools/qa/presence-peer.ts <SALA>`.

## Invitaciones caducables (v2.5)

La contraseña cierra la puerta, pero compartirla es para siempre: quien la
tiene entra hoy y el mes que viene, y quitársela a uno se la quita a todos. Una
invitación es la forma de dejar entrar a alguien **sin dársela**.

```
token = <id>.<secreto>          ← los dos en base64url; el secreto, 144 bits
guardado = SHA-256(secreto)     ← lo ÚNICO que guarda el servidor
```

Cada invitación tiene **caducidad** y **usos**, y se puede **revocar**. Al
entrar se gasta un uso; cuando llega a cero desaparece sola, igual que cuando
pasa su hora.

**Un token es un portador, y eso es deliberado.** La contraseña no viaja nunca
(SCRAM: viaja una prueba distinta en cada conexión); un token, por definición,
sí — es un secreto que le das a alguien para que lo enseñe. Lo que compensa esa
diferencia es que caduca, se gasta y se revoca, no disimularla. Por eso las
invitaciones que genera el botón «Invitar» de la red local son de **un uso y
media hora**: un paquete capturado sirve para entrar una vez y durante un rato,
que es exactamente lo que no pasaba compartiendo la contraseña.

**En la puerta** valen dos respuestas al mismo `challenge`: `auth` (la prueba de
la contraseña) o `joinInvite` (el token). Mismas reglas para las dos: una por
conexión, 20 s de margen, y fallar cierra con 1008. El motivo del rechazo se
distingue en el log pero **no** en lo que se le dice a quien llama — un mensaje
por caso sería un oráculo de qué invitaciones existen.

**Crear y revocar** los juzga el servidor con el rol que él reparte, igual que
`setPassword`: un invitado que mande el mensaje a mano no fabrica llaves. Y no
se pueden crear sin contraseña puesta: sin puerta entra quien sepa el código y
una invitación no significaría nada.

**El token se manda una vez**, solo al que la pidió. El servidor guarda el hash,
así que ese mensaje es el único momento en el que el secreto existe fuera de
quien lo va a usar; si se pierde, se revoca y se hace otra.

**Dónde viven:** en el mismo `<código>.auth.json` que la puerta, y por el mismo
motivo — fuera del Y.Doc, que se replica en la máquina de cada invitado. Quitar
la contraseña se las lleva; cambiarla **no** las revoca (son otra credencial,
igual que cambiarla tampoco echa a los que ya están dentro).

Probado contra el servidor de verdad en `apps/server/test/room-invite.test.ts`:
que abre sin contraseña, que la de un uso no abre dos veces, que revocar surte
efecto en el acto, que sobreviven a cerrar la sala y que en el archivo solo hay
huellas.

## Gente en la red local (v2.4)

Para entrar en una sala hacía falta que alguien te dictara el código y la
dirección. Desde v2.4 la app se anuncia (si tú quieres) en la red local y
enseña a los demás en el panel, con botones para guardarlos como amigos e
invitarlos.

**Cómo va.** Un socket UDP en el grupo multicast `239.255.77.90:47900`, con
**TTL 1**: no sale de la subred, a propósito. Cada instancia manda una baliza
`{v, kind:'hello', id, name}` cada cuatro segundos, y el que lleva trece
segundos callado se cae de la lista. Una invitación es un mensaje unicast
`{v, kind:'invite', id, name, room, url}` a la dirección del otro.

No hay servidor central ni cuentas: el `id` identifica la INSTALACIÓN (para no
contarse a uno mismo y para que un amigo siga siendo el mismo cuando le cambie
la IP), y el nombre es el mismo con el que entras a las salas.

**Las dos asimetrías, y por qué.**

- *Escuchar es siempre, anunciarse es opcional.* Escuchar no cuenta nada de ti y
  es lo que hace que te lleguen las invitaciones. Anunciarse manda tu nombre a
  toda la red local, y eso se pide.
- *Una invitación no entra en ninguna sala.* Llega, se enseña quién invita y a
  qué, y decide el usuario. Unirse reemplaza el proyecto abierto: un paquete UDP
  que lo hiciera solo sería un botón que puede pulsar cualquiera del mismo wifi.

**Lo que se valida** (`apps/desktop/src/main/discovery-protocol.ts`, con tests).
Es la única frontera del programa a la que le puede escribir cualquiera de la
red, así que todo lo que llega se comprueba: versión del protocolo, tamaño del
paquete, forma del `id`, `kind` conocido, código de sala válido y —la que más
importa— que la `url` sea `ws://` o `wss://`. Esa URL la va a abrir la app: sin
la guarda, quien invita elegiría a qué servidor se conecta el invitado. Los
nombres se sanean (controles a espacio, tope de 40) porque acaban pintados en
una lista.

**Lo que guarda el main.** `friends` está en `SETTINGS_LOCKED` igual que
`userFolders` y `recentProjects`: es la lista blanca de a quién se puede
invitar, y no la escribe quien tiene que cumplirla. Y `net:invite` solo acepta
direcciones de alguien visto o de un amigo, y además de la red local
(`isLanAddress`), para que el renderer no pueda convertir el proceso principal
en un lanzador de paquetes UDP a donde le apetezca.

**Probarlo sin dos máquinas:** `node tools/qa/lan-peer.mjs "Ana" 20 K3P9QF`
levanta un vecino falso que se anuncia y luego invita.

## Presencia (awareness)

- Cada cliente publica: nombre, color asignado, editor activo (Playlist,
  Piano Roll de X, Mixer…), cursor (posición en el timeline / celda), selección.
- La UI dibuja: cursores remotos con etiqueta de nombre, contornos de selección
  con el color del usuario, chips "🎹 Ana está en el Piano Roll de Orbit Sub",
  lista de conectados en la barra superior.
- **Un color por persona (v1.3)**: el color sale del nombre y casi todo el
  mundo entra como "Productor", así que tres personas salían del mismo color en
  la lista, en los cursores y en el chat. Ahora, al cambiar la presencia, quien
  comparta color con alguien de `clientId` más bajo se aparta al primer color
  libre (`pickDistinctColor`, en `packages/collab/src/colors.ts`): el de id más
  bajo no se mueve nunca, así que converge sin protocolo nuevo. En la lista, los
  nombres repetidos se numeran ("Productor 2").
- **Claude aparece aquí como un usuario más** (nombre "Claude", su color) cuando
  el bridge MCP está activo.

## Undo por usuario

Tu Ctrl+Z deshace **tus** cambios, no los del colaborador. El historial visible
marca de quién fue cada paso.

El scoping por origen NO lo hace Yjs: no hay ningún `Y.UndoManager` en el repo.
Lo hace `ProjectStore` (`packages/core/src/store.ts`), con `undo(origin)` /
`redo(origin)` sobre sus dos pilas — cada entrada lleva su origen (`local`,
`claude`, `remote:<usuario>`) y el undo busca la más reciente que sea tuya.

Y hay una consecuencia que conviene tener presente: **en Orbit un undo no
rebobina nada**. Aplica el comando inverso y lo emite como un cambio más, que
este binding anexa al log compartido. Para la sala, tu Ctrl+Z es una edición
nueva como cualquier otra — por eso converge sin protocolo especial de undo.

### El historial en árbol

Deshacer y volver a editar ya no borra lo deshecho: se archiva como rama a la
que se puede volver. Ese árbol es **local**, no se replica, y una re-derivación
(`replay` → `replaceProject`) lo borra igual que borraba el undo lineal — pero
ahora avisando (`ProjectStore.historyEpoch`). Las ramas de origen `remote:*`
**no se archivan** a propósito: volver a ellas re-aplicaría comandos ajenos sin
pasar por el log y sacaría a este cliente del estado de la sala.

El porqué completo, con lo que se promete y lo que no: **`docs/HISTORY.md`**.

## Audio en colaboración

No hay streaming de audio: **cada cliente renderiza el proyecto con su propio
motor**. Nadie reproduce nada en la máquina de nadie — lo que oyes es tu motor
tocando el proyecto compartido. Todos oyen lo mismo *si* todos tienen lo mismo,
y eso incluye los bytes de los sonidos, no solo el proyecto.

### Los samples viajan por la sala (`packages/collab/src/assets.ts`)

El log de comandos replica **referencias** (`SampleRef`: id, ruta, hash), no
contenido. El kernel, en cambio, resuelve las voces por id contra los bytes que
le hayas subido: sin ellos `ctx.samples.get(id)` es null y esa voz sale muda.
Hasta v1.0 esto no se cerraba y el resultado era el "a veces se oye, a veces
no": un sonido de fábrica sonaba solo si el otro ya lo había pinchado en su
Browser (su kernel lo tenía cacheado bajo el mismo id), y una grabación o un
bounce (`recording:<archivo>`) no sonaba **nunca** en la otra máquina.

Cómo va ahora:

- Un `Y.Map` `assets` en el MISMO documento, indexado por **hash** (el sha1 que
  `SampleRef.hash` ya trae) y no por id: el hash es igual en las dos máquinas
  aunque el id no tenga por qué serlo, dos referencias al mismo archivo
  comparten un solo blob, y republicar lo que ya está se detecta sin red.
- Un observer en el peer recibe el blob **una sola vez por hash** y lo sube a su
  kernel bajo *su* id.
- La rehidratación se dispara además al **unirse** (`join`) y al **re-derivar**
  (`replay`), que son justo los dos momentos en los que el proyecto se sustituye
  entero y el kernel local se queda vacío (`onProjectReplaced`).
- El contenido de **fábrica no viaja**: `factory:<ruta>` se resuelve leyendo el
  pack local en ambas máquinas; subirlo sería duplicar el pack por la red.
- La reconciliación (`packages/ui/src/collab/sample-sync.ts`) es asíncrona y va
  de una en una: cargar cincuenta samples no congela la interfaz.

**Límites.** El documento Yjs vive en memoria en todos los clientes y el
servidor lo persiste entero, así que un stem de diez minutos dentro del doc
penaliza incluso a quien no lo usa:

| Tope | Valor | Qué pasa al pasarse |
| --- | --- | --- |
| Por sample | **16 MB** | No se sube; el panel lo dice con el nombre del sonido. |
| Por sala (acumulado) | **64 MB** | No se sube; el panel avisa de que la sala está llena. |

Rechazar no rompe la sesión: el proyecto converge igual y ese sonido concreto
suena en la máquina que lo tiene y no en la otra. El panel de colaboración
lleva un contador de **"N sonidos de la sala todavía no están disponibles
aquí"** para que el silencio nunca sea un misterio.

La compactación del log no toca los blobs (viven fuera del log, en su propio
mapa), así que sobreviven al recorte. Lo que **no** hay todavía es recogida de
basura: un sample que deja de usarse sigue ocupando su hueco del presupuesto
hasta cerrar la sala — borrarlo mientras otro cliente aún lo referencia es
justo la carrera que no interesa. Backlog.

### Congelar tu audio ("Silenciar lo que toca el otro")

Botón del panel. Como el otro no reproduce nada en tu máquina, "silenciarle" no
es mutear un canal: es **dejar de llevarle a tu kernel los cambios que van
entrando**. Sus comandos se siguen aplicando al modelo (la UI converge, el chat
sigue, la presencia también), pero tu motor se queda con el último snapshot
compilado. Al desactivarlo se resincroniza de golpe con todo lo acumulado.
Pulsar play con el motor congelado tampoco recompila: si pediste no oírlo, no
se cuela por ahí.

El streaming del master remoto sigue en backlog (v1+).

## Convergencia (test)

Test automatizado: N clientes simulados aplican secuencias aleatorias de
comandos con latencias artificiales → al sincronizar, los N estados serializan
byte a byte igual. Corre en CI.
