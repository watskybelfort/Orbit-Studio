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
```

## Los tres temas

| | Oscuro (defecto) | Claro | Acrílico |
|---|---|---|---|
| Fondo | `#141518` opaco | `#f4f5f7` opaco | tinte oscuro con alfa (DWM detrás) |
| Superficies | grises fríos | blancos suaves | alfa bajo + borde 1px sutil |
| Popups | sombra | sombra | `backdrop-filter: blur` real |

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
3. **Semáforo Mac**: interruptor on/off (persiste).
4. **Temas custom**: "Guardar como…" con nombre; lista editable; exportar/
   importar `.orbittheme` (JSON de tokens).

Persistencia en `settings.json` del userData; el tema se aplica al instante
(sin reiniciar) — cambiar a/desde acrílico avisa al main para conmutar el
`backgroundMaterial` de la ventana en caliente.

## Iconografía

SVG propios, trazo fino 1.5px, esquinas redondeadas, rejilla 24px — sensación
macOS. Un solo archivo de sprites; `currentColor` para que hereden el tema.
