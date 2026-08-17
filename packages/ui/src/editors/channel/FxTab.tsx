/**
 * Pestaña "Efectos": los cuatro inserts PROPIOS del canal (`Channel.fx`).
 *
 * Suenan entre las voces y la pista de mixer, y el volumen/pan del canal va
 * después de la cadena. Eso es lo que permite bajarle el reverb a UN sonido
 * sin gastar un insert del mixer ni arrastrar a los demás canales que
 * compartan pista.
 *
 * La cadena se maneja igual que la del mixer (menú "+", perillas generadas
 * desde EFFECT_PARAMS, dry/wet por slot, bypass y quitar), pero el código está
 * duplicado aquí a propósito: el panel del mixer es de otra ventana y otro
 * ciclo de vida, y acoplarlos por un puñado de botones ata dos editores que
 * evolucionan por separado.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_SLOTS,
  EFFECT_LABELS,
  EFFECT_PARAMS,
  defaultEffectParams,
  newId,
  type Channel,
  type EffectKind,
  type EffectSlot,
  type MixerTrack,
} from '@orbit/core';
import { store } from '../../state/app';
import { defaultPluginParams } from '../../state/plugin-parse';
import { usePluginsStore, type PluginInfo } from '../../state/plugins';
import { Knob } from '../../widgets/Knob';
import { MenuPortal } from '../../widgets/MenuPortal';
import { ParamControl } from './ParamControl';

/** Efectos nativos insertables; 'plugin' entra por su propia sección. */
const EFFECT_KINDS = (Object.keys(EFFECT_LABELS) as EffectKind[]).filter((k) => k !== 'plugin');

/** Nombre visible de un slot: los kind 'plugin' toman el del registro. */
function slotLabel(slot: EffectSlot, plugins: PluginInfo[]): string {
  if (slot.kind !== 'plugin') return EFFECT_LABELS[slot.kind];
  return plugins.find((p) => p.id === slot.pluginId)?.name ?? EFFECT_LABELS.plugin;
}

export interface FxTabProps {
  channel: Channel;
  mixer: MixerTrack[];
}

export function FxTab({ channel, mixer }: FxTabProps) {
  const plugins = usePluginsStore((s) => s.plugins);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ slot: number; x: number; y: number; anchor: Element } | null>(
    null,
  );

  // Cambiar de canal cierra editor y menú: los slots son de otra cadena.
  useEffect(() => {
    setExpanded(null);
    setMenu(null);
  }, [channel.id]);

  const insert = useCallback(
    (slotIndex: number, kind: EffectKind) => {
      const slot: EffectSlot = {
        id: newId(),
        kind,
        enabled: true,
        mix: 1,
        params: defaultEffectParams(kind),
      };
      store.dispatch(
        { type: 'setChannelEffect', channelId: channel.id, slotIndex, slot },
        { label: `${EFFECT_LABELS[kind]} en "${channel.name}"` },
      );
      setExpanded(slotIndex);
    },
    [channel.id, channel.name],
  );

  const insertPlugin = useCallback(
    (slotIndex: number, plugin: PluginInfo) => {
      const slot: EffectSlot = {
        id: newId(),
        kind: 'plugin',
        enabled: true,
        mix: 1,
        params: defaultPluginParams(plugin.params),
        pluginId: plugin.id,
      };
      store.dispatch(
        { type: 'setChannelEffect', channelId: channel.id, slotIndex, slot },
        { label: `${plugin.name} en "${channel.name}"` },
      );
      setExpanded(slotIndex);
    },
    [channel.id, channel.name],
  );

  const slots = Array.from({ length: CHANNEL_SLOTS }, (_, i) => channel.fx?.[i] ?? null);
  const used = slots.filter(Boolean).length;

  return (
    <div className="chan-tab">
      <p className="chan-note">
        Estos {CHANNEL_SLOTS} efectos son solo de <b>{channel.name}</b>: van antes de su pista de
        mixer, así que no tocan a los demás canales que salgan por ahí. {used}/{CHANNEL_SLOTS} en
        uso.
      </p>

      <div className="chan-fx-list">
        {slots.map((slot, i) => {
          if (!slot) {
            return (
              <div key={`empty-${i}`} className="chan-fx-slot empty">
                <span className="chan-fx-index">{i + 1}</span>
                <button
                  className="chan-fx-add"
                  title="Insertar efecto en este canal"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ slot: i, x: r.left, y: r.bottom + 2, anchor: e.currentTarget });
                  }}
                >
                  + Efecto
                </button>
              </div>
            );
          }
          const name = slotLabel(slot, plugins);
          return (
            <div key={slot.id} className="chan-fx-slot">
              <div className={`chan-fx-row${slot.enabled ? '' : ' off'}`}>
                <span className="chan-fx-index">{i + 1}</span>
                <button
                  className={`chan-fx-led${slot.enabled ? ' on' : ''}`}
                  title={slot.enabled ? 'Poner en bypass' : 'Activar'}
                  onClick={() =>
                    store.dispatch(
                      {
                        type: 'patchChannelEffect',
                        channelId: channel.id,
                        slotIndex: i,
                        patch: { enabled: !slot.enabled },
                      },
                      { label: `${slot.enabled ? 'Bypass' : 'Activar'} ${name}` },
                    )
                  }
                />
                <button
                  className="chan-fx-name"
                  title="Ver y tocar sus parámetros"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  {name}
                </button>
                <Knob
                  value={slot.mix}
                  min={0}
                  max={1}
                  defaultValue={1}
                  size={22}
                  format={(v) => `Mix ${Math.round(v * 100)}%`}
                  onChange={(v) =>
                    store.dispatch(
                      {
                        type: 'patchChannelEffect',
                        channelId: channel.id,
                        slotIndex: i,
                        patch: { mix: v },
                      },
                      { mergeKey: `chfx:${channel.id}:${i}:mix`, label: 'Dry/Wet' },
                    )
                  }
                />
                <button
                  className="chan-fx-del"
                  title="Quitar efecto"
                  onClick={() => {
                    store.dispatch(
                      { type: 'setChannelEffect', channelId: channel.id, slotIndex: i, slot: null },
                      { label: `Quitar ${name} de "${channel.name}"` },
                    );
                    if (expanded === i) setExpanded(null);
                  }}
                >
                  ×
                </button>
              </div>
              {expanded === i && (
                <ChannelEffectEditor
                  channelId={channel.id}
                  slotIndex={i}
                  slot={slot}
                  mixer={mixer}
                />
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <MenuPortal
          anchor={menu.anchor}
          x={menu.x}
          y={menu.y}
          className="chan-menu"
          onClose={() => setMenu(null)}
        >
          {EFFECT_KINDS.map((kind) => (
            <button
              key={kind}
              className="menu-item"
              onClick={() => {
                insert(menu.slot, kind);
                setMenu(null);
              }}
            >
              {EFFECT_LABELS[kind]}
            </button>
          ))}
          <div className="menu-sep" />
          <div className="chan-menu-title">Plugins JS</div>
          {plugins
            .filter((p) => p.effect)
            .map((p) => (
              <button
                key={p.id}
                className="menu-item"
                title={`Plugin JS de usuario (${p.id}.js)`}
                onClick={() => {
                  insertPlugin(menu.slot, p);
                  setMenu(null);
                }}
              >
                {p.name}
              </button>
            ))}
          {plugins.filter((p) => p.effect).length === 0 && (
            <div className="chan-menu-hint">Pon archivos .js en la carpeta de plugins</div>
          )}
        </MenuPortal>
      )}
    </div>
  );
}

