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
- Persistencia: snapshot del doc + updates incrementales en disco; si el host
  se cae, la sesión sobrevive.
- Auth simple v0.1: token de room (el código) + nombre de usuario.
- **Roles (v1.0)**: productor (todo), invitado (edita pero no borra pistas ni
  toca el master, ni dentro de un batch) y oyente (solo mira y escucha). El
  control está en el log de comandos, que es por donde pasa TODO, con una
  función pura y el rol sellado en la entrada: emisor y receptores dan el mismo
  veredicto, así que la convergencia no se rompe. El rol es autodeclarado al
  entrar (mismo modelo de confianza que el código de sala); que sea inviolable
  exige que el servidor valide las entradas del log — backlog.
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
- **Claude aparece aquí como un usuario más** (nombre "Claude", su color) cuando
  el bridge MCP está activo.

## Undo por usuario

`Y.UndoManager` con `trackedOrigins = {miUserId}`: tu Ctrl+Z deshace **tus**
cambios, no los del colaborador. El historial visible marca de quién fue cada
paso.

## Audio en colaboración

Cada cliente renderiza el proyecto localmente con su propio motor (los samples
de fábrica son idénticos por hash; los samples propios se suben al room y se
cachean por hash). No hay streaming de audio en v0.1 — todos oyen lo mismo
porque todos tienen el mismo proyecto. El streaming del master remoto queda en
backlog (v1+).

## Convergencia (test)

Test automatizado: N clientes simulados aplican secuencias aleatorias de
comandos con latencias artificiales → al sincronizar, los N estados serializan
byte a byte igual. Corre en CI.
