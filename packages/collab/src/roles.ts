/**
 * Permisos por rol de la sesión colaborativa.
 *
 * El punto de control es el LOG DE COMANDOS: todo lo que muta el proyecto
 * (UI, atajos, Claude, remotos) acaba pasando por él, así que basta con
 * filtrar ahí. `checkRole` es una función PURA sobre el comando serializable
 * — la misma entrada da el mismo veredicto en todos los clientes, que es lo
 * que permite validar también las entradas remotas sin romper la convergencia.
 *
 * Roles:
 * - productor → todo (es el dueño de la sesión).
 * - invitado  → edita, pero NO borra pistas ni toca el master del mixer.
 * - oyente    → solo mira y escucha: ni un comando.
 *
 * Rechazar NO rompe la sesión: el comando simplemente no entra al log (y si
 * ya se aplicó en local, el binding lo deshace) y se avisa por `onDenied`.
 */

import type { Command, Id } from '@orbit/core';

export type CollabRole = 'productor' | 'invitado' | 'oyente';

/** Orden de menor a mayor restricción (para selectores de la UI). */
export const COLLAB_ROLES: readonly CollabRole[] = ['productor', 'invitado', 'oyente'];

export const ROLE_LABELS: Record<CollabRole, string> = {
  productor: 'Productor',
  invitado: 'Invitado',
  oyente: 'Oyente',
};

export const ROLE_DESCRIPTIONS: Record<CollabRole, string> = {
  productor: 'Control total del proyecto.',
  invitado: 'Puede editar, pero no borra pistas ni toca el master.',
  oyente: 'Solo mira y escucha; no puede cambiar nada.',
};

/** El rol de quien no declara ninguno (sesiones antiguas, host que crea). */
export const DEFAULT_ROLE: CollabRole = 'productor';

export function isCollabRole(value: unknown): value is CollabRole {
  return typeof value === 'string' && (COLLAB_ROLES as readonly string[]).includes(value);
}

/** Contexto opcional que puede ablandar una regla (ver `ownCreation`). */
export interface RoleContext {
  /**
   * El comando borra algo que ESE MISMO cliente creó durante la sesión. Sin
   * esta excusa un invitado no podría ni deshacer su propio "añadir canal"
   * (el inverso de addChannel es removeChannel). El binding lo calcula y lo
   * sella en la entrada del log, así que todos los clientes ven el mismo dato
   * y el veredicto sigue siendo idéntico en todos.
   */
  ownCreation?: boolean;
}

export interface RoleVerdict {
  allowed: boolean;
  /** Motivo legible en español cuando `allowed` es false. */
  reason?: string;
}

const ALLOWED: RoleVerdict = { allowed: true };

/** Índice de la pista master del mixer. */
const MASTER_TRACK = 0;

/**
 * Comandos que borran una PISTA entera (canal del rack, pista de playlist o
 * arrangement completo, que se lleva sus pistas por delante). Devuelve los
 * ids afectados; vacío = el comando no borra pistas.
 */
export function trackDeletionTargets(cmd: Command): Id[] {
  switch (cmd.type) {
    case 'removeChannel':
      return [cmd.channelId];
    case 'removePlaylistTrack':
      return [cmd.trackId];
    case 'removeArrangement':
      return [cmd.arrangementId];
    default:
      return [];
  }
}

/** ¿El comando toca la pista master del mixer (fader, efectos, sends, ruta)? */
export function touchesMaster(cmd: Command): boolean {
  switch (cmd.type) {
    case 'patchMixerTrack':
    case 'setEffect':
    case 'patchEffect':
    case 'setEffectParam':
    case 'setSend':
    case 'setRoute':
      return cmd.trackIndex === MASTER_TRACK;
    default:
      return false;
  }
}

/**
 * ¿Puede este rol ejecutar este comando? Los lotes (`batch`) se juzgan
 * enteros: si un solo sub-comando está prohibido cae el lote completo, porque
 * un batch es UN paso de undo y aplicarlo a medias dejaría el log incoherente.
 */
export function checkRole(
  role: CollabRole,
  cmd: Command,
  ctx: RoleContext = {},
): RoleVerdict {
  if (role === 'productor') return ALLOWED;

  if (role === 'oyente') {
    return {
      allowed: false,
      reason: 'Estás como oyente: solo puedes mirar y escuchar, no cambiar el proyecto.',
    };
  }

  // invitado
  if (cmd.type === 'batch') {
    for (const sub of cmd.commands) {
      const verdict = checkRole(role, sub, ctx);
      if (!verdict.allowed) return verdict;
    }
    return ALLOWED;
  }

  if (touchesMaster(cmd)) {
    return {
      allowed: false,
      reason: 'Como invitado no puedes tocar el master del mixer (pista 0).',
    };
  }

  if (trackDeletionTargets(cmd).length > 0 && ctx.ownCreation !== true) {
    return {
      allowed: false,
      reason: 'Como invitado no puedes borrar pistas; pídeselo al productor de la sesión.',
    };
  }

  return ALLOWED;
}

/** Atajo legible: ¿este rol puede tocar algo del proyecto? */
export function canEdit(role: CollabRole): boolean {
  return role !== 'oyente';
}
