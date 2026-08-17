/**
 * Escala global de la interfaz (80–150 %) — el "zoom" de Orbit Studio.
 *
 * ## Por qué `zoom` y no `rem`
 * Escalar con el tamaño de fuente raíz obligaría a reescribir en `rem` cada px
 * de cada panel (mixer, rack, playlist…): cientos de reglas y un diff enorme.
 * `zoom` en `<html>` escala TODO —layout, texto, bordes, sombras, radios— sin
 * tocar una sola regla CSS del resto de la app.
 *
 * ## El pero de `zoom` (y por qué hay shim)
 * Con `zoom` en la raíz, Chromium deja el DOM hablando **dos idiomas**:
 *
 * | API                                    | unidades con `zoom: 1.25`   |
 * |----------------------------------------|-----------------------------|
 * | `clientWidth`/`offsetWidth`, px del CSS | de **layout** (sin escalar) |
 * | `getBoundingClientRect()`               | **visuales** (× 1.25)       |
 * | `MouseEvent.clientX/clientY`            | **visuales** (× 1.25)       |
 * | `window.innerWidth/innerHeight`         | **visuales** (× 1.25)       |
 * | `devicePixelRatio`                      | sin enterarse               |
 *
 * Y el repo mezcla los dos idiomas a propósito: los editores de canvas se
 * dimensionan con `wrap.clientWidth` (layout) y hacen hit-test con
 * `e.clientX - rect.left` (visual). A escala ≠ 100 % los clics caerían
 * desplazados por el factor de escala y el canvas saldría borroso (su backing
 * store quedaría a la resolución vieja mientras el elemento se pinta mayor).
 *
 * El shim de aquí abajo pone a todo el DOM a hablar **un solo idioma, el de
 * layout**: divide por la escala lo que llega en píxeles visuales y multiplica
 * `devicePixelRatio` por ella. Así `canvas.width = clientWidth * dpr` vuelve a
 * caer clavado en píxeles de dispositivo (dibujo nítido a cualquier escala) y
 * `e.clientX - rect.left` vuelve a dar la misma coordenada que a 100 %.
 *
 * Verificado en Electron 43 / Chromium 150 con clics sintéticos
 * (`webContents.sendInputEvent`): a 80 %, 100 %, 125 % y 150 % el hit-test
 * devuelve exactamente las mismas coordenadas y la relación
 * `backing / (tamaño visual × dpr nativo)` se mantiene en 1.
 *
 * ## Coste
 * El shim **solo se instala la primera vez que se pide una escala ≠ 100 %**:
 * quien no toque el ajuste corre con el DOM virgen. Una vez instalado, a 100 %
 * los getters dividen por 1 (identidad exacta en IEEE-754), así que volver a
 * 100 % no deja residuo ni deriva.
 *
 * ## Cuando esto sobre
 * Si el puente de Electron llega a exponer `webFrame.setZoomFactor`, este
 * archivo se queda en una línea: el zoom nativo ya cambia `devicePixelRatio` y
 * deja las coordenadas CSS quietas, que es justo lo que el shim emula a mano.
 */

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_DEFAULT = 1;

/** Escala aplicada ahora mismo; el shim divide/multiplica por ella. */
let currentScale = UI_SCALE_DEFAULT;
let openWrapped = false;
/** Ventanas ya parcheadas (la principal y las desacopladas). */
const shimmed = new WeakSet<Window>();
/** Ventanas desacopladas vivas (editores sacados con window.open). */
const childWindows = new Set<Window>();

/** Deja la escala dentro de rango (y descarta basura persistida). */
export function clampUiScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n));
}

/** Escala vigente (1 = 100 %). */
export function getUiScale(): number {
  return currentScale;
}

/**
 * Ventanas que llevan los tokens del tema: la principal y los editores
 * desacoplados (`window.open`, ver shell/DetachedWindow). Las que ya se
 * cerraron se olvidan por el camino.
 */
export function themedWindows(): Window[] {
  if (typeof window === 'undefined') return [];
  const out: Window[] = [window];
  for (const w of [...childWindows]) {
    if (w.closed) childWindows.delete(w);
    else out.push(w);
  }
  return out;
}

/**
 * Aplica la escala EN CALIENTE. Mutar el `style` de `<html>` dispara el
 * MutationObserver de `useThemeVersion`, así que los canvas se redibujan solos
 * con el nuevo `devicePixelRatio`.
 */
export function applyUiScale(scale: number): void {
  if (typeof document === 'undefined') return;
  const next = clampUiScale(scale);
  if (next !== UI_SCALE_DEFAULT) installScaleShim();

  // Primero la variable del shim y luego el DOM: cualquier lectura de
  // geometría que ocurra a partir de aquí ya se traduce con el factor bueno.
  currentScale = next;

  for (const w of themedWindows()) {
    const root = w.document.documentElement;
    root.style.setProperty('--ui-scale', String(next));
    if (next === UI_SCALE_DEFAULT) root.style.removeProperty('zoom');
    else root.style.setProperty('zoom', String(next));
  }
}

