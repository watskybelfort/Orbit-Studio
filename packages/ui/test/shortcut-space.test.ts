import { describe, expect, it, vi } from 'vitest';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { shouldHandleTransportSpace } from '../src/hooks/shortcut-space';
import { readSource } from './read-source';

function node(tagName?: string, attributes: Record<string, string> = {}, parentElement?: ReturnTypeNode): ReturnTypeNode {
  return { tagName, parentElement, getAttribute: (name) => attributes[name] ?? null };
}
interface ReturnTypeNode {
  tagName?: string;
  parentElement?: ReturnTypeNode;
  getAttribute: (name: string) => string | null;
  isContentEditable?: boolean;
}
const space = (target: unknown, defaultPrevented = false) => ({ code: 'Space', defaultPrevented, target });

describe('BUG043: Espacio pertenece primero al control enfocado', () => {
  it.each(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'AUDIO', 'VIDEO'])('respeta el control nativo %s', (tag) => {
    expect(shouldHandleTransportSpace(space(node(tag)))).toBe(false);
  });

  it.each(['button', 'slider', 'menuitem', 'checkbox', 'radio', 'switch', 'tab', 'option', 'combobox', 'listbox', 'spinbutton', 'textbox', 'searchbox', 'treeitem', 'menuitemcheckbox', 'menuitemradio'])('respeta el widget con role=%s', (role) => {
    expect(shouldHandleTransportSpace(space(node('DIV', { role })))).toBe(false);
  });

  it('respeta descendientes SVG y texto de un botón o un widget', () => {
    const svg = node('path', {}, node('svg', {}, node('BUTTON')));
    const text = node(undefined, {}, node('SPAN', {}, node('DIV', { role: 'button' })));
    expect(shouldHandleTransportSpace(space(svg))).toBe(false);
    expect(shouldHandleTransportSpace(space(text))).toBe(false);
  });

  it.each(['', 'true', 'plaintext-only'])('respeta texto editable heredado (%s)', (value) => {
    const text = node(undefined, {}, node('SPAN', {}, node('DIV', { contenteditable: value })));
    expect(shouldHandleTransportSpace(space(text))).toBe(false);
  });

  it('respeta isContentEditable y la frontera contenteditable=false', () => {
    expect(shouldHandleTransportSpace(space({ isContentEditable: true }))).toBe(false);
    const locked = node('DIV', { contenteditable: 'false' }, node('DIV', { contenteditable: 'true' }));
    expect(shouldHandleTransportSpace(space(node('CANVAS', {}, locked)))).toBe(true);
    expect(shouldHandleTransportSpace(space(node('BUTTON', {}, locked)))).toBe(false);
  });

  it('deja enlaces con href en su propio contexto, sin convertir anclas vacías en widgets', () => {
    expect(shouldHandleTransportSpace(space(node('A', { href: '/help' })))).toBe(false);
    expect(shouldHandleTransportSpace(space(node('A')))).toBe(true);
  });

  it('el transporte conserva Espacio en canvas y regiones normales de edición', () => {
    expect(shouldHandleTransportSpace(space(node('CANVAS', {}, node('DIV', { role: 'group' }))))).toBe(true);
    expect(shouldHandleTransportSpace(space(node('DIV', { tabindex: '0' })))).toBe(true);
    expect(shouldHandleTransportSpace(space(null))).toBe(true);
  });

  it('no consume eventos cancelados ni otras teclas', () => {
    expect(shouldHandleTransportSpace(space(node('CANVAS'), true))).toBe(false);
    expect(shouldHandleTransportSpace({ ...space(node('CANVAS')), code: 'Enter' })).toBe(false);
  });
});

/** Ejecuta el callback instalado de verdad por useShortcuts, como la sonda de
 * auditoría. Se extrae del source y se elimina TS; no se reescribe su lógica ni
 * se monta React/DOM. Inyectamos el helper real y los efectos observables. */
function callbackRig(decide = shouldHandleTransportSpace) {
  const source = readSource('hooks/useShortcuts.ts');
  const begin = source.indexOf('    const onKey =');
  const end = source.indexOf("    window.addEventListener('keydown'", begin);
  if (begin < 0 || end < 0) throw new Error('No se encontró el callback real de useShortcuts');
  const togglePlay = vi.fn();
  const togglePalette = vi.fn();
  const undo = vi.fn();
  const collectSessionSamples = vi.fn();
  const decision = vi.fn(decide);
  const context = {
    shouldHandleTransportSpace: decision,
    togglePlay,
    collectSessionSamples,
    usePaletteStore: { getState: () => ({ togglePalette }) },
    useUiStore: { getState: () => ({}) },
    store: { undo },
    onKey: undefined as ((event: object) => void) | undefined,
  };
  runInNewContext(`${stripTypeScriptTypes(source.slice(begin, end))}\nglobalThis.onKey = onKey;`, context);
  const send = (target: unknown, extra: object = {}) => {
    const event = { ...space(target), preventDefault: vi.fn(), ctrlKey: false, shiftKey: false, altKey: false, ...extra };
    context.onKey!(event);
    return event;
  };
  return { send, togglePlay, togglePalette, undo, decision };
}

describe('callback real: prioridad de widgets sobre el transporte', () => {
  it('BUTTON conserva su activación nativa y el helper real está conectado', () => {
    const rig = callbackRig();
    const event = rig.send(node('BUTTON'));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(rig.togglePlay).not.toHaveBeenCalled();
    expect(rig.decision).toHaveBeenCalledWith(event);
  });

  it('un widget custom recibe Espacio sin cancelar su comportamiento', () => {
    const rig = callbackRig();
    const event = rig.send(node('SPAN', {}, node('DIV', { role: 'menuitem' })));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(rig.togglePlay).not.toHaveBeenCalled();
  });

  it('el callback detecta una regresión si el helper deja pasar BUTTON', () => {
    const rig = callbackRig(() => true);
    const event = rig.send(node('BUTTON'));
    // Control negativo: con la decisión rota reaparece exactamente BUG043.
    expect(rig.togglePlay).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('Espacio en el editor mantiene reproducción/parada', () => {
    const rig = callbackRig();
    const event = rig.send(node('CANVAS'));
    expect(rig.togglePlay).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['Space', 'KeyK', 'KeyZ'])('%s ya consumido por un widget/modal no ejecuta otro atajo global', (code) => {
    const rig = callbackRig();
    const event = rig.send(node('DIV'), { code, ctrlKey: true, defaultPrevented: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(rig.togglePlay).not.toHaveBeenCalled();
    expect(rig.togglePalette).not.toHaveBeenCalled();
    expect(rig.undo).not.toHaveBeenCalled();
  });

  it('Ctrl+K sigue abriendo la paleta desde un campo cuando no fue consumido', () => {
    const rig = callbackRig();
    const event = rig.send(node('INPUT'), { code: 'KeyK', ctrlKey: true });
    expect(rig.togglePalette).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(rig.togglePlay).not.toHaveBeenCalled();
  });
});
