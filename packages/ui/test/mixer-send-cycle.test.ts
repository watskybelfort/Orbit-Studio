import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ProjectStore } from '@orbit/core';

// El callback real del TSX no necesita React ni DOM para comprobar su contrato.
const source = readFileSync(new URL('../src/editors/mixer/Mixer.tsx', import.meta.url), 'utf8');
const body = source.match(/const onToggleSend = useCallback\(\s*\(target: number\) => \{([\s\S]*?)\n {4}\},\s*\[selIndex\]/)?.[1];
if (!body) throw new Error('No se encontró el manejador real de los envíos del mixer');
const toggle = new Function('store', 'selIndex', 'target', 'SEND_DEFAULT', 'notifyBanner', body);

it('Ctrl+clic y menú comparten el rechazo del ciclo y muestran la causa', () => {
  const store = new ProjectStore();
  store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 2 });
  const notify = vi.fn();
  expect(() => toggle(store, 2, 1, 0.7, notify)).not.toThrow();
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/ciclo/));
  expect(store.project.mixer[2]!.sends).toEqual([]);
});

it('un envío válido se puede activar y quitar sin avisos de error', () => {
  const store = new ProjectStore();
  const notify = vi.fn();
  toggle(store, 1, 2, 0.7, notify);
  expect(store.project.mixer[1]!.sends).toEqual([{ target: 2, level: 0.7 }]);
  toggle(store, 1, 2, 0.7, notify);
  expect(store.project.mixer[1]!.sends).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
});