// ── Shim de geometría ────────────────────────────────────────────────────────

/**
 * Busca el descriptor de una propiedad subiendo por la cadena de prototipos.
 * `devicePixelRatio` e `innerWidth` no cuelgan del prototipo inmediato de
 * `window` (ahí está el objeto de propiedades nombradas), sino de
 * `Window.prototype`, un eslabón más arriba.
 */
function findDescriptor(start: object, prop: string): PropertyDescriptor | null {
  for (let o: object | null = start; o !== null; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, prop);
    if (d) return d;
  }
  return null;
}

/** Redefine `prop` en `target` traduciendo el getter nativo visual → layout. */
function patchToLayoutUnits(target: object, prop: string): void {
  const desc = findDescriptor(target, prop);
  const native = desc?.get;
  if (!native) return;
  Object.defineProperty(target, prop, {
    configurable: true,
    enumerable: desc?.enumerable ?? true,
    get(this: object): number {
      return Number(native.call(this)) / currentScale;
    },
  });
}

/**
 * Parchea las APIs de geometría de UNA ventana. Cada ventana tiene sus propios
 * globals (`MouseEvent`, `Element`, `DOMRect`…), de ahí el tipo con
 * `typeof globalThis`: son los constructores de ESA ventana, no los nuestros.
 */
function installShimIn(win: Window & typeof globalThis): void {
  if (shimmed.has(win)) return;
  shimmed.add(win);

  // 1. devicePixelRatio × escala: los canvas del repo dimensionan su backing
  //    store con `clientWidth * dpr`, y con la escala aplicada un px de layout
  //    ocupa `escala` px visuales. Multiplicar aquí es lo que los mantiene
  //    nítidos sin tocar ni un editor.
  const dpr = findDescriptor(win, 'devicePixelRatio');
  const nativeDpr = dpr?.get;
  if (nativeDpr) {
    Object.defineProperty(win, 'devicePixelRatio', {
      configurable: true,
      enumerable: dpr?.enumerable ?? true,
      get(): number {
        return Number(nativeDpr.call(win)) * currentScale;
      },
    });
  }

  // 2. Viewport en px de layout (lo usan los menús para no salirse de pantalla,
  //    comparándolo con clientX — que también traducimos).
  patchToLayoutUnits(win, 'innerWidth');
  patchToLayoutUnits(win, 'innerHeight');

  // 3. Coordenadas de puntero. `PointerEvent`, `WheelEvent` y `DragEvent`
  //    heredan de `MouseEvent`, así que con parchear el prototipo base llegan
  //    todas. `screenX/screenY` NO se tocan: son de pantalla, no de página.
  const mouse = win.MouseEvent.prototype;
  for (const prop of [
    'clientX',
    'clientY',
    'pageX',
    'pageY',
    'offsetX',
    'offsetY',
    'x',
    'y',
    'movementX',
    'movementY',
  ]) {
    patchToLayoutUnits(mouse, prop);
  }

  // 4. Rects. Se devuelve un DOMRect nuevo (los nativos son de solo lectura).
  const nativeRect = win.Element.prototype.getBoundingClientRect;
  const Rect = win.DOMRect;
  win.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const r = nativeRect.call(this);
    if (currentScale === UI_SCALE_DEFAULT) return r;
    const k = currentScale;
    return new Rect(r.x / k, r.y / k, r.width / k, r.height / k);
  };
}

/**
 * Adopta una ventana desacoplada: mismo shim y misma escala. DetachedWindow
 * clona el atributo `style` de <html> al abrirla, así que el `zoom` ya viaja
 * solo; lo que NO viaja son los globals (cada ventana tiene su
 * `MouseEvent.prototype` y su `devicePixelRatio`), y sin parchearlos los
 * editores sacados fuera tendrían el hit-test desplazado.
 */
function adoptChildWindow(child: Window): void {
  if (childWindows.has(child)) return;
  childWindows.add(child);
  try {
    // `window.open` devuelve `Window`, pero la ventana hija es un global
    // completo con sus propios constructores.
    installShimIn(child as Window & typeof globalThis);
    const root = child.document.documentElement;
    root.style.setProperty('--ui-scale', String(currentScale));
    if (currentScale !== UI_SCALE_DEFAULT) root.style.setProperty('zoom', String(currentScale));
  } catch {
    // Ventana de otro origen o ya cerrada: no se toca y no se escala.
    childWindows.delete(child);
  }
}

function installScaleShim(): void {
  if (typeof window === 'undefined') return;
  installShimIn(window);
  if (openWrapped) return;
  openWrapped = true;

  // Las ventanas desacopladas se abren con window.open desde shell/: se
  // envuelve una vez para poder parchearlas al nacer.
  const nativeOpen = window.open;
  window.open = function (...args: Parameters<typeof nativeOpen>): Window | null {
    const child = nativeOpen.apply(window, args);
    if (child && child !== window) adoptChildWindow(child);
    return child;
  };
}
