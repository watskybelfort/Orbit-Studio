/**
 * Acciones del escritorio de ventanas, sin DOM: geometría pura sobre un store
 * sintético. El gesto, el botón y el portal se prueban en la app real; lo que
 * una regresión rompería en silencio es qué caja se guarda y a cuál se vuelve.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowBox } from '../src/shell/window-bounds';
import { useDetachedStore } from '../src/state/detached';
import { applyLayoutWindows, captureLayout } from '../src/state/layouts';
import { useUiStore, type WindowId } from '../src/state/ui';
import {
  activeWindowId,
  isWindowMaximized,
  maximizeWindow,
  refreshMaximizedWindow,
  restoreActiveWindow,
  restoreWindow,
  tileActiveWindow,
  tileWindow,
  toggleMaximizeWindow,
} from '../src/state/window-actions';
import { registerWindowMinimum, windowMinimum } from '../src/state/window-minimums';
import { clearWindowRestore, isMarkedMaximized, peekWindowBox } from '../src/state/window-restore';
import { readSource } from './read-source';

const initialUi = useUiStore.getState();
const area = { w: 1200, h: 700 };
const minimum = { w: 320, h: 200 };
const floating: WindowBox = { x: 140, y: 90, w: 620, h: 430 };

function place(id: WindowId, box: WindowBox, z: number, open = true): void {
  useUiStore.setState((s) => ({
    windows: { ...s.windows, [id]: { ...s.windows[id], ...box, open, z } },
  }));
}

function boxOf(id: WindowId): WindowBox {
  const { x, y, w, h } = useUiStore.getState().windows[id];
  return { x, y, w, h };
}

beforeEach(() => {
  // `useDetachedStore` guarda en settings al cambiar y en Node no hay `window`:
  // un stub vacío evita el ReferenceError del suscriptor (sin tocar su lógica).
  vi.stubGlobal('window', {});
  clearWindowRestore();
  useDetachedStore.setState({ detached: {}, alwaysOnTop: {} });
  place('playlist', floating, 10);
  place('mixer', { x: 40, y: 30, w: 700, h: 500 }, 5);
});

afterEach(() => {
  clearWindowRestore();
  useUiStore.setState(initialUi, true);
  useDetachedStore.setState({ detached: {}, alwaysOnTop: {} });
  vi.unstubAllGlobals();
});

describe('maximizar y restaurar', () => {
  it('maximizar guarda la caja exacta y restaurar la devuelve', () => {
    expect(maximizeWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 1200, h: 700 });
    expect(isWindowMaximized('playlist', area)).toBe(true);
    expect(isMarkedMaximized('playlist')).toBe(true);
    expect(peekWindowBox('playlist')).toEqual(floating);

    expect(restoreWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
    expect(peekWindowBox('playlist')).toBeUndefined();
    expect(isMarkedMaximized('playlist')).toBe(false);
  });

  it('maximizar dos veces no pisa la caja de vuelta', () => {
    expect(maximizeWindow('playlist', area, minimum)).toBe(true);
    expect(maximizeWindow('playlist', area, minimum)).toBe(false);
    expect(peekWindowBox('playlist')).toEqual(floating);
    expect(restoreWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
  });

  it('toggle maximiza y restaura en el mismo botón', () => {
    expect(toggleMaximizeWindow('playlist', area, minimum)).toBe(true);
    expect(isWindowMaximized('playlist', area)).toBe(true);
    expect(toggleMaximizeWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
    expect(isMarkedMaximized('playlist')).toBe(false);
  });

  it('restaurar recorta la caja si el escritorio se achicó o era de otro monitor', () => {
    place('playlist', { x: 2000, y: 1200, w: 900, h: 500 }, 10);
    expect(maximizeWindow('playlist', area, minimum)).toBe(true);
    expect(restoreWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 300, y: 200, w: 900, h: 500 });
  });

  it('refrescar mantiene maximizada al cambiar el área sin perder la caja de vuelta', () => {
    expect(maximizeWindow('playlist', { w: 1000, h: 700 }, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 1000, h: 700 });

    expect(refreshMaximizedWindow('playlist', { w: 1400, h: 900 }, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 1400, h: 900 });
    // La caja de vuelta sigue siendo la flotante de ANTES de maximizar, no la
    // de 1000×700: el escritorio creció, no la intención del usuario.
    expect(peekWindowBox('playlist')).toEqual(floating);

    expect(restoreWindow('playlist', { w: 1400, h: 900 }, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
  });

  it('la marca hace que el toggle siga diciendo «restaurar» si el área cambió', () => {
    expect(maximizeWindow('playlist', { w: 1000, h: 700 }, minimum)).toBe(true);
    // Sin refresh, la caja guardada (1000×700) ya no coincide con 1400×900.
    expect(isWindowMaximized('playlist', { w: 1400, h: 900 })).toBe(false);
    expect(toggleMaximizeWindow('playlist', { w: 1400, h: 900 }, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
  });

  it('una caja que llena el área sin marca no se puede restaurar ni se marca al togglear', () => {
    // Viene de un layout o de workspace-memory, no de maximizar: no hay caja de
    // vuelta. Restaurar no puede fingir, y el botón tiene que seguir diciendo
    // «Maximizar» para que el asa y el arrastre sigan disponibles.
    place('playlist', { x: 0, y: 0, w: 1200, h: 700 }, 10);
    expect(isWindowMaximized('playlist', area)).toBe(true);
    expect(isMarkedMaximized('playlist')).toBe(false);

    expect(restoreWindow('playlist', area, minimum)).toBe(false);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 1200, h: 700 });

    expect(toggleMaximizeWindow('playlist', area, minimum)).toBe(false);
    expect(isMarkedMaximized('playlist')).toBe(false);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 1200, h: 700 });
  });
});

describe('acoplar a una mitad', () => {
  it('izquierda, derecha y arriba (maximizar), con una sola caja de vuelta', () => {
    expect(tileWindow('playlist', 'left', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 600, h: 700 });
    expect(peekWindowBox('playlist')).toEqual(floating);

    expect(tileWindow('playlist', 'right', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 600, y: 0, w: 600, h: 700 });

    expect(tileWindow('playlist', 'top', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual({ x: 0, y: 0, w: 1200, h: 700 });
    expect(isMarkedMaximized('playlist')).toBe(true);

    expect(restoreWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
  });

  it('de maximizada a media pantalla, restaurar vuelve a la flotante original', () => {
    expect(maximizeWindow('playlist', area, minimum)).toBe(true);
    expect(tileWindow('playlist', 'right', area, minimum)).toBe(true);
    expect(isMarkedMaximized('playlist')).toBe(false);
    expect(peekWindowBox('playlist')).toEqual(floating);
    expect(restoreWindow('playlist', area, minimum)).toBe(true);
    expect(boxOf('playlist')).toEqual(floating);
  });

  it('respeta el mínimo registrado por el editor, no un genérico', () => {
    // Prisma declara 720×460 en Workspace.tsx; a 1160 px media pantalla son
    // 580 y el editor se pintaría a 720, comiéndose la otra mitad.
    registerWindowMinimum('prisma', { w: 720, h: 460 });
    place('prisma', { x: 160, y: 100, w: 940, h: 580 }, 10);
    expect(windowMinimum('prisma')).toEqual({ w: 720, h: 460 });

    expect(tileWindow('prisma', 'left', { w: 1160, h: 700 })).toBe(true);
    expect(boxOf('prisma')).toEqual({ x: 0, y: 0, w: 1160, h: 700 });

    clearWindowRestore();
    expect(tileWindow('prisma', 'left', { w: 1600, h: 700 })).toBe(true);
    expect(boxOf('prisma')).toEqual({ x: 0, y: 0, w: 800, h: 700 });
  });

  it('una ventana sin registrar cae al mínimo de InternalWindow', () => {
    expect(windowMinimum('graph')).toEqual({ w: 320, h: 200 });
  });
});

describe('ventana activa', () => {
  it('es la abierta con mayor z, no la última tocada', () => {
    place('playlist', floating, 10);
    place('mixer', { x: 40, y: 30, w: 700, h: 500 }, 30);
    expect(activeWindowId()).toBe('mixer');

    expect(tileActiveWindow('left', area, minimum)).toBe('mixer');
    expect(boxOf('mixer')).toEqual({ x: 0, y: 0, w: 600, h: 700 });
    expect(boxOf('playlist')).toEqual(floating);
  });

  it('ignora cerradas y desacopladas aunque tengan z alta', () => {
    place('playlist', floating, 10);
    place('mixer', { x: 40, y: 30, w: 700, h: 500 }, 50, false);
    expect(activeWindowId()).toBe('playlist');

    place('mixer', { x: 40, y: 30, w: 700, h: 500 }, 60);
    useDetachedStore.setState({ detached: { mixer: true } });
    expect(activeWindowId()).toBe('playlist');
    expect(tileActiveWindow('right', area, minimum)).toBe('playlist');
  });

  it('restaurar la activa devuelve la caja flotante', () => {
    place('playlist', floating, 10);
    place('mixer', { x: 40, y: 30, w: 700, h: 500 }, 30);
    expect(tileActiveWindow('top', area, minimum)).toBe('mixer');
    expect(boxOf('mixer')).toEqual({ x: 0, y: 0, w: 1200, h: 700 });
    expect(restoreActiveWindow(area, minimum)).toBe('mixer');
    expect(boxOf('mixer')).toEqual({ x: 40, y: 30, w: 700, h: 500 });
  });
});

describe('aplicar un layout', () => {
  it('limpia cajas y marcas: no se restaura a la geometría de otro layout', () => {
    expect(maximizeWindow('playlist', area, minimum)).toBe(true);
    expect(peekWindowBox('playlist')).toEqual(floating);
    expect(isMarkedMaximized('playlist')).toBe(true);

    applyLayoutWindows({ playlist: { open: true, x: 40, y: 30, w: 700, h: 500 } });

    expect(peekWindowBox('playlist')).toBeUndefined();
    expect(isMarkedMaximized('playlist')).toBe(false);
    const afterLayout = boxOf('playlist');
    expect(afterLayout).toEqual({ x: 40, y: 30, w: 700, h: 500 });

    expect(restoreWindow('playlist', area, minimum)).toBe(false);
    expect(boxOf('playlist')).toEqual(afterLayout);
  });
});

describe('la memoria del escritorio captura la caja de descanso', () => {
  it('una ventana maximizada se guarda flotante, no con la caja del área', () => {
    // La marca no se persiste y el layout del proyecto tampoco sabe expresar
    // «maximizada»: guardar la caja grande la devolvía en el próximo arranque
    // como una ventana del tamaño del área, sin marca y sin poder moverse.
    expect(maximizeWindow('playlist', area, minimum)).toBe(true);
    expect(captureLayout()['playlist']).toEqual({ open: true, ...floating });
  });

  it('una ventana normal se guarda con su caja viva', () => {
    place('mixer', { x: 9, y: 11, w: 500, h: 300 }, 5);
    expect(captureLayout()['mixer']).toEqual({ open: true, x: 9, y: 11, w: 500, h: 300 });
  });
});

describe('fuente de InternalWindow', () => {
  it('la UI solo se cree maximizada por la marca, nunca por la geometría', () => {
    // Regresión real: con el fallback geométrico, una ventana que ocupa el área
    // sin marca mostraba «Restaurar» (sin caja de vuelta) y escondía el asa.
    const source = readSource('shell/InternalWindow.tsx');
    const line = source.split('\n').find((text) => text.includes('const maximized ='));
    expect(line).toBeDefined();
    expect(line).toContain('isMarkedMaximized(id)');
    expect(line).not.toContain('isWindowMaximized');
    expect(source).not.toContain('isWindowMaximized');
  });

  it('«Maximizar» se deshabilita si la ventana ya ocupa el escritorio sin marca', () => {
    // El caso que deja workspace-memory: guardó la geometría maximizada y la
    // marca no sobrevive al reinicio. Sin esto el botón decía «Maximizar» y no
    // hacía nada; el title ahora explica por qué y la ventana sigue arrastrable.
    const source = readSource('shell/InternalWindow.tsx');
    expect(source).toContain('const fillsWorkspace =');
    expect(source).toContain('isMaximizedBox(box, area)');
    expect(source).toContain('disabled={fillsWorkspace}');
  });
});
