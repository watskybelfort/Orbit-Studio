/**
 * Envíos que además de llevar la señal la moldean.
 *
 * Aquí no se prueba que "se oye algo": se prueba QUÉ se oye. Un envío de lados
 * sobre una fuente centrada tiene que dar SILENCIO, y sumar una pista con su
 * copia invertida tiene que cancelar. Son las dos afirmaciones que, si el
 * kernel se equivoca de signo o de fórmula, fallan de inmediato — y que
 * mirando la pantalla no se ven.
 *
 * El montaje es siempre el mismo: un clip de audio conocido en el carril 1
 * (que va a la pista de mixer 1), la pista 1 muda hacia el master y un envío
 * de la 1 a la 2, que sí desemboca. Así, lo que sale por el master es EL
 * ENVÍO y nada más.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createEmptyProject,
  newId,
  type Clip,
  type Project,
  type Send,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';

const SR = 44100;

function rms(xs: Float32Array): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, xs.length));
}

/**
 * Fuente estéreo: la usa el test para saber qué debe pasar.
 * - `centered`: lo mismo en los dos canales → todo mid, nada de side.
 * - `wide`: uno la inversa del otro → todo side, nada de mid.
 * - `leftOnly`: solo el canal izquierdo.
 */
type Source = 'centered' | 'wide' | 'leftOnly';

function stereoTone(kind: Source): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(SR);
  const right = new Float32Array(SR);
  for (let i = 0; i < left.length; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
    left[i] = v;
    right[i] = kind === 'centered' ? v : kind === 'wide' ? -v : 0;
  }
  return { left, right };
}

/**
 * Proyecto con el clip en la pista 1, la 1 SIN salida al master y un envío a
 * la 2. Lo que se renderiza es exclusivamente lo que pasa por el envío.
 */
function scene(send: Partial<Send>, source: Source = 'centered') {
  const project: Project = createEmptyProject('Sends');
  project.tempo = 240;
  const track = Object.values(project.playlistTracks).find(
    (t) => t.arrangementId === project.activeArrangementId,
  )!;
  applyCommand(project, { type: 'patchPlaylistTrack', trackId: track.id, patch: { mixerTrack: 1 } });

  const sampleId = newId();
  const clip: Clip = {
    id: newId(),
    kind: 'audio',
    playlistTrackId: track.id,
    start: 0,
    length: 4,
    muted: false,
    sampleId,
    audioGain: 1,
  };
  applyCommand(project, { type: 'addClips', clips: [clip] });

  // La 1 no desemboca en ningún sitio: solo manda por el envío.
  project.mixer[1]!.routeTo = null;
  project.mixer[1]!.sends = [{ target: 2, level: 1, ...send }];
  project.mixer[2]!.routeTo = 0;

  const { left, right } = stereoTone(source);
  return renderProject(compileProject(project, { mode: 'song' }), {
    sampleRate: SR,
    tailSeconds: 0.05,
    samples: new Map([[sampleId, { left, right, rate: SR }]]),
  });
}

describe('envíos: lo que llega al destino', () => {
  it('un envío normal lleva la señal entera', () => {
    const out = scene({});
    expect(rms(out.left)).toBeGreaterThan(0.05);
    expect(rms(out.right)).toBeGreaterThan(0.05);
  });

  it('nivel 0 no manda nada', () => {
    const out = scene({ level: 0 });
    expect(rms(out.left)).toBeLessThan(1e-5);
  });

  it('silenciado no manda nada, aunque tenga nivel', () => {
    const out = scene({ level: 1, mute: true });
    expect(rms(out.left)).toBeLessThan(1e-5);
  });
});

