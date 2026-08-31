# Contribuir a Orbit Studio

Gracias por mirar. Antes de escribir código, dos cosas que ahorran viajes.

## Lo primero: abrí un issue

Orbit tiene decisiones de arquitectura tomadas a conciencia y escritas
([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`CLAUDE.md`](CLAUDE.md)). Un
PR grande que choca con una de ellas es trabajo tirado para los dos. Para
cualquier cosa que no sea un arreglo obvio, contá primero qué querés hacer.

## Arrancar

```bash
npm install     # instala todo el workspace (npm workspaces, Node 22+)
npm run dev     # Vite + Electron con recarga
npm run test    # unit + golden DSP
```

Windows x64 es la única plataforma empaquetada hoy. El código no tiene nada
atado a Windows salvo el acrílico DWM y el instalador.

## Las reglas duras

Están completas en [`CLAUDE.md`](CLAUDE.md) y las hace cumplir el linter, no la
buena voluntad. En corto:

1. **Toda mutación del proyecto pasa por el bus de comandos de `packages/core`.**
   Mutar el store o Yjs directo rompe el undo y el merge de colaboración.
2. **Cero alocaciones en el audio thread.** En `packages/engine/worklet` no se
   crea ningún objeto ni array dentro de `process()`.
3. **Ningún color hardcodeado en componentes**: todo por tokens CSS. La
   excepción de los `<canvas>` está explicada donde vive.
4. **Las dependencias entre paquetes van en un solo sentido** (es un DAG por
   capas). Lo verifica `orbit/package-boundaries`.
5. **Los golden tests fijan el sonido.** Si tu cambio mueve el audio, hay que
   actualizar la línea base *a propósito*: `npm run golden:update` enseña el
   diff y no escribe; escribir pide `--accept "<motivo>"`. Nunca un
   `--update-snapshots` a ciegas. El porqué, en [`docs/GOLDEN.md`](docs/GOLDEN.md).

## Antes de abrir el PR

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Los cuatro tienen que pasar; es exactamente lo que corre la CI.

## Commits

En español, con ámbito: `feat(engine): …`, `fix(ui): …`, `docs: …`. Muchos
commits pequeños y coherentes antes que uno gigante — que cada uno deje el
árbol compilando por su cuenta.

## Tests de UI

Sin jsdom y sin `@testing-library/react`: la lógica se extrae a un módulo
hermano sin React y se prueba eso (`selection.ts`, `filters.ts`,
`plugin-parse.ts` son los ejemplos). Cuando la regla vive dentro del `.tsx`, se
lee el archivo con `fs.readFileSync` y se comprueba la propiedad sobre el texto,
o se ejercitan los estados internos con `vi.stubGlobal`. El motivo está en
`CLAUDE.md`: una dependencia de DOM envejece peor que la aritmética aislada.

## Licencia

Al contribuir aceptás que tu aportación se distribuya bajo la
[Apache License 2.0](LICENSE), igual que el resto del proyecto.
