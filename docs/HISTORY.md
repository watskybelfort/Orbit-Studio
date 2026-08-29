# Historial en árbol

El undo de casi todos los DAW es una lista. Deshaces cinco pasos, tocas
cualquier otra cosa, y esos cinco **se borran**. Es el fallo que más rabia da
del oficio: pruebas una variación del drop, no te convence, vuelves atrás,
sigues por otro lado — y la variación, que estaba a dos clics, ya no existe.

Orbit guarda esa variación. No como algo tachado: como una **rama**.

```
raíz ──A──B──C──D          ← el tronco: lo que tienes sacado ahora
          └──X──Y          ← rama abandonada, colgada de B
              └──Z         ← rama colgada de X (una bifurcación de una bifurcación)
```

Todo esto vive en `packages/core`: la forma del árbol en
`src/history-tree.ts` (puro, sin estado) y el movimiento de las pilas en
`src/store.ts`. Los tests: `packages/core/test/history-tree.test.ts` y
`packages/collab/test/history-tree.test.ts`.

## Cómo funciona

El **tronco** son las dos pilas de siempre de `ProjectStore`: `undoStack` (lo
aplicado) y `redoStack` (lo rehacible). Eso no ha cambiado, y por eso Ctrl+Z,
Ctrl+Y, `historyView()` y `jumpTo()` se comportan exactamente igual que antes.

Lo que cambia está en una línea de `dispatch`. Antes decía:

```ts
this.redoStack = this.redoStack.filter((e) => e.origin !== origin); // adiós
```

Ahora eso mismo, en vez de tirarse, se archiva como `HistoryBranch` colgada de
`forkAt` — la entrada que era el presente justo antes del cambio nuevo. Divergir
deja de ser una operación destructiva.

**Volver a una rama** (`switchToBranch`) no es "restaurar una copia", es
**cambiar de camino**:

1. `jumpTo(ancla)` deja el proyecto en el punto de la bifurcación.
2. Lo que quede en el futuro de ese origen —el camino que estás dejando— se
   archiva a su vez como rama.
3. Las entradas de la rama entran en el `redoStack` y se rehacen una a una.

Es simétrico: ir y volver, las veces que haga falta, sin perder ninguno de los
dos caminos. Y como el paso 3 pasa por `redo()`, cada cambio sale por el bus
como cualquier otro — undo, colaboración y las ediciones de Claude por MCP ven
lo de siempre.

Las entradas conservan su `id` al ir y volver, así que el panel no las pierde
de vista. Los `inverse` de una rama se capturaron con el proyecto en el estado
del ancla, y el paso 1 nos devuelve justo ahí: por eso siguen valiendo. Es la
misma suposición que ya hacía el undo por origen.

### Ramas de ramas

El ancla de una rama puede ser una entrada que **hoy vive dentro de otra rama**.
Para llegar a `Z` en el dibujo de arriba hay que sacar antes `X`. Eso lo calcula
`branchChain`, que devuelve las ramas a restaurar en orden. Si la cadena se
rompe (el tope de 500 entradas se comió la entrada de la que colgaba todo), la
rama se marca inalcanzable y se poda: mejor eso que un botón que no hace nada.

### Topes

- 500 entradas de tronco (como siempre). Al caerse una entrada por arriba, las
  ramas ancladas a ella se van con ella.
- 200 ramas archivadas. Una rama son punteros a comandos que ya existían, no
  copias del proyecto, así que el tope es alto a propósito.

---

## Qué significa el árbol en una sala de colaboración

**Decisión: el árbol es LOCAL. No se replica, no se comparte, no se ve desde
fuera. En una sala sigue funcionando, pero solo para tus propios caminos, y una
re-derivación del proyecto lo borra entero — avisando.**

Esto no es un "ya lo haremos": es lo que la arquitectura puede sostener sin
mentir. Va el porqué.

### Por qué funciona en una sala

`packages/collab` **no replica un historial**: replica un log de comandos sobre
un `Y.Doc` (`src/command-log.ts`). Y aquí está la pieza clave — en Orbit, un
undo **no rebobina nada**: aplica el comando inverso y lo emite como un cambio
más, que `CommandLogBinding` anexa al log compartido. Ctrl+Z es, para la sala,
una edición nueva como cualquier otra.

