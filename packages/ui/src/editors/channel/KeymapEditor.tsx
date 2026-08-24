/**
 * Editor de keymap: el multisample de un canal de sampler.
 *
 * Arriba, el teclado con las zonas dibujadas encima — es la vista que hace
 * falta para ver de un golpe si queda un hueco o si dos zonas se pisan. Debajo,
 * la lista con los números exactos, porque afinar un borde a la tecla concreta
 * arrastrando es una tortura y escribirlo son dos segundos.
 *
 * Se sueltan sonidos del Browser encima y entran solos con su nota leída del
 * nombre del archivo. Lo que no sabe leer se dice, no se coloca a bulto: una
 * nota en el sitio equivocado no se ve hasta que se toca.
 */

import { useState } from 'react';
import {
  createKeymapZone,
  midiToNote,
  normalizeKeymap,
  normalizeKeymapZone,
  spreadKeymapRanges,
  spreadKeymapVelocities,
  type Channel,
  type KeymapZone,
} from '@orbit/core';
import { addKeymapZones, describeKeymapDrop, getDragEntries } from '../../browser/sound-actions';
import { store } from '../../state/app';
import { useProject } from '../../state/useProject';

/** Rango pintado en la tira del teclado: cinco octavas desde C1. */
const VIEW_LOW = 24;
const VIEW_HIGH = 96;

/** Blancas y negras dentro de la octava (para pintar el teclado). */
const IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

export interface KeymapEditorProps {
  channel: Channel;
}