// ── Editor de un insert del canal ────────────────────────────────────────────

function ChannelEffectEditor({
  channelId,
  slotIndex,
  slot,
  mixer,
}: {
  channelId: string;
  slotIndex: number;
  slot: EffectSlot;
  mixer: MixerTrack[];
}) {
  const plugins = usePluginsStore((s) => s.plugins);
  const plugin = slot.kind === 'plugin' ? plugins.find((p) => p.id === slot.pluginId) : undefined;
  const specs = slot.kind === 'plugin' ? (plugin?.params ?? []) : EFFECT_PARAMS[slot.kind];
  const pluginMissing = slot.kind === 'plugin' && !plugin;

  return (
    <div className="chan-fx-editor">
      {pluginMissing && (
        <div className="chan-warn">Plugin no encontrado: {slot.pluginId ?? '(sin id)'}</div>
      )}
      {specs.length === 0 && slot.kind !== 'compressor' && !pluginMissing && (
        <div className="chan-warn">Sin parámetros.</div>
      )}
      <div className="chan-knobs">
        {specs.map((spec) => (
          <ParamControl
            key={spec.key}
            spec={spec}
            value={slot.params[spec.key] ?? spec.default}
            onChange={(v) =>
              store.dispatch(
                { type: 'setChannelEffectParam', channelId, slotIndex, key: spec.key, value: v },
                { mergeKey: `chfx:${channelId}:${slotIndex}:${spec.key}`, label: spec.label },
              )
            }
            // Igual que en el mixer: un plugin declara sus rangos fuera del
            // registro de params, así que su perilla no es automatizable.
            paramRef={
              slot.kind === 'plugin'
                ? undefined
                : { kind: 'channelFx', channelId, slotIndex, param: spec.key }
            }
          />
        ))}
      </div>
      {slot.kind === 'compressor' && (
        <label className="chan-side">
          <span>Sidechain</span>
          <select
            className="chan-select"
            value={slot.sidechainSource ?? -1}
            onChange={(e) => {
              const v = Number(e.target.value);
              store.dispatch(
                {
                  type: 'patchChannelEffect',
                  channelId,
                  slotIndex,
                  patch: { sidechainSource: v < 0 ? undefined : v },
                },
                { label: 'Sidechain' },
              );
            }}
          >
            <option value={-1}>Ninguno</option>
            {mixer.map((t, ti) =>
              ti === 0 ? null : (
                <option key={t.id} value={ti}>
                  {ti} — {t.name}
                </option>
              ),
            )}
          </select>
        </label>
      )}
    </div>
  );
}