describe('envíos: qué parte de la señal', () => {
  it('los LADOS de una fuente centrada son silencio', () => {
    const out = scene({ part: 'side' }, 'centered');
    expect(rms(out.left)).toBeLessThan(1e-5);
    expect(rms(out.right)).toBeLessThan(1e-5);
  });

  it('los lados de una fuente ancha llegan enteros', () => {
    const out = scene({ part: 'side' }, 'wide');
    expect(rms(out.left)).toBeGreaterThan(0.05);
  });

  it('el CENTRO de una fuente ancha (L = −R) es silencio', () => {
    const out = scene({ part: 'mid' }, 'wide');
    expect(rms(out.left)).toBeLessThan(1e-5);
  });

  it('el centro de una fuente centrada llega entero', () => {
    const out = scene({ part: 'mid' }, 'centered');
    expect(rms(out.left)).toBeGreaterThan(0.05);
  });

  it('el side sale en contrafase: lo que suma por un lado resta por el otro', () => {
    const out = scene({ part: 'side' }, 'wide');
    for (let i = 100; i < 200; i++) {
      expect(out.left[i]! + out.right[i]!).toBeCloseTo(0, 5);
    }
  });

  it('extraer un canal lo manda en MONO a los dos', () => {
    const out = scene({ part: 'left' }, 'leftOnly');
    expect(rms(out.left)).toBeGreaterThan(0.05);
    expect(rms(out.right)).toBeGreaterThan(0.05);
    for (let i = 100; i < 200; i++) {
      expect(out.left[i]!).toBeCloseTo(out.right[i]!, 5);
    }
  });

  it('extraer el canal que está vacío da silencio', () => {
    const out = scene({ part: 'right' }, 'leftOnly');
    expect(rms(out.left)).toBeLessThan(1e-5);
  });
});

describe('envíos: polaridad', () => {
  it('invertir cambia el signo de todas las muestras', () => {
    const normal = scene({});
    const flipped = scene({ invert: true });
    for (let i = 100; i < 200; i++) {
      expect(normal.left[i]! + flipped.left[i]!).toBeCloseTo(0, 5);
    }
  });

  it('la misma señal sumada e invertida se cancela: eso es una "suma rara"', () => {
    const project: Project = createEmptyProject('Null');
    project.tempo = 240;
    const track = Object.values(project.playlistTracks).find(
      (t) => t.arrangementId === project.activeArrangementId,
    )!;
    applyCommand(project, {
      type: 'patchPlaylistTrack',
      trackId: track.id,
      patch: { mixerTrack: 1 },
    });
    const sampleId = newId();
    applyCommand(project, {
      type: 'addClips',
      clips: [
        {
          id: newId(),
          kind: 'audio',
          playlistTrackId: track.id,
          start: 0,
          length: 4,
          muted: false,
          sampleId,
          audioGain: 1,
        },
      ],
    });
    // La 1 va al master Y manda una copia invertida al master: debe anularse.
    project.mixer[1]!.routeTo = 0;
    project.mixer[1]!.sends = [{ target: 0, level: 1, invert: true }];

    const { left, right } = stereoTone('centered');
    const out = renderProject(compileProject(project, { mode: 'song' }), {
      sampleRate: SR,
      tailSeconds: 0.05,
      samples: new Map([[sampleId, { left, right, rate: SR }]]),
    });
    expect(rms(out.left)).toBeLessThan(1e-5);
  });
});

