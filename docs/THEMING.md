# Sistema de temas — Orbit Studio

Minimalista con guiños a macOS. Tres temas de serie (oscuro, claro, acrílico),
semáforo Mac opcional y un customizador con perillas simples.

## Arquitectura del acrílico (regla del skill `acrylic-theming`)

Nuestra app es Electron y **nosotros controlamos la ventana**, así que vamos por
la **arquitectura A**: la ventana compone con alfa y el blur lo pone el
compositor del sistema (DWM), no un degradado que lo imita.

- `BrowserWindow` con `backgroundMaterial: 'acrylic'` (Win11) y fondo
  transparente; fallback `SetWindowCompositionAttribute` para Win10.
- Con el tema acrílico activo, el CSS **deja de pintar opaco**: la raíz y los
  contenedores grandes pasan a tintes con alfa. Las opacidades **no se
  acumulan**: solo tiñen las regiones que no se solapan (barra superior,
  sidebar); los contenedores anidados van `transparent`.
- `backdrop-filter` va **únicamente** en menús, modales, tooltips y ventanas
  internas flotantes — sobre la ventana transparente no hay píxeles que
  muestrear, pero dentro de la página sí (difumina la UI que hay debajo).
- En temas oscuro/claro la ventana vuelve a `backgroundMaterial: 'none'` y fondo
  opaco: apagar es un **teardown real**, no dejar el cristal a medias.
- Verificación obligatoria: captura con la ventana traída al frente y ciclo
  acrílico→oscuro→acrílico sin residuos.

### Windhawk: por qué las capturas se ven mejor que una instalación limpia

