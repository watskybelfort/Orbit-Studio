/**
 * Cable de enrutado Playlist → Mixer.
 *
 * - Lo puro de `state/route-cable.ts`: la curva, el canal bajo un elemento,
 *   el estado del gesto y qué pistas entran por cada canal.
 * - Que conectar cambie de verdad por dónde suena el audio: el motor compila
 *   cada clip de audio al `mixerTrack` de su pista (`engine/compile.ts`), así
 *   que basta con comprobar que el comando lo deja ahí y que es un undo.
 * - Que el LED, la etiqueta de destino y los canales del Mixer estén cableados
 *   (lectura de la fuente, sin jsdom).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginCableDrag,
  cablePath,
  cancelCableDrag,
  endCableDrag,
  MIXER_INSERT_ATTR,
  mixerInsertOf,
  mixerTargetLabel,
  moveCable,
  playlistSourcesByInsert,
  useRouteCable,
} from '../src/state/route-cable';
import { readSource } from './read-source';

/** Un `Element` mínimo: `closest` sube hasta el que tenga el atributo. */
function fakeEl(attr: string | null): Element {
  const host = { getAttribute: (name: string) => (name === MIXER_INSERT_ATTR ? attr : null) };
  return { closest: () => (attr === null ? null : host) } as unknown as Element;
}

describe('piezas puras', () => {
  it('mixerInsertOf lee el canal del ancestro marcado y rechaza basura', () => {
    expect(mixerInsertOf(fakeEl('3'))).toBe(3);
    expect(mixerInsertOf(fakeEl('0'))).toBe(0);
    expect(mixerInsertOf(fakeEl(null))).toBeNull();
    expect(mixerInsertOf(fakeEl('x'))).toBeNull();
    expect(mixerInsertOf(fakeEl('-1'))).toBeNull();
    expect(mixerInsertOf(fakeEl(''))).toBeNull();
    expect(mixerInsertOf(null)).toBeNull();
  });

  it('cablePath sale y llega a los extremos y cuelga hacia abajo', () => {
    const d = cablePath(10, 20, 310, 120);
    expect(d.startsWith('M 10 20 C')).toBe(true);
    expect(d.endsWith('310 120')).toBe(true);
    const nums = d.replace(/[MC]/g, '').trim().split(/\s+/).map(Number);
    // Los dos puntos de control quedan por debajo de sus extremos (cuelga).
    expect(nums[3]!).toBeGreaterThan(20);
    expect(nums[5]!).toBeGreaterThan(120);
  });

  it('mixerTargetLabel: Master, número con nombre, o Insert N', () => {
    expect(mixerTargetLabel(0, 'Master')).toBe('Master');
    expect(mixerTargetLabel(3, 'Voz')).toBe('3 · Voz');
    expect(mixerTargetLabel(4, '  ')).toBe('Insert 4');
    expect(mixerTargetLabel(3, 'Insert 3')).toBe('Insert 3');
  });
});

describe('el gesto', () => {
  afterEach(() => cancelCableDrag());

  it('empieza en el conector, sigue al cursor, y al soltar devuelve el canal de debajo', () => {
    beginCableDrag({ trackId: 't1', trackName: 'Voz', color: 'c', x0: 5, y0: 6 });
    expect(useRouteCable.getState().drag).toMatchObject({ x: 5, y: 6, hover: null });
    moveCable(100, 50, () => 2);
    expect(useRouteCable.getState().drag).toMatchObject({ x: 100, y: 50, hover: 2 });
    moveCable(120, 60, () => null);
    expect(useRouteCable.getState().drag?.hover).toBeNull();
    moveCable(130, 70, () => 4);
    expect(endCableDrag()).toBe(4);
    expect(useRouteCable.getState().drag).toBeNull();
  });

  it('cancelar no conecta nada', () => {
    beginCableDrag({ trackId: 't1', trackName: 'Voz', color: 'c', x0: 0, y0: 0 });
    moveCable(10, 10, () => 1);
    cancelCableDrag();
    expect(endCableDrag()).toBeNull();
  });
});

describe('conectar de verdad', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('connectTrackToMixer deja el audio de la pista en ese canal, en un undo, y el Mixer lo muestra', async () => {
    vi.resetModules();
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    const app = await import('../src/state/app');
    const { connectTrackToMixer } = await import('../src/editors/playlist/route-jack');
    const store = app.store;
    const track = Object.values(store.project.playlistTracks).sort((a, b) => a.order - b.order)[0]!;
    connectTrackToMixer(track.id, 3);
    expect(store.project.playlistTracks[track.id]!.mixerTrack).toBe(3);
    expect(playlistSourcesByInsert(store.project).get(3)?.map((s) => s.name)).toEqual([track.name]);
    // Un canal que no existe no se acepta.
    connectTrackToMixer(track.id, store.project.mixer.length + 5);
    expect(store.project.playlistTracks[track.id]!.mixerTrack).toBe(3);
    store.undo();
    expect(store.project.playlistTracks[track.id]!.mixerTrack ?? 0).toBe(0);
    expect(playlistSourcesByInsert(store.project).size).toBe(0);
  });
});

describe('cableado de la UI', () => {
  it('el LED y la etiqueta de destino son conectores', () => {
    const src = readSource('editors/playlist/Playlist.tsx');
    expect(src).toContain('const ledJack = useJack(jackTrack, toggleMute);');
    expect(src).toContain('{...ledJack}');
    expect(src).toContain('{...routeJack}');
  });

  it('un clic sigue siendo un clic: el cable solo sale pasado el umbral', () => {
    const src = readSource('editors/playlist/route-jack.ts');
    expect(src).toContain('export const CABLE_DRAG_PX = 5;');
    expect(src).toMatch(/if \(!dragged\) \{\s+onClick\(\);/);
    // Siempre al frente, aunque ya estuviera abierto detrás de la Playlist.
    expect(src).toContain("useUiStore.getState().openWindow('mixer');");
  });

  it('cada canal del Mixer es destino y se ilumina bajo la punta', () => {
    const src = readSource('editors/mixer/Mixer.tsx');
    expect(src).toContain('{...{ [MIXER_INSERT_ATTR]: index }}');
    expect(src).toContain("' cable-over' : ''");
    expect(src).toContain('sources={sources.get(i)}');
  });

  it('la capa del cable está montada en la app y no recibe eventos', () => {
    expect(readSource('App.tsx')).toContain('<RouteCableOverlay />');
    expect(readSource('shell/shell.css')).toMatch(/\.route-cable \{[^}]*pointer-events: none;/);
  });
});