describe('envíos: pre-fader', () => {
  it('post-fader (el de siempre) se va con el fader', () => {
    const bajo = scene({ tap: 'post' });
    // Mismo montaje pero con el fader de la pista de origen a cero.
    const project: Project = createEmptyProject('Post');
    project.tempo = 240;
    const track = Object.values(project.playlistTracks).find(
      (t) => t.arrangementId === project.activeArrangementId,
    )!;
    applyCommand(project, {
      type: 'patchPlaylistTrack',
      trackId: track.id,
      patch: { mixerTrack: 1 },
    });
    const sampleId = newId();
    applyCommand(project, {
      type: 'addClips',
      clips: [
        {
          id: newId(),
          kind: 'audio',
          playlistTrackId: track.id,
          start: 0,
          length: 4,
          muted: false,
          sampleId,
          audioGain: 1,
        },
      ],
    });
    project.mixer[1]!.routeTo = null;
    project.mixer[1]!.volume = 0;
    project.mixer[1]!.sends = [{ target: 2, level: 1, tap: 'post' }];
    project.mixer[2]!.routeTo = 0;
    const { left, right } = stereoTone('centered');
    const out = renderProject(compileProject(project, { mode: 'song' }), {
      sampleRate: SR,
      tailSeconds: 0.05,
      samples: new Map([[sampleId, { left, right, rate: SR }]]),
    });
    expect(rms(bajo.left)).toBeGreaterThan(0.05);
    expect(rms(out.left)).toBeLessThan(1e-5);
  });

  it('pre-fader se queda aunque el fader esté a cero', () => {
    const project: Project = createEmptyProject('Pre');
    project.tempo = 240;
    const track = Object.values(project.playlistTracks).find(
      (t) => t.arrangementId === project.activeArrangementId,
    )!;
    applyCommand(project, {
      type: 'patchPlaylistTrack',
      trackId: track.id,
      patch: { mixerTrack: 1 },
    });
    const sampleId = newId();
    applyCommand(project, {
      type: 'addClips',
      clips: [
        {
          id: newId(),
          kind: 'audio',
          playlistTrackId: track.id,
          start: 0,
          length: 4,
          muted: false,
          sampleId,
          audioGain: 1,
        },
      ],
    });
    project.mixer[1]!.routeTo = null;
    project.mixer[1]!.volume = 0;
    project.mixer[1]!.sends = [{ target: 2, level: 1, tap: 'pre' }];
    project.mixer[2]!.routeTo = 0;
    const { left, right } = stereoTone('centered');
    const out = renderProject(compileProject(project, { mode: 'song' }), {
      sampleRate: SR,
      tailSeconds: 0.05,
      samples: new Map([[sampleId, { left, right, rate: SR }]]),
    });
    expect(rms(out.left)).toBeGreaterThan(0.05);
  });

  it('mutear la pista sí calla el envío pre: es antes del fader, no antes del mute', () => {
    const project: Project = createEmptyProject('PreMute');
    project.tempo = 240;
    const track = Object.values(project.playlistTracks).find(
      (t) => t.arrangementId === project.activeArrangementId,
    )!;
    applyCommand(project, {
      type: 'patchPlaylistTrack',
      trackId: track.id,
      patch: { mixerTrack: 1 },
    });
    const sampleId = newId();
    applyCommand(project, {
      type: 'addClips',
      clips: [
        {
          id: newId(),
          kind: 'audio',
          playlistTrackId: track.id,
          start: 0,
          length: 4,
          muted: false,
          sampleId,
          audioGain: 1,
        },
      ],
    });
    project.mixer[1]!.routeTo = null;
    project.mixer[1]!.mute = true;
    project.mixer[1]!.sends = [{ target: 2, level: 1, tap: 'pre' }];
    project.mixer[2]!.routeTo = 0;
    const { left, right } = stereoTone('centered');
    const out = renderProject(compileProject(project, { mode: 'song' }), {
      sampleRate: SR,
      tailSeconds: 0.05,
      samples: new Map([[sampleId, { left, right, rate: SR }]]),
    });
    expect(rms(out.left)).toBeLessThan(1e-5);
  });
});

describe('envíos: compilación', () => {
  it('un envío sin campos nuevos se compila con los valores de siempre', () => {
    const project: Project = createEmptyProject('Compile');
    project.mixer[1]!.sends = [{ target: 2, level: 0.5 }];
    const compiled = compileProject(project, { mode: 'song' });
    expect(compiled.mixer[1]!.sends[0]).toEqual({
      target: 2,
      level: 0.5,
      tap: 'post',
      part: 'stereo',
      invert: false,
      pan: 0,
      mute: false,
    });
  });
});