export function KeymapEditor({ channel }: KeymapEditorProps) {
  const project = useProject();
  const zones = channel.keymap ?? [];
  const [octaveOffset, setOctaveOffset] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const commit = (next: readonly KeymapZone[], label: string) =>
    store.dispatch(
      {
        type: 'patchChannel',
        channelId: channel.id,
        // SIEMPRE un array, nunca undefined: un patch con undefined se pierde
        // al serializarlo y por la sala no llegaría a limpiar nada.
        patch: { keymap: normalizeKeymap(next) ?? [] },
      },
      { label: `${channel.name}: ${label}`, mergeKey: `keymap:${channel.id}` },
    );

  const patchZone = (id: string, patch: Partial<KeymapZone>, label: string) =>
    commit(
      zones.map((z) => (z.id === id ? normalizeKeymapZone({ ...z, ...patch }) : z)),
      label,
    );

  const drop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    // Un arrastre trae lo que se seleccionó en el Browser: una muestra, o las
    // treinta de un piano. Aquí da igual — es el mismo camino.
    const entries = getDragEntries(e.dataTransfer);
    if (entries.length === 0) return;
    // Treinta muestras tardan lo suyo en leerse del disco y decodificarse: sin
    // este aviso el editor se queda quieto y parece que el drop no ha hecho
    // nada. Con una sola no se enseña, que sería un parpadeo.
    if (entries.length > 1) setNotice(`Cargando ${entries.length} muestras…`);
    const result = await addKeymapZones(channel.id, entries, { octaveOffset });
    setNotice(describeKeymapDrop(result));
  };

  /** Posición 0..1 de una tecla dentro de la tira. */
  const pos = (key: number) => (key - VIEW_LOW) / (VIEW_HIGH - VIEW_LOW);

  return (
    <section className="chan-group">
      <h4 className="chan-group-title">
        Multisample
        <span className="chan-group-sub">
          {zones.length === 0
            ? 'Sin keymap: el canal toca su único sample'
            : `${zones.length} zona(s)`}
        </span>
      </h4>

      <div
        className={`km-strip${dropping ? ' dropping' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void drop(e)}
        title="Suelta aquí sonidos del Browser (uno, o los que tengas seleccionados): entran con su nota leída del nombre"
      >
        <div className="km-keys" aria-hidden="true">
          {Array.from({ length: VIEW_HIGH - VIEW_LOW }, (_, i) => {
            const key = VIEW_LOW + i;
            return (
              <span
                key={key}
                className={`km-key${IS_BLACK[key % 12] ? ' black' : ''}`}
                style={{ left: `${pos(key) * 100}%`, width: `${(1 / (VIEW_HIGH - VIEW_LOW)) * 100}%` }}
              />
            );
          })}
        </div>
        {zones.map((z, i) => (
          <button
            key={z.id}
            className={`km-zone${selected === z.id ? ' selected' : ''}`}
            style={{
              left: `${Math.max(0, pos(z.keyLow)) * 100}%`,
              width: `${Math.max(0.01, pos(z.keyHigh + 1) - pos(z.keyLow)) * 100}%`,
              // Las capas se apilan en altura: dos zonas en la misma franja de
              // teclado se ven las dos en vez de taparse.
              bottom: `${z.velLow * 100}%`,
              height: `${Math.max(8, (z.velHigh - z.velLow) * 100)}%`,
              background: `color-mix(in srgb, ${channel.color} ${45 + (i % 3) * 15}%, transparent)`,
            }}
            onClick={() => setSelected(selected === z.id ? null : z.id)}
            title={`${project.samples[z.sampleId]?.name ?? z.sampleId} · ${midiToNote(z.keyLow)}–${midiToNote(z.keyHigh)} · raíz ${midiToNote(z.keyRoot)}`}
          >
            <span className="km-zone-label">{midiToNote(z.keyRoot)}</span>
          </button>
        ))}
        {zones.length === 0 && (
          <span className="km-empty">
            Suelta aquí las muestras del instrumento (todas de golpe)
          </span>
        )}
      </div>

      <div className="chan-slice-tools">
        <button
          className="chan-slice-btn"
          disabled={zones.length < 2}
          title="Reparte los rangos de tecla entre las raíces, sin huecos"
          onClick={() => commit(spreadKeymapRanges(zones), 'repartir rangos')}
        >
          Repartir teclado
        </button>
        <button
          className="chan-slice-btn"
          disabled={zones.length < 2}
          title="Las muestras que comparten nota se reparten la velocidad (capas)"
          onClick={() => commit(spreadKeymapVelocities(zones), 'repartir capas')}
        >
          Repartir capas
        </button>
        <select
          className="chan-slice-btn"
          value={octaveOffset}
          onChange={(e) => setOctaveOffset(Number(e.target.value))}
          title="Si la librería usa otra convención de octava, todo el mapa se corre entero"
        >
          {[-2, -1, 0, 1, 2].map((o) => (
            <option key={o} value={o}>
              {o === 0 ? 'Octava tal cual' : `Octava ${o > 0 ? '+' : ''}${o}`}
            </option>
          ))}
        </select>
        {zones.length > 0 && (
          <button
            className="chan-slice-btn"
            title="Quitar el keymap: el canal vuelve a tocar su único sample"
            onClick={() => {
              setSelected(null);
              setNotice(null);
              commit([], 'quitar keymap');
            }}
          >
            Quitar keymap
          </button>
        )}
      </div>

      {notice && <p className="chan-warn">{notice}</p>}

      {zones.length > 0 && (
        <div className="km-list">
          {zones.map((z) => (
            <div key={z.id} className={`km-row${selected === z.id ? ' selected' : ''}`}>
              <span className="km-row-name" title={z.sampleId}>
                {project.samples[z.sampleId]?.name ?? '(sample perdido)'}
              </span>
              <label className="km-field" title="Tecla más grave de la zona">
                <span>Desde</span>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={z.keyLow}
                  onChange={(e) => patchZone(z.id, { keyLow: Number(e.target.value) }, 'rango')}
                />
                <em>{midiToNote(z.keyLow)}</em>
              </label>
              <label className="km-field" title="Tecla más aguda de la zona">
                <span>Hasta</span>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={z.keyHigh}
                  onChange={(e) => patchZone(z.id, { keyHigh: Number(e.target.value) }, 'rango')}
                />
                <em>{midiToNote(z.keyHigh)}</em>
              </label>
              <label className="km-field" title="Nota a la que esta muestra suena sin transponer">
                <span>Raíz</span>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={z.keyRoot}
                  onChange={(e) => patchZone(z.id, { keyRoot: Number(e.target.value) }, 'raíz')}
                />
                <em>{midiToNote(z.keyRoot)}</em>
              </label>
              <label className="km-field" title="Afinación fina, en semitonos">
                <span>Afin.</span>
                <input
                  type="number"
                  min={-6}
                  max={6}
                  step={0.1}
                  value={z.tune}
                  onChange={(e) => patchZone(z.id, { tune: Number(e.target.value) }, 'afinación')}
                />
              </label>
              <label className="km-field" title="Ganancia de la zona, para igualar tomas">
                <span>Gan.</span>
                <input
                  type="number"
                  min={0}
                  max={4}
                  step={0.05}
                  value={Number(z.gain.toFixed(2))}
                  onChange={(e) => patchZone(z.id, { gain: Number(e.target.value) }, 'ganancia')}
                />
              </label>
              <button
                className="custom-del"
                title="Quitar esta zona"
                onClick={() => commit(zones.filter((o) => o.id !== z.id), 'quitar zona')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {zones.length === 0 && channel.sampleId && (
        <button
          className="chan-slice-btn"
          title="Empieza el keymap con el sample que ya tiene el canal"
          onClick={() =>
            commit(
              [createKeymapZone(channel.sampleId!, { keyRoot: 60 })],
              'empezar keymap',
            )
          }
        >
          Empezar con el sample actual
        </button>
      )}
    </section>
  );
}
