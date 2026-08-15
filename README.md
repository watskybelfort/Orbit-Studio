# Onza Studio

**El DAW de Onza.** Un estudio de producción musical completo, hecho desde cero:
secuenciador, piano roll, playlist, mixer con cadenas de efectos, síntesis propia,
librería de sonidos clasificada, colaboración en tiempo real y Claude integrado
como un productor más dentro del proyecto.

> Inspirado en el flujo de FL Studio, pero nuestro: minimalista, con iconografía
> estilo Mac, tema oscuro / claro / **acrílico real** (blur del escritorio vía DWM),
> semáforo de macOS opcional y customizador de temas integrado.

## Los cinco pilares

1. **Motor de audio propio** — DSP sample-accurate en AudioWorklet: síntesis
   sustractiva, supersaw, FM, 808 con glide y saturación, sampler, drums
   sintetizados; EQ paramétrico, compresor, reverb, delay, distorsión, sidechain
   y mezclador con buses y sends. El ADN sonoro viene del engine con el que ya
   producimos el catálogo de El Doctor.
2. **Flujo FL Studio completo** — Channel Rack con step sequencer, Piano Roll
   con todas las herramientas, Playlist con clips de patrón/audio/automatización,
   Mixer con 10 slots de efectos por pista y routing libre.
3. **Librería perfecta** — todo el contenido de fábrica clasificado por
   categoría, género, tonalidad y BPM; búsqueda instantánea, preview al click,
   drag & drop.
4. **Colaboración en tiempo real** — el proyecto es un documento CRDT: varias
   personas conectadas a la misma sesión editando partes distintas de la pista a
   la vez, con presencia (quién está tocando qué) y undo por usuario.
5. **Claude dentro del estudio** — la app expone un servidor MCP: Claude se
   conecta como un colaborador más, lee el proyecto, escribe notas, ajusta la
   mezcla, añade efectos y renderiza — y todo lo que hace se ve en tiempo real
   en la interfaz.

## Documentación

| Documento | Qué contiene |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Plan de trabajo detallado por fases |
| [docs/FEATURES.md](docs/FEATURES.md) | Catálogo completo de funciones (guía de todo lo que tiene) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitectura técnica del monorepo |
| [docs/THEMING.md](docs/THEMING.md) | Sistema de temas: oscuro, claro, acrílico, semáforo Mac |
| [docs/COLLAB.md](docs/COLLAB.md) | Colaboración en tiempo real |
| [docs/CLAUDE-INTEGRATION.md](docs/CLAUDE-INTEGRATION.md) | Claude como colaborador (MCP) |

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # UI en Vite + Electron
npm run server     # servidor de colaboración
```

## Estructura

```
onza-studio/
├─ apps/
│  ├─ desktop/        Shell Electron (ventana, acrílico, IPC, empaquetado)
│  └─ server/         Servidor de colaboración (rooms, presencia)
├─ packages/
│  ├─ core/           Modelo de proyecto, comandos, undo, formato .onza
│  ├─ engine/         Motor de audio DSP (AudioWorklet)
│  ├─ ui/             Interfaz React (playlist, piano roll, mixer, browser…)
│  ├─ collab/         Bindings Yjs + presencia
│  ├─ claude-bridge/  Servidor MCP para Claude
│  └─ sound-library/  Contenido de fábrica + manifest clasificado
└─ docs/              Toda la documentación
```
