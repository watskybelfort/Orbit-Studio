/**
 * LUFS del master EN VIVO: integrado, short-term (3 s) y true-peak, para que
 * el usuario vea que va camino a -14 LUFS (el objetivo de streaming del
 * proyecto) ANTES de exportar, no después. `run-export.ts`/`ExportPanel.tsx`
 * ya miden esto con `analyzeMix` sobre el archivo terminado; esto es lo
 * mismo, corriendo mientras suena, sobre el mismo tap que ya usa el Orbit
 * Scope (`scopeFrame`, mono L+R/2 — ver `state/scope-track.ts`).
 *
 * Preasignado: la instancia de `LiveLoudnessMeter` es de módulo, y el
 * `snapshot()` (el único cálculo que recorre todo el historial de bloques) se
 * throttlea a ~6-7 Hz en vez de correr a 60 fps — a esa cadencia sobra para
 * leer un número y no hace falta rehacer el gating en cada frame de pintado.
 */

import { engine } from './app';
import { LiveLoudnessMeter } from './loudness-meter';
import { acquireScopeTracked, isScopeTrackActive, MASTER_TRACK } from './scope-track';
import { useUiStore } from './ui';
import { create } from 'zustand';

const SNAPSHOT_INTERVAL_MS = 150;

interface LiveLoudnessState {
  integrated: number | null;
  shortTerm: number | null;
  truePeak: number;
  /**
   * El tap está sirviendo AHORA MISMO otra pista (alguien abrió su espectro):
   * los números de arriba son la última lectura válida del master, congelada,
   * no lo que suena en este instante.
   */
  stale: boolean;
  /** Al menos un consumidor pidió el medidor (útil para no pintar "-∞" antes de tiempo). */
  active: boolean;
}

export const useLiveLoudness = create<LiveLoudnessState>(() => ({
  integrated: null,
  shortTerm: null,
  truePeak: -Infinity,
  stale: false,
  active: false,
}));

const meter = new LiveLoudnessMeter();
let lastFrame: Float32Array | null = null;
let lastSnapshotAt = 0;
let raf = 0;
let refCount = 0;
let releaseTap: (() => void) | null = null;

function tick(): void {
  raf = requestAnimationFrame(tick);
  const owns = isScopeTrackActive(MASTER_TRACK);
  if (owns) {
    const frame = useUiStore.getState().scopeFrame;
    if (frame && frame !== lastFrame) {
      lastFrame = frame;
      meter.configure(engine.sampleRate);
      meter.pushMono(frame);
    }
  }
  const now = performance.now();
  if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotAt = now;
  const snap = meter.snapshot();
  useLiveLoudness.setState({
    integrated: snap.integrated,
    shortTerm: snap.shortTerm,
    truePeak: snap.truePeak,
    stale: !owns,
    active: true,
  });
}

/**
 * Empieza a medir el master en vivo. Préstamo con recuento, como el Scope:
 * varias vistas pueden pedirlo a la vez y el tap del kernel solo se suelta
 * cuando la última lo libera. Devuelve la función de soltarlo (pensada para
 * `useEffect`).
 */
export function acquireLiveLoudness(): () => void {
  refCount++;
  if (refCount === 1) {
    releaseTap = acquireScopeTracked(MASTER_TRACK);
    lastFrame = null;
    lastSnapshotAt = 0;
    raf = requestAnimationFrame(tick);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount--;
    if (refCount === 0) {
      cancelAnimationFrame(raf);
      releaseTap?.();
      releaseTap = null;
      meter.reset();
      useLiveLoudness.setState({
        integrated: null,
        shortTerm: null,
        truePeak: -Infinity,
        stale: false,
        active: false,
      });
    }
  };
}
