import type { CompiledMixerTrack } from './protocol';

/**
 * Solo del mixer, resuelto fuera del hilo de audio sobre las rutas finales
 * (incluidos buses de carpeta). Un bus necesita sus fuentes y sus salidas.
 *
 * Los nodos aguas abajo transportan audio, pero no habilitan sus instrumentos
 * propios ni otros afluentes: compartir Master o retorno no hace que todo el
 * proyecto pertenezca al solo. Los afluentes solo conservan los cables que
 * conducen al bus elegido; así escuchar un retorno no añade también su señal
 * seca directa al Master. Desde la pista elegida sí se conservan sus salidas.
 *
 * Modifica únicamente el compilado y devuelve las pistas que admiten fuentes
 * propias (rack y clips). Sin solo no cambia nada y devuelve null.
 */
export function applyMixerSolo(
  mixer: CompiledMixerTrack[],
  soloIndices: readonly number[],
): ReadonlySet<number> | null {
  if (soloIndices.length === 0) return null;
  const outgoing = mixer.map((track, index) => {
    const targets = new Set<number>();
    const add = (target: number) => {
      if (Number.isInteger(target) && target >= 0 && target < mixer.length && target !== index) {
        targets.add(target);
      }
    };
    // Master es la salida, no una fuente del grafo de inserts.
    if (index !== 0) {
      if (track.routeTo !== null) add(track.routeTo);
      for (const send of track.sends) if (!send.mute && send.level > 0) add(send.target);
    }
    return [...targets];
  });
  const incoming = mixer.map(() => [] as number[]);
  outgoing.forEach((targets, from) => {
    for (const target of targets) incoming[target]!.push(from);
  });
  const reachable = (edges: readonly number[][]): Set<number> => {
    const seen = new Set(soloIndices);
    const pending = [...soloIndices];
    while (pending.length) {
      for (const next of edges[pending.pop()!] ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    return seen;
  };
  const sources = reachable(incoming);
  const outputs = reachable(outgoing);
  mixer.forEach((track, index) => {
    track.audible = track.audible && (index === 0 || sources.has(index) || outputs.has(index));
    if (!sources.has(index) || outputs.has(index)) return;
    // Es un afluente, no la pista elegida ni una salida de ella. Solo viaja
    // por los cables que terminan en el solo, nunca por un bypass seco.
    if (track.routeTo !== null && !sources.has(track.routeTo)) track.routeTo = null;
    for (const send of track.sends) if (!sources.has(send.target)) send.mute = true;
  });
  return sources;
}