De ahí sale gratis que cambiar de rama funcione en una sala: es una tanda de
comandos hacia delante (los inversos hasta la bifurcación, luego los de la
rama). Los demás no ven tu árbol; ven el resultado, que es lo único que un
documento compartido puede significar. Y convergen byte a byte, porque han
recibido los mismos comandos por el mismo log.

> Durante un tiempo `docs/ARCHITECTURE.md` y `docs/COLLAB.md` decían que esto
> era un `Y.UndoManager` con `trackedOrigins`. No lo es, y ya está corregido en
> los dos: el scoping por origen vive en `ProjectStore` (`undo(origin)` /
> `redo(origin)`), no en Yjs, y no hay ningún `UndoManager` en el repo. Queda
> anotado porque esa creencia equivocada llegó a cambiar un diseño: en Orbit un
> undo **emite** un comando nuevo en vez de rebobinar, y el árbol de ramas se
> construye sobre eso.

### Las ramas ajenas NO se archivan

Cuando Ana deshace algo, mi cliente recibe su inverso como un comando normal con
origen `remote:Ana`. Si esas entradas se archivaran como rama, yo tendría en mi
panel una "rama de Ana" — y volver a ella re-aplicaría **sus** comandos en **mi**
proyecto sin que llegaran al log, porque `CommandLogBinding` no anexa lo que
viene con origen `remote:*` (ya venía de ahí). Mi cliente se saldría del estado
de la sala en silencio, que es la peor forma de romper una colaboración.

Así que `isBranchableOrigin` devuelve `false` para `remote:*` y su redo se
descarta exactamente como antes. **Tu árbol solo contiene tus caminos** — y los
de Claude, que sí se replican porque su origen no es `remote:*`.

### Dónde se degrada, y qué se hace al respecto

`CommandLogBinding` llama a `store.replaceProject()` en dos momentos: al
**unirse** a la sala y al **re-derivar** el proyecto tras un merge cruzado (dos
ediciones concurrentes que el log ordena metiendo entradas por delante de otras
ya aplicadas). Eso tira el historial entero — las ramas incluidas.

No es una regresión: el undo lineal se perdía igual en ese punto, desde siempre.
Y las ramas no pueden sobrevivir aunque quisiéramos, porque el `inverse` de cada
entrada se calculó contra un proyecto que la re-derivación acaba de sustituir;
re-aplicarlo daría basura. Enseñarlas sin poder usarlas sería una tomadura de
pelo.

Lo que sí se hace es **contarlo**: `ProjectStore.historyEpoch` sube en cada
`replaceProject`. La UI compara el número que vio la última vez y, si cambió,
dice que el historial se reinició por un cambio simultáneo en la sala en vez de
enseñar una lista vacía sin explicación — que es lo que pasaba hasta ahora.

### Lo que NO se promete

- **No hay un árbol compartido.** Dos personas no ven ni pueden saltar a las
  ramas de la otra.
- **No hay "ramas de la sala".** Una rama es un camino que anduvo *tu* cliente;
  sacarla cambia el proyecto para todos, porque el proyecto es uno solo.
- **No es duradero.** El árbol vive en memoria: muere al cerrar, al recargar, al
  cargar un archivo `.orbit` y en una re-derivación. Para volver a algo que tiene
  que durar están las **versiones guardadas** (`packages/ui/src/state/versions.ts`),
  que son otra cosa y siguen ahí debajo del panel.

## En la interfaz

`packages/ui/src/history/` — `HistoryBranches` se cuelga del panel de historial,
debajo del tronco: cada rama dice de qué punto sale, cuántos cambios tiene, de
quién son y cuándo se abandonó; se despliega para ver sus pasos uno a uno; y
tiene dos botones, **Volver aquí** (`switchToBranch`) y **Olvidar**
(`dropBranch`). Las que cuelgan de otra rama van indentadas.

La lógica de presentación está en `packages/ui/src/history/branch-rows.ts`, sin
React, y se prueba en `packages/ui/test/history-branches.test.ts`.
