/**
 * Info del proyecto: título, autor y notas, más el recuento de lo que hay
 * dentro y la duración estimada.
 *
 * El título no es decorativo — es el nombre con el que se guarda el `.orbit`
 * y el que usa el export para nombrar el WAV, así que conviene tenerlo a mano
 * y no enterrado en un diálogo de guardado.
 */

import { useMemo } from 'react';
import { store } from '../../state/app';
import { useProject } from '../../state/useProject';
import './project-info.css';

export function ProjectInfo() {
  const project = useProject();

  const stats = useMemo(() => {
    const clips = Object.values(project.clips);
    const tracks = Object.values(project.playlistTracks).filter(
      (t) => t.arrangementId === project.activeArrangementId,
    );
    let notes = 0;
    for (const pattern of Object.values(project.patterns)) {
      for (const list of Object.values(pattern.notes)) notes += list.length;
    }
    const endBeat = clips.reduce((max, c) => Math.max(max, c.start + c.length), 0);
    const seconds = (endBeat * 60) / Math.max(1, project.tempo);
    const usedEffects = project.mixer.reduce(
      (n, t) => n + t.slots.filter((s) => s !== null).length,
      0,
    );
    return {
      channels: project.channelOrder.length,
      patterns: project.patternOrder.length,
      clips: clips.length,
      tracks: tracks.length,
      notes,
      samples: Object.keys(project.samples).length,
      lfos: Object.keys(project.lfos).length,
      effects: usedEffects,
      arrangements: project.arrangementOrder.length,
      duration: seconds,
    };
  }, [project]);

  const setMeta = (patch: { title?: string; author?: string; comments?: string }) => {
    store.dispatch({ type: 'setMeta', patch }, { label: 'Info del proyecto', mergeKey: 'meta' });
  };

  return (
    <div className="pinfo">
      <label className="pinfo-field">
        Título
        <input
          value={project.meta.title}
          placeholder="Sin título"
          onChange={(e) => setMeta({ title: e.target.value })}
        />
      </label>
      <label className="pinfo-field">
        Autor
        <input
          value={project.meta.author}
          placeholder="Tú"
          onChange={(e) => setMeta({ author: e.target.value })}
        />
      </label>
      <label className="pinfo-field pinfo-notes">
        Notas
        <textarea
          value={project.meta.comments}
          placeholder="Ideas, qué falta, referencias…"
          rows={5}
          onChange={(e) => setMeta({ comments: e.target.value })}
        />
      </label>

      <div className="pinfo-stats">
        <Stat label="Duración" value={formatDuration(stats.duration)} />
        <Stat label="Tempo" value={`${project.tempo.toFixed(1)} BPM`} />
        <Stat label="Compás" value={`${project.timeSig.num}/${project.timeSig.den}`} />
        <Stat label="Canales" value={stats.channels} />
        <Stat label="Patrones" value={stats.patterns} />
        <Stat label="Notas" value={stats.notes} />
        <Stat label="Pistas" value={stats.tracks} />
        <Stat label="Clips" value={stats.clips} />
        <Stat label="Arrangements" value={stats.arrangements} />
        <Stat label="Efectos" value={stats.effects} />
        <Stat label="LFOs" value={stats.lfos} />
        <Stat label="Samples" value={stats.samples} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="pinfo-stat">
      <span className="pinfo-stat-value">{value}</span>
      <span className="pinfo-stat-label">{label}</span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
