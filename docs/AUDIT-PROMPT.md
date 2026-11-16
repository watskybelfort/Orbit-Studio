# Prompt de auditoría — tercera pasada

Este documento **es** el prompt. No se lee de corrido: se copia por bloques.

- **Bloque A** → terminal maestra, la que orquesta.
- **Bloque B** → una por cada lane de auditoría (6 a la vez).
- **Bloque C** → los arreglos y la integración.

La estructura sale de la pasada del 15-11-2026, que salió barata justamente por
esto: siete lanes leyeron en paralelo sin escribir una línea, y el trabajo caro
—verificar y commitear— quedó en una sola terminal. Lo que sigue es esa misma
forma, con el hueco que dejó abierto: `main` no está protegida y nada impide que
un commit rojo aterrice.

Antes de arrancar: `docs/REVISION-2026-11-15.md` y
`docs/REVISION-2026-11-15-B.md` son las dos pasadas anteriores. La B deja 18
abiertos con su porqué y 18 símbolos de código muerto confirmados. Ese es el
punto de partida, no el trabajo.

---

## A · Terminal maestra (orquesta la auditoría)

```
Auditoría completa de Orbit Studio, repartida entre terminales.

CONTEXTO
- Repo: orbit-studio (cwd). Leé AGENTS.md y docs/ARCHITECTURE.md antes de nada.
- docs/REVISION-2026-11-15.md y docs/REVISION-2026-11-15-B.md son las dos
  pasadas anteriores: son el punto de partida, no el trabajo. La B deja 18
  abiertos con su porqué y 18 símbolos de código muerto confirmados.

OBJETIVO
- Segunda vuelta completa: bugs, código muerto y errores visuales/posicionamiento.
- Las mejoras pequeñas se implementan; las grandes se documentan con propuesta.
- Al final, commits granulares en español, agrupados por área.

FASE 0 — LÍNEA BASE (antes de tocar nada, en esta terminal)
- Anotá HEAD, `npm run typecheck`, `npm run lint`, `npx vitest run` (archivos y
  tests), `npm run build`. Guardá los números: sin línea base la auditoría no
  se puede defender después.
- Anotá también el hardware: núcleos físicos/lógicos y RAM.

FASE 1 — AUDITORÍA (6 simultáneas, 7 lanes)
- Abrí 6 terminales con el brief del bloque B, una por lane (la 7ª entra cuando
  alguna termine). Solo lectura: no editan código, no commitean, no crean ramas.
- Cada lane escribe UN archivo, el suyo: docs/AUDIT/<fecha>/<NN>-<lane>.md.
  Nada más. Ese archivo es su entregable.
- Al cerrar, leé los 7 archivos y deduplicá: los mismos hallazgos vistos por dos
  lanes se fusionan en uno, con la lane que mejor lo probó.

FASE 2 — ARREGLOS (3 + 1 integrador)
- Con la lista deduplicada, partí por propiedad de archivos (tabla del bloque C).
  Ningún archivo tiene dos dueños. packages/core/src/model/ tiene dueño único.
- El golden tiene UN dueño: nadie más toca sonido.
- Lo grande NO se implementa: se documenta con la propuesta y el porqué.

FASE 3 — INTEGRACIÓN (1 terminal)
- Merge en orden, typecheck → lint → suite completa → build → golden 33/33.
- Commits granulares en español, push, y `npm run ci:status` después de CADA push.
- Antes del primer push, instalá el pre-push hook del bloque C.

REGLAS DURAS
- Si no lo corriste, no lo afirmes. Medí, no estimes.
- No corras `npm run test` completo en varias terminales a la vez: falsea los
  tiempos y produce timeouts falsos (medido: dinamica 964 ms aislado → 5254 ms
  bajo carga). Los arreglos corren tests acotados por archivo; la suite entera
  se corre UNA vez, en la integración.
- No toques las líneas base del golden ni `npm run golden:update` sin --accept.
- Nada de jsdom ni @testing-library: lógica pura a un módulo hermano, o se
  afirma sobre la fuente con read-source.ts.
- Código muerto confirmado: no se borra a la callada; si toca API, va en su
  propio commit y se dice.
- El presupuesto de contexto es real: cada lane lee lo suyo, no el repo entero.

ENTREGABLE
- docs/REVISION-<fecha>-C.md con: línea base medida, tabla por lane, qué se
  cerró, qué sigue abierto y por qué, y cómo se verificó cada cosa.
- Cabecera de estado en docs/PLAN.md.
```

---

## B · Brief de cada lane (auditoría, solo lectura)

