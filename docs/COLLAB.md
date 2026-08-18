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

`Y.UndoManager` con `trackedOrigins = {miUserId}`: tu Ctrl+Z deshace **tus**
cambios, no los del colaborador. El historial visible marca de quién fue cada
paso.

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
