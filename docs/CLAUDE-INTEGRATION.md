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
| `arrange_clip` | Colocar/mover/cortar clips en la playlist |
| `set_mixer` | Fader/pan/mute/solo/routing/sends de pistas |
| `add_effect` / `set_effect` | Insertar efecto en un slot y ajustar sus parámetros |
| `set_automation` | Crear/editar clips de automatización |
| `set_tempo` / `set_swing` | Transport |
| `render` | Exportar WAV (master o stems) y devolver la ruta |
| `analyze_mix` | Medidas reales del render: LUFS, peak, balance espectral por bandas, correlación estéreo |
| `list_library` / `load_sample` | Buscar en la librería clasificada y cargar samples |

Diseño de las tools: parámetros musicales (notas como `"F2"`, tiempos en beats,
ganancias en dB), respuestas compactas, y **batch** (`edit_many`) para que una
pasada de mezcla entera sea una sola transacción/un solo undo.

## Panel de Claude (en la app)

Panel acoplable a la derecha:

- **Feed de actividad**: cada tool call como tarjeta legible — "🎚️ Subió la voz
  +2 dB en el drop (Mixer 3)" — con timestamp y botón *deshacer esto*.
- **Petición rápida** (v0.x): campo de texto que lanza Claude Code headless con
  el contexto del proyecto ("hazme un contratiempo de conga en el patrón 2").
- Indicador de conexión del bridge (puerto, estado, último ping).

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

- El MCP server escucha **solo en localhost** y exige un token que la app
  muestra/rota en Ajustes.
- Tools destructivas (borrar patrón, sobrescribir proyecto) piden confirmación
  en la UI salvo modo "manos libres" activado explícitamente.