```
Auditoría de SOLO LECTURA de Orbit Studio. Lane: <N> — <NOMBRE>.

Tu alcance son estos archivos y nada más: <RUTAS>.
Leé AGENTS.md y docs/ARCHITECTURE.md antes de opinar.

QUÉ BUSCAR
- Bugs reales: estados imposibles, carreras, off-by-one, validación que falta,
  algo que se rompe al cargar/guardar, un comando que deja el proyecto inválido.
- Código muerto: exportaciones, símbolos y campos que nadie lee. Confirmá con
  búsqueda en todo el repo antes de declararlo muerto.
- Errores visuales y de posicionamiento: solapes, recortes, scroll que no acota,
  hit-test que no coincide con lo dibujado, foco, teclado, accesibilidad.
- Mejoras: separá las pequeñas (se implementan) de las grandes (se documentan).

FORMATO DE CADA HALLAZGO
`archivo:línea` · qué pasa · cómo se reproduce · severidad (crítico/alto/medio/
bajo) · qué test lo fija o falta · propuesta concreta.
Sin "se podría mejorar" sin evidencia: si no lo podés señalar en una línea, no
es un hallazgo.

ADEMÁS, DOS SECCIONES OBLIGATORIAS
- «No es un bug»: lo que parecía roto y no lo es, para que la siguiente pasada
  no lo vuelva a abrir.
- «No pude comprobar»: hardware, oído, pointercancel real del sistema, etc.

ENTREGABLE: escribí SOLO docs/AUDIT/<fecha>/<NN>-<lane>.md con todo lo anterior,
las 5 primeras por severidad y una tabla. No toques código, no commitees, no
crees ramas. No corras la suite completa: acotá a tus archivos.
```

### Las 7 lanes y sus rutas

| # | Lane | Rutas |
|---|---|---|
| 1 | core | `packages/core/**` |
| 2 | engine | `packages/engine/**` (kernel, worklet, render) |
| 3 | editores | `packages/ui/src/editors/**`, `packages/ui/src/plugins/**` |
| 4 | shell/estado | `packages/ui/src/shell/**`, `state/**`, `theme/**` |
| 5 | collab/servidor/escritorio | `packages/collab/**`, `apps/server/**`, `apps/desktop/**` |
| 6 | puente/librería | `packages/codex-bridge/**`, `packages/sound-library/**` |
| 7 | grabación de voz | `state/{recorder*,recording-*,capture-peak,input-latency,take-stack,vocal}`, `shell/Transport.tsx`, `export/ExportPanel.tsx`, `apps/desktop/src/main/recording-journal.ts` |

La 7ª se abre cuando alguna de las 6 primeras termine: 6 simultáneas es el
techo útil con 20 hilos lógicos. Por encima, el reloj no mejora y el triaje de
hallazgos duplicados sí crece.

---

## C · Brief de arreglos e integración

```
Arreglos de Orbit Studio. Trabajás en TU worktree: <RUTA>.
Lane de arreglo: <N>. Archivos que son TUYOS: <LISTA>. No tocás nada fuera.
packages/core/src/model/ y el golden tienen dueño único (el integrador).

QUÉ HACER
- Leé los hallazgos asignados en docs/AUDIT/<fecha>/ y arreglá los pequeños.
- Cada arreglo con lógica pura entra con su test. Las reglas de UI viven en
  módulos puros; si la lógica es inseparable del JSX, se afirma sobre la fuente
  con read-source.ts. Servidor y escritorio: peers WebSocket y FS real en %TEMP%.
- Commits granulares en español, uno por hallazgo o por grupo coherente.
- Lo grande no se implementa: se documenta con propuesta y porqué.

VERIFICACIÓN (antes de decir que está)
- `npm run typecheck && npm run lint` y los tests acotados a tus archivos.
- NUNCA la suite completa: eso lo hace el integrador, una sola vez.
- No toques el golden. Si creés que hay que moverlo, lo dice el integrador con
  `npm run golden:update` y `--accept "<motivo>"`.

INTEGRADOR (terminal aparte)
- Instalá el pre-push antes del primer push:
  .git/hooks/pre-push → npm run typecheck && npm run lint (rechaza el push si
  está rojo). Así un commit rojo no aterriza en main.
- Merge en orden de dependencias: core → engine → sound-library → bridge →
  collab/servidor → ui → desktop.
- Gate: `npm run typecheck` → `npm run lint` → `npx vitest run` → `npm run build`
  → golden 33/33 bit a bit → commits → push → `npm run ci:status`.
- PR solo para lo que toca golden o para una pieza grande de varios días.
  Todo lo demás va directo a main, como manda AGENTS.md.
```

---

## Por qué está partido así

- **La fase 1 no escribe código a propósito.** Es lo que hizo barata la pasada
  anterior: siete lanes leyeron en paralelo sin pisarse. El riesgo aparece
  cuando auditar y arreglar se mezclan en la misma terminal.
- **La línea base de la fase 0 es lo que hace defendible la auditoría.** Sin
  ella, «se arregló» y «no rompí nada» son opiniones.
- **Tres terminales para arreglar, no seis.** El cuello no es la CPU: es que los
  conflictos son de diseño (`core` es la raíz del DAG) y que la verificación es
  serial. Cuatro arreglando en paralelo ganan menos de 2× y arriesgan commits
  que se pisan.
- **El pre-push es lo único nuevo respecto del flujo actual.** No cambia
  trunk-based, no añade PRs, y tapa el hueco que ya costó una release: la
  v3.8.0 se taggeó con la CI roja desde seis pushes antes.
