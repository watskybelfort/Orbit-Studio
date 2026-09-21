# Claude dentro del estudio — Orbit Studio

Claude no es un chatbot pegado al lado: es **un colaborador dentro del proyecto**,
con las mismas capacidades que un humano en la sesión y visible en tiempo real.

## Cómo entra: MCP

La app expone un **servidor MCP** (Model Context Protocol) desde el main process
(`packages/claude-bridge`). El repo incluye `.mcp.json`, así que abrir Claude
Code en la carpeta del proyecto ya lo conecta.

```
Claude Code ── MCP (WebSocket) ──> claude-bridge ──> bus de comandos (core) ──> UI + Yjs
```

Consecuencias de diseño (por qué es elegante):

- **Todo lo que hace Claude pasa por el mismo bus de comandos** que la UI y la
  colaboración → sus ediciones se ven al instante en pantalla, tienen undo, y
  quedan en el historial marcadas como suyas.
- En una sesión colaborativa, Claude publica **presencia**: aparece en la lista
  de conectados como "Claude", con color propio, y se ve qué editor está tocando.

## Herramientas MCP (v0.1)

| Tool | Qué hace |
|---|---|
| `get_project` | Estado completo o resumido del proyecto (tempo, patrones, canales, mixer) |
| `get_notes` / `set_notes` | Leer/escribir notas de un patrón+canal (piano roll) |
| `add_channel` / `set_channel` | Crear canal con instrumento y preset; ajustar vol/pan/ruta |
| `set_steps` | Programar el step sequencer de un canal |
| `set_keymap` | Multisample: repartir varias muestras por el teclado de un sampler (nota leída del nombre del archivo, o dada a mano) |

| `arrange_clip` | Colocar/mover/cortar clips en la playlist |
| `set_mixer` | Fader/pan/mute/solo/routing/sends de pistas |
| `add_effect` / `set_effect` | Insertar efecto en un slot y ajustar sus parámetros |
| `set_automation` | Crear/editar clips de automatización |
| `set_tempo` / `set_swing` | Transport |
| `render` | Exportar WAV (master o stems) y devolver la ruta |
| `analyze_mix` | Medidas reales del render: LUFS, peak, balance espectral por bandas, correlación estéreo |
| `advise_mix` | Diagnóstico accionable de la mezcla (tilts entre bandas, fase, loudness contra -14 LUFS) y cadena propuesta con valores reales; con `apply` la monta en un solo undo |
| `list_library` | Qué hay en el browser: pack de fábrica + packs generados, con BPM y nota de cada loop |
| `load_sample` | Mete sonidos de la librería en el rack como canales sampler, igual que arrastrarlos |

`load_sample` resuelve por NOMBRE, no solo por id: los ids del manifest
(`pack:drums/warehouse/kick-hard-groove-01`) no se teclean de memoria y el nombre
visible sí. Un nombre ambiguo se rechaza diciendo con cuáles cuadraba, porque
elegir uno a ciegas es lo que acaba con un bombo que no era ese en el compás 33.

Diseño de las tools: parámetros musicales (notas como `"F2"`, tiempos en beats,
ganancias en dB) y respuestas compactas. No existe una tool `edit_many`: cada
tool que toca varias cosas a la vez las manda por dentro en un solo comando
`batch` del bus, así que **una llamada = un paso de undo** (p. ej. `advise_mix`
con `apply`, `set_notes` con `replace` o `set_channel` con parámetros).

## Panel de Claude (en la app)

Panel acoplable a la derecha:

- **Feed de actividad**: cada tool call como tarjeta con el nombre de la tool,
  su resultado en una línea y el timestamp, más el estado (en curso / ✓ / ✕).
  No hay botón de deshacer por tarjeta: deshacer es por origen — la tool `undo`
  del bridge (o el panel de historial) revierte lo último de Claude sin tocar
  lo del usuario.
- **Petición rápida**: campo de texto cuya petición viaja adjunta a la SIGUIENTE
  `get_project` que haga Claude ("hazme un contratiempo de conga en el patrón
  2"). No lanza Claude Code sola: MCP no permite empujarle mensajes.
- Indicador de conexión del bridge: conectado, esperando o no disponible
  (fuera de Electron).

## Flujos reales que habilita

1. **"Mézclame esto"**: Claude llama `analyze_mix`, decide EQ/compresión por
   pista con criterios del skill music-producer (low-end mono, voz por encima
   del beat), aplica con `add_effect`/`set_mixer`, re-renderiza y compara LUFS.
2. **Trabajo en vivo a cuatro manos**: tú en el piano roll, Claude programando
   la percusión del mismo patrón — lo ves aparecer nota a nota por presencia.
3. **Correcciones quirúrgicas**: "la conga del compás 33 está tarde" → Claude
   lee las notas, la pega a la rejilla (regla de feedback: todo pegado a la
   rejilla) y responde con qué movió exactamente.
4. **Packs a demanda** (v0.x): "hazme 10 kicks de reggaetón" → genera por
   síntesis, clasifica y los deja en la librería con tags.

## Seguridad

- El MCP server escucha **solo en localhost** y exige un token distinto por
  sesión: la app lo genera al arrancar y lo deja en `~/.orbit/bridge.json`
  (legible solo por el usuario), de donde lo lee el relay para presentarlo. Las
  conexiones con cabecera `Origin` (clientes navegador) se rechazan de entrada.
- No hay confirmación por tool ni modo "manos libres" todavía: lo que hay es el
  historial por origen. Todo lo de Claude entra como `origin: 'claude'` y se
  revierte con su tool `undo` (o desde el panel de historial) sin tocar los
  cambios del usuario. Cuando exista la confirmación de tools destructivas, se
  documentará aquí.
