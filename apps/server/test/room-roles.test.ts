/**
 * Roles decididos por el servidor.
 *
 * Lo que importa: que el primero mande, que la sala NUNCA se quede sin
 * productor (si se va, hereda el más antiguo; y el único productor no puede
 * degradarse a sí mismo), que solo un productor reparta roles, y que una
 * entrada del log se juzgue con el rol que le da el SERVIDOR y no con el que
 * ella misma dice traer — que es justo el agujero que esto cierra.
 */

import { describe, expect, it } from 'vitest';
import { RoomRoles, checkEntry, strictestRole, JOIN_ROLE } from '../src/room-roles';

describe('reparto de roles', () => {
  it('el primero es productor y los demás entran de invitados', () => {
    const roles = new RoomRoles();
    expect(roles.join(1)).toEqual({ role: 'productor', host: true });
    expect(roles.join(2)).toEqual({ role: JOIN_ROLE, host: false });
    expect(roles.join(3).role).toBe('invitado');
  });

  it('si el productor se va, hereda el más antiguo que queda', () => {
    const roles = new RoomRoles();
    roles.join(1);
    roles.join(2);
    roles.join(3);
    expect(roles.leave(1)).toEqual({ promoted: 2 });
    expect(roles.get(2)).toBe('productor');
    expect(roles.get(3)).toBe('invitado');
  });

  it('si se va un invitado no se mueve nada', () => {
    const roles = new RoomRoles();
    roles.join(1);
    roles.join(2);
    expect(roles.leave(2)).toEqual({ promoted: null });
    expect(roles.get(1)).toBe('productor');
  });

  it('la sala vacía no promociona a nadie', () => {
    const roles = new RoomRoles();
    roles.join(1);
    expect(roles.leave(1)).toEqual({ promoted: null });
    expect(roles.size).toBe(0);
  });

  it('solo un productor cambia el rol de otro', () => {
    const roles = new RoomRoles();
    roles.join(1);
    roles.join(2);
    roles.join(3);
    expect(roles.setRole(2, 3, 'productor')).toBe(false); // un invitado no reparte
    expect(roles.get(3)).toBe('invitado');
    expect(roles.setRole(1, 3, 'oyente')).toBe(true);
    expect(roles.get(3)).toBe('oyente');
  });

  it('no se puede ascender a quien no está en la sala', () => {
    const roles = new RoomRoles();
    roles.join(1);
    expect(roles.setRole(1, 99, 'productor')).toBe(false);
  });

  it('el único productor no puede quedarse sin serlo', () => {
    const roles = new RoomRoles();
    roles.join(1);
    roles.join(2);
    expect(roles.setRole(1, 1, 'oyente')).toBe(false);
    expect(roles.get(1)).toBe('productor');
    // Con dos productores sí puede soltarlo uno.
    expect(roles.setRole(1, 2, 'productor')).toBe(true);
    expect(roles.setRole(1, 1, 'invitado')).toBe(true);
    expect(roles.get(1)).toBe('invitado');
  });

  it('la tabla sale en orden de llegada', () => {
    const roles = new RoomRoles();
    roles.join(7);
    roles.join(4);
    roles.setRole(7, 4, 'oyente');
    expect(roles.entries()).toEqual([
      [7, 'productor'],
      [4, 'oyente'],
    ]);
  });

  it('a un desconocido se le juzga como invitado, no como productor', () => {
    const roles = new RoomRoles();
    expect(roles.roleOf(undefined)).toBe('invitado');
    expect(roles.roleOf(42)).toBe('invitado');
  });
});

describe('validación de entradas del log', () => {
  const borrarCanal = { type: 'removeChannel', channelId: 'ch1' };

  it('el rol que manda es el del servidor, no el que trae la entrada', () => {
    // La entrada se firma como productor; el servidor sabe que es un oyente.
    const entry = { cmd: borrarCanal, client: 5, seq: 1, role: 'productor' };
    expect(checkEntry(entry, 'oyente').allowed).toBe(false);
    expect(checkEntry(entry, 'productor').allowed).toBe(true);
  });

  it('un invitado no borra canales ajenos pero sí los suyos', () => {
    expect(checkEntry({ cmd: borrarCanal, client: 5, seq: 1 }, 'invitado').allowed).toBe(false);
    expect(
      checkEntry({ cmd: borrarCanal, client: 5, seq: 2, own: true }, 'invitado').allowed,
    ).toBe(true);
  });

  it('un invitado no toca el master', () => {
    const master = { type: 'patchMixerTrack', trackIndex: 0, patch: { volume: 2 } };
    expect(checkEntry({ cmd: master, client: 1, seq: 1 }, 'invitado').allowed).toBe(false);
    expect(checkEntry({ cmd: master, client: 1, seq: 1 }, 'productor').allowed).toBe(true);
  });

  it('una entrada sin comando reconocible no entra', () => {
    expect(checkEntry({ client: 1, seq: 1 }, 'productor').allowed).toBe(false);
    expect(checkEntry({ cmd: 'borra todo', client: 1, seq: 1 }, 'productor').allowed).toBe(false);
    expect(checkEntry({ cmd: {}, client: 1, seq: 1 }, 'productor').allowed).toBe(false);
  });

  it('el peor de dos roles es el que manda cuando una entrada dice venir de otro', () => {
    expect(strictestRole('productor', 'invitado')).toBe('invitado');
    expect(strictestRole('invitado', 'productor')).toBe('invitado');
    expect(strictestRole('invitado', 'oyente')).toBe('oyente');
    expect(strictestRole('oyente', 'oyente')).toBe('oyente');
    expect(strictestRole('productor', 'productor')).toBe('productor');
  });
});
