# Claude dentro del estudio — Orbit Studio

Claude no es un chatbot pegado al lado: es **un colaborador dentro del proyecto**,
con las mismas capacidades que un humano en la sesión y visible en tiempo real.

## Cómo entra: MCP

La app expone un **servidor MCP** (Model Context Protocol) desde el main process
(`packages/claude-bridge`). El repo incluye `.mcp.json`, así que abrir Claude
Code en la carpeta del proyecto ya lo conecta.

```
Claude Code ──(MCP stdio)──> mcp-stdio (relay) ──(WS 7855)──> main ──(IPC)──> UI / bus de comandos (core)
```

Consecuencias de diseño (por qué es elegante):

- **Todo lo que hace Claude pasa por el mismo bus de comandos** que la UI y la
  colaboración → sus ediciones se ven al instante en pantalla, tienen undo, y
  quedan en el historial marcadas como suyas.
- En una sesión colaborativa, Claude publica **presencia**: aparece en la lista
  de conectados como "Claude", con color propio, y se ve qué editor está tocando.

## Herramientas MCP (36, v3.18)

| Tool | Qué hace |
|---|---|
| `get_project` | Estado completo o resumido del proyecto (tempo, patrones, canales, mixer) |
| `get_notes` / `set_notes` / `transform_notes` | Leer/escribir notas de un patrón+canal (piano roll) y transformarlas en un paso de undo: humanize, strum, arpegiar, chop, acordes, transponer, cuantizar o velocity |
| `add_channel` / `set_channel` / `delete_channel` | Crear canal con instrumento y preset, ajustar vol/pan/ruta, o borrarlo con sus notas |
| `set_keymap` | Multisample: repartir varias muestras por el teclado de un sampler (nota leída del nombre del archivo, o dada a mano) |
| `add_pattern` / `delete_pattern` | Crear un patrón o borrarlo junto con sus clips (nunca el último) |
| `set_steps` | Programar el step sequencer de un canal |
| `riff` | Generar un riff/melodía en la escala dentro de un patrón, determinista por semilla (la «riff machine» del piano roll, Alt+G) |
| `arrange_clip` / `sections` | Colocar/mover/cortar clips en la playlist; listar, añadir o quitar secciones del arreglo (intro, drop…) |
| `set_tempo` / `set_swing` | Transport |
| `set_mixer` | Fader/pan/mute/solo/routing/sends de pistas |
| `add_effect` / `set_effect` / `remove_effect` | Insertar efecto en un slot, ajustar sus parámetros o quitarlo |
| `set_automation` | Crear/editar clips de automatización |
| `render` / `analyze_mix` / `advise_mix` | Exportar el master a WAV; medir LUFS, peak, balance espectral y correlación; diagnosticar la mezcla y proponer (o aplicar) la cadena con valores reales |
| `list_library` / `load_sample` / `generate_pack` | Qué hay en el browser; meter sonidos en el rack como canales sampler; generar un pack nuevo por síntesis |
| `list_genres` / `compose_beat` / `recompose_part` | Compositor local: géneros y variantes disponibles; un beat entero con cada parte en su canal, patrón y pista; rehacer una sola parte del último beat |
| `list_style_profiles` / `learn_style` / `analyze_reference` / `compose_from_reference` | Perfiles de estilo medidos de audio: listarlos, entrenarlos, analizar una referencia y componer con su temática |
| `undo` / `redo` | Deshacer/rehacer el último cambio hecho por Claude, sin tocar los del usuario |

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
