/** Transacción de edición destructiva, compartida por procesado y afinación. */
import { newId, type Clip, type SampleRef } from '@orbit/core';
import { encodeWav } from '@orbit/engine';
import { create } from 'zustand';
import { sha1Hex } from '../../browser/sound-actions';
import { engine, store } from '../../state/app';
import { notifyBanner } from '../../state/bounce';
import { collectWorkletSamples, noteRecordingWritten, withPinnedSample } from '../../state/sample-gc';
import { useUiStore } from '../../state/ui';

export interface AudioChannels {
  left: Float32Array;
  right: Float32Array;
  rate: number;
  duration: number;
}

interface AudioEditRequest {
  clip: Clip;
  sample: SampleRef;
  channels: AudioChannels;
  fileKind: string;
  sampleName: string;
  label: string;
  process: () => { left: Float32Array; right: Float32Array };
  onApplied?: () => void;
}

export const useAudioEditStore = create<{ recoveryNotice: string | null }>(() => ({ recoveryNotice: null }));

export function dismissAudioEditRecovery(): void {
  useAudioEditStore.setState({ recoveryNotice: null });
}

/** Contenido igual produce nombre igual; el reloj nunca identifica audio. */
function editFileName(kind: string, hash: string): string {
  return `${kind} ${hash}.wav`;
}

/** Un controlador por editor: cancelar una ventana no cancela otra instancia. */
export function createAudioEditActions(onBusy: (busy: boolean) => void) {
  let active: { token: symbol; unsubscribe: () => void } | null = null;
  const cancel = () => {
    if (!active) return;
    active.unsubscribe();
    active = null;
    onBusy(false);
  };

  const run = async (input: AudioEditRequest): Promise<void> => {
    const api = window.orbit;
    if (!api || active) return;
    const project = store.project;
    // Un callback de un render anterior no puede editar el sample recién abierto.
    if (project.clips[input.clip.id] !== input.clip || project.samples[input.sample.id] !== input.sample ||
        input.clip.sampleId !== input.sample.id) return;
    const epoch = store.historyEpoch;
    const version = store.version;
    const request = { token: Symbol('audio-edit'), unsubscribe: () => undefined as void };
    active = request;
    const off = store.subscribeBeforeReplace(cancel);
    // La selección y el cierre se publican antes del próximo render de React.
    // No esperar a su cleanup permite cancelar incluso en ese mismo microtask.
    const offView = useUiStore.subscribe((next, previous) => {
      if (next.audioClipId !== previous.audioClipId ||
          (!next.windows.audioEditor.open && previous.windows.audioEditor.open)) cancel();
    });
    request.unsubscribe = () => { off(); offView(); request.unsubscribe = () => undefined; };
    const sameSession = () => epoch === store.historyEpoch && project.id === store.project.id;
    const ownsUi = () => active === request && sameSession();
    let file: string | null = null;
    let uploaded = false;
    let inserted = false;
    const reportRecovery = (reason: string) => {
      if (!file) return;
      useAudioEditStore.setState({ recoveryNotice:
        `Edición de «${input.sample.name}» en «${project.meta.title}» no aplicada: ${reason}. ` +
        `WAV conservado: «${file}». La ruta de datos está en Ayuda → Acerca de. ` +
        'En esa ruta, abre recordings; puedes arrastrar el WAV al proyecto.',
      });
    };
    const canContinue = () => {
      if (ownsUi() && store.version === version) return true;
      const reason = !sameSession() ? 'cambiaste de proyecto' :
        active !== request ? 'cerraste el editor o cambiaste de clip' : 'el proyecto cambió; repite la edición';
      reportRecovery(reason);
      if (ownsUi()) notifyBanner(`No se aplicó la edición: ${reason}.`);
      return false;
    };

    onBusy(true);
    try {
      const processed = input.process();
      const wav = encodeWav(processed.left, processed.right, input.channels.rate, 24);
      const wavBuf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
      const newSampleId = newId();
      const hash = (await sha1Hex(wavBuf)) ?? newSampleId;
      if (!canContinue()) return;
      file = await api.recording.save(editFileName(input.fileKind, hash), wav);
      if (!canContinue()) return;
      await withPinnedSample(newSampleId, async () => {
        uploaded = true;
        await engine.loadSample(newSampleId, wavBuf);
        if (!canContinue()) return;
        const ref: SampleRef = {
          id: newSampleId, name: input.sampleName, path: `recording:${file}`,
          hash, duration: input.channels.duration,
        };
        store.dispatch({
          type: 'batch', label: input.label, commands: [
            { type: 'registerSample', sample: ref },
            { type: 'patchClips', patches: [{ id: input.clip.id, sampleId: newSampleId }] },
          ],
        }, { label: input.label });
        inserted = true;
        // Lo no insertado queda recuperable y fuera del ledger de otra sesión.
        noteRecordingWritten({ sampleId: newSampleId, path: ref.path, bytes: wav.byteLength });
        if (ownsUi()) input.onApplied?.();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo editar el audio';
      if (!inserted) reportRecovery(message);
      if (ownsUi()) notifyBanner(message);
    } finally {
      request.unsubscribe();
      if (uploaded && !inserted) collectWorkletSamples(engine, store.project);
      if (active === request) { active = null; onBusy(false); }
    }
  };
  return { run, cancel };
}