Lo de arriba es lo que hace Orbit por su cuenta y no depende de nada externo.
Pero conviene decirlo claro, porque si no la comparación con el README parece
un engaño: **las capturas acrílicas del README están tomadas con
[Windhawk](https://windhawk.net) y el mod
[Translucent Windows](https://windhawk.net/mods/translucent-windows) activo.**

El motivo es de Windows, no nuestro. DWM compone `backgroundMaterial` con una
mano bastante corta para la ventana de una aplicación cualquiera: el resultado
tira más a tinte plano que a cristal, y varía según el build y según si la
ventana tiene el foco. El mod de Windhawk fuerza la translucidez real sobre las
ventanas que le indiques, y es lo que da el vidrio de la captura.

Consecuencias prácticas para quien toque el tema:

- **No optimices los tokens del acrílico mirando solo tu máquina con el mod
  puesto.** Un tinte que se ve perfecto sobre cristal profundo puede quedar
  turbio sobre el acrílico nativo, que es lo que ve la mayoría. Comprobá los dos.
- El `applyWindowTheme()` de `apps/desktop/src/main/index.ts` no sabe nada de
  Windhawk ni tiene por qué: devuelve si el material quedó activo, y el mod (si
  está) actúa por debajo, a nivel de compositor.
- El teardown al salir del acrílico sigue siendo obligatorio igual, haya mod o
  no.

## Tokens (CSS variables)

Todo color/radio/blur de la UI sale de tokens en `:root`. Un tema = un set de
tokens; el customizador solo escribe tokens.

```css
--bg          /* fondo raíz (opaco en oscuro/claro, tinte alfa en acrílico) */
--surface     /* paneles y ventanas internas */
--surface-2   /* cabeceras, strips */
--text, --text-dim
--accent      /* color de marca, elegible por el usuario */
--glass-alpha /* perilla transparencia (solo acrílico) */
--glass-tint  /* perilla tinte: color que vela el vidrio */
--radius, --blur-popup
--radius-sm, --radius-lg, --radius-pill /* derivados del radio del usuario */
--shadow-ink  /* única tinta de sombra; las sombras nuevas componen con color-mix */
--ease-soft, --ease-out, --ease-spring, --motion-fast, --motion-base /* ritmo del acabado suave */
--control-h-sm/h/lg  /* escala de alturas de control: 22 / 26 / 30 */
--fill-hover, --fill-pressed, --fill-selected /* velos de estado, del color del texto o del acento */
--hairline   /* borde de 1px para separar sin dibujar cajas */
--focus-halo /* anillo de foco tipo macOS */
--on-accent  /* texto sobre relleno de acento (siempre blanco) */
--meter, --meter-hot, --meter-clip /* verde/ámbar/rojo de las BARRAS de nivel */
--danger, --warn /* estados semánticos de relleno/borde, iguales en los tres temas */
--meter-ink, --meter-hot-ink, --meter-clip-ink, --danger-ink, --warn-ink
              /* los mismos estados cuando son TEXTO: en oscuro valen el color
                 del medidor; en claro se oscurecen hasta pasar 4,5:1. Solo los
                 usa el acabado suave, igual que el resto de su capa. */
--piano-key-black, --piano-key-white /* teclas del piano roll y Prisma */
```

Radios: `--radius-sm` es `calc(var(--radius) * 0.75)` y `--radius-lg` **es**
`var(--radius)` por defecto. Solo el bloque `html[data-style='soft']` agranda
`--radius-lg` a `calc(var(--radius) * 1.75)`: por eso `Clásico` reproduce la
v3.14 sin un píxel de diferencia aunque el usuario haya cambiado su radio.

## Los tres temas

| | Oscuro (defecto) | Claro | Acrílico |
|---|---|---|---|
| Fondo | `#141518` opaco | `#f4f5f7` opaco | tinte oscuro con alfa (DWM detrás) |
| Superficies | grises fríos | blancos suaves | alfa bajo + borde 1px sutil |
| Popups | sombra | sombra | `backdrop-filter: blur` real |

## Acabado: suave, animaciones y vidrio

El carácter visual va por **atributos en `<html>`** (`theme/appearance.ts`), no
por variables: una custom property no puede condicionar un bloque entero de
reglas CSS. Los tres se aplican en caliente y se guardan como claves planas en
`settings.json` (`uiStyle`, `uiMotion`, `uiGlassMenus`).

| Atributo | Valores | Qué hace |
|---|---|---|
| `data-style` | `soft` (defecto) · `classic` | `soft` agranda `--radius-lg`, compone sombras más aireadas y añade transiciones de 150–200 ms en popups, menús y controles. `classic` no enciende **ninguna** regla: es el look de la v3.14 |
| `data-motion` | `on` (defecto) · `off` | `off` **elimina** transiciones y animaciones (`none`, no `0.01ms`), igual que `prefers-reduced-motion` en `base.css` |
| `data-glass-menus` | `on` · `off` (defecto) | En oscuro/claro da a los popups fondo al 82 % + `backdrop-filter: blur(var(--blur-popup))`. En acrílico no se aplica: ahí el vidrio ya lo pone el tema |

`soft` no toca la grilla de los editores ni el modelo: es presentación. Pero
desde la v3.16 **sí redefine la densidad y el idioma visual de los controles**,
en una sola capa: `packages/ui/src/theme/native.css`, importada última desde
`App.tsx`. Toda regla va prefijada con `html[data-style='soft']`, sin excepción:
`classic` no enciende ninguna y sigue siendo la v3.14 píxel a píxel.

### Lenguaje visual del acabado suave

`native.css` es el único sitio donde vive este idioma; los `.css` de cada editor
siguen siendo la base estructural. Las reglas que lo definen:

- **Controles sin caja hasta que hacen falta.** Los botones, selects y campos
  usan fondos `--fill-hover` / `--fill-pressed` y el borde desaparece; solo
  aparece (o se enciende el acento) al seleccionar, activar o enfocar.
- **Alturas unificadas** con `--control-h-sm` (22), `--control-h` (26) y
  `--control-h-lg` (30). Las barras de herramientas usan 26; las acciones
  principales, 30. Radios de 6–10px en controles, 10–12px en tarjetas y grupos,
  16px en modales y en la paleta de comandos.
- **Separadores de 1px** (`--hairline`) en lugar de marcos: la jerarquía la da
  el espacio, no una caja alrededor de cada bloque.
- **El acento es estado, no decoración.** Relleno de selección, pestaña activa,
  pad sonando, «el presente» del historial, acción principal. Nada más.
- **Las entradas son solo opacidad** (`orbit-snap-in`), nunca `transform`, para
  no pelear con el arrastre y el escalado de las ventanas internas.
- **Los estados vacíos se centran** (`.panel-placeholder` y equivalentes) en vez
  de quedar como una línea perdida en la esquina del lienzo.
- **Los `<select>` siguen siendo nativos**: se visten por fuera, no se sustituyen
  por un menú propio, así el teclado y el lector de pantalla no cambian.
- **Nada de colores literales en componentes**: la única excepción sigue siendo
  la paleta `--au-*`, `--pr-*` y `--pl-*` de los editores que pintan en canvas,
  y `plugins/view-replay.ts` (ver la regla 4 del `AGENTS.md`).
- **Acrílico**: las ventanas internas suben al 96 % de opacidad y las maximizadas
  son opacas; los popups usan `--popup-bg`; los nodos del grafo llevan borde
  `--hairline` para no desaparecer sobre la retícula del lienzo.
- **Teclas de piano**: `--piano-key-white` es claro en los tres temas (en oscuro
  y acrílico las superficies son casi transparentes) y `--piano-key-black`
  oscuro; piano roll y Prisma comparten el criterio.

Los temas custom guardados antes de la v3.15 no traen los campos de acabado;
`normalizeAppearance` los rellena (`soft`, animaciones `on`, vidrio `off`) al
leerlos y `buildThemeFile` los escribe normalizados al exportar.

## Controles de ventana

Frameless siempre; los botones los dibuja la UI:

- **Estilo Windows** (defecto): minimizar/maximizar/cerrar a la derecha, glifos
  finos, hover rojo en cerrar.
- **Semáforo macOS** (opción en Ajustes → Apariencia): círculos 12px a la
  izquierda — cerrar `#ff5f57`, minimizar `#febc2e`, maximizar `#28c840` — con
  glifos al hacer hover sobre el grupo, exactamente como macOS.
- La barra de título es región de arrastre (`-webkit-app-region: drag`); los
  botones y menús, `no-drag`.

## Customizador (Ajustes → Apariencia)

Intuitivo: nada de editar archivos.

1. **Tema**: tarjetas Oscuro / Claro / Acrílico con miniatura en vivo.
2. **Tres perillas** (regla del skill): Transparencia (`--glass-alpha`),
   Tinte (`--glass-tint` con picker), Acento (`--accent` con picker + paleta).
3. **Estilo de la interfaz**: tarjetas Suave (iOS) / Clásico, más los
   interruptores de Animaciones y Menús translúcidos (ver «Acabado» arriba).
4. **Semáforo Mac**: interruptor on/off (persiste).
5. **Lectura y tamaño**: escala 80–150 %, fuente y radio de esquinas.
6. **Temas custom**: "Guardar como…" con nombre; lista editable; exportar/
   importar `.orbittheme` (JSON de tokens).

Persistencia en `settings.json` del userData; el tema se aplica al instante
(sin reiniciar) — cambiar a/desde acrílico avisa al main para conmutar el
`backgroundMaterial` de la ventana en caliente.

## Iconografía

SVG propios, trazo fino 1.5px, esquinas redondeadas, rejilla 24px — sensación
macOS. Un solo archivo de sprites; `currentColor` para que hereden el tema.
